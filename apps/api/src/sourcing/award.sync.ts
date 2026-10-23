// award.sync.ts — the awarded rate, the PR's amount, and the per-line Capex/Opex
// class. One module owns all three, because they are one decision.
//
// WHY THIS IS ITS OWN FILE, AND WHY IT IMPORTS NOTHING
// -----------------------------------------------------
// pr.service.ts imports the cost policy (../pr/cost.stages). If this module
// imported anything back from pr.service.ts, the two would form a cycle, and
// under CommonJS a partial init yields `undefined` at first use — which looks
// exactly like the bug you were fixing. cost.stages.ts's header documents the
// same trap. So this file imports NOTHING from the services. It takes a `run`
// function (the transaction handle) and a PR id, and it owns the rules.
//
// The one import below is `./recommendation.shape` — a leaf module in this same
// folder that imports nothing at all. It is where the SINGLE/SPLIT shape lives,
// because the legacy CS lock decides the same thing and the two must not be
// free to disagree (they were: one wrote SINGLE, this one wrote SPLIT
// unconditionally, and a one-vendor statement was stored as a split).
//
// THE APPROVED-LINE RULE
// ----------------------
// A line is IN the spend when it is approved and neither rejected nor held:
//
//     approved = true AND rejected = false AND held = false
//
// A held line is not being bought in this round. It never went out to vendors,
// so it never had a rate, and demanding one is a constraint against a line that
// does not exist yet — the state Case 16's line 3 was in for the whole of its
// life. The cost gate, the header total and the D365 payload all read the
// spend through THIS predicate, so they cannot disagree about which lines
// count.
//
// WHY THE AWARD IS WRITTEN BACK INTO unit_price_est
// --------------------------------------------------
// The cost gate asks the header whether the amount is known, and the header
// asks the lines. The winning rate exists — proc.cs_line_awards carries it,
// and the D365 push already prefers it over the estimate — but it was never
// written to proc.pr_lines, so the header stayed at 0 / UNKNOWN and the gate
// refused the PR forever. Writing it back is what lets a free-text request
// with no price at creation reach the cost centre.
//
// The requester's own budget guess is preserved in `budget_unit_price` at the
// moment of the first sync, because the Cost approval screen exists to compare
// a budget against a commitment. Overwriting the estimate without keeping the
// budget would quietly delete that comparison.

// The recommendation shape — SINGLE or SPLIT, and the vendor keys each one
// carries — is owned by a leaf module so that this file and the legacy CS lock
// cannot invent two answers again. A leaf in the SAME folder: no service is
// imported, so the cycle the header warns about stays impossible.
import { buildAwardRecommendation, type Run } from './recommendation.shape';

/** The transaction handle. Re-exported so existing importers are unaffected. */
export type { Run };

/**
 * The SQL predicate for "this line is part of the spend". Kept as one string
 * so the three places that need it cannot drift apart.
 */
export const APPROVED_LINE = 'pl.approved = true AND pl.rejected = false AND pl.held = false';

export type PrTotals = {
  /** Σ(qty × unit price) over the approved lines. */
  estimated_amount: number;
  /** The part of the spend that is capitalised. */
  capex_amount: number;
  /** The part of the spend that is operating. */
  opex_amount: number;
  amount_status: 'ESTIMATED' | 'UNKNOWN';
  /**
   * The header's Capex/Opex summary, derived from the SAME approved classified
   * lines as the two amounts above.
   *
   * It used to be absent here entirely, while `proc.fn_compute_pr_totals`
   * wrote the column from `core.items` — so the money followed the desk's
   * classification and the LABEL followed the catalogue, and no test could see
   * it because each owner was correct in isolation. Four readers took that
   * column, including `d365.service.ts` (`pr.expense_type AS expense_split`),
   * which maps it onto the ERP's PurchaseType. An all-CAPEX request was pushed
   * to F&O as "Operating Expense".
   *
   * A capital line without a depreciation period is refused by
   * `pr_lines_capex_needs_life_ck`, so a CAPEX header here always has assets
   * behind it.
   */
  expense_type: 'CAPEX' | 'OPEX' | 'MIXED';
  /** How many lines the spend is made of. */
  approved_lines: number;
  /** Approved lines with no price — the cost gate's list. */
  unpriced_lines: number[];
  /** Approved lines with no Capex/Opex class — the CS gate's list. */
  unclassified_lines: number[];
};

/**
 * Recompute the PR's money from its approved lines and write it back.
 *
 * The amount_status rule: the spend is ESTIMATED only when every approved line
 * carries a price. "Some lines are priced" is not a known amount, it is a
 * partial one, and the old rule (`any line priced` ⇒ ESTIMATED) stored the
 * total of the priced lines as if it were the whole — a confident, understated
 * number. The web screen already refused to print that; this makes the stored
 * header agree with it.
 *
 * A PR with no approved lines at all is UNKNOWN, not zero: there is nothing
 * to confirm, and the cost gate is right to refuse it.
 */
export async function syncPrTotals(run: Run, prId: string): Promise<PrTotals> {
  // The SUMS are done in the database, where numeric is exact, and come back
  // as strings that the CSV bridge leaves as text.
  //
  // The LISTS are NOT array_agg. psql --csv returns every column as text, so
  // an aggregated array arrives as the Postgres literal "{1,2}" and a
  // `.map()` on it throws at runtime. One row per line, with two boolean
  // columns, travels safely and needs no parsing on this side.
  const res = await run<any>(
    `SELECT
       COALESCE(SUM(pl.quantity * pl.unit_price_est), 0) AS total,
       COALESCE(SUM(pl.quantity * pl.unit_price_est)
                FILTER (WHERE pl.classification LIKE 'CAPEX%'), 0) AS capex,
       COALESCE(SUM(pl.quantity * pl.unit_price_est)
                FILTER (WHERE pl.classification LIKE 'OPEX%'), 0) AS opex,
       count(*) AS approved_lines
     FROM proc.pr_lines pl
    WHERE pl.pr_id = $1
      AND ${APPROVED_LINE}`,
    [prId],
  );
  const row = res.rows[0] || {};

  const flagged = await run<any>(
    `SELECT pl.line_no,
            (pl.unit_price_est IS NULL) AS unpriced,
            (pl.classification IS NULL) AS unclassified,
            pl.classification
       FROM proc.pr_lines pl
      WHERE pl.pr_id = $1
        AND ${APPROVED_LINE}
      ORDER BY pl.line_no`,
    [prId],
  );

  const approvedLines = Number(row.approved_lines || 0);
  const unpriced: number[] = (flagged.rows || [])
    .filter((r: any) => r.unpriced === true)
    .map((r: any) => Number(r.line_no));
  const unclassified: number[] = (flagged.rows || [])
    .filter((r: any) => r.unclassified === true)
    .map((r: any) => Number(r.line_no));

  // THE HEADER'S SPLIT, FROM THE SAME ROWS AS THE MONEY.
  //
  // The desk's classification wins wherever it exists. Only when NOT ONE
  // approved line has been classified does the item master answer — because
  // before the CS exit there is no human decision to defer to, and migration
  // 046 already fixed the totals-derived rule that used to call an unpriced
  // laptop an operating expense.
  //
  // The database has this exact rule as `proc.fn_header_expense_type`, written
  // by migration 074 so the stored rows and this live path cannot drift. It is
  // called rather than re-typed: two implementations of one rule is how the
  // header and the lines came apart in the first place. It is a single-row,
  // index-friendly aggregate over the same predicate.
  const expenseType = (await run<{ expense_type: string }>(
    `SELECT proc.fn_header_expense_type($1::uuid) AS expense_type`,
    [prId],
  )).rows[0]?.expense_type;

  const amountStatus: 'ESTIMATED' | 'UNKNOWN' =
    approvedLines > 0 && unpriced.length === 0 ? 'ESTIMATED' : 'UNKNOWN';

  const totals: PrTotals = {
    estimated_amount: Number(row.total || 0),
    capex_amount: Number(row.capex || 0),
    opex_amount: Number(row.opex || 0),
    amount_status: amountStatus,
    expense_type: (expenseType === 'CAPEX' || expenseType === 'MIXED' ? expenseType : 'OPEX') as
      'CAPEX' | 'OPEX' | 'MIXED',
    approved_lines: approvedLines,
    unpriced_lines: unpriced,
    unclassified_lines: unclassified,
  };

  // The database constrains UNKNOWN to a zero amount
  // (prs_amount_status_coherent), because a 0 that claims to be an estimate is
  // the lie this whole mechanism exists to prevent. The API presents the
  // header as "not set yet" whenever the status is UNKNOWN, so the user is
  // told the truth even though the column is a number.
  await run(
    `UPDATE proc.purchase_requisitions
        SET estimated_amount = $2,
            capex_amount    = $3,
            opex_amount     = $4,
            amount_status   = $5,
            expense_type    = $6,
            last_updated_at = now()
      WHERE id = $1`,
    [
      prId,
      amountStatus === 'ESTIMATED' ? totals.estimated_amount : 0,
      totals.capex_amount,
      totals.opex_amount,
      amountStatus,
      totals.expense_type,
    ],
  );

  return totals;
}

export type AwardedLine = {
  pr_line_id: string;
  line_no: number;
  pr_unit_price: number | null;
  budget_unit_price: number | null;
  awarded_unit_price: number | null;
  awarded_qty: number | null;
  vendor_id: string | null;
  approved: boolean;
  rejected: boolean;
  held: boolean;
};

export type AwardSyncResult = {
  /** Lines whose price was written. */
  synced: number[];
  /** Approved lines with no live award — nobody won them. */
  unawarded_lines: number[];
  /** Lines where more than one vendor won a share of the same line. */
  split_lines: number[];
  totals: PrTotals;
};

/**
 * LOCK THE STATEMENT.
 *
 * The CS review chain's confirm() is the other way a statement gets decided,
 * and until now it did NOT lock it: it set the review row to CONFIRMED and
 * moved the PR, leaving `comparative_statements` in state 'Generated' with a
 * NULL recommendation. Thirty-five requests are sitting at Cost approval right
 * now with a statement that was decided but never locked.
 *
 * That is not a tidiness problem. The D365 push reads the winners from a
 * LOCKED statement:
 *
 *   SELECT ... FROM proc.comparative_statements
 *    WHERE pr_id = $1 AND cs_round = fn_latest_cs_round($1) AND state = 'Locked'
 *
 * with an INNER JOIN on the recommendation. A statement that was never locked
 * produces NO ROW — not an error, an empty result — so the purchase order
 * pushes with no vendor on it, and the line prices fall back to the request's
 * own estimate. The push looks successful and the vendor is missing.
 *
 * The award is per LINE here (proc.cs_line_awards is the record), so the
 * recommendation is SPLIT-shaped: a split array of the lines and their
 * winners, and NO winner_vendor_id, because a per-line award genuinely has no
 * single winner. The database refuses a locked SPLIT that claims one
 * (comparative_statements_split_consistency), and the D365 push reads the
 * split array directly.
 *
 * The RFQ is deliberately NOT moved to 'Awarded' here. The review path closes
 * it at the forward, and the reissue flow owns reopening it for a second
 * round; a lock that took the RFQ out of its owner's hands would make round
 * two unreachable. The legacy CS lock does move it, because that route runs
 * the governance branch, which has no second round.
 */
export async function lockStatementWithAward(
  run: Run,
  args: { csId: string; userId: string; reason: string },
): Promise<{ awardMode: 'SINGLE' | 'SPLIT'; vendors: string[]; lines: number[] }> {
  const res = await run<any>(
    `SELECT a.rfq_line_no, a.vendor_id, a.awarded_qty, a.justification, a.award_round,
            v.legal_name, v.vendor_code
       FROM proc.cs_line_awards a
       JOIN proc.comparative_statements cs ON cs.id = a.cs_id
       JOIN core.vendors v ON v.id = a.vendor_id
      WHERE a.cs_id = $1::uuid AND a.superseded_at IS NULL
      ORDER BY a.rfq_line_no, a.awarded_qty DESC`,
    [args.csId],
  );

  const lineAwards = (res.rows || []).map((a: any) => ({
    line_no: Number(a.rfq_line_no),
    vendor_id: a.vendor_id,
    vendor_name: a.legal_name,
    vendor_code: a.vendor_code,
    awarded_qty: Number(a.awarded_qty),
    justification: a.justification ?? null,
    award_round: Number(a.award_round),
  }));

  if (!lineAwards.length) {
    throw new Error(
      'This statement has no live award, so it cannot be locked. Award the lines first.',
    );
  }

  // Which lines the award must account for. The CS may have been regenerated
  // since its lines were awarded, and a lock that ignored that would record a
  // decision over a line set that no longer exists.
  const rfqLineNos = await run<{ line_no: number }>(
      `SELECT l.line_no
         FROM proc.rfq_lines l
        WHERE l.rfq_id = (SELECT cs.rfq_id FROM proc.comparative_statements cs WHERE cs.id = $1::uuid)
        ORDER BY l.line_no`,
      [args.csId],
    );

  const prRouting = await run<{ routing_key: string }>(
    `SELECT routing_key FROM proc.purchase_requisitions
      WHERE id = (SELECT pr_id FROM proc.comparative_statements WHERE id = $1::uuid)`,
    [args.csId],
  );

  // THE SHAPE IS DECIDED IN ONE PLACE. This used to write
  // `award_mode: 'SPLIT'` unconditionally, so a statement where one vendor won
  // every line was stored as a split: no `winner_vendor_id`, and no
  // `winner_quotation_id` at all. The D365 push reads that key for a PO's
  // TotalAmount, so with it absent the push fell back to the REQUEST'S OWN
  // ESTIMATE — a budget presented to the ERP as a commitment.
  //
  // Called BEFORE the winners' quotations are flipped to 'Awarded' below: the
  // builder resolves the winning quotation, and the flip would change which rows
  // it can see.
  const decision = await buildAwardRecommendation(run, {
    csId: args.csId,
    lineAwards,
    rfqLineNos: rfqLineNos.rows.map((l) => Number(l.line_no)),
    reason: args.reason,
    overrideReason: null,
    // The routing key of the request this statement belongs to. Read, never
    // derived: where that key COMES FROM is a separate defect (the light flow
    // hardcodes 'STANDARD'), and fixing it here would hide that rather than fix
    // it. On a SPLIT there is no winner_total to carry it, which is why the
    // original wrote null.
    routingKey: prRouting.rows[0]?.routing_key ?? null,
    lockedVia: 'cs_review_confirm',
  });

  const { recommendation, vendors } = decision;

  // What the statement looked like BEFORE this lock, for the audit row.
  //
  // READ, not asserted. The old row hardcoded
  // `{ state: 'Generated', award_mode: 'SINGLE' }` — a claim about a value
  // nobody had looked at, and on this very path the stored mode was SPLIT, so
  // every lock this module performed was audited as having replaced a SINGLE.
  const before = await run<{ state: string; award_mode: string | null }>(
    `SELECT state, award_mode FROM proc.comparative_statements WHERE id = $1::uuid`,
    [args.csId],
  );

  await run(
    `UPDATE proc.comparative_statements
        SET state = 'Locked',
            locked_at = now(),
            locked_by_user_id = $2::uuid,
            award_mode = $4,
            recommendation = $3::jsonb
      WHERE id = $1::uuid`,
    [args.csId, args.userId, JSON.stringify(recommendation), decision.awardMode],
  );

  // The winners' quotes become the awarded ones and the rest are rejected —
  // per VENDOR, not per line, so a vendor who won one line is not recorded as
  // having lost the others.
  await run(
    `UPDATE proc.quotations SET state = 'Awarded'
      WHERE id IN (
        SELECT DISTINCT ON (vendor_id) id
          FROM proc.quotations
         WHERE rfq_id = (SELECT rfq_id FROM proc.comparative_statements WHERE id = $1::uuid)
           AND state = 'Submitted'
           AND vendor_id = ANY($2::uuid[])
         ORDER BY vendor_id, version DESC)`,
    [args.csId, vendors],
  );
  await run(
    `UPDATE proc.quotations SET state = 'Rejected'
      WHERE rfq_id = (SELECT rfq_id FROM proc.comparative_statements WHERE id = $1::uuid)
        AND NOT (vendor_id = ANY($2::uuid[]))
        AND state = 'Submitted'`,
    [args.csId, vendors],
  );

  // The lock itself is audited, exactly as the legacy CS lock audits its own.
  // "The act of locking the CS — the decision that goes to the committee and
  // becomes the approved pack — wrote no audit row at all" was the gap the
  // legacy lock's own entry was written to close, and the review path is the
  // other way a statement gets decided. A decision that is not audited is a
  // decision nobody can account for.
  //
  // The ACTION stays `cs_split_lock` even when the decision is a SINGLE. It is
  // the only action the audit vocabulary has for "a comparative statement was
  // locked" (migration 042's post-condition asserts it must survive), and
  // widening that CHECK would mean restating the canon in three migrations to
  // relabel one verb. The mode is not lost — it is in `after.award_mode`, and
  // in every `winner_*` key that shape carries.
  await run(
    `INSERT INTO audit.audit_log
       (actor_user_id, entity, entity_id, action, before, after, reason)
     VALUES ($1::uuid, 'proc.comparative_statements', $2::text, 'cs_split_lock',
             $3::jsonb, $4::jsonb, $5)`,
    [
      args.userId,
      args.csId,
      JSON.stringify({
        state: before.rows[0]?.state ?? null,
        award_mode: before.rows[0]?.award_mode ?? null,
      }),
      JSON.stringify(recommendation),
      args.reason,
    ],
  );

  return { awardMode: decision.awardMode, vendors, lines: decision.lines };
}

/**
 * The live awards on a statement, joined to the PR lines they price.
 *
 * `superseded_at IS NULL` is the live award: a re-award supersedes its
 * predecessor rather than deleting it, so the history stays and only the
 * current decision is read. The PR line is reached through
 * proc.rfq_lines.pr_line_id, which is the FK the RFQ was built from — not
 * through a line_no guess.
 *
 * The rate comes from the winning vendor's newest LIVE quotation for that RFQ
 * line. That is the same join the D365 payload uses, so the rate written onto
 * the PR line and the rate pushed to D365 are the same number rather than two
 * numbers that happen to agree today.
 */
export async function readAwardedLines(run: Run, csId: string): Promise<AwardedLine[]> {
  const res = await run<any>(
    `SELECT DISTINCT ON (pl.id)
            pl.id AS pr_line_id,
            pl.line_no,
            pl.unit_price_est AS pr_unit_price,
            pl.budget_unit_price,
            ql.unit_price AS awarded_unit_price,
            a.awarded_qty,
            a.vendor_id,
            pl.approved, pl.rejected, pl.held,
            (SELECT count(*) FROM proc.cs_line_awards a2
              WHERE a2.cs_id = cs.id AND a2.superseded_at IS NULL
                AND a2.rfq_line_no = a.rfq_line_no) AS vendors_on_line
       FROM proc.comparative_statements cs
       JOIN proc.cs_line_awards a
         ON a.cs_id = cs.id AND a.superseded_at IS NULL
       JOIN proc.rfq_lines l
         ON l.rfq_id = cs.rfq_id AND l.line_no = a.rfq_line_no
       JOIN proc.pr_lines pl
         ON pl.id = l.pr_line_id
       LEFT JOIN LATERAL (
            SELECT q2.id
              FROM proc.quotations q2
             WHERE q2.rfq_id = cs.rfq_id
               AND q2.vendor_id = a.vendor_id
               AND q2.state IN ('Submitted','Awarded')
             ORDER BY q2.version DESC LIMIT 1
       ) q ON true
       LEFT JOIN proc.quotation_lines ql
         ON ql.quotation_id = q.id AND ql.rfq_line_no = a.rfq_line_no
      WHERE cs.id = $1
      ORDER BY pl.id, a.awarded_qty DESC NULLS LAST, a.vendor_id`,
    [csId],
  );
  return res.rows as AwardedLine[];
}

/**
 * Write the winning rates onto the PR lines and recompute the header.
 *
 * A held or rejected line is not written: it is not part of the spend, and a
 * rate on it would put a number in front of somebody for something nobody is
 * buying. A line with no award keeps its existing price — the function
 * reports it as unawarded so the caller can refuse the confirmation rather
 * than silently advancing a PR whose competition produced nothing.
 */
export async function applyAwardToPrLines(
  run: Run,
  args: { prId: string; csId: string },
): Promise<AwardSyncResult> {
  // ONE statement, and therefore one transaction.
  //
  // The write is "put the rate on the line" and then "recompute the header
  // from the lines", and the second depends on the first. The API's transport
  // runs each statement in its OWN transaction — DbService.withTransaction()
  // says so in its own header — so doing this as two statements would leave a
  // priced line and a stale header behind if the second one failed. It did:
  // the first run of the backfill wrote the rates, threw, and left exactly
  // that.
  //
  // proc.fn_apply_award_to_pr_lines does both in one call, so it is atomic for
  // the same reason any other statement is. The rule lives in ONE place, and
  // the API, the backfill script and any future caller all reach that one
  // place.
  const res = await run<any>(
    `SELECT * FROM proc.fn_apply_award_to_pr_lines($1::uuid, $2::uuid)`,
    [args.prId, args.csId],
  );
  const row = res.rows[0] || {};

  // The lists come back as jsonb, which the CSV bridge hands over as TEXT.
  const list = (v: any): number[] => {
    if (v === null || v === undefined) return [];
    if (Array.isArray(v)) return v.map(Number);
    try {
      const parsed = JSON.parse(String(v));
      return Array.isArray(parsed) ? parsed.map(Number) : [];
    } catch {
      return [];
    }
  };

  // `fn_apply_award_to_pr_lines` writes the money and deliberately does NOT
  // write expense_type: stamping a class is a DECISION, and this path is a
  // money repair — the same rule `reapplyAward` follows. The header's class is
  // written by the classification path (`syncPrTotals`) and by migration 074's
  // repair.
  //
  // So it is READ here rather than re-derived, from the one function that owns
  // the rule. Returning the stored value instead would hand the caller a
  // PrTotals whose own field contradicts the row it just wrote.
  const derivedType = (await run<{ expense_type: string }>(
    `SELECT proc.fn_header_expense_type($1::uuid) AS expense_type`,
    [args.prId],
  )).rows[0]?.expense_type;

  const totals: PrTotals = {
    estimated_amount: Number(row.estimated_amount || 0),
    capex_amount: Number(row.capex_amount || 0),
    opex_amount: Number(row.opex_amount || 0),
    amount_status: row.amount_status === 'ESTIMATED' ? 'ESTIMATED' : 'UNKNOWN',
    expense_type: (derivedType === 'CAPEX' || derivedType === 'MIXED' ? derivedType : 'OPEX') as
      'CAPEX' | 'OPEX' | 'MIXED',
    approved_lines: Number(row.approved_lines || 0),
    unpriced_lines: list(row.unpriced_lines),
    unclassified_lines: list(row.unclassified_lines),
  };

  return {
    synced: list(row.synced_lines),
    unawarded_lines: list(row.unawarded_lines),
    split_lines: list(row.split_lines),
    totals,
  };
}

/**
 * The lines the CS gate is about: approved lines with no Capex/Opex class.
 *
 * Read from the LINE, not from the header, because the header carries a
 * single expense_type that the requester chose at creation and that is
 * derived from the catalogue item. It is a statement about the request, not
 * about each line, and it cannot answer "is this laptop capitalised".
 */
export async function unclassifiedApprovedLines(run: Run, prId: string): Promise<number[]> {
  // One row per line, not array_agg: the CSV bridge returns an aggregated
  // array as the Postgres literal "{1,2}", and `.map()` on that throws.
  const res = await run<any>(
    `SELECT pl.line_no
       FROM proc.pr_lines pl
      WHERE pl.pr_id = $1
        AND ${APPROVED_LINE}
        AND pl.classification IS NULL
      ORDER BY pl.line_no`,
    [prId],
  );
  return (res.rows || []).map((r: any) => Number(r.line_no));
}

/**
 * The approved lines of a PR, with the facts both gates need.
 *
 * One query for both gates, so the cost gate and the Capex/Opex gate are
 * looking at the same set of lines and cannot be talking past each other.
 */
export async function readApprovedLines(
  run: Run,
  prId: string,
): Promise<
  Array<{
    line_no: number;
    description: string | null;
    unit_price_est: number | null;
    classification: string | null;
  }>
> {
  const res = await run<any>(
    `SELECT pl.line_no, pl.description, pl.unit_price_est, pl.classification
       FROM proc.pr_lines pl
      WHERE pl.pr_id = $1
        AND ${APPROVED_LINE}
      ORDER BY pl.line_no`,
    [prId],
  );
  return (res.rows || []).map((r: any) => ({
    line_no: Number(r.line_no),
    description: r.description ?? null,
    unit_price_est: r.unit_price_est === null ? null : Number(r.unit_price_est),
    classification: r.classification ?? null,
  }));
}

/**
 * The state the COST-APPROVAL GATE reads.
 *
 * The gate asks two questions: does the header say the amount is known, and
 * which lines carry no price? Both are now answered over APPROVED lines only.
 * A held line is not being bought, so it cannot block the confirmation of the
 * spend on the lines that are.
 */
export async function readAmountGateState(
  run: Run,
  prId: string,
): Promise<{ amount_status: string; unpriced_lines: number[] }> {
  // Two plain reads, no array_agg: the CSV bridge returns an aggregated array
  // as the Postgres literal "{1,2}", which is a string and not a list.
  const head = await run<any>(
    `SELECT amount_status FROM proc.purchase_requisitions WHERE id = $1`,
    [prId],
  );
  const unpriced = await run<any>(
    `SELECT pl.line_no
       FROM proc.pr_lines pl
      WHERE pl.pr_id = $1
        AND ${APPROVED_LINE}
        AND pl.unit_price_est IS NULL
      ORDER BY pl.line_no`,
    [prId],
  );
  return {
    amount_status: String(head.rows[0]?.amount_status || 'UNKNOWN'),
    unpriced_lines: (unpriced.rows || []).map((r: any) => Number(r.line_no)),
  };
}

/**
 * The moment the Capex/Opex gate was armed.
 *
 * The gate is FORWARD-ONLY: a PR that was already in the CS review chain when
 * the gate went live is not held to it. Without that, every PR that had
 * already passed step 5 would be refused at a gate it was never subject to —
 * which is not a gate, it is a retrospective demand.
 *
 * The review row's created_at is the moment the PR entered the chain, which
 * is the moment the gate has to be measured from.
 */
export async function readCapexOpexGateFrom(run: Run): Promise<Date | null> {
  const res = await run<any>(
    `SELECT value FROM core.settings WHERE key = 'capex_opex_gate_from'`,
  );
  const raw = res.rows[0]?.value;
  if (!raw) return null;
  const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const d = new Date(parsed);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * When the PR last entered a stage.
 *
 * The forward-only gate has to be measured from the moment the PR ENTERED the
 * gated step, not from the moment the gate was armed: a PR that was already
 * sitting in the step when the gate went live is exempt, and one that arrived
 * afterwards is not.
 *
 * The audit log carries every status transition with the full row in `after`,
 * so the answer is the most recent transition whose `after.status` is the
 * stage in question.
 */
export async function readStageEnteredAt(
  run: Run,
  prId: string,
  stage: string,
): Promise<Date | null> {
  const res = await run<any>(
    `SELECT max(au.ts) AS entered_at
       FROM audit.audit_log au
      WHERE au.entity = 'proc.purchase_requisitions'
        AND au.entity_id = $1
        AND au.after->>'status' = $2`,
    [prId, stage],
  );
  const raw = res.rows[0]?.entered_at;
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Is the forward-only gate in force for this PR at this stage?
 *
 * No gate_from setting means the gate is always in force (somebody has turned
 * it on by hand, or the setting was removed). A PR that entered the stage
 * before the gate was armed is exempt.
 */
export async function capexOpexGateApplies(
  run: Run,
  args: { prId: string; stage: string },
): Promise<boolean> {
  const gateFrom = await readCapexOpexGateFrom(run);
  if (!gateFrom) return true;
  const enteredAt = await readStageEnteredAt(run, args.prId, args.stage);
  if (!enteredAt) return true;
  return enteredAt.getTime() >= gateFrom.getTime();
}
