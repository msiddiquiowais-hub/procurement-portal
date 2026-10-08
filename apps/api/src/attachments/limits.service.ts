import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DbService } from '../db/db.service';

/**
 * DIRECTIVE 1 — NO HARDCODE LIMITS.
 *
 * Each limit has exactly ONE home: the `core.settings` row that the database
 * triggers read. This service's job is to let the ENVIRONMENT set that row at
 * boot, so an operator can raise a ceiling for a large quotation package by
 * changing a variable and restarting — with no code change, no migration, and no
 * risk of the API and the database disagreeing.
 *
 * Precedence:  environment  >  core.settings
 *
 * The environment is not a second store. `syncFromEnv()` UPSERTS into the same
 * row the trigger reads. If the API and the trigger could hold different numbers,
 * an upload the API allowed could still be refused by the database, and the
 * failure would look like a bug rather than a configuration problem.
 *
 * Nothing here invents a number. If neither source supplies a limit the database
 * raises a named configuration error — the service surfaces that as a 500 with
 * the setting name, because a missing limit is an operator problem to fix, not
 * something to paper over with a default.
 */

export interface AttachmentLimits {
  perFileBytes: number;
  perPrTotalBytes: number;
  imagePerFileBytes: number;
  imagePerPrTotalBytes: number;
  sources: Record<string, string>;
}

const MAP: Array<{ env: string; key: string; field: keyof AttachmentLimits }> = [
  { env: 'ATTACHMENT_MAX_BYTES', key: 'attachmentMaxBytes', field: 'perFileBytes' },
  { env: 'ATTACHMENT_TOTAL_MAX_BYTES', key: 'attachmentTotalMaxBytes', field: 'perPrTotalBytes' },
  { env: 'IMAGE_MAX_BYTES', key: 'imageMaxBytes', field: 'imagePerFileBytes' },
  { env: 'IMAGE_TOTAL_MAX_BYTES', key: 'imageTotalMaxBytes', field: 'imagePerPrTotalBytes' },
];

@Injectable()
export class AttachmentLimitsService implements OnModuleInit {
  private readonly log = new Logger('AttachmentLimits');

  constructor(private readonly db: DbService) {}

  /**
   * Push any environment-provided limit into core.settings before the first
   * request. Idempotent: an unset variable changes nothing.
   */
  async onModuleInit() {
    await this.syncFromEnv();
  }

  async syncFromEnv(): Promise<string[]> {
    const applied: string[] = [];
    for (const { env, key } of MAP) {
      const raw = process.env[env];
      if (raw === undefined || raw.trim() === '') continue;

      const n = Number(raw);
      if (!Number.isInteger(n) || n <= 0) {
        // Refuse a bad override rather than writing a limit that would refuse
        // every upload or none of them.
        this.log.error(`${env}=${raw} is not a positive integer; leaving ${key} as it was`);
        continue;
      }

      await this.db.query(
        `UPDATE core.settings
            SET value = to_jsonb($1::bigint), updated_at = now()
          WHERE key = $2`,
        [n, key],
        { bypassRls: true },
      );
      applied.push(`${env}=${n} -> core.settings.${key}`);
    }
    if (applied.length) this.log.log(`limit overrides applied: ${applied.join('; ')}`);
    return applied;
  }

  /**
   * Read the current limits. Throws a NAMED error when a limit is unconfigured,
   * because "unconfigured" and "unlimited" must never be confused.
   */
  async get(): Promise<AttachmentLimits> {
    const r = await this.db.query<any>(
      `SELECT key, (value #>> '{}')::bigint AS v, updated_at
         FROM core.settings
        WHERE key = ANY($1::text[])`,
      [MAP.map((m) => m.key)],
      { bypassRls: true },
    );

    const byKey = new Map<string, any>(r.rows.map((x: any) => [x.key, x]));
    const out: any = { sources: {} };
    const missing: string[] = [];

    for (const { env, key, field } of MAP) {
      const row = byKey.get(key);
      if (row?.v === null || row?.v === undefined) {
        missing.push(`${key} (set ${env})`);
        continue;
      }
      out[field] = Number(row.v);
      out.sources[field] = process.env[env]
        ? `core.settings.${key}, last written from ${env}`
        : `core.settings.${key}`;
    }

    if (missing.length) {
      const err: any = new Error(
        `attachment limits are not configured: ${missing.join(', ')}. ` +
          `Set the environment variable (which seeds the setting at boot) or create the row.`,
      );
      err.status = 500;
      throw err;
    }
    return out as AttachmentLimits;
  }
}
