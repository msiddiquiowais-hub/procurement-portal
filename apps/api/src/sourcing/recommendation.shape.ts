// ONE definition of "what shape is this award?", for both ways a comparative
// statement gets decided.
//
// WHY THIS EXISTS
// ---------------
// Two locks exist. `cs.service.ts` `lock()` is the legacy governance route;
// `award.sync.ts` `lockStatementWithAward()` is the CS review chain's confirm.
// Both used to invent their own recommendation, and they disagreed:
//
//   · the legacy route wrote `award_mode: 'SINGLE'` with a real winner
//   · the review route wrote `award_mode: 'SPLIT'` — ALWAYS, hardcoded at
//     award.sync.ts, never once looking at how many vendors had actually won
//
// So PR-2026-202043 locked as "a split award across 1 vendor(s) and 1 line(s)".
// A split carries no `winner_vendor_id`, and `winner_quotation_id` was never
// written on that path at all. Both are read downstream by the D365 push
// (`d365.service.ts` — a PO header's TotalAmount comes from the winner's
// quotation) and by the governance pack (`governance.service.ts`). With neither
// key present, the push falls back to the REQUEST'S OWN ESTIMATE as the PO
// TotalAmount: "a budget against a commitment", which is exactly what the push
// is supposed to prevent.
//
// So this is not a cosmetic label. The mode decides which numbers exist.
//
// THE RULE
// --------
//     SINGLE  iff  exactly one vendor won
//            AND  that vendor's live quotation covers EXACTLY the awarded lines
//     SPLIT   otherwise
//
// The second clause is the one that is easy to get wrong. `winner_total` is
// `quotations.total_amount` — the WHOLE quotation, not the awarded part. If a
// vendor quoted five lines and won two, a SINGLE lock would put the full
// five-line total into `winner_total`, and the PO would carry a TotalAmount
// inflated by three lines nobody awarded. The split array is the only honest
// representation there, so the array wins.
//
// CASE 18: one vendor, one awarded line, Acme's quotation carries that one
// line → SINGLE, and the push can finally name the awarded 139.73.
//
// ORDERING, WHICH IS NOT A DETAIL
// -------------------------------
// This must be called BEFORE the winners' quotations are flipped to 'Awarded'.
// It reads the winning quotation with `state IN ('Submitted','Awarded')`
// because both are live states — but the legacy lock's own lookup filtered to
// `state = 'Submitted'` only, and copying that filter here would have found
// nothing on the review path, where the flip has already happened. The codebase
// has already been bitten by this once and wrote down why, at
// `award.service.ts`: "'Awarded' belongs here as much as 'Submitted' … a matrix
// that reads only 'Submitted' goes EMPTY the moment the decision is made."
//
// A LEAF MODULE ON PURPOSE
// ------------------------
// No service imports. Both locks pass their own transaction `run`, so this
// cannot create an import cycle with either of them.
//
// One import, and it is a leaf too: `pgIntArray`, because this API's database
// bridge returns an `array_agg` as a STRING.

import { pgIntArray } from '../db/pg-array';

/** The transaction handle. Matches DbService.withTransaction's callback. */
export type Run = <T = any>(sql: string, params?: any[]) => Promise<{ rows: T[]; rowCount?: number }>;

/** A vendor the roster treats as established. Anything else is a Q3 risk. */
const ROSTER_OK = ['Active', 'Approved'];

/** One line's award, normalised from `proc.cs_line_awards`. */
export type AwardLine = {
  line_no: number;
  vendor_id: string;
  vendor_name: string | null;
  vendor_code: string | null;
  awarded_qty: number;
  justification: string | null;
  award_round: number;
};

export type MatrixWinner = {
  vendor_id: string;
  legal_name: string | null;
};

export type AwardInput = {
  csId: string;
  /** The live per-line awards. Empty when the legacy matrix-winner path ran. */
  lineAwards: AwardLine[];
  /**
   * The vendor chosen on the CS matrix, used ONLY when there are no line awards.
   * In that case the award covers every line of the RFQ by construction.
   */
  matrixWinner?: MatrixWinner | null;
  /** Every line number on the CS's RFQ. */
  rfqLineNos: number[];
  reason?: string | null;
  overrideReason?: string | null;
  /** The vendor whose rank was overridden — legacy matrix route only. */
  overrodeRank?: string | null;
  /**
   * The PR's routing key. A PARAMETER, not a lookup: `cs.service.ts` passes
   * `c.routing_key || 'STANDARD'` and the review path passes its own. Where that
   * key comes from is Phase B's problem, and it must not be decided here.
   */
  routingKey?: string | null;
  /** Which route locked it. Recorded so a decision can be traced to its door. */
  lockedVia?: string | null;
};

export type AwardDecision = {
  awardMode: 'SINGLE' | 'SPLIT';
  recommendation: Record<string, unknown>;
  /** Every vendor that won at least one line. Used to move the quotations. */
  vendors: string[];
  /** Every line that was awarded. */
  lines: number[];
  /** The sole winner, when there is exactly one and the quotation matches. */
  winnerVendorId: string | null;
  /**
   * The winning quotation, resolved ONCE here and handed back. Both locks need it
   * after the shape is decided — the pack's quote block, the response's
   * `winner.total`, the event line — and letting each re-query is how the two
   * routes ended up with different answers in the first place.
   *
   * NULL on a split: a split has no single quotation, and a per-line total is not
   * a quotation.
   */
  winnerQuote: WinnerQuote | null;
};

/** The winning vendor's live quotation. Field names match `proc.quotations`. */
export type WinnerQuote = {
  id: string;
  total_amount: number | null;
  currency: string | null;
  lead_time_days: number | null;
  version: number | null;
};

/** The award as ONE list, whichever route produced it. */
function normalise(input: AwardInput): AwardLine[] {
  if (input.lineAwards.length > 0) return input.lineAwards;
  const w = input.matrixWinner;
  if (!w) return [];
  // The matrix route picks a vendor for the WHOLE statement, so the award is
  // every line of the RFQ. Fabricating per-line rows here is not invention: the
  // legacy lock already treats "no line awards" as "one vendor, everything".
  return input.rfqLineNos.map((no) => ({
    line_no: no,
    vendor_id: w.vendor_id,
    vendor_name: w.legal_name ?? null,
    vendor_code: null,
    awarded_qty: 0,
    justification: null,
    award_round: 1,
  }));
}

export async function buildAwardRecommendation(
  run: Run,
  input: AwardInput,
): Promise<AwardDecision> {
  const awarded = normalise(input);

  if (!awarded.length) {
    throw new Error(
      'This statement has no live award, so it cannot be locked. Award the lines first.',
    );
  }

  const vendors = [...new Set(awarded.map((a) => a.vendor_id))];
  const lines = awarded.map((a) => a.line_no);
  const isNewVendor = (vendorId: string, states: Map<string, string>) =>
    !ROSTER_OK.includes(states.get(vendorId) ?? '');

  // ONE query for every vendor's roster standing, so the "was this vendor on the
  // approved roster" question has a single answer regardless of shape.
  const vendorStates = await run<{ id: string; state: string }>(
    `SELECT id::text, state FROM core.vendors WHERE id = ANY($1::uuid[])`,
    [vendors],
  );
  const states = new Map(vendorStates.rows.map((r) => [r.id, r.state]));

  // ── can this be a SINGLE? ────────────────────────────────────────────────
  //
  // `quoted_lines` is an `array_agg`, and this API reads the database through
  // `psql --csv`, so it arrives as the literal STRING `'{1,2}'`. Reading it as
  // an array directly threw `map is not a function` — a 500 on the CS
  // confirm, the one action that has to work for the blind reviewer to be
  // able to release the request at all. `?? []` cannot save it: a non-empty
  // string is truthy, so the default never fires. See `db/pg-array.ts`.
  let winnerRow: (WinnerQuote & { quoted_lines: unknown }) | null = null;

  if (vendors.length === 1) {
    const vendorId = vendors[0];
    const quote = await run<any>(
      `SELECT q.id::text, q.total_amount, q.currency, q.lead_time_days, q.version,
              (SELECT array_agg(ql.rfq_line_no ORDER BY ql.rfq_line_no)
                 FROM proc.quotation_lines ql
                WHERE ql.quotation_id = q.id) AS quoted_lines
         FROM proc.quotations q
         JOIN core.vendors v ON v.id = q.vendor_id
        WHERE q.rfq_id = (SELECT cs.rfq_id FROM proc.comparative_statements cs WHERE cs.id = $1::uuid)
          AND q.vendor_id = $2::uuid
          AND q.state IN ('Submitted','Awarded')
        ORDER BY q.version DESC
        LIMIT 1`,
      [input.csId, vendorId],
    );
    const row = quote.rows[0] ?? null;
    if (row) {
      // "Covers exactly" — no more, no fewer. A quotation carrying lines nobody
      // awarded would inflate the PO total; a quotation missing an awarded line
      // would under-price it. Both are worse than admitting it is a split.
      const quoted = new Set(pgIntArray(row.quoted_lines));
      const awardedSet = new Set(awarded.map((a) => a.line_no));
      const coversExactly =
        quoted.size === awardedSet.size
        && [...awardedSet].every((n) => quoted.has(n));
      if (coversExactly) winnerRow = row;
    }
  }

  // ── the recommendation ───────────────────────────────────────────────────
  const splitShape = awarded.map((a) => ({
    line_no: a.line_no,
    vendor_id: a.vendor_id,
    vendor_name: a.vendor_name,
    vendor_code: a.vendor_code,
    awarded_qty: a.awarded_qty,
    justification: a.justification,
    award_round: a.award_round,
  }));

  const common = {
    reason: input.reason ?? null,
    override_reason: input.overrideReason ?? null,
    routing_key: input.routingKey ?? null,
    ...(input.lockedVia ? { locked_via: input.lockedVia } : {}),
  };

  if (winnerRow) {
    const winner = awarded[0];
    const recommendation = {
      award_mode: 'SINGLE',
      winner_vendor_id: winner.vendor_id,
      winner_vendor_name: winner.vendor_name,
      winner_quotation_id: winnerRow.id,
      winner_total: winnerRow.total_amount === null ? null : Number(winnerRow.total_amount),
      winner_currency: winnerRow.currency ?? null,
      lead_time_days: winnerRow.lead_time_days ?? null,
      // NO `split` KEY HERE, and that is load-bearing rather than tidiness.
      //
      // Readers treat the presence of `split` as authoritative and branch on it
      // BEFORE looking for a winner — `rfq.service.ts`:
      //
      //     const split = Array.isArray(rec?.split) && rec.split.length > 0 ? ... : null
      //     if (split) return { vendor_id: null, ..., split };
      //     if (!rec.winner_vendor_id) return null;
      //     return { vendor_id: rec.winner_vendor_id, ..., split: null };
      //
      // So a SINGLE carrying a split array would be read as a SPLIT with no
      // winner — silently reverting the whole change. The two shapes are
      // mutually exclusive by that if/else, and this is the key that selects.
      //
      // Nothing is lost by dropping it. The per-line award detail lives in
      // `proc.cs_line_awards`, which is the authoritative record: the D365
      // pricing function and the CS matrix both read the lines from there, not
      // from this array.
      winner_is_new_vendor: isNewVendor(winner.vendor_id, states),
      ...(input.overrodeRank ? { overrode_rank: input.overrodeRank } : {}),
      ...common,
    };
    return {
      awardMode: 'SINGLE',
      recommendation,
      vendors,
      lines,
      winnerVendorId: winner.vendor_id,
      winnerQuote: {
        id: winnerRow.id,
        total_amount: winnerRow.total_amount,
        currency: winnerRow.currency,
        lead_time_days: winnerRow.lead_time_days,
        version: winnerRow.version,
      },
    };
  }

  const recommendation = {
    award_mode: 'SPLIT',
    split: splitShape,
    split_vendor_count: vendors.length,
    split_line_count: awarded.length,
    winner_is_new_vendor: awarded.some((a) => isNewVendor(a.vendor_id, states)),
    ...common,
  };

  return {
    awardMode: 'SPLIT',
    recommendation,
    vendors,
    lines,
    winnerVendorId: null,
    winnerQuote: null,
  };
}