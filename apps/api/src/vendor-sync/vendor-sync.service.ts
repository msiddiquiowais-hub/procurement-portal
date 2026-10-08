// ═══════════════════════════════════════════════════════════════════════════
// Wave 5 Track H — vendor master sync to D365 F&O (the OUTBOUND direction).
//
// WHY OUTBOUND ONLY
//
// W5-H asks for "vendor onboarding status, hold controls, category mappings"
// to be synchronised with F&O. That is deliberately a ONE-WAY push from this
// application to F&O, and the direction is the whole design decision:
//
//   * Onboarding, AML screening, sanctions screening, risk score and the hold
//     controls all live HERE. F&O has no field that can represent them — it
//     knows nothing about a sanctions hit or a W5-E hold reason. Pulling from
//     F&O would therefore have nothing to pull.
//   * F&O owns vendor descriptive master (bank details, credit limits, its own
//     credit-management state). This application must not overwrite it.
//
// So each system writes what it owns, and the sync pushes only the first set.
//
// THE HOLD IS THE PART THAT MUST NOT GO WRONG
//
// A vendor held here must be blocked in F&O, or F&O will happily raise a PO
// against a supplier this application has frozen. Conversely a failed push must
// NOT be recorded as pushed: if the ledger advanced anyway, the sync would
// report success, skip the vendor next run, and the block would never land.
// The ledger is therefore written only after F&O has accepted the change.
//
// CHANGE DETECTION
//
// `core.fn_vendor_d365_sync_hash` (migration 045) hashes exactly the fields
// pushed here. Unchanged hash means nothing to send, and an unchanged vendor
// writes NO audit row — an append-only hash-chained log full of identical
// "synced" entries is noise that hides the one row that mattered.
//
// STUB MODE OPENS NO SOCKET AND ASSERTS NOTHING
//
// `D365_MODE` is anything but the literal word `live` is stub. A stub run
// returns a labelled "nothing was sent" summary, writes no ledger and no audit
// row. Inventing a reconciliation that never happened is worse than doing
// nothing.
// ═══════════════════════════════════════════════════════════════════════════

import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { DbService } from '../db/db.service';
import { roleAllowed } from '@procurement/roles';
import {
  D365_ENTITY_SETS, D365_VENDOR_FIELDS as VENDOR_FIELDS, D365ConfigError,
  EntraTokenProvider, ODataClient, missingConfig,
} from '@procurement/d365-client';

// Lowercase, matching core.users.role. See d365-sync.service.ts for why a
// capitalized list here denied every real user.
const VENDOR_SYNC_ROLES = 'cs,procurement,procurement_manager,management,cfo,admin';

/**
 * Default batch size for one push.
 *
 * Every vendor is two round trips (existence probe, then create-or-update), so
 * this is deliberately modest. A larger limit against a slow F&O produces a
 * very long request with no progress to show for it.
 */
const DEFAULT_LIMIT = 25;

/**
 * Onboarding states F&O can meaningfully represent. */
const ONBOARDED_STATE = 'Active';

type Ctx = { userId: string; role: string; costCenterIds: string[] };

export type VendorSyncResult = {
  ok: boolean;
  mode: 'stub' | 'live';
  considered: number;
  pushed: number;
  created: number;
  updated: number;
  unchanged: number;
  failed: number;
  skipped: number;
  results: Array<{
    vendor_code: string | null;
    legal_name: string | null;
    action: 'created' | 'updated' | 'unchanged' | 'failed' | 'skipped';
    detail: string | null;
  }>;
  message: string;
};

type VendorRow = {
  id: string;
  vendor_code: string | null;
  legal_name: string | null;
  ntn: string | null;
  strn: string | null;
  currency: string | null;
  payment_terms: string | null;
  state: string | null;
  is_hold: boolean;
  hold_reason: string | null;
  preferred_categories: string[] | null;
  sync_hash: string | null;
  d365_vendor_sync_hash: string | null;
  d365_vendor_synced_at: string | null;
};

@Injectable()
export class VendorSyncService {
  constructor(private readonly db: DbService) {}

  /**
   * GET /d365/sync/vendors/preview
   *
   * Which vendors are pending, and why. Read-only: it performs no network call
   * and writes nothing, so it is safe to call to answer "is there anything to
   * do?" without an operator having to trigger a push to find out.
   */
  async preview(userId: string, role: string, costCenterIds: string[]) {
    this.assertRole(role);
    const rows = await this.candidates(1000);
    return {
      mode: this.mode(),
      pending: rows.filter((v) => this.isPending(v)).length,
      never_pushed: rows.filter((v) => !v.d365_vendor_synced_at).length,
      held: rows.filter((v) => v.is_hold).length,
      total: rows.length,
      vendors: rows.slice(0, 50).map((v) => ({
        vendor_code: v.vendor_code,
        legal_name: v.legal_name,
        state: v.state,
        is_hold: v.is_hold,
        hold_reason: v.hold_reason,
        preferred_categories: v.preferred_categories ?? [],
        pending: this.isPending(v),
        last_pushed_at: v.d365_vendor_synced_at,
      })),
    };
  }

  /**
   * POST /d365/sync/vendors
   *
   * Push vendor master to F&O. `only_changed` (default true) skips vendors
   * whose pushed fields are byte-identical to the last successful push.
   */
  async push(
    userId: string, role: string, costCenterIds: string[],
    body: { vendor_codes?: string[]; only_changed?: boolean; limit?: number } = {},
  ): Promise<VendorSyncResult> {
    this.assertRole(role);
    const ctx: Ctx = { userId, role, costCenterIds };
    const mode = this.mode();
    const onlyChanged = body.only_changed !== false;

    const wanted = Array.isArray(body.vendor_codes) ? body.vendor_codes : null;
    let rows = await this.candidates(Math.min(body.limit ?? DEFAULT_LIMIT, 200));
    if (wanted && wanted.length > 0) {
      const set = new Set(wanted.map((c) => String(c)));
      rows = rows.filter((v) => v.vendor_code && set.has(v.vendor_code));
    } else if (onlyChanged) {
      rows = rows.filter((v) => this.isPending(v));
    }

    const results: VendorSyncResult['results'] = [];
    const base: VendorSyncResult = {
      ok: true, mode, considered: rows.length,
      pushed: 0, created: 0, updated: 0, unchanged: 0, failed: 0, skipped: 0,
      results, message: '',
    };

    // ── STUB: no client, no socket, no ledger, no audit row ───────────────
    if (mode === 'stub') {
      return {
        ...base,
        message:
          'STUB MODE: no D365 connection is configured, so nothing was sent to F&O. ' +
          'No vendor was marked as synced and no audit row was written — this ' +
          'run asserts nothing. Set D365_MODE=live with credentials to push.',
      };
    }

    const cfg = this.config();
    const missing = missingConfig({
      tenantId: cfg.tenantId, clientId: cfg.clientId,
      clientSecret: cfg.clientSecret, resourceUrl: cfg.baseUrl,
    });
    if (missing.length > 0) throw new D365ConfigError(missing);
    const baseUrl = cfg.baseUrl;
    if (!baseUrl) throw new D365ConfigError(['D365_BASE_URL']);

    const tokens = new EntraTokenProvider({
      tenantId: cfg.tenantId,
      clientId: cfg.clientId,
      clientSecret: cfg.clientSecret,
      resourceUrl: baseUrl,
    });
    const odata = new ODataClient({ baseUrl, company: cfg.company, tokens });

    for (const v of rows) {
      // A vendor with no code has no F&O key. Do not invent one.
      if (!v.vendor_code || !v.vendor_code.trim()) {
        base.skipped++;
        results.push({
          vendor_code: null, legal_name: v.legal_name, action: 'skipped',
          detail: 'no vendor_code, and F&O keys VendorsV2 on VendorAccount — ' +
            'one was not invented',
        });
        continue;
      }
      if (!v.legal_name || !v.legal_name.trim()) {
        base.skipped++;
        results.push({
          vendor_code: v.vendor_code, legal_name: null, action: 'skipped',
          detail: 'no legal_name; F&O requires a vendor name and one was not invented',
        });
        continue;
      }
      if (onlyChanged && !this.isPending(v)) {
        base.unchanged++;
        results.push({
          vendor_code: v.vendor_code, legal_name: v.legal_name,
          action: 'unchanged', detail: null,
        });
        continue;
      }

      const payload = this.payload(v);

      try {
        const exists = await odata.count(
          D365_ENTITY_SETS.vendors,
          `${VENDOR_FIELDS.account} eq '${v.vendor_code.replace(/'/g, "''")}'`,
        );

        if (exists > 0) {
          // PATCH only the fields this application owns. A full replace would
          // overwrite F&O's own vendor master with our partial view of it.
          await odata.patchByKey(
            D365_ENTITY_SETS.vendors,
            `${VENDOR_FIELDS.account}='${v.vendor_code.replace(/'/g, "''")}'`,
            payload,
          );
          base.updated++;
        } else {
          const created = await odata.post<any>(D365_ENTITY_SETS.vendors, payload);
          // A 200 with no account back means the create is not confirmed.
          if (!created?.[VENDOR_FIELDS.account]) {
            throw new Error(
              `F&O accepted the vendor but returned no ${VENDOR_FIELDS.account}; ` +
              'not recording this vendor as synced, because the push is unconfirmed.',
            );
          }
          base.created++;
        }

        // Ledger AFTER acceptance only. Advancing it first would make a failed
        // push look done, and the vendor would be skipped on every later run.
        await this.db.query(
          `UPDATE core.vendors
              SET d365_vendor_synced_at = now(), d365_vendor_sync_hash = $2::text
            WHERE id = $1::uuid`,
          [v.id, v.sync_hash], ctx,
        );

        await this.db.query(
          `INSERT INTO audit.audit_log
             (actor_user_id, entity, entity_id, action, before, after, reason)
           VALUES ($1::uuid, 'core.vendors', $2::uuid, 'd365_vendor_sync',
                   $3::jsonb, $4::jsonb, $5)`,
          [
            userId, v.id,
            JSON.stringify({
              d365_vendor_synced_at: v.d365_vendor_synced_at,
              is_hold: v.is_hold,
              state: v.state,
            }),
            JSON.stringify({
              vendor_account: v.vendor_code,
              is_hold: v.is_hold,
              block_on_hold: v.is_hold,
              onboarding_state: v.state,
              categories: v.preferred_categories ?? [],
              push_hash: v.sync_hash,
            }),
            `Vendor ${v.vendor_code} (${v.legal_name}) → F&O. ` +
            (v.is_hold
              ? `ON HOLD — ${v.hold_reason || 'no reason recorded'}`
              : 'not held') +
            (v.state && v.state !== ONBOARDED_STATE ? `, onboarding ${v.state}` : ''),
          ], ctx,
        );

        base.pushed++;
        results.push({
          vendor_code: v.vendor_code, legal_name: v.legal_name,
          action: exists > 0 ? 'updated' : 'created', detail: null,
        });
      } catch (e: any) {
        // One vendor failing must not abandon the rest, and the failure must be
        // visible rather than rolled into a green summary.
        base.failed++;
        base.ok = false;
        results.push({
          vendor_code: v.vendor_code, legal_name: v.legal_name, action: 'failed',
          detail: String(e?.message || e).slice(0, 240),
        });
      }
    }

    return { ...base, message: this.summarise(base) };
  }

  // ── internals ───────────────────────────────────────────────────────────

  private assertRole(role: string) {
    if (!roleAllowed(role, VENDOR_SYNC_ROLES)) {
      throw new ForbiddenException(
        'Only CS, Procurement, a Procurement Manager, Management, CFO or an Admin ' +
        'can sync vendor master to D365.',
      );
    }
  }

  /**
   * The pushable set. The hash comes from the DATABASE, not from this file, so
   * the service and the harness cannot disagree about what "changed" means.
   */
  private async candidates(limit: number): Promise<VendorRow[]> {
    const r = await this.db.query<any>(
      `SELECT v.id, v.vendor_code, v.legal_name, v.ntn, v.strn, v.currency,
              v.payment_terms, v.state, v.is_hold, v.hold_reason,
              -- ACTIVE links only, read from the mapping table rather than from
              -- v.preferred_categories. The two agree today (the sync trigger
              -- rebuilds the array from active links), but F&O must never be told
              -- a vendor serves a category we have deactivated, and the payload
              -- should not depend on a projection staying correct.
              --
              -- core.categories, not the ItemGroup dimension: migration 051 moved
              -- the vendor mapping onto the line categories, and reading the
              -- wrong library here would send an empty category note to every
              -- vendor — a silent failure that looks like a successful push.
              ARRAY(
                SELECT c.code
                  FROM core.vendor_categories vc
                  JOIN core.categories c ON c.id = vc.category_id
                 WHERE vc.vendor_id = v.id AND vc.is_active
                 ORDER BY c.code
              ) AS preferred_categories,
              core.fn_vendor_d365_sync_hash(v.id) AS sync_hash,
              v.d365_vendor_sync_hash, v.d365_vendor_synced_at
         FROM core.vendors v
        ORDER BY v.vendor_code
        LIMIT $1`,
      [limit], { role: 'system', bypassRls: true } as any,
    );
    return r.rows as VendorRow[];
  }

  /** Never pushed, or the pushed fields have changed since. */
  private isPending(v: VendorRow): boolean {
    if (!v.d365_vendor_synced_at) return true;
    return v.sync_hash !== v.d365_vendor_sync_hash;
  }

  /** Exactly the fields this application owns. Nothing else is sent. */
  private payload(v: VendorRow) {
    const cats = (v.preferred_categories ?? []).filter(Boolean);
    return {
      [VENDOR_FIELDS.account]: v.vendor_code,
      [VENDOR_FIELDS.name]: v.legal_name,
      [VENDOR_FIELDS.legalName]: v.legal_name,
      [VENDOR_FIELDS.ntn]: v.ntn ?? null,
      [VENDOR_FIELDS.strn]: v.strn ?? null,
      [VENDOR_FIELDS.currency]: v.currency ?? null,
      [VENDOR_FIELDS.paymentTerms]: v.payment_terms ?? null,
      // Onboarding: F&O can act on a vendor only once it is Active here.
      [VENDOR_FIELDS.isOnHold]: v.is_hold,
      [VENDOR_FIELDS.blockOnHold]: v.is_hold,
      [VENDOR_FIELDS.categoryNote]: cats.length ? `procurement-categories: ${cats.join(',')}` : null,
    };
  }

  private summarise(r: Omit<VendorSyncResult, 'message'>): string {
    const parts = [
      `${r.pushed} pushed (${r.created} created, ${r.updated} updated)`,
    ];
    if (r.unchanged) parts.push(`${r.unchanged} unchanged`);
    if (r.skipped) parts.push(`${r.skipped} skipped`);
    if (r.failed) parts.push(`${r.failed} FAILED`);
    return `${parts.join(', ')} of ${r.considered} considered.`;
  }

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
