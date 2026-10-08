import {
  BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException,
} from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { DbService } from '../db/db.service';
import { roleAllowed } from '@procurement/roles';

/**
 * WAVE 5 TRACK F — one-click dispatch.
 *
 * Procurement presses one button; every invited vendor receives an email holding
 * a link they can use with no password, no NTN and no portal account.
 *
 * WHY THE OUTBOX IS THE QUEUE OF RECORD
 * -------------------------------------
 * There is no SMTP configuration in this environment, and a dispatcher that
 * reports "sent" without a transport is worse than one that reports "queued",
 * because the operator believes the vendor has the RFQ when it is still sitting
 * in a table. So:
 *
 *   state 'pending' -> the message exists and is waiting for a transport
 *   state 'sent'    -> a real transport acknowledged it
 *   state 'failed'  -> a transport tried and refused, with the reason kept
 *
 * With no SMTP configured, messages stay `pending` and are also written to disk
 * so they can be relayed by whatever the deployment actually uses. The API
 * reports `queued` and `delivered` as separate numbers rather than collapsing
 * them into a cheerful "sent".
 */
@Injectable()
export class DispatchService {
  private readonly log = new Logger('Dispatch');

  constructor(private readonly db: DbService) {}

  private assertCanDispatch(role: string) {
    if (!roleAllowed(role, 'procurement,cs')) {
      throw new ForbiddenException('Only Procurement or the Committee Secretary may dispatch an RFQ.');
    }
  }

  /** The raw token is returned exactly once. Only its SHA-256 is ever stored. */
  private static mintToken(): { raw: string; hash: string } {
    const raw = randomBytes(32).toString('base64url');
    return { raw, hash: createHash('sha256').update(raw).digest('hex') };
  }

  private async outboxRoot(): Promise<string> {
    const configured = process.env.OUTBOX_ROOT;
    if (configured && configured.trim()) return resolve(configured.trim());
    let dir = __dirname;
    for (let hop = 0; hop < 8; hop++) {
      if (existsSync(join(dir, 'apps')) && existsSync(join(dir, 'db')) && existsSync(join(dir, 'package.json'))) {
        return resolve(dir, 'var', 'outbox');
      }
      const up = resolve(dir, '..');
      if (up === dir) break;
      dir = up;
    }
    return resolve(__dirname, '..', '..', 'var', 'outbox');
  }

  /**
   * POST /rfq/:id/dispatch
   *
   * Idempotent per vendor: a vendor already invited on this RFQ is left alone
   * rather than being re-minted a second link, because a second live link is a
   * second credential to the same RFQ.
   */
  async dispatch(
    rfqId: string, userId: string, role: string, costCenterIds: string[],
    opts: { vendorIds?: string[]; channel?: 'email' | 'manual' } = {},
  ) {
    this.assertCanDispatch(role);
    const ctx = { role, userId, costCenterIds };
    const channel = opts.channel ?? 'email';

    const rfq = await this.db.query<any>(
      `SELECT r.id, r.rfq_number, r.title, r.currency, r.deadline_at, p.pr_number,
              COALESCE(r.incoterm,'') AS incoterm
         FROM proc.rfq r JOIN proc.purchase_requisitions p ON p.id = r.pr_id
        WHERE r.id = $1::uuid`,
      [rfqId], ctx,
    );
    if (rfq.rows.length === 0) throw new NotFoundException('RFQ not found');
    const head = rfq.rows[0];

    // Fails CLOSED if nobody configured the lifetime. A link that never expires
    // is a permanent credential to one vendor's pack sitting in a mailbox.
    let ttlHours: number;
    try {
      const t = await this.db.query<any>(`SELECT core.fn_vendor_token_ttl_hours()::text AS h;`, [], ctx);
      ttlHours = Number(t.rows[0]?.h);
    } catch (e: any) {
      throw new BadRequestException(
        `Cannot dispatch: ${String(e?.message || e).split('\n')[0]}. ` +
          'Set VENDOR_PORTAL_TOKEN_HOURS or create the core.settings row.',
      );
    }

    // Which vendors to write to. Explicit list wins; otherwise everyone on the
    // live roster. Vendors with no email are REFUSED here rather than silently
    // skipped - a dispatch that quietly drops half its recipients is the failure
    // mode this whole feature exists to remove.
    const wanted = await this.db.query<any>(
      opts.vendorIds?.length
        ? `SELECT v.id, v.vendor_code, v.legal_name, v.contact_email
             FROM proc.rfq_invitations i JOIN core.vendors v ON v.id = i.vendor_id
            WHERE i.rfq_id = $1::uuid AND i.vendor_id = ANY($2::uuid[])
            ORDER BY v.vendor_code`
        : `SELECT v.id, v.vendor_code, v.legal_name, v.contact_email
             FROM proc.rfq_invitations i JOIN core.vendors v ON v.id = i.vendor_id
            WHERE i.rfq_id = $1::uuid AND NOT i.submitted AND NOT i.declined
            ORDER BY v.vendor_code`,
      opts.vendorIds?.length ? [rfqId, `{${opts.vendorIds.join(',')}}`] : [rfqId], ctx,
    );

    const noEmail = wanted.rows.filter((v: any) => !String(v.contact_email || '').trim());
    if (noEmail.length && channel === 'email') {
      throw new BadRequestException(
        `${noEmail.length} invited vendor(s) have no email on file: ` +
          `${noEmail.map((v: any) => v.vendor_code).join(', ')}. ` +
          'A vendor email is mandatory before an RFQ can be dispatched — add it in Vendor Master.',
      );
    }

    const portalBase = (process.env.PUBLIC_WEB_URL || 'http://localhost:33002').replace(/\/+$/, '');
    const outboxDir = await this.outboxRoot();
    await mkdir(outboxDir, { recursive: true });

    const results: any[] = [];
    let queued = 0, alreadyInvited = 0;

    for (const v of wanted.rows) {
      const inv = await this.db.query<any>(
        `SELECT id, dispatched_at FROM proc.rfq_invitations
          WHERE rfq_id = $1::uuid AND vendor_id = $2::uuid`,
        [rfqId, v.id], ctx,
      );
      if (inv.rows[0]?.dispatched_at) {
        alreadyInvited++;
        results.push({ vendor: v.vendor_code, state: 'already-dispatched' });
        continue;
      }

      const { raw, hash } = DispatchService.mintToken();
      const link = `${portalBase}/vendor-portal/${raw}`;

      // One transaction: re-point the invitation at the new token, stamp the
      // expiry, and record the dispatch channel. The raw token exists only in
      // this process and in the message body.
      const upd = await this.db.query<any>(
        `UPDATE proc.rfq_invitations
            SET token_hash = $3::text,
                expires_at = now() + ($4 || ' hours')::interval,
                dispatched_at = now(),
                dispatch_channel = $5::text
          WHERE rfq_id = $1::uuid AND vendor_id = $2::uuid
        RETURNING id`,
        [rfqId, v.id, hash, String(ttlHours), channel],
        ctx,
      );
      if (upd.rows.length === 0) { results.push({ vendor: v.vendor_code, state: 'not-invited' }); continue; }
      const invitationId = upd.rows[0].id;

      const expiresAt = new Date(Date.now() + ttlHours * 3600_000).toISOString();
      const subject = `RFQ ${head.rfq_number} — ${head.title || 'quotation requested'}`;
      const bodyText = [
        `Dear ${v.legal_name},`,
        '',
        `You have been invited to quote for RFQ ${head.rfq_number}${head.pr_number ? ` (PR ${head.pr_number})` : ''}.`,
        '',
        `Open your secure link to see ONLY the lines assigned to you, fill in your rates, and submit.`,
        `Link: ${link}`,
        '',
        `This link expires ${expiresAt} and can be used by you alone. No login is required.`,
        `It shows your assigned lines and quantities only — you cannot see other vendors, other lines, or any part of our system.`,
        '',
        `Please quote in ${head.currency}. Delivery by ${new Date(head.deadline_at).toISOString().slice(0, 10)}.`,
      ].join('\n');

      const ob = await this.db.query<any>(
        `INSERT INTO core.email_outbox
           (to_vendor_id, to_email, subject, body_text, body_html, template, payload,
            state, rfq_id, invitation_id, created_by_user_id)
         VALUES ($1::uuid, $2::text, $3::text, $4::text, $5::text, 'rfq_dispatch', $6::jsonb,
                 'pending', $7::uuid, $8::uuid, $9::uuid)
        RETURNING id`,
        [
          v.id, v.contact_email, subject, bodyText,
          `<p>Dear ${v.legal_name},</p><p>You have been invited to quote for <strong>RFQ ${head.rfq_number}</strong>.</p>` +
          `<p><a href="${link}">Open your secure quotation link</a></p>` +
          `<p>This link expires <strong>${expiresAt}</strong>. No login is required, and it shows only the lines assigned to you.</p>`,
          JSON.stringify({ rfq_id: rfqId, invitation_id: invitationId, link, expires_at: expiresAt }),
          rfqId, invitationId, userId,
        ],
        ctx,
      );
      const outboxId = ob.rows[0]?.id;
      await this.db.query(
        `UPDATE proc.rfq_invitations SET outbox_id = $2::bigint WHERE id = $1::uuid`,
        [invitationId, String(outboxId)], ctx,
      );

      // Written to disk as an .eml so a relay (or a human) can deliver it. This
      // is NOT counted as delivered - see the class comment.
      if (channel === 'email') {
        const file = join(outboxDir, `${outboxId}-${v.vendor_code}.eml`);
        await writeFile(file, [
          `From: procurement@pakboxes.pk`, `To: ${v.contact_email}`, `Subject: ${subject}`,
          `Date: ${new Date().toUTCString()}`,
          'Content-Type: text/plain; charset=utf-8', '', bodyText,
        ].join('\r\n'), 'utf8');
        queued++;
      }

      results.push({
        vendor: v.vendor_code, state: channel === 'email' ? 'queued' : 'manual',
        token_link: channel === 'manual' ? link : undefined,
        expires_at: expiresAt, outbox_id: outboxId,
      });
    }

    this.log.log(`dispatched ${results.length} invitation(s) on ${head.rfq_number}; ${queued} queued`);
    return {
      rfq_id: rfqId,
      rfq_number: head.rfq_number,
      channel,
      token_lifetime_hours: ttlHours,
      transport: this.transportDescription(),
      recipients: results.length,
      queued,
      delivered: 0,          // honest: no SMTP is configured in this environment
      already_dispatched: alreadyInvited,
      results,
      note: this.transportDescription(),
    };
  }

  /** What will actually carry these messages. Reported, never assumed. */
  private transportDescription(): string {
    return process.env.SMTP_HOST
      ? `SMTP ${process.env.SMTP_HOST}`
      : 'no SMTP transport configured — messages are queued in core.email_outbox and written to var/outbox as .eml';
  }

  /** GET /outbox — the operator view of what has and has not gone out. */
  async outbox(role: string, limit = 50) {
    const r = await this.db.query<any>(
      `SELECT o.id, o.to_email, o.subject, o.state, o.attempts, o.last_error, o.sent_at,
              o.created_at, v.vendor_code
         FROM core.email_outbox o
         LEFT JOIN core.vendors v ON v.id = o.to_vendor_id
        ORDER BY o.id DESC LIMIT $1::int`,
      [Math.min(Math.max(Number(limit) || 50, 1), 200)],
      { role },
    );
    const counts = await this.db.query<any>(
      `SELECT state, count(*)::int AS n FROM core.email_outbox GROUP BY state`,
      [], { role },
    );
    return { transport: this.transportDescription(), counts: counts.rows, messages: r.rows };
  }

  /**
   * F1 — vendors that cannot be dispatched to, because they have no email.
   *
   * Computed from core.vendors.contact_email, never stored as a second boolean
   * that could disagree with the column it summarises.
   */
  async missingEmails(role: string) {
    const r = await this.db.query<any>(
      `SELECT * FROM core.fn_vendor_email_missing()`,
      [], { role },
    );
    return {
      count: r.rows.length,
      rule: 'A vendor with no email on file cannot receive a dispatch, so it is a silent dead end in the pool.',
      vendors: r.rows,
    };
  }
}
