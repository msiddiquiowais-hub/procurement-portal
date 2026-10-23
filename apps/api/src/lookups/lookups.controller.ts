import { Controller, Get, UseGuards } from '@nestjs/common';
import { DbService } from '../db/db.service';
import { JwtAuthGuard } from '../auth/jwt.guard';
// The eligibility rules live with the RFQ pool, not here. A second copy would
// drift, and the drift is silent: the dropdown would enable a category the RFQ
// then refuses, so the requester meets a block with no visible cause.
import { EXCLUDED_VENDOR_STATES, INVITABLE_VENDOR_PREDICATE } from '../sourcing/rfq.service';

@UseGuards(JwtAuthGuard)
@Controller('lookups')
export class LookupsController {
  constructor(private readonly db: DbService) {}

  @Get('cost-centers')
  async costCenters() {
    // department_id is REQUIRED by the client: a PR's department is derived
    // server-side from cost_center_id, so the form must be able to resolve
    // "which cost centre belongs to department X" to send the right one.
    // Without this column the client can only guess, and guessing picks
    // whatever row happens to sort first (Lahore Sales).
    const r = await this.db.query(
      `SELECT id, code, name, hod_user_id, department_id
         FROM core.cost_centers WHERE active = true ORDER BY code`,
      [],
      { bypassRls: true },
    );
    return r.rows;
  }

  @Get('items')
  async items() {
    const r = await this.db.query(
      `SELECT id, item_code, name, category, uom, expense_type, gl_account
         FROM core.items WHERE active = true ORDER BY item_code`,
      [],
      { bypassRls: true },
    );
    return r.rows;
  }

  /**
   * Line categories, with BOTH the name and the description — and how many
   * vendors can actually be reached from each one.
   *
   * Reads core.categories rather than `SELECT DISTINCT category FROM
   * core.items`, and the distinction matters: items only carry four of the nine
   * categories, and the four they carry are not the ones the approval rules
   * branch on. workflow.steps_config 'hod_review' routes IT_HARDWARE and
   * IT_SOFTWARE (over PKR 100,000 to the IT Manager) and OFFICE_SUPPLIES and
   * WAREHOUSE_ACCESSORY (to Warehouse). Deriving the dropdown from items would
   * have hidden IT_SOFTWARE and MACHINERY, making that routing unreachable
   * from the form.
   *
   * Only ACTIVE categories are returned, and the code is what the client must
   * send back: proc.pr_lines.category carries a foreign key to this table, so
   * the database rejects anything not listed here.
   *
   * ─── WHY vendor_count IS ON THIS QUERY ─────────────────────────────────────
   * Being SELECTABLE is not being SOURCEABLE. The FK above stops a typo; it does
   * not stop a requester picking MACHINERY, a real category with nobody mapped
   * to it. That line then travels to the Issue RFQ modal, where no vendor can
   * ever be matched to it, and the failure surfaces weeks later at AWARD with
   * nothing to point back at. The dropdown can only prevent that if it knows the
   * count, and the count has to be the same count the RFQ gate uses — hence
   * INVITABLE_VENDOR_PREDICATE rather than a raw `count(*)`, which would enable
   * a category whose only vendors are all High-risk, on hold or blacklisted.
   */
  @Get('categories')
  async categories() {
    const r = await this.db.query(
      `SELECT c.code, c.name, c.description,
              (SELECT count(*)::int
                 FROM core.vendor_categories vc
                 JOIN core.vendors v ON v.id = vc.vendor_id
                 CROSS JOIN LATERAL core.fn_vendor_composite(v.scorecard) AS comp
                WHERE vc.category_id = c.id
                  AND vc.is_active
                  AND ${INVITABLE_VENDOR_PREDICATE}
              ) AS vendor_count
         FROM core.categories c
        WHERE c.active = true
        ORDER BY c.name`,
      [`{${EXCLUDED_VENDOR_STATES.join(',')}}`],
      { bypassRls: true },
    );
    return r.rows;
  }

  @Get('uoms')
  async uoms() {
    // The create form used to carry a hardcoded 10-entry UOM array. It offered
    // 10 of the 19 codes core.uom actually defines, so a requester picking the
    // wrong thing got a foreign-key failure from proc.pr_lines.uom (migration
    // 034) naming a constraint instead of saying "pick one of these".
    const r = await this.db.query(
      `SELECT code, name FROM core.uom ORDER BY code`,
      [],
      { bypassRls: true },
    );
    return r.rows;
  }

  @Get('departments')
  async departments() {
    const r = await this.db.query(
      `SELECT id, code, name, hod_user_id FROM core.departments WHERE active = true ORDER BY code`,
      [],
      { bypassRls: true },
    );
    return r.rows;
  }

  /**
   * Currencies with their CURRENT rate to PKR, from core.fx_rates.
   *
   * The Receive Quotation form used to have PKR hard-coded in its column
   * header. That is wrong twice over: the API has always stored `currency`,
   * `fx_rate` and `normalized_total_pkr`, and the comparative statement ranks
   * on the normalised figure — so a USD or AED quotation typed into a PKR-only
   * form is not comparable to anything.
   *
   * LATEST PER CURRENCY, not "every dated row": fx_rates is a time series, so a
   * plain `SELECT currency, rate_to_pkr FROM core.fx_rates` returns several
   * rows per currency and the dropdown would list USD four times, once per
   * effective date, each with a different rate. DISTINCT ON picks the newest
   * rate for each currency, which is the one an officer is quoting at today.
   *
   * Ties on effective_date resolve by `source` so the result is deterministic
   * rather than dependent on the planner's row order — a form that silently
   * offers two different USD rates is worse than one that offers neither.
   * (fx_rates has no surrogate `id`; its key is (currency, effective_date).)
   */
  @Get('currencies')
  async currencies() {
    // core.fx_rates IS the master — written by the Settings screen's FX card
    // (PUT /admin/fx-rates/:currency) and seeded by migration 002. There is no
    // second copy: an officer changing a rate in Global Setup changes what this
    // dropdown offers on their next open.
    //
    // STALE-RATE CHECK. A rate whose newest row is months old is returned but
    // flagged, because a silent stale rate is worse than an obviously wrong one:
    // an officer quoting in USD at a 4-month-old rate gets a total that looks
    // authoritative and is not. The flag is informational — the dropdown still
    // lists the currency, because refusing to quote in a real currency is not
    // this lookup's decision to make.
    const r = await this.db.query(
      `SELECT DISTINCT ON (currency)
              currency, rate_to_pkr AS rate_to_pkr, effective_date, source
         FROM core.fx_rates
        ORDER BY currency, effective_date DESC, source DESC NULLS LAST`,
      [],
      { bypassRls: true },
    );
    const today = new Date().toISOString().slice(0, 10);
    return r.rows.map((x: any) => {
      const d = x.effective_date instanceof Date
        ? x.effective_date.toISOString().slice(0, 10)
        : String(x.effective_date);
      const ageDays = Math.floor(
        (Date.parse(today) - Date.parse(d)) / 86_400_000,
      );
      return {
        ...x,
        rate_to_pkr: Number(x.rate_to_pkr),
        effective_date: d,
        stale: ageDays > 30,
        age_days: ageDays,
      };
    });
  }
}
