// cs.scoring.ts — the Comparative Statement's scoring model, as a pure function.
//
// The prototype has NO scoring at all: renderCS (line 7842) just lists each
// quote's Amount / Lead / Warranty / Compliant and lets a human pick a winner
// from the buttons. The schema, however, demands real numbers —
// `proc.cs_lines` carries commercial_score, technical_score, warranty_score,
// weighted_score and rank, each CHECK-constrained to 0..100, and
// `comparative_statements.weights` is NOT NULL. So the port has to compute
// something, and "something" has to be defensible rather than decorative.
//
// ── The rules, and why ──────────────────────────────────────────────────────
//
// THREE CRITERIA, from the schema's own columns:
//   commercial — the quote's total. LOWER IS BETTER.
//   technical  — lead_time_days.      LOWER IS BETTER.
//   warranty   — warranty_months.     HIGHER IS BETTER.
//
// MIN-MAX NORMALISATION to 0..100 across the vendors actually being compared,
// then a weighted sum. Chosen over rank-points because rank throws away
// magnitude: if one bid is 10% cheaper that is materially different from one
// that is 60% cheaper, and both would score 100 vs 0 under ranking.
//
// A MISSING VALUE SCORES ZERO, IT DOES NOT WIN. This is the D5 rule applied to
// numbers. `core.vendor_due_diligence` is empty and many quotes leave
// `warranty_months` NULL; a vendor that did not state a lead time must not
// collect a perfect technical score by being silent. Every omitted dimension is
// listed in `missing` so the CS screen can render an em-dash next to the score
// instead of implying a measured result.
//
// COMPLIANCE IS NOT A SCORED CRITERION. The schema has no compliance column on
// cs_lines, and a compliance state is only ever 'pass' or 'unknown' here —
// scoring an unknown as anything but zero would fabricate a finding.
//
// THE WEIGHTS ARE NOT HARDCODED. `comparative_statements.weights` already
// carries a DB default of {commercial:0.6, technical:0.3, warranty:0.1}; the
// service omits the column on INSERT so the schema's own value applies. This
// module accepts whatever weights it is handed rather than asserting its own.

export type CsWeights = { commercial: number; technical: number; warranty: number };

export type ScoredVendorInput = {
  vendor_id: string;
  vendor_name: string;
  vendor_code: string;
  total_amount: number;
  lead_time_days: number | null;
  warranty_months: number | null;
  /** Live version, so the CS records which quote it scored. */
  quotation_id: string;
  version: number;
};

export type ScoredVendor = {
  vendor_id: string;
  vendor_name: string;
  vendor_code: string;
  quotation_id: string;
  version: number;
  commercial_score: number;
  technical_score: number;
  warranty_score: number;
  weighted_score: number;
  rank: number;
  total_amount: number;
  lead_time_days: number | null;
  warranty_months: number | null;
  /** Which of the three dimensions this vendor did not state. */
  missing: string[];
};

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Min-max one criterion to 0..100. `lowerIsBetter` states which end of the
 * range is the good one — commercial and technical want the SMALLEST value, so
 * they pass true; warranty wants the largest, so it passes false.
 *
 * A criterion with a single distinct value gives everyone 100 — with one bidder
 * there is nothing to be better or worse than. A NULL scores 0 whichever way
 * the axis points, so silence never buys a perfect mark.
 */
function normalise(values: Array<number | null>, lowerIsBetter: boolean): number[] {
  const present = values.filter((v): v is number => v !== null && Number.isFinite(v));
  if (present.length === 0) return values.map(() => 0);

  const min = Math.min(...present);
  const max = Math.max(...present);
  // Everyone quoted the same figure: nothing separates them on this axis.
  if (min === max) return values.map((v) => (v === null ? 0 : 100));

  return values.map((v) => {
    if (v === null || !Number.isFinite(v)) return 0;   // missing => 0, never 100
    // t = 0 at the minimum, 1 at the maximum.
    const t = (v - min) / (max - min);
    return round2((lowerIsBetter ? 1 - t : t) * 100);
  });
}

/** Sum the weights so a partial or odd set still lands inside 0..100. */
function weightSum(w: CsWeights): number {
  const s = w.commercial + w.technical + w.warranty;
  return s > 0 ? s : 1;
}

export function scoreCs(vendors: ScoredVendorInput[], weights: CsWeights): ScoredVendor[] {
  if (vendors.length === 0) return [];

  const commercial = normalise(vendors.map(v => v.total_amount), true);    // lowest wins
  const technical = normalise(vendors.map(v => v.lead_time_days), true);   // lowest wins
  const warranty = normalise(vendors.map(v => v.warranty_months), false);  // highest wins

  const ws = weightSum(weights);
  const scored = vendors.map((v, i) => {
    const missing: string[] = [];
    if (v.lead_time_days === null || v.lead_time_days === undefined) missing.push('technical');
    if (v.warranty_months === null || v.warranty_months === undefined) missing.push('warranty');

    const weighted =
      (commercial[i] * weights.commercial +
        technical[i] * weights.technical +
        warranty[i] * weights.warranty) / ws;

    return {
      vendor_id: v.vendor_id,
      vendor_name: v.vendor_name,
      vendor_code: v.vendor_code,
      quotation_id: v.quotation_id,
      version: v.version,
      commercial_score: commercial[i],
      technical_score: technical[i],
      warranty_score: warranty[i],
      weighted_score: round2(weighted),
      rank: 0,
      total_amount: round2(v.total_amount),
      lead_time_days: v.lead_time_days,
      warranty_months: v.warranty_months,
      missing,
    };
  });

  // Rank by weighted score, highest first. Ties break on the cheaper total, so
  // the order is deterministic rather than dependent on scan order.
  scored.sort((a, b) => b.weighted_score - a.weighted_score || a.total_amount - b.total_amount);
  scored.forEach((s, i) => { s.rank = i + 1; });
  return scored;
}
