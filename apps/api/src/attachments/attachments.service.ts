import {
  BadRequestException, ForbiddenException, Injectable, InternalServerErrorException,
  Logger, NotFoundException, PayloadTooLargeException,
} from '@nestjs/common';
import { DbService } from '../db/db.service';
import { roleAllowed } from '@procurement/roles';
import { createReadStream } from 'node:fs';
import { StorageAdapter } from './storage.adapter';
import { AttachmentLimitsService } from './limits.service';

export type UploadResult = {
  attachment_id: string;
  version: number;
  name: string;
  kind: string;
  size_bytes: number;
  sha256: string;
  status: string;
  bucket: string;
  object_key: string;
  superseded_id: string | null;
  limits_source: string;
};

@Injectable()
export class AttachmentsService {
  private readonly log = new Logger('Attachments');

  constructor(
    private readonly db: DbService,
    private readonly storage: StorageAdapter,
    private readonly limits: AttachmentLimitsService,
  ) {}

  /**
   * Turn a database refusal into the right HTTP answer.
   *
   * The per-file cap is checked in TypeScript BEFORE the bytes are buffered, so
   * it already answers 413. The per-PR budget cannot be: it is a DEFERRED
   * constraint trigger, evaluated at COMMIT, long after the service has handed
   * the bytes over. So the database is the only place that can refuse it.
   *
   * Left alone, DbService throws a plain Error whose message embeds the whole
   * statement and the psql exit code, Nest renders that as HTTP 500, and the
   * client receives schema names and SQL. A crossed budget is not a server
   * fault — it is 413, with a message that says what to change. A missing limit
   * is a genuine misconfiguration and stays a 500, but without the SQL.
   */
  private static translateDbError(e: any): Error {
    if (e instanceof PayloadTooLargeException || e instanceof BadRequestException) return e;
    const raw = String(e?.message ?? e ?? '');
    // DbService's error is `psql exited N: <stderr>\nSQL was:\n<statement>`, and
    // <stderr> itself is decorated `psql:<stdin>:31: ERROR:  <text>`. Three
    // layers of transport noise sit in front of the sentence worth reading, so
    // take only what follows the last ERROR: marker and never touch the SQL.
    const headline = raw.split(/\r?\n/)[0];
    const afterError = /ERROR:\s+(.*)$/.exec(headline);
    const detail = (afterError ? afterError[1] : headline)
      .replace(/^psql exited \d+:\s*/, '')
      .trim();

    if (/ceiling exceeded/i.test(detail)) {
      return new PayloadTooLargeException(
        `${detail} — remove an existing attachment, or raise the ceiling in Admin → Settings.`,
      );
    }
    if (/above the configured per-file/i.test(detail)) {
      return new PayloadTooLargeException(detail);
    }
    if (/attachment parent .* does not exist/i.test(detail)) {
      return new BadRequestException('the parent record no longer exists');
    }
    if (/limits are not configured|is not configured/i.test(detail)) {
      return new InternalServerErrorException(
        'attachment limits are not configured on this server; an administrator must set them',
      );
    }
    if (/violates exclusion constraint|violates foreign key|violates check constraint/i.test(detail)) {
      return new BadRequestException(
        'the attachment could not be recorded: a concurrent change conflicted with it',
      );
    }
    return e;
  }

  /**
   * Read an upload's bytes off the request, refusing as soon as the running
   * total passes the CONFIGURED per-file ceiling.
   *
   * `content-length` is checked first so an oversized upload is rejected before
   * a single byte is buffered. The running total is still enforced, because a
   * client may lie about or omit the header.
   *
   * The cap comes from configuration every time. There is no constant here to
   * drift out of step with the database trigger that will check the same row.
   */
  private async readBody(req: any, maxBytes: number): Promise<Buffer> {
    const declared = Number(req.headers['content-length'] ?? 0);
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new PayloadTooLargeException(
        `declared size ${declared} bytes exceeds the configured per-file ceiling of ${maxBytes} bytes. ` +
          `Raise ATTACHMENT_MAX_BYTES (or core.settings.attachmentMaxBytes) for larger packages.`,
      );
    }
    if (req.body && Buffer.isBuffer(req.body) && !req.readable) return req.body as Buffer;

    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of req) {
      const buf: Buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.length;
      if (total > maxBytes) {
        throw new PayloadTooLargeException(
          `upload exceeded the configured per-file ceiling of ${maxBytes} bytes. ` +
            `Raise ATTACHMENT_MAX_BYTES (or core.settings.attachmentMaxBytes) for larger packages.`,
        );
      }
      chunks.push(buf);
    }
    if (total === 0) throw new BadRequestException('the upload carried no bytes');
    return Buffer.concat(chunks);
  }

  /**
   * POST /pr/:id/attachments — the write path.
   *
   * Order of operations, and why:
   *   1. role gate
   *   2. resolve the CONFIGURED limits        (fail loudly if unconfigured)
   *   3. confirm the PR exists                (so the trigger's parent check will pass)
   *   4. stream the bytes, aborting at the configured ceiling
   *   5. write to DISK                        (bytes never enter the database)
   *   6. record metadata + the relative path  (one transaction)
   *
   * Step 5 precedes step 6 deliberately: if the row cannot be written the file is
   * removed again, so a failed upload does not leave an orphan on the volume.
   */
  async uploadToPr(
    prId: string, userId: string, role: string, costCenterIds: string[],
    req: any, filename: string, mimeType: string, declaredKind?: string,
  ): Promise<UploadResult> {
    if (!roleAllowed(role, 'procurement,hod,requester,cs')) {
      throw new ForbiddenException('Only the requester or an approver may attach files to a PR.');
    }

    const lim = await this.limits.get();
    const isImage = (declaredKind ?? '') === 'image' || String(mimeType).startsWith('image/');
    const maxBytes = isImage ? lim.imagePerFileBytes : lim.perFileBytes;

    const pr = await this.db.query<any>(
      `SELECT id FROM proc.purchase_requisitions WHERE id = $1::uuid`,
      [prId],
      { role, userId, costCenterIds },
    );
    if (pr.rows.length === 0) throw new NotFoundException('PR not found');

    const safe = StorageAdapter.safeName(filename);
    const data = await this.readBody(req, maxBytes);

    // A name collision means a REPLACE, not a second copy. Versioning is tracked
    // on the ATTACHMENT, independent of quote versioning, so replacing a file on
    // V1 does not disturb V2's own files.
    const prior = await this.db.query<any>(
      `SELECT id, version FROM core.attachment_registry
        WHERE parent_type='pr' AND parent_id=$1::uuid AND name=$2 AND status='ACTIVE'
        ORDER BY version DESC LIMIT 1`,
      [prId, safe],
      { role, userId, costCenterIds },
    );

    const stored = await this.storage.put(safe, data);

    try {
      // ONE STATEMENT, therefore one transaction.
      //
      // Replace means "insert the new ACTIVE row, then flip the old one to
      // SUPERSEDED". `uq_attachment_active_per_parent_name` is a DEFERRABLE
      // EXCLUDE, so that order is legal — but only if both halves share a
      // transaction. DbService runs one psql process per query, so issuing the
      // insert and the supersede separately makes the insert COMMIT on its own,
      // at which point two ACTIVE rows exist and the constraint refuses with
      // "conflicting key value violates exclusion constraint". That is what an
      // earlier version of this file did, and replacing any attachment 500'd.
      //
      // Doing it as a single CTE keeps insert+supersede in one transaction, so
      // the exclusion is evaluated at the commit where the old row is already
      // retired.
      //
      // The supersede deliberately does NOT stamp voided_at/voided_by_user_id.
      // `attachment_void_consistent` reads
      //   (status = 'VOID' AND both NOT NULL) OR (status <> 'VOID' AND voided_at IS NULL)
      // so a SUPERSEDED row carrying a voided_at is itself a constraint
      // violation. Retirement is not erasure: SUPERSEDED is its own terminal
      // state, identified by superseded_by, and the audit row is what records
      // who retired it. Voiding is a separate, deliberate act.
      const r = await this.db.query<any>(
        `WITH f AS (
           INSERT INTO core.files (bucket, object_key, content_type, size_bytes, sha256, uploaded_by_user_id)
           VALUES ($1,$2,$3,$4,$5,$6::uuid)
           RETURNING id
         ), nxt AS (
           SELECT COALESCE(MAX(version),0) + 1 AS v
             FROM core.attachment_registry
            WHERE parent_type='pr' AND parent_id=$7::uuid AND name=$8
         ), ins AS (
           INSERT INTO core.attachment_registry
             (name, file_id, mime_type, size_bytes, kind, parent_type, parent_id,
              visibility, status, version, uploaded_by_user_id)
           SELECT $8, f.id, $3, $4, core.fn_attachment_kind($3), 'pr', $7::uuid,
                  'internal', 'ACTIVE', nxt.v, $6::uuid
             FROM f, nxt
           RETURNING id, version, status, kind
         ), sup AS (
           UPDATE core.attachment_registry a
              SET status='SUPERSEDED', superseded_by = ins.id
             FROM ins
            WHERE a.id = $9::uuid AND a.status = 'ACTIVE'
           RETURNING a.id
         )
         SELECT id, version, status, kind FROM ins`,
        [
          stored.bucket, stored.objectKey, mimeType || 'application/octet-stream',
          stored.size, stored.sha256, userId,
          prId, safe, prior.rows[0]?.id ?? null,
        ],
        { role, userId, costCenterIds },
      );
      const row = r.rows[0];
      if (!row) throw new BadRequestException('the attachment could not be recorded');

      if (prior.rows[0]) {
        await this.db.query(
          `INSERT INTO core.attachment_audit (attachment_id, action, actor_user_id, detail)
           VALUES ($1::uuid, 'SUPERSEDED', $2::uuid, $3::jsonb)`,
          [prior.rows[0].id, userId, JSON.stringify({ superseded_by: row.id })],
          { role, userId, costCenterIds },
        ).catch((e: any) => this.log.warn(`audit write failed (non-fatal): ${e?.message}`));
      }

      await this.db.query(
        `INSERT INTO core.attachment_audit (attachment_id, action, actor_user_id, detail)
         VALUES ($1::uuid, 'UPLOADED', $2::uuid, $3::jsonb)`,
        [row.id, userId, JSON.stringify({ name: safe, size: stored.size, object_key: stored.objectKey })],
        { role, userId, costCenterIds },
      ).catch((e: any) => this.log.warn(`audit write failed (non-fatal): ${e?.message}`));

      return {
        attachment_id: row.id,
        version: row.version,
        name: safe,
        // Report the kind the DATABASE derived via core.fn_attachment_kind($mime),
        // not a second mapping written here. Recomputing it in TypeScript would be
        // exactly the second source of truth that function exists to prevent.
        kind: row.kind,
        size_bytes: stored.size,
        sha256: stored.sha256,
        status: row.status,
        bucket: stored.bucket,
        object_key: stored.objectKey,
        superseded_id: prior.rows[0]?.id ?? null,
        limits_source: lim.sources[isImage ? 'imagePerFileBytes' : 'perFileBytes'],
      };
    } catch (e: any) {
      // The database refused — a parent that vanished, a per-PR ceiling crossed,
      // an unconfigured limit. Do not leave the bytes behind.
      await this.storage.remove(stored.objectKey).catch(() => undefined);
      throw AttachmentsService.translateDbError(e);
    }
  }

  /**
   * GET /attachments/:id/download — the ONLY way the bytes leave the server.
   *
   * DIRECTIVE 2 put the files on disk, which removes the database bloat but
   * creates the opposite risk: a storage directory that a web server will happily
   * serve as static files. So retrieval goes through here, where it can be
   * role-checked and recorded.
   *
   * Three things are enforced:
   *   - the caller must be allowed to read PRs at all
   *   - the path is re-resolved inside the storage root, so a tampered
   *     object_key cannot walk out of it
   *   - a DOWNLOADED row is appended to core.attachment_audit, so "who read this
   *     quotation" is answerable after the fact
   *
   * A SUPERSEDED version stays downloadable on purpose: replacing a quotation
   * must not make the version a buyer already read disappear.
   */
  async download(
    id: string, userId: string, role: string, costCenterIds: string[],
  ): Promise<{ stream: any; name: string; mimeType: string; size: number }> {
    if (!roleAllowed(role, 'procurement,hod,requester,cs')) {
      throw new ForbiddenException('You are not allowed to read purchase requisition attachments.');
    }

    const r = await this.db.query<any>(
      `SELECT a.id, a.name, a.mime_type, a.size_bytes, a.status, a.version,
              a.parent_type, a.parent_id, f.bucket, f.object_key, f.sha256
         FROM core.attachment_registry a
         JOIN core.files f ON f.id = a.file_id
        WHERE a.id = $1::uuid`,
      [id],
      { role, userId, costCenterIds },
    );
    if (r.rows.length === 0) throw new NotFoundException('no attachment with that id');
    const row = r.rows[0];
    if (row.status === 'VOID') {
      throw new NotFoundException('that attachment has been voided');
    }

    // absolute() re-checks containment and throws rather than escaping the root.
    const abs = this.storage.absolute(String(row.object_key));

    await this.db.query(
      `INSERT INTO core.attachment_audit (attachment_id, action, actor_user_id, detail)
       VALUES ($1::uuid, 'DOWNLOADED', $2::uuid, $3::jsonb)`,
      [id, userId, JSON.stringify({ name: row.name, version: row.version, object_key: row.object_key })],
      { role, userId, costCenterIds },
    ).catch((e: any) => this.log.warn(`audit write failed (non-fatal): ${e?.message}`));

    return {
      stream: createReadStream(abs),
      name: String(row.name),
      mimeType: String(row.mime_type || 'application/octet-stream'),
      size: Number(row.size_bytes),
    };
  }

  /** GET /pr/:id/attachments — the live set, with its version history. */
  async listForPr(prId: string, userId: string, role: string, costCenterIds: string[]) {
    const r = await this.db.query<any>(
      `SELECT a.id, a.name, a.mime_type, a.size_bytes, a.kind, a.status, a.version,
              a.visibility, a.uploaded_at, a.superseded_by, f.bucket, f.object_key, f.sha256
         FROM core.attachment_registry a
         JOIN core.files f ON f.id = a.file_id
        WHERE a.parent_type='pr' AND a.parent_id=$1::uuid
        ORDER BY a.name, a.version DESC`,
      [prId],
      { role, userId, costCenterIds },
    );
    const rows: any[] = r.rows;
    const active = rows.filter((x) => x.status === 'ACTIVE');
    return {
      storage: this.storage.describe(),
      totals: {
        count: active.length,
        bytes: active.reduce((a, x) => a + Number(x.size_bytes), 0),
      },
      attachments: rows,
    };
  }

  /** GET /attachments/limits — what is configured, and where it came from. */
  async limitsReport() {
    const lim = await this.limits.get();
    return { ...lim, storage: this.storage.describe() };
  }

  /**
   * POST /attachments/:id/void — retire a record without erasing history.
   *
   * A hard DELETE would break the audit chain this whole subsystem exists to
   * provide, so retirement sets the status and leaves the row.
   */
  async voidAttachment(id: string, userId: string, role: string, costCenterIds: string[], reason?: string) {
    if (!roleAllowed(role, 'procurement,hod,cs')) {
      throw new ForbiddenException('Only Procurement, HOD or CS may void an attachment.');
    }
    if (!reason || !String(reason).trim()) {
      throw new BadRequestException('A reason is required to void an attachment.');
    }
    const r = await this.db.query<any>(
      `UPDATE core.attachment_registry
          SET status='VOID', voided_by_user_id=$1::uuid, voided_at=now()
        WHERE id=$2::uuid AND status='ACTIVE'
        RETURNING id, name, status`,
      [userId, id],
      { role, userId, costCenterIds },
    );
    if (r.rows.length === 0) throw new NotFoundException('no ACTIVE attachment with that id');
    return { ...r.rows[0], reason };
  }
}
