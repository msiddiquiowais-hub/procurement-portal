import { Injectable, ForbiddenException, NotFoundException } from '@nestjs/common';
import { DbService } from '../db/db.service';
import { roleAllowed } from '@procurement/roles';
import { parseJsonb } from '../sourcing/rfq.status';

/**
 * The prototype's grade and risk vocabulary (blueprint 9.5), kept in ONE place.
 *
 * The composite arithmetic itself is NOT here — it lives in SQL as
 * `core.fn_vendor_composite()`, so the Vendor Risk screen, the Vendor Master's
 * Risk column and the RFQ invitation guard cannot disagree about it. A second
 * TypeScript implementation would be exactly the kind of drift this project keeps
 * refusing; this file only maps the model's OUTPUT onto the prototype's words.
 */
const GRADE_PILL: Record<string, string> = {
  A: 'approved',
  B: 'pending',
  C: 'pending',
  D: 'danger',
};

const RISK_PILL: Record<string, string> = {
  Low: 'approved',
  Medium: 'pending',
  High: 'danger',
};

const RISK_ACTION: Record<string, string> = {
  Low: 'Eligible for RFQ',
  Medium: 'Eligible — monitored',
  High: 'Blocked pending remediation',
};

/** The blueprint's weights, used only to EXPLAIN a score, never to compute one. */
const WEIGHTS: Record<string, number> = { financial: 0.4, delivery: 0.35, quality: 0.25 };
const POINTS: Record<string, number> = { A: 3, B: 2, C: 1, D: 0 };

function gradePill(g: string | null): string {
  return g ? GRADE_PILL[g] ?? 'pending' : 'unrated';
}

/**
 * A vendor with no scorecard is NOT a low-risk vendor. `blocked` is null rather
 * than false so callers must decide what "unscored" means instead of silently
 * treating it as eligible.
 */
function shape(row: any) {
  // The driver hands jsonb back as a STRING here, not as an object. Reading
  // `row.scorecard.financial` off the raw string yields undefined and the screen
  // renders every vendor as unrated — which looks like missing data rather than
  // a parsing mistake. parseJsonb handles both shapes.
  const sc = parseJsonb(row.scorecard) ?? {};
  // DbService runs psql as a subprocess, so a text[] column arrives as the
  // POSTGRES ARRAY LITERAL (a quoted string), not a JS array. Array.isArray is
  // false on that string and every vendor silently reads as un-categorised.
  // BASE_SELECT casts the column to jsonb for exactly this reason, so parseJsonb
  // is the single reader for both jsonb and text[] in this file.
  const catsParsed = parseJsonb(row.preferred_categories);
  const cats = Array.isArray(catsParsed) ? catsParsed : [];
  // Same jsonb-vs-string guard as `cats`: psql hands jsonb back as a string here,
  // and without parsing it every vendor would report an empty deactivated list.
  const inactiveParsed = parseJsonb(row.inactive_categories);
  const inactiveCats = Array.isArray(inactiveParsed) ? inactiveParsed : [];
  const composite = {
    score: row.c_score === undefined ? null : row.c_score,
    grade: row.c_grade ?? null,
    blocked: row.c_blocked === undefined ? null : row.c_blocked,
    pill: row.c_grade ? RISK_PILL[row.c_grade] : 'unrated',
    action: row.c_grade ? RISK_ACTION[row.c_grade] : 'Not yet risk-assessed',
  };
  return {
    id: row.id,
    vendorCode: row.vendor_code,
    name: row.legal_name,
    city: row.city ?? null,
    rating: row.rating ?? null,
    category: cats,
    // Deactivated links, kept separate rather than merged into `category`: a
    // merged list makes "we stopped routing them there" look identical to "they
    // serve it", which is the one distinction an operator most needs here.
    inactiveCategory: inactiveCats,
    // Rule 3: a category is mandatory for an active vendor used for procurement.
    // It is NOT a database constraint (that would reject a D365 sync); it is a
    // computed fact the RFQ dispatch gate acts on and the dashboard counts.
    categorised: cats.length > 0,
    state: row.state,
    scorecard: {
      financial: sc.financial ?? null,
      delivery: sc.delivery ?? null,
      quality: sc.quality ?? null,
    },
    grades: {
      financial: gradePill(sc.financial),
      delivery: gradePill(sc.delivery),
      quality: gradePill(sc.quality),
    },
    composite,
    // RULE 5: the hold, and why. `is_hold` arrives from psql as the STRING
    // 'true'/'false', so a bare `row.is_hold` is always truthy — which would show
    // every vendor in the portal as held. Normalise here, once, so no caller has
    // to remember.
    isHold: row.is_hold === true || row.is_hold === 'true',
    holdReason: row.hold_reason ?? null,
    heldAt: row.held_at ?? null,
    holdCount: Number(row.hold_count ?? 0),
    // Real, derived award data — there is no `purchase_orders` table, so a
    // locked comparative statement IS the award record.
    posAwarded: Number(row.pos_awarded ?? 0),
    lifetimeSpend: Number(row.lifetime_spend ?? 0),
    onTimePct: row.on_time_pct === null || row.on_time_pct === undefined ? null : Number(row.on_time_pct),
  };
}

const BASE_SELECT = `
  SELECT v.id, v.vendor_code, v.legal_name, v.ntn, v.address, v.contacts,
         to_jsonb(v.preferred_categories) AS preferred_categories,
         -- Deactivated links, as a projection. The master list badges them so an
         -- operator can see that a relationship exists but is not routing — the
         -- alternative is a vendor who looks uncategorised when in fact they
         -- were deliberately withdrawn from one group and still serve another.
         -- the active set above, so the two never double-count.
         (SELECT COALESCE(jsonb_agg(c.code ORDER BY c.code), '[]'::jsonb)
            FROM core.vendor_categories vc
            JOIN core.categories c ON c.id = vc.category_id
           WHERE vc.vendor_id = v.id AND NOT vc.is_active) AS inactive_categories,
         v.state, v.created_at, v.approved_at,
         v.is_hold, v.hold_reason, v.held_at, v.hold_count,
         v.scorecard, v.risk_score, v.payment_terms, v.currency,
         v.bank_account_verified_at,
         v.rating, v.city, v.contact_name, v.contact_email,
         v.tax_filing_valid_until, v.insurance_valid_until, v.insurance_policy_ref,
         v.aml_check_result, v.aml_checked_at,
         v.sanctions_result, v.sanctions_screened_at,
         v.last_audit_at, v.next_review_at,
         c.score      AS c_score,
         c.risk_grade AS c_grade,
         c.blocked    AS c_blocked,
         COALESCE(w.pos_awarded, 0)   AS pos_awarded,
         COALESCE(w.lifetime_spend, 0) AS lifetime_spend,
         p.on_time_pct, p.reject_pct, p.avg_response_hours, p.score AS perf_score,
         p.quarter AS perf_quarter
    FROM core.vendors v
    CROSS JOIN LATERAL core.fn_vendor_composite(v.scorecard) AS c
    LEFT JOIN LATERAL (
      -- W5-G: a split lock has no winner_vendor_id, so counting only that key
      -- reported ZERO POs and ZERO lifetime spend for every vendor who won a
      -- line — the vendor master silently under-stated every split supplier.
      -- Both branches now count, and a split contributes its awarded line value
      -- (unit price × AWARDED quantity, not the full line quantity).
      SELECT count(DISTINCT x.cs_id)::int AS pos_awarded,
             COALESCE(sum(x.lifetime_spend), 0) AS lifetime_spend
        FROM (
          SELECT s.id AS cs_id,
                 NULLIF(s.recommendation->>'winner_total','')::numeric AS lifetime_spend
            FROM proc.comparative_statements s
           WHERE s.state = 'Locked'
             AND NULLIF(s.recommendation->>'winner_vendor_id','')::uuid = v.id
          UNION ALL
          SELECT a.cs_id, ql.unit_price * a.awarded_qty
            FROM proc.cs_line_awards a
            JOIN proc.comparative_statements cs
              ON cs.id = a.cs_id AND cs.state = 'Locked'
             AND cs.cs_round = proc.fn_latest_cs_round(cs.pr_id)
            JOIN proc.rfq rf ON rf.pr_id = cs.pr_id
            JOIN proc.quotations q
              ON q.rfq_id = rf.id AND q.vendor_id = a.vendor_id AND q.state = 'Awarded'
            JOIN proc.quotation_lines ql
              ON ql.quotation_id = q.id AND ql.rfq_line_no = a.rfq_line_no
           WHERE a.superseded_at IS NULL AND a.vendor_id = v.id
        ) x
    ) w ON true
    LEFT JOIN LATERAL (
      SELECT on_time_pct, reject_pct, avg_response_hours, score, quarter
        FROM core.vendor_performance vp
       WHERE vp.vendor_id = v.id ORDER BY vp.quarter DESC LIMIT 1
    ) p ON true
`;

/**
 * Compliance labels are DERIVED from stored facts, never stored alongside them.
 *
 * "Up to date" and "Valid" are statements about a date, so the date is the only
 * thing kept — a stored status word would be a second copy free to disagree.
 * "Clear" for AML and sanctions is NOT derivable: a check timestamp says a check
 * happened, never that it came back clean, so that result is stored explicitly.
 *
 * A missing fact yields `null`, which the screen renders as "Not recorded".
 * It never yields a pass.
 */
function deriveCompliance(row: any) {
  const today = new Date().toISOString().slice(0, 10);

  const byDate = (d: unknown, validLabel: string) => {
    if (d === null || d === undefined) return null;
    // pg returns DATE as a string by default and as a Date under some drivers.
    const iso = d instanceof Date
      ? d.toISOString().slice(0, 10)
      : String(d).slice(0, 10);
    return iso >= today ? validLabel : 'Expired';
  };

  const aml = row.aml_check_result ?? null;
  const sanctions = row.sanctions_result ?? null;

  const checks = {
    taxFiling: byDate(row.tax_filing_valid_until, 'Up to date'),
    bankAccount: row.bank_account_verified_at ? 'Verified' : 'Not verified',
    insurance: byDate(row.insurance_valid_until, 'Valid'),
    amlCheck: aml === 'Pending' ? 'Pending review' : aml,
    sanctionsScreening: sanctions,
  };

  return {
    ...checks,
    amlCheckedAt: row.aml_checked_at ?? null,
    sanctionsScreenedAt: row.sanctions_screened_at ?? null,
    insurancePolicyRef: row.insurance_policy_ref ?? null,
    lastAudit: row.last_audit_at ?? null,
    nextReview: row.next_review_at ?? null,
    // How many of the five the prototype lists are actually backed by a record.
    // The screen shows "n of 5" so an unrecorded check is visibly unrecorded
    // rather than quietly counted as a pass.
    checksRecorded: ['taxFiling', 'bankAccount', 'insurance', 'amlCheck', 'sanctionsScreening']
      .filter((k) => {
        const val = (checks as Record<string, unknown>)[k];
        return val !== null && val !== 'Not verified';
      }).length,
  };
}

@Injectable()
export class VendorsService {
  constructor(private readonly db: DbService) {}

  /** The blueprint gates all three screens on procurement, hod, cs. */
  private assertVendorRead(role: string) {
    if (!roleAllowed(role, 'procurement,hod,cs')) {
      throw new ForbiddenException(
        'Vendor master and risk data are visible to Procurement, HOD and CS only.',
      );
    }
  }

  /**
   * GET /vendors — the Vendor Master (blueprint 9.3).
   *
   * 4-up KPI + the `Vendor ID | Name | Category | City | Rating | POs | Spend |
   * Risk` table. The blueprint says "No filter, sort, search, add-vendor, or
   * per-row action", so none is offered.
   *
   * Blacklisted vendors are excluded, as before: the list is a sourcing pool.
   */
  async list(role: string) {
    this.assertVendorRead(role);
    const r = await this.db.query<any>(
      `${BASE_SELECT}
        WHERE NOT EXISTS (
          SELECT 1 FROM core.vendor_blacklist b
           WHERE b.vendor_id = v.id AND b.resolved_at IS NULL
        )
        ORDER BY v.vendor_code`,
      [],
      { role, bypassRls: true },
    );
    const rows = r.rows.map(shape);
    return {
      kpis: {
        total: rows.length,
        low: rows.filter((x) => x.composite.grade === 'Low').length,
        medium: rows.filter((x) => x.composite.grade === 'Medium').length,
        high: rows.filter((x) => x.composite.grade === 'High').length,
        // A vendor nobody has risk-assessed is neither a win nor a loss; it is
        // counted separately so "Low risk" cannot quietly mean "everything not
        // yet known to be terrible".
        unrated: rows.filter((x) => x.composite.grade === null).length,
        // Rule 4 groundwork: these are the vendors the RFQ dispatch gate will
        // exclude. Surfaced here so the count is visible before the gate bites.
        uncategorised: rows.filter((x) => !x.categorised).length,
        // Rule 5: vendors a local user has put on hold. They exist, they are
        // visible, and they are out of the automatic pool.
        held: rows.filter((x) => x.isHold).length,
      },
      rows,
      // RULE 4's "clear dashboard intimation/alert for the admin to fix".
      // Named rather than counted, because a count does not tell an admin what
      // to do next; a list of vendors does.
      attention: [
        ...rows.filter((x) => !x.categorised)
          .map((x) => ({
            kind: 'uncategorised' as const,
            vendor_id: x.id,
            vendor_code: x.vendorCode,
            name: x.name,
            message: 'No category mapped — excluded from automatic RFQs until one is assigned.',
          })),
        ...rows.filter((x) => x.isHold)
          .map((x) => ({
            kind: 'held' as const,
            vendor_id: x.id,
            vendor_code: x.vendorCode,
            name: x.name,
            message: x.holdReason
              ? `On hold: ${x.holdReason}`
              : 'On hold — excluded from RFQ invitations until released.',
          })),
      ],
    };
  }

  /**
   * GET /vendors/applications — Wave 4's read side.
   *
   * The public onboarding form (step 3) writes here, so this is what proves the
   * intake is REAL and visible to Procurement rather than a reference number
   * that went nowhere. The prototype's public form says submissions are
   * "validated by Procurement before vendor master creation", and this is the
   * queue that validation would work from.
   *
   * Gated on 'procurement,cs' so the `admin` alias reaches it through
   * ROLE_ALIASES (it expands to both) while a `vendor` cannot — a supplier
   * reading other suppliers' applications, including their tax numbers, is
   * exactly what this gate prevents.
   */
  async applications(role: string) {
    if (!roleAllowed(role, 'procurement,cs')) {
      throw new ForbiddenException('Vendor applications are visible to Procurement and CS only.');
    }
    const r = await this.db.query<any>(
      `SELECT a.id, a.reference, a.legal_name, a.ntn, a.contact_name, a.contact_email,
              a.categories, a.state, a.reference_note, a.submitted_at,
              a.reviewed_at, a.decision_note,
              rv.email AS reviewed_by_email
         FROM core.vendor_applications a
         LEFT JOIN core.users rv ON rv.id = a.reviewed_by_user_id
        ORDER BY (a.state IN ('Submitted','Under_Review')) DESC NULLS LAST,
                 a.submitted_at DESC`,
      [],
      { role, bypassRls: true },
    );
    const rows = r.rows;
    return {
      // Counts the queue UI needs, computed rather than left to the renderer.
      totals: {
        total: rows.length,
        pending: rows.filter((x: any) => ['Submitted', 'Under_Review'].includes(x.state)).length,
        decided: rows.filter((x: any) => ['Approved', 'Rejected'].includes(x.state)).length,
      },
      applications: rows,
    };
  }

  /**
   * GET /vendors/:id — the Vendor Detail (blueprint 9.4).
   *
   * The prototype hard-wires this screen to one fictional vendor and hard-codes
   * its grades, its basis strings and its "★ 4.7" rating. Those literals are NOT
   * reproduced: where the database has no field, this returns an explicit null
   * and the screen renders an em-dash. That is the same rule the codebase already
   * applies to D365 compliance ("unknown, never an assumed pass") and to a blank
   * quote unit price ("never synthesised").
   */
  async detail(id: string, role: string) {
    this.assertVendorRead(role);
    const r = await this.db.query<any>(
      `${BASE_SELECT} WHERE v.id = $1::uuid`,
      [id],
      { role, bypassRls: true },
    );
    if (r.rows.length === 0) throw new NotFoundException('vendor not found');
    const row = r.rows[0];
    const v = shape(row);

    const compliance = deriveCompliance(row);

    // Risk breakdown. The basis column is REAL ARITHMETIC — points × weight —
    // not the prototype's prose, which describes evidence this database does not
    // hold (audited statements, defect rates, on-time history).
    const basis = (dim: 'financial' | 'delivery' | 'quality') => {
      const g = v.scorecard[dim];
      if (!g) return null;
      const pts = POINTS[g];
      return `${pts} point${pts === 1 ? '' : 's'} × ${Math.round(WEIGHTS[dim] * 100)}% = ${(pts * WEIGHTS[dim]).toFixed(2)}`;
    };

    return {
      vendor: v,
      kpis: {
        rating: v.rating,
        ratingBasis: v.rating === null ? 'No supplier rating has been recorded' : null,
        posAwarded: v.posAwarded,
        lifetimeSpend: v.lifetimeSpend,
        onTimePct: v.onTimePct,
        onTimeBasis: v.onTimePct === null ? 'No performance record has been filed' : null,
        // The quarterly sample behind the on-time figure, so a percentage is not
        // presented as if it were a lifetime average.
        onTimeQuarter: row.perf_quarter ?? null,
        rejectPct: row.reject_pct ?? null,
        avgResponseHours: row.avg_response_hours ?? null,
        since: row.approved_at ?? row.created_at,
      },
      profile: {
        vendorId: v.vendorCode,
        ntn: row.ntn ?? null,
        category: v.category,
        categorised: v.categorised,
        city: v.city,
        activeSince: row.approved_at ?? row.created_at,
        contactPerson: row.contact_name ?? null,
        email: row.contact_email ?? null,
        rating: v.rating,
        paymentTerms: row.payment_terms ?? null,
        currency: row.currency ?? null,
      },
      compliance,
      riskBreakdown: [
        { dimension: 'Financial', grade: v.scorecard.financial, pill: v.grades.financial, basis: basis('financial') },
        { dimension: 'Delivery', grade: v.scorecard.delivery, pill: v.grades.delivery, basis: basis('delivery') },
        { dimension: 'Quality', grade: v.scorecard.quality, pill: v.grades.quality, basis: basis('quality') },
        {
          dimension: 'Composite',
          grade: v.composite.grade,
          pill: v.composite.pill,
          basis: v.composite.score === null ? null : `Weighted 40/35/25 → ${v.composite.score}/100`,
          score: v.composite.score,
          action: v.composite.action,
        },
      ],
    };
  }

  /**
   * GET /vendors/risk — the Vendor Risk Review (blueprint 9.5).
   *
   * `Vendor | Financial | Delivery | Quality | Weighted score | Composite |
   * Action`, plus the 3-up `Eligible for RFQ | Blocked | Avg composite`.
   *
   * Every scored row is returned, INCLUDING the blocked ones. The screen is a
   * remediation queue, not a shortlist — hiding the blocked vendors would hide
   * exactly the ones a buyer needs to act on.
   */
  async riskMatrix(role: string) {
    this.assertVendorRead(role);
    const r = await this.db.query<any>(
      `${BASE_SELECT}
        -- NOTE: a sort direction cannot sit inside the parentheses — (c.score DESC)
        -- is a syntax error. Blocked vendors first, unscored vendors last.
        ORDER BY c.blocked DESC NULLS LAST, c.score DESC NULLS LAST, v.vendor_code`,
      [],
      { role, bypassRls: true },
    );
    const rows = r.rows.map(shape);
    const scored = rows.filter((x) => x.composite.score !== null);

    return {
      kpis: {
        // "Eligible" means not blocked, which includes the monitored band.
        eligible: rows.filter((x) => x.composite.blocked === false).length,
        blocked: rows.filter((x) => x.composite.blocked === true).length,
        unrated: rows.filter((x) => x.composite.blocked === null).length,
        // Averaged over SCORED vendors only. Including unscored vendors as zero
        // would drag the average down and read as a risk signal that is not there.
        avgComposite: scored.length
          ? Math.round((scored.reduce((a, x) => a + Number(x.composite.score), 0) / scored.length) * 10) / 10
          : null,
        scored: scored.length,
      },
      weights: WEIGHTS,
      rows,
    };
  }

  /**
   * `core.fn_vendor_composite()` read for a SINGLE vendor — used by the RFQ
   * invitation guard so the block decision uses the same function the screen
   * renders. Exposed rather than inlined into rfq.service so there is one query.
   */
  async riskFor(vendorId: string, role: string) {
    const r = await this.db.query<any>(
      `SELECT v.vendor_code, v.legal_name, v.scorecard,
              c.score, c.risk_grade, c.blocked
         FROM core.vendors v
         CROSS JOIN LATERAL core.fn_vendor_composite(v.scorecard) AS c
        WHERE v.id = $1::uuid`,
      [vendorId],
      { role, bypassRls: true },
    );
    return r.rows[0] ?? null;
  }
}
