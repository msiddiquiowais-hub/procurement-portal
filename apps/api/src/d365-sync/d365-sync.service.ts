// ═══════════════════════════════════════════════════════════════════════════
// Wave 5 Track H — D365 F&O master-data sync.
//
// WHAT THIS IS
//
// Three F&O entity sets, pulled over OData v4 and upserted into the
// `core.d365_*` cache tables created by migration 042:
//
//   OMOperatingUnits          -> core.d365_operating_units
//   HcmWorkers                -> core.d365_workers
//   FinancialDimensionValues  -> core.d365_financial_dimension_values
//
// These are CACHES of D365-owned data, not local truth. Nothing else in this
// application may write them, and this file is the only writer.
//
// FIVE RULES THIS FILE EXISTS TO ENFORCE
//
// 1. STUB MODE MAKES NO NETWORK CALL. `D365_MODE` is anything other than the
//    literal word `live` (case-insensitively) is stub, so a typo in the
//    environment can never open the network path by accident. A stub sync
//    returns a labelled "nothing was read" result and writes NO rows. It also
//    writes NO audit row: a `d365_master_sync` entry in the append-only,
//    hash-chained audit log would assert that master data was reconciled with
//    F&O when no connection existed. A live sync that reads ZERO rows IS
//    audited, because that is a real observation an operator must see.
//
// 2. PAGING IS NOT OPTIONAL. `readAll` follows @odata.nextLink to exhaustion.
//    A truncated read (maxPages hit) is reported as `ok: false` with the
//    truncation stated in `message` — a truncated sync that reports success is
//    a silent data-loss bug, and the cache would then look complete.
//
// 3. NOTHING IS DELETED. A row D365 stops returning is counted as `vanished`
//    and left in place. F&O filtering (the $filter on each query, a legal
//    entity de-activating, a dimension value being retired) is not proof the
//    record is gone, and deleting a cached operating unit would break every
//    historical reference to it.
//
// 4. NOTHING IS INVENTED. A field missing from an F&O row is stored as NULL.
//    No defaults, no placeholders, no guessed names. Where the schema makes
//    NULL impossible (a NOT NULL primary key, NOT NULL `name`, NOT NULL
//    `active`) the row is NOT written and is counted as `skipped` with the
//    reason in the message — because writing it would mean inventing a value.
//
// 5. EVERY VALUE IS BOUND. Table and column names are compile-time constants
//    on the TARGETS below; every datum from F&O is a $N parameter, which
//    DbService literalises with quote escaping.
// ═══════════════════════════════════════════════════════════════════════════

import { ForbiddenException, Injectable } from '@nestjs/common';
import { DbService } from '../db/db.service';
import { roleAllowed } from '@procurement/roles';
import {
  D365_ENTITY_SETS, D365_QUERIES, D365ConfigError, EntraTokenProvider,
  ODataClient, missingConfig,
} from '@procurement/d365-client';

// Lowercase, matching `core.users.role` as stored and constrained. This list
// was capitalized ('CS,Procurement,...'), so it matched no real user and every
// sync call 403'd. There is no 'Manager' role; the managerial values are
// procurement_manager, department_manager and management.
const SYNC_ROLES = 'cs,procurement,procurement_manager,management,admin';

/**
 * Page ceiling for one `readAll` walk. F&O commonly caps a page at 1000
 * records, so 100 pages is ~100k rows — comfortably above any real operating
 * unit, worker or dimension list, and low enough that a runaway nextLink loop
 * terminates.
 */
const SYNC_MAX_PAGES = 100;

/**
 * Rows per upsert statement.
 *
 * Not a style choice: DbService spawns one `psql` process PER QUERY, so a
 * per-row upsert of a few thousand workers would mean a few thousand process
 * spawns. One multi-row statement per chunk keeps the sync to a handful.
 */
const UPSERT_CHUNK = 200;

type Ctx = { userId: string; role: string; costCenterIds: string[] };

export type SyncSummary = {
  ok: boolean;
  mode: 'stub' | 'live';
  entity_set: string;
  read: number;
  upserted: number;
  vanished: number;
  pages: number;
  truncated: boolean;
  message: string;
  /**
   * Rows F&O returned that were NOT written, because a NOT NULL column could
   * not be filled without inventing a value. Always 0 against a healthy F&O.
   */
  skipped: number;
};

type Mapped =
  | { ok: true; values: any[]; keys: string[] }
  | { ok: false; reason: string };

/**
 * One cache table, described entirely by compile-time constants.
 *
 * `columns` / `conflict` / `updates` / `vanishedSql` are string literals in this
 * file — never derived from a request or from F&O — so the only thing
 * interpolated into a statement is an identifier this codebase already chose.
 * All row data travels as bound parameters.
 */
type Target = {
  entitySet: string;
  query: string;
  /** The cache table this target writes. A compile-time constant. */
  table: string;
  /** The audit `entity`, mirroring how po.service names `proc.purchase_orders`. */
  auditEntity: string;
  columns: string[];
  conflict: string;
  /** ON CONFLICT DO UPDATE SET, with `synced_at = now()` in every case. */
  updates: string;
  vanishedSql: string;
  map: (row: any) => Mapped;
  vanishedParams: (mapped: Mapped[]) => any[];
};

const TARGETS: Record<'operatingUnits' | 'workers' | 'dimensionValues', Target> = {
  // ── OMOperatingUnits -> core.d365_operating_units ────────────────────────
  operatingUnits: {
    entitySet: D365_ENTITY_SETS.operatingUnits,
    query: D365_QUERIES.operatingUnits,
    table: 'core.d365_operating_units',
    auditEntity: 'core.d365_operating_units',
    columns: [
      'd365_operating_unit_id', 'operating_unit_type', 'name',
      'description', 'row_version',
    ],
    conflict: 'd365_operating_unit_id',
    updates: `operating_unit_type = EXCLUDED.operating_unit_type,
                name                 = EXCLUDED.name,
                description          = EXCLUDED.description,
                row_version          = EXCLUDED.row_version,
                synced_at            = now()`,
    vanishedSql: `SELECT count(*)::int AS vanished
                    FROM core.d365_operating_units
                   WHERE NOT (d365_operating_unit_id = ANY($1::text[]))`,
    map: (row) => {
      const id = text(row?.OMOperatingUnitId);
      if (id === null) return { ok: false, reason: 'OMOperatingUnitId' };
      // `name` is NOT NULL. F&O omitting it is not a licence to invent one.
      const name = text(row?.Name);
      if (name === null) return { ok: false, reason: 'Name' };
      return {
        ok: true,
        values: [id, text(row?.OperatingUnitType), name, text(row?.Description), text(row?.RowVersion)],
        keys: [id],
      };
    },
    vanishedParams: (mapped) => [mapped.map((m) => (m.ok ? m.keys[0] : ''))],
  },

  // ── HcmWorkers -> core.d365_workers ──────────────────────────────────────
  workers: {
    entitySet: D365_ENTITY_SETS.workers,
    query: D365_QUERIES.workers,
    table: 'core.d365_workers',
    auditEntity: 'core.d365_workers',
    columns: [
      'd365_worker_id', 'worker_number', 'name', 'email',
      'department_id', 'employment_status', 'row_version',
    ],
    conflict: 'd365_worker_id',
    updates: `worker_number     = EXCLUDED.worker_number,
                name              = EXCLUDED.name,
                email             = EXCLUDED.email,
                department_id     = EXCLUDED.department_id,
                employment_status = EXCLUDED.employment_status,
                row_version       = EXCLUDED.row_version,
                synced_at         = now()`,
    vanishedSql: `SELECT count(*)::int AS vanished
                    FROM core.d365_workers
                   WHERE NOT (d365_worker_id = ANY($1::text[]))`,
    map: (row) => {
      const id = text(row?.HcmWorkerId);
      if (id === null) return { ok: false, reason: 'HcmWorkerId' };
      const name = text(row?.Name);
      if (name === null) return { ok: false, reason: 'Name' };
      return {
        ok: true,
        values: [
          id, text(row?.WorkerNumber), name, text(row?.Email),
          text(row?.DepartmentId), text(row?.EmploymentStatus), text(row?.RowVersion),
        ],
        keys: [id],
      };
    },
    vanishedParams: (mapped) => [mapped.map((m) => (m.ok ? m.keys[0] : ''))],
  },

  // ── FinancialDimensionValues -> core.d365_financial_dimension_values ────
  //
  // The key is COMPOSITE (dimension_type, dimension_value), which is why the
  // vanished query matches with unnest over two parallel arrays rather than a
  // single key list — no encoding, so no separator can collide with a real
  // value.
  dimensionValues: {
    entitySet: D365_ENTITY_SETS.dimensionValues,
    query: D365_QUERIES.dimensionValues,
    table: 'core.d365_financial_dimension_values',
    auditEntity: 'core.d365_financial_dimension_values',
    columns: ['dimension_type', 'dimension_value', 'display_name', 'active', 'row_version'],
    conflict: 'dimension_type, dimension_value',
    updates: `display_name = EXCLUDED.display_name,
                active       = EXCLUDED.active,
                row_version  = EXCLUDED.row_version,
                synced_at    = now()`,
    vanishedSql: `SELECT count(*)::int AS vanished
                    FROM core.d365_financial_dimension_values t
                   WHERE NOT EXISTS (
                     SELECT 1
                       FROM unnest($1::text[], $2::text[])
                            AS s(dimension_type, dimension_value)
                      WHERE s.dimension_type  = t.dimension_type
                        AND s.dimension_value = t.dimension_value)`,
    map: (row) => {
      const type = text(row?.FinancialDimensionType);
      if (type === null) return { ok: false, reason: 'FinancialDimensionType' };
      const value = text(row?.FinancialDimensionValue);
      if (value === null) return { ok: false, reason: 'FinancialDimensionValue' };
      // `active` is NOT NULL, so an ABSENT Active cannot be stored as null and
      // must not be defaulted to true. The row is skipped and reported instead.
      const active = flag(row?.Active);
      if (active === null) return { ok: false, reason: 'Active' };
      return {
        ok: true,
        values: [type, value, text(row?.Name), active, text(row?.RowVersion)],
        keys: [type, value],
      };
    },
    vanishedParams: (mapped) => [
      mapped.map((m) => (m.ok ? m.keys[0] : '')),
      mapped.map((m) => (m.ok ? m.keys[1] : '')),
    ],
  },
};

/** A F&O scalar as text, or NULL when the field is absent. Never defaulted. */
function text(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'object') return null;
  return String(v);
}

/**
 * F&O's Edm.Boolean arrives as `true`, or as a string on some projections.
 * 'No' / 'false' / 0 / '0' are false; anything else PRESENT is true. Absent is
 * null — the caller decides, because `active` is NOT NULL.
 */
function flag(v: unknown): boolean | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v !== 0 : null;
  const s = String(v).trim().toLowerCase();
  if (s === '') return null;
  return !['no', 'false', 'f', '0', 'off'].includes(s);
}

@Injectable()
export class D365SyncService {
  constructor(private readonly db: DbService) {}

  // ── POST /d365/sync/operating-units ─────────────────────────────────────

  async syncOperatingUnits(userId: string, role: string, costCenterIds: string[]) {
    return this.run(TARGETS.operatingUnits, userId, role, costCenterIds);
  }

  // ── POST /d365/sync/workers ─────────────────────────────────────────────

  async syncWorkers(userId: string, role: string, costCenterIds: string[]) {
    return this.run(TARGETS.workers, userId, role, costCenterIds);
  }

  // ── POST /d365/sync/dimensions ──────────────────────────────────────────

  async syncDimensionValues(userId: string, role: string, costCenterIds: string[]) {
    return this.run(TARGETS.dimensionValues, userId, role, costCenterIds);
  }

  // ── GET /d365/sync/status ───────────────────────────────────────────────

  /**
   * What is in each cache, and when it was last refreshed. Read-only, and
   * deliberately NOT role-gated beyond authentication: it is a health view
   * over row counts and timestamps, and it has to answer in stub mode too —
   * that is precisely when an operator needs to ask "is anything here?".
   */
  async status(userId: string, role: string, costCenterIds: string[]) {
    const ctx: Ctx = { userId, role, costCenterIds };
    const mode = this.mode();

    const counts = await this.db.query<any>(
      `SELECT 'core.d365_operating_units' AS cache, count(*)::int AS row_count,
              max(synced_at) AS last_synced_at
         FROM core.d365_operating_units
        UNION ALL
       SELECT 'core.d365_workers', count(*)::int, max(synced_at)
         FROM core.d365_workers
        UNION ALL
       SELECT 'core.d365_financial_dimension_values', count(*)::int, max(synced_at)
         FROM core.d365_financial_dimension_values`,
      [], ctx,
    );

    const tables: Record<string, { rows: number; last_synced_at: string | null }> = {};
    for (const r of counts.rows) {
      tables[r.cache] = {
        rows: Number(r.row_count ?? 0),
        last_synced_at: r.last_synced_at ?? null,
      };
    }

    return {
      mode,
      // In stub mode a connection is NOT configured, so the master-data caches
      // cannot be refreshed at all. Saying so beats reporting zero missing
      // variables and letting a reader assume the ERP is simply empty.
      configured: mode === 'live'
        ? true
        : 'No D365 connection configured — set D365_MODE=live with D365_BASE_URL, ' +
          'D365_TENANT_ID, D365_CLIENT_ID and D365_CLIENT_SECRET to sync master data.',
      company: process.env.D365_COMPANY || 'PKE',
      base_url: mode === 'live' ? (process.env.D365_BASE_URL ?? null) : null,
      entity_sets: {
        operating_units: D365_ENTITY_SETS.operatingUnits,
        workers: D365_ENTITY_SETS.workers,
        dimension_values: D365_ENTITY_SETS.dimensionValues,
      },
      tables,
      total_rows: Object.values(tables).reduce((n, t) => n + t.rows, 0),
      max_pages: SYNC_MAX_PAGES,
    };
  }

  // ── internals ───────────────────────────────────────────────────────────

  private async run(
    target: Target, userId: string, role: string, costCenterIds: string[],
  ): Promise<SyncSummary> {
    if (!roleAllowed(role, SYNC_ROLES)) {
      throw new ForbiddenException(
        'Only CS, Procurement, a Procurement Manager, Management or an Admin can sync D365 master data.',
      );
    }
    const ctx: Ctx = { userId, role, costCenterIds };
    const mode = this.mode();

    // ── STUB: stop here. No client is constructed, so no socket is opened. ──
    if (mode === 'stub') {
      return {
        ok: true,
        mode: 'stub',
        entity_set: target.entitySet,
        read: 0,
        upserted: 0,
        vanished: 0,
        pages: 0,
        truncated: false,
        skipped: 0,
        message:
          'STUB MODE: no D365 connection is configured, so nothing was read from ' +
          `F&O and nothing was written to ${target.auditEntity}. ` +
          'These rows were not invented. Set D365_MODE=live with credentials to sync.',
      };
    }

    // ── the network read, OUTSIDE the transaction ──────────────────────────
    // A live read that fails must not leave a half-written cache, and a slow
    // F&O must not hold a transaction open.
    const cfg = this.config();
    const missing = missingConfig({
      tenantId: cfg.tenantId, clientId: cfg.clientId,
      clientSecret: cfg.clientSecret, resourceUrl: cfg.baseUrl,
    });
    if (missing.length > 0) throw new D365ConfigError(missing);

    // An empty `missing` already means the base URL is present, but TypeScript
    // cannot narrow through an array check, and `ODataClient` requires a
    // non-optional `baseUrl`. Stated once, here, rather than with a `!` that
    // would hide a genuine misconfiguration.
    const baseUrl = cfg.baseUrl;
    if (!baseUrl) throw new D365ConfigError(['D365_BASE_URL']);

    const tokens = new EntraTokenProvider({
      tenantId: cfg.tenantId,
      clientId: cfg.clientId,
      clientSecret: cfg.clientSecret,
      resourceUrl: baseUrl,
    });
    const odata = new ODataClient({
      baseUrl,
      company: cfg.company,
      tokens,
    });

    const read = await odata.readAll<any>(target.entitySet, target.query, {
      maxPages: SYNC_MAX_PAGES,
    });

    const mapped: Mapped[] = read.rows.map((row) => target.map(row));
    const writable = mapped.filter((m): m is Extract<Mapped, { ok: true }> => m.ok);
    const skipReasons = new Set(
      mapped.filter((m) => !m.ok).map((m) => (m as Extract<Mapped, { ok: false }>).reason),
    );

    // ── the write, inside one transaction ─────────────────────────────────
    const counts = await this.db.withTransaction(ctx, async (run) => {
      let upserted = 0;
      for (let i = 0; i < writable.length; i += UPSERT_CHUNK) {
        const chunk = writable.slice(i, i + UPSERT_CHUNK);
        const res = await run<{ touched: number }>(this.upsertSql(target, chunk.length), [
          ...chunk.flatMap((m) => m.values),
        ]);
        // Counted from RETURNING, not from rowCount: DbService shells out to
        // `psql -q`, which prints no command tag, so rowCount is not a
        // reliable statement result here.
        upserted += res.rows.length;
      }

      const vanishedRes = await run<{ vanished: number }>(
        target.vanishedSql, target.vanishedParams(writable),
      );
      const vanished = Number(vanishedRes.rows[0]?.vanished ?? 0);

      // ONE audit row per completed sync — including a sync that read nothing.
      // `audit.audit_log` is append-only under a hash chain: this file INSERTs
      // and never UPDATEs or DELETEs an audit row.
      const skipped = mapped.length - writable.length;
      await run(
        `INSERT INTO audit.audit_log (actor_user_id, entity, entity_id, action, after)
         VALUES ($1::uuid, $2, $3, 'd365_master_sync', $4::jsonb)`,
        [
          userId, target.auditEntity, target.entitySet,
          JSON.stringify({
            entity_set: target.entitySet,
            read: read.rows.length,
            upserted,
            vanished,
            pages: read.pages,
            truncated: read.truncated,
            skipped,
            skipped_fields: [...skipReasons],
            max_pages: SYNC_MAX_PAGES,
          }),
        ],
      );

      return { upserted, vanished, skipped };
    });

    const summary: SyncSummary = {
      ok: !read.truncated,
      mode: 'live',
      entity_set: target.entitySet,
      read: read.rows.length,
      upserted: counts.upserted,
      vanished: counts.vanished,
      pages: read.pages,
      truncated: read.truncated,
      skipped: counts.skipped,
      message: this.message(target, {
        read: read.rows.length,
        upserted: counts.upserted,
        vanished: counts.vanished,
        pages: read.pages,
        truncated: read.truncated,
        skipped: counts.skipped,
        skipReasons: [...skipReasons],
      }),
    };
    return summary;
  }

  /**
   * One multi-row upsert. The only interpolated text is the target's own table
   * and column names — all compile-time constants on TARGETS — plus `$n`
   * placeholders generated here. Every value from F&O is a bound parameter.
   */
  private upsertSql(target: Target, rowCount: number): string {
    const width = target.columns.length;
    const tuples: string[] = [];
    for (let r = 0; r < rowCount; r++) {
      const slots: string[] = [];
      for (let c = 0; c < width; c++) slots.push(`$${r * width + c + 1}`);
      tuples.push(`(${slots.join(', ')})`);
    }
    return `INSERT INTO ${target.table} (${target.columns.join(', ')}, synced_at)
            VALUES ${tuples.join(', ')}
        ON CONFLICT (${target.conflict}) DO UPDATE SET ${target.updates}
        RETURNING 1 AS touched`;
  }

  private message(
    target: Target,
    s: {
      read: number; upserted: number; vanished: number; pages: number;
      truncated: boolean; skipped: number; skipReasons: string[];
    },
  ): string {
    const parts: string[] = [];

    // Loudest first. A truncated read is the one result that must never look
    // like a complete one.
    if (s.truncated) {
      parts.push(
        `TRUNCATED: the read stopped at the ${s.pages}-page ceiling, so this is ` +
        'NOT the whole entity set and the cache is INCOMPLETE. Re-run with a ' +
        'higher maxPages, or narrow the $filter.',
      );
    }
    if (s.read === 0) {
      parts.push(
        'D365 returned 0 rows. Nothing was written. If this entity set is not ' +
        'genuinely empty in F&O, treat this as a failed sync, not a clean one.',
      );
    }
    if (s.skipped > 0) {
      parts.push(
        `${s.skipped} row(s) were read but NOT written because a NOT NULL ` +
        `column was absent (${s.skipReasons.join(', ')}). They were skipped ` +
        'rather than filled with a default.',
      );
    }
    if (s.vanished > 0) {
      parts.push(
        `${s.vanished} cached row(s) were not returned by D365 and were left ` +
        'untouched — they are reported, never deleted. A $filter or a F&O-side ' +
        'deactivation hides a record just as effectively as deleting it.',
      );
    }
    if (parts.length === 0) {
      parts.push(
        `Synced ${s.upserted} of ${s.read} row(s) from ${target.entitySet} ` +
        `across ${s.pages} page(s).`,
      );
    }
    return parts.join(' ');
  }

  /**
   * 'live' only when D365_MODE says exactly that (case-insensitively).
   *
   * Anything else — unset, `stub`, or a typo like `lve` — is stub. A
   * misconfigured deployment must not open a network path it cannot service.
   */
  private mode(): 'stub' | 'live' {
    return String(process.env.D365_MODE || 'stub').trim().toLowerCase() === 'live'
      ? 'live' : 'stub';
  }

  private config() {
    return {
      baseUrl: process.env.D365_BASE_URL,
      tenantId: process.env.D365_TENANT_ID,
      clientId: process.env.D365_CLIENT_ID,
      clientSecret: process.env.D365_CLIENT_SECRET,
      company: process.env.D365_COMPANY || 'PKE',
    };
  }
}
