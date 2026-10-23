import { Injectable, NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { DbService, type SessionContext } from '../db/db.service';
import { roleAllowed } from '@procurement/roles';
import { scoreCs, type CsWeights, type ScoredVendor } from './cs.scoring';
import { lockPack } from '../governance/pack.lock';
// cs.scores is jsonb, and DbService executes SQL through a CSV bridge, so it
// arrives as a STRING. Without this the parse silently yields undefined and
// every downstream lookup returns "not found" rather than an error.
import { parseJsonb } from './rfq.status';
import { CsReviewService } from './cs.review.service';
import { CS_DRAFT_STAGES, isCsDraftStage } from './cs.stages';
// Where the SINGLE/SPLIT decision is made. Shared with the CS review chain's
// confirm(), because the two locks used to answer this differently — one reasoned
// from the matrix winner, the other hardcoded SPLIT — and a one-vendor statement
// stored as a split left the D365 push with no quotation to take a PO total from.
import { buildAwardRecommendation } from './recommendation.shape';

type Ctx = SessionContext;

/**
 * The schema's own default. We omit `weights` on INSERT so the DB applies this,
 * but the service needs it in order to score, so it is read back and parsed
 * rather than hardcoded in two places that could drift.
 */
const FALLBACK_WEIGHTS: CsWeights = { commercial: 0.6, technical: 0.3, warranty: 0.1 };

/** The prototype's "Target ≥ 3 per RFQ". Below this we warn, we do not block. */
export const RECOMMENDED_QUOTES = 3;

/** Only Procurement / CS may generate or lock the CS (csLock, line 7199). */
const CS_ROLES = 'procurement,cs';

/**
 * The stages a Comparative Statement may be BUILT at.
 *
 * Both are real and both are load-bearing. IN_PROCUREMENT_REVIEW is where
 * procurement owns the competition. QUOTES_RECEIVED is where the "Ready for CS"
 * hand-off (migration 064) parks the PR, and 56 of the 813 existing statements
 * were generated there — the CS is generated AFTER the hand-off, not before it.
 *
 * Restricting this to procurement review alone would have refused the normal
 * flow, which is why the set is stated rather than inferred.
 */
export { CS_DRAFT_STAGES, isCsDraftStage };

/**
 * The stages a Comparative Statement may be LOCKED at. A lock records a
 * decision against a live competition, so every stage from CS_LOCKED onward is
 * excluded: the decision is already taken there, or the request has left
 * sourcing entirely.
 */
const CS_LOCK_STAGES = CS_DRAFT_STAGES;

@Injectable()
export class CsService {
  constructor(
    private readonly db: DbService,
    // The blind-review scope lives in CsReviewService, which owns the chain.
    // CsService asks it "is this viewer the blind reviewer right now?" and
    // strips the payload; it does not re-implement the scoping, because two
    // copies of "who may see what" is how a control starts disagreeing with
    // itself.
    private readonly review: CsReviewService,
  ) {}

  // ── POST /pr/:id/cs ──────────────────────────────────────────────────────
  /**
   * Generate the Comparative Statement.
   *
   * Creates the CS header in state 'Generated' plus one `cs_lines` row per
   * live vendor quote, carrying REAL scores (see cs.scoring.ts). It does NOT
   * pick a winner: the prototype's CS screen offers "Recommend <vendor>"
   * buttons, so the choice is a human's and it is recorded at LOCK time.
   *
   * `comparative_statements` is UNIQUE(pr_id, cs_round), so one round records
   * one decision and a second round is an INSERT rather than an overwrite.
   * Wave 3 decision 2A: when the MC rejects, the PR returns to sourcing and the
   * next generate() opens round 2 — the rejected round is preserved as evidence
   * of what was objected to, not deleted.
   */
  async generate(prId: string, userId: string, role: string, costCenterIds: string[]) {
    if (!roleAllowed(role, CS_ROLES)) {
      throw new ForbiddenException('Only Procurement / CS can lock the CS.');
    }
    const ctx = { userId, role, costCenterIds };

    const pr = await this.db.query<any>(
      `SELECT pr.id, pr.pr_number, pr.status, pr.routing_key, pr.expense_type
              AS expense_split, pr.currency, pr.estimated_amount
         FROM proc.purchase_requisitions pr
        WHERE pr.id = $1::uuid`,
      [prId],
      ctx,
    );
    if (pr.rows.length === 0) throw new NotFoundException('PR not found');
    const p = pr.rows[0];

    // STAGE GATE (migration 065). A comparative statement is built from a
    // competition that is still live, so the PR must still be in sourcing.
    //
    // Neither generate() nor lock() checked the PR's stage before this, which
    // is how five PRs ended up sitting at IN_PROCUREMENT_REVIEW with a Locked
    // CS: the statement was locked against a stage the lock was never meant to
    // be taken from and nothing refused it.
    //
    // BOTH live stages are admitted, and that is measured, not assumed:
    //   IN_PROCUREMENT_REVIEW — procurement still owns the competition.
    //   QUOTES_RECEIVED       — the "Ready for CS" hand-off (migration 064)
    //                           parks the PR here, and the CS is generated at
    //                           this stage for 56 of the 813 existing
    //                           statements. Gating on procurement review alone
    //                           would have refused the normal flow.
    //
    // Everything from CS_LOCKED onward is refused: the decision has been taken
    // or the request has left sourcing entirely.
    if (!CS_DRAFT_STAGES.includes(String(p.status))) {
      throw new BadRequestException(
        `${p.pr_number} is at ${p.status}; a Comparative Statement is built from a live ` +
        `competition, so it can only be generated at ${CS_DRAFT_STAGES.join(' or ')}.`,
      );
    }

    const quotes = await this.liveQuotes(prId, ctx);
    if (quotes.length === 0) {
      // csLock's own gate, verbatim: 'Quotes not yet received.'
      throw new BadRequestException('Quotes not yet received.');
    }

    // Decision 2A: the CS is per-ROUND, not per-PR. A fresh round is allowed
    // only when the committee actually sent the last one back — that is, the
    // live round is Locked AND the PR has been returned to sourcing. In every
    // other case a new CS would overwrite a decision that still stands.
    const existing = await this.db.query<any>(
      `SELECT cs.id, cs.cs_number, cs.cs_round, cs.state, cs.locked_at, pr.status,
              (SELECT cr.revert_kind
                 FROM proc.cs_reviews cr
                WHERE cr.cs_id = cs.id AND cr.current_round = cs.cs_round
                  AND cr.sub_state = 'REVERTED') AS hard_reverted
         FROM proc.comparative_statements cs
         JOIN proc.purchase_requisitions pr ON pr.id = cs.pr_id
        WHERE cs.pr_id = $1::uuid
          AND cs.cs_round = proc.fn_latest_cs_round($1::uuid)`,
      [prId],
      ctx,
    );
    if (existing.rows.length > 0) {
      const e = existing.rows[0];
      const sentBack = e.state === 'Locked' && e.status === 'QUOTES_RECEIVED';
      // A HARD revert (migration 065) withdraws the statement so a fresh round
      // can be solicited. The statement row itself is deliberately left as it
      // was — its state CHECK only admits Generated/Locked, and the chain is
      // meant to live in proc.cs_reviews — so the withdrawal is read from the
      // review row rather than from comparative_statements.
      const withdrawn = e.hard_reverted === 'HARD';
      if (!sentBack && !withdrawn) {
        throw new BadRequestException(
          `a Comparative Statement already exists for this PR (${e.cs_number} round ${e.cs_round}, ` +
          `${e.state}) — UNIQUE(pr_id, cs_round) records one decision per round`,
        );
      }
    }

    // The CS is now line-addressable (W5-F: the comparative matrix and split
    // awards are per RFQ LINE), so it records which RFQ it was built from. Every
    // PR carries exactly one RFQ today, but if that ever stops being true the
    // column cannot hold the answer — so this fails loudly instead of writing
    // NULL, because a NULL here renders as a silently EMPTY matrix, which is the
    // worst possible failure: it looks like nobody quoted.
    const rfqIds = [...new Set(quotes.map((q: any) => String(q.rfq_id)))];
    if (rfqIds.length !== 1) {
      throw new BadRequestException(
        `the live quotes for this PR span ${rfqIds.length} RFQs (${rfqIds.join(', ')}). ` +
        `A Comparative Statement is addressed to one RFQ, so this cannot be generated from them.`,
      );
    }

    const scored = scoreCs(
      quotes.map(q => ({
        vendor_id: q.vendor_id,
        vendor_name: q.vendor_name,
        vendor_code: q.vendor_code,
        total_amount: Number(q.total_amount),
        lead_time_days: q.lead_time_days === null ? null : Number(q.lead_time_days),
        warranty_months: q.warranty_months === null ? null : Number(q.warranty_months),
        quotation_id: q.id,
        version: Number(q.version),
      })),
      FALLBACK_WEIGHTS,
    );

    return this.db.withTransaction(ctx, async (run) => {
      const num = await run<{ cs_number: string }>(`SELECT proc.fn_next_cs_number() AS cs_number`);

      // `weights` is deliberately OMITTED so the column default applies —
      // one source of truth for the weighting, in the schema.
      const ins = await run<any>(
        `INSERT INTO proc.comparative_statements
           (cs_number, pr_id, rfq_id, cs_round, generated_at, generated_by_user_id, state, scores)
         VALUES ($1, $2::uuid, $5::uuid,
                 coalesce((SELECT proc.fn_latest_cs_round($2::uuid)), 0) + 1,
                 now(), $3::uuid, 'Generated', $4::jsonb)
         RETURNING id, cs_number, cs_round, state, generated_at`,
        [
          num.rows[0].cs_number, prId, userId,
          JSON.stringify({
            model: 'min-max, 0..100, weighted',
            direction: { commercial: 'lower_is_better', technical: 'lower_is_better', warranty: 'higher_is_better' },
            missing_value_policy: 'a dimension the vendor did not state scores 0 and is listed in missing',
            compliance_scored: false,
            compliance_note: 'D5: compliance is pass/unknown and is never scored',
            quotes_considered: scored.length,
            below_recommended: scored.length < RECOMMENDED_QUOTES,
            ranked: scored.map(s => ({
              rank: s.rank, vendor_id: s.vendor_id, vendor_name: s.vendor_name,
              weighted_score: s.weighted_score, missing: s.missing,
            })),
          }),
          rfqIds[0],
        ],
      );
      const cs = ins.rows[0];

      for (const s of scored) {
        const lr = await run(
          `INSERT INTO proc.cs_lines
             (cs_id, vendor_id, commercial_score, technical_score, warranty_score, weighted_score, rank)
           VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7)
           RETURNING 1`,
          [cs.id, s.vendor_id, s.commercial_score, s.technical_score, s.warranty_score, s.weighted_score, s.rank],
        );
        if (lr.rowCount === 0) throw new BadRequestException('could not record a CS line');
      }

      return {
        cs: {
          id: cs.id,
          cs_number: cs.cs_number,
          // Decision 2A: the round is part of the CS's identity now, and a
          // screen that cannot show it cannot explain why a PR has two CSs.
          cs_round: Number(cs.cs_round || 1),
          pr_id: prId,
          pr_number: p.pr_number,
          state: 'Generated',
          generated_at: cs.generated_at,
        },
        lines: scored,
        recommended: scored.length >= RECOMMENDED_QUOTES
          ? null
          : `Only ${scored.length} quote(s) scored — the prototype targets ${RECOMMENDED_QUOTES} per RFQ`,
        // The prototype's renderCS alert text, kept for the CS screen.
        alert: `${scored.length} quotes scored. Lock the CS to recommend a winner to the MC.`,
      };
    });
  }

  // ── POST /cs/:id/lock ────────────────────────────────────────────────────
  /**
   * Lock the CS and record the winner. Port of `csLock()` (line 7198).
   *
   * THE LOCK IS TERMINAL. `comparative_statements` is UNIQUE(pr_id) and the
   * lock is an UPDATE of that one row, so a second lock has no row to write to
   * and is refused. Nothing ever moves a locked CS back to 'Generated' — the
   * MC's reject path (Wave 3) returns the PR to procurement and a NEW CS is
   * generated once the quotes change, which is why the unique constraint is a
   * feature rather than a limitation.
   *
   * FAST_TRACK: per decision 10 — and the prototype does it at line 7205 —
   * locking the CS on a FAST_TRACK route auto-locks the approved pack, skipping
   * MC and CFO. That coupling lives here, not in the UI.
   *
   * Wave 3 decision 1A: the lock now MOVES the PR. STANDARD and BOARD land on
   * CS_LOCKED (the committee has something to vote on); FAST_TRACK lands on
   * PACK_LOCKED, because the MC and CFO gates are skipped rather than silently
   * approved. Q4's "leave it parked" applied only while no governance stage was
   * storable in the database.
   */
  async lock(
    csId: string,
    userId: string,
    role: string,
    costCenterIds: string[],
    /** Omitted for a split lock (W5-G); the mode comes from the recorded awards. */
    body: { winnerVendorId?: string; reason?: string; overrideReason?: string },
  ) {
    if (!roleAllowed(role, CS_ROLES)) {
      throw new ForbiddenException('Only Procurement / CS can lock the CS.');
    }
    // W5-G: `winnerVendorId` is NOT required up front any more. Whether this is a
    // single-winner or a split lock is decided from the recorded line awards
    // below, which is the only place that holds the evidence. Demanding it here
    // made a split-award CS un-lockable — the one check standing between a
    // correct line-by-line award and a recorded decision.
    const ctx = { userId, role, costCenterIds };

    return this.db.withTransaction(ctx, async (run) => {
      const cs = await run<any>(
        `SELECT cs.id, cs.cs_number, cs.cs_round, cs.pr_id, cs.state, cs.locked_at,
                pr.pr_number, pr.status AS pr_stage, pr.routing_key,
                pr.expense_type AS expense_split,
                pr.currency, pr.estimated_amount, pr.requester_user_id
           FROM proc.comparative_statements cs
           JOIN proc.purchase_requisitions pr ON pr.id = cs.pr_id
          WHERE cs.id = $1::uuid`,
        [csId],
      );
      if (cs.rows.length === 0) throw new NotFoundException('Comparative Statement not found');
      const c = cs.rows[0];

      // Only the LIVE round may be locked. After an MC reject, round 1 is frozen
      // evidence and round 2 is the CS in force; locking round 1 again would
      // re-decide a decision the committee already sent back.
      const latest = await run<{ r: number }>(
        `SELECT proc.fn_latest_cs_round($1::uuid) AS r`, [c.pr_id],
      );
      if (Number(c.cs_round) !== Number(latest.rows[0]?.r ?? 0)) {
        throw new BadRequestException(
          `CS ${c.cs_number} is round ${c.cs_round}, which is no longer in force — ` +
          `a later round superseded it`,
        );
      }

      // Terminal. A locked CS is a record of a decision that was taken.
      if (c.state === 'Locked') {
        throw new BadRequestException(
          `CS ${c.cs_number} was already locked at ${c.locked_at} — locking is terminal`,
        );
      }

      // STAGE GATE (migration 065). lock() never checked the PR's stage, which
      // is how five PRs ended up stranded at IN_PROCUREMENT_REVIEW holding a
      // Locked CS: the decision was recorded against a stage the lock was never
      // meant to be taken from, and nothing refused it.
      //
      // A lock MOVES the PR to CS_LOCKED (or PACK_LOCKED on a fast track). From
      // CS_LOCKED onward the decision already exists, so re-locking is refused
      // by the state check above; this gate refuses it one step earlier, on the
      // stage, so the refusal names the real problem.
      if (!CS_LOCK_STAGES.includes(String(c.pr_stage))) {
        throw new BadRequestException(
          `${c.pr_number} is at ${c.pr_stage}; a Comparative Statement is locked against a ` +
          `live competition, so it can only be locked while the PR is at ${CS_LOCK_STAGES.join(' or ')}.`,
        );
      }

      // THE REVIEW CHAIN OWNS THIS STATEMENT ONCE IT HAS STARTED.
      //
      // lock() moves the PR to CS_LOCKED and hands it to the MC. That is the
      // legacy route, and while a comparative statement is in review it is a
      // BYPASS: procurement would draft it, send it to a blind reviewer, and
      // then press Lock to jump straight into MC governance — skipping both the
      // procurement-manager gate and the originating department's blind sign-off
      // in a single click. The review panel was, in effect, optional.
      //
      // Once a review row exists the ONLY way forward is the chain, ending in
      // CS_CONFIRMED -> IN_COST_CENTER_APPROVAL. Statements that have never
      // entered review — all 390 pre-existing ones — are untouched and keep
      // their original behaviour.
      const reviewState = await this.review.activeReviewState(csId, ctx);
      if (reviewState) {
        throw new BadRequestException(
          `${c.pr_number} is in CS review (${reviewState}). Locking is not available while a ` +
          'statement is under review — the review chain must be confirmed first.',
        );
      }

      // Separation of duties. fn_check_sod is the schema's own opinion: it is
      // true when the voter is NOT the PR's requester. The requester choosing
      // the winner for their own PR defeats the point of a comparative review.
      const sod = await run<{ sod: boolean }>(
        `SELECT proc.fn_check_sod($1::uuid, $2::uuid) AS sod`, [c.pr_id, userId],
      );
      if (sod.rows[0]?.sod !== true) {
        throw new ForbiddenException(
          'separation of duties: the PR requester cannot lock the Comparative Statement',
        );
      }

      // The winner must be a vendor that was actually scored.
      const lines = await run<any>(
        `SELECT l.vendor_id, l.rank, l.weighted_score, l.commercial_score,
                l.technical_score, l.warranty_score,
                v.legal_name, v.vendor_code, v.state AS vendor_state
           FROM proc.cs_lines l
           JOIN core.vendors v ON v.id = l.vendor_id
          WHERE l.cs_id = $1::uuid
          ORDER BY l.rank`,
        [csId],
      );
      if (lines.rows.length === 0) throw new BadRequestException('this CS has no scored lines');

      // ── W5-G: is this CS being locked as ONE winner or as a SPLIT? ─────────
      //
      // The mode is not chosen by the caller. It is decided by the RECORD: if
      // any line carries a live award, the package was split, and the CS must be
      // locked as the split it already is. Letting the caller assert
      // awardMode='SINGLE' over a CS that has per-line awards would let the
      // recorded decision be re-described at lock time, which is exactly the
      // thing an audit trail exists to prevent.
      const liveAwards = await run<any>(
        `SELECT a.rfq_line_no, a.vendor_id, a.awarded_qty, a.justification, a.award_round,
                v.legal_name, v.vendor_code, v.state AS vendor_state
           FROM proc.cs_line_awards a
           JOIN core.vendors v ON v.id = a.vendor_id
          WHERE a.cs_id = $1::uuid AND a.superseded_at IS NULL
          ORDER BY a.rfq_line_no`,
        [csId],
      );
      const isSplit = liveAwards.rows.length > 0;

      let winner: any = null;
      let topRank = lines.rows[0];
      let isOverride = false;
      let split: any[] = [];

      if (isSplit) {
        // Every line must be awarded. A partially-awarded CS is a procurement
        // error, not a partial decision: the un-awarded lines have no winner and
        // the pack would go forward with a hole in it.
        const awardedNos = new Set(liveAwards.rows.map((r: any) => Number(r.rfq_line_no)));
        const rfqLines = await run<any>(
          `SELECT line_no, description, quantity FROM proc.rfq_lines
            WHERE rfq_id = (SELECT rf.id FROM proc.rfq rf
                              JOIN proc.comparative_statements cs ON cs.pr_id = rf.pr_id
                             WHERE cs.id = $1)
            ORDER BY line_no`,
          [csId],
        );
        const missing = rfqLines.rows.filter((l: any) => !awardedNos.has(Number(l.line_no)));
        if (missing.length > 0) {
          throw new BadRequestException(
            `This CS is being locked as a split award, but ${missing.length} line(s) have no ` +
            `winner yet: ${missing.map((l: any) => `#${l.line_no} ${l.description}`).join('; ')}. ` +
            `Award every line, or remove the line awards to lock a single winner instead.`,
          );
        }

        // A winning vendor must be one that was actually scored on this CS.
        // awardLine validates the LINE and the quantity; it does not — and
        // should not — decide whether a vendor was a legitimate bidder, because
        // that is a statement about the CS, not about the line.
        const scoredIds = new Set(lines.rows.map((l: any) => l.vendor_id));
        for (const a of liveAwards.rows as any[]) {
          if (!scoredIds.has(a.vendor_id)) {
            throw new BadRequestException(
              `Line ${a.rfq_line_no} is awarded to ${a.legal_name}, who was not scored on this CS. ` +
              `Re-generate the CS so every bidder is scored before awarding.`,
            );
          }
        }

        split = liveAwards.rows.map((a: any) => ({
          line_no: Number(a.rfq_line_no),
          vendor_id: a.vendor_id,
          vendor_name: a.legal_name,
          vendor_code: a.vendor_code,
          awarded_qty: Number(a.awarded_qty),
          justification: a.justification,
          award_round: Number(a.award_round),
        }));
      } else {
        winner = lines.rows.find((l: any) => l.vendor_id === body.winnerVendorId);
        if (!winner) {
          throw new BadRequestException(
            'the winner must be one of the vendors scored on this CS',
          );
        }

        // An override is an audit event, so it must say why.
        isOverride = winner.rank !== topRank.rank;
        if (isOverride && !(body.overrideReason || '').trim()) {
          throw new BadRequestException(
            `overriding the top-ranked vendor (${topRank.legal_name}, rank ${topRank.rank}) ` +
            `requires an overrideReason`,
          );
        }
      }

      // The CS's RFQ, reached through proc.rfq.pr_id. `comparative_statements`
      // DOES carry its own rfq_id (W5-F, so the matrix can address lines), but
      // this runs inside the same transaction as the INSERT that sets it, so
      // the join below is what is guaranteed to be consistent either way.
      const rfqId = await run<{ rfq_id: string }>(
        `SELECT rf.id AS rfq_id
           FROM proc.rfq rf
           JOIN proc.comparative_statements cs ON cs.pr_id = rf.pr_id
          WHERE cs.id = $1::uuid`,
        [csId],
      );
      const theRfqId = rfqId.rows[0]?.rfq_id;
      if (!theRfqId) throw new BadRequestException('this PR has no RFQ to award against');

      // The winning quotation is resolved by `buildAwardRecommendation` below,
      // which reads `state IN ('Submitted','Awarded')`. This lookup used to sit
      // here filtering `state = 'Submitted'` — correct for THIS route, whose
      // quotation flip runs later in the same transaction, and wrong for the
      // review route, whose flip has already happened by the time it locks. One
      // rule now serves both doors.
      const rfqLineNos = await run<{ line_no: number }>(
        `SELECT line_no FROM proc.rfq_lines WHERE rfq_id = $1::uuid ORDER BY line_no`,
        [theRfqId],
      );

      // ── the recommendation ───────────────────────────────────────────────
      // THE SHAPE IS DECIDED IN ONE PLACE — recommendation.shape.ts, which the
      // CS review chain's confirm() also calls. These two routes used to invent
      // their own answer and they disagreed: this one reasoned from the matrix
      // winner, the review route hardcoded SPLIT unconditionally. One rule now
      // serves both:
      //
      //     SINGLE  iff  exactly one vendor won
      //            AND  that vendor's quotation covers exactly the awarded lines
      //
      // Here that is very nearly the old behaviour — the matrix winner is the
      // only vendor and is taken as covering every line — but it is now derived
      // rather than assumed, and the winning quotation is resolved inside the
      // builder instead of by a second lookup above.
      //
      // A SPLIT carries NO winner_vendor_id. There is no single winner, and the
      // migration's consistency CHECK refuses a row that claims one. Inventing a
      // "lead vendor" to keep the column populated was rejected deliberately:
      // it would attribute the whole winner_total to one vendor and silently
      // inflate their lifetime spend by lines they did not win.
      const decision = await buildAwardRecommendation(run, {
        csId,
        lineAwards: split,
        matrixWinner: winner
          ? { vendor_id: winner.vendor_id, legal_name: winner.legal_name }
          : null,
        rfqLineNos: rfqLineNos.rows.map((l) => Number(l.line_no)),
        reason: body.reason ?? null,
        overrideReason: body.overrideReason ?? null,
        overrodeRank: isOverride ? topRank.vendor_id : null,
        routingKey: c.routing_key || 'STANDARD',
      });
      const recommendation = decision.recommendation;

      // ── the lock itself ──────────────────────────────────────────────────
      const locked = await run<any>(
        `UPDATE proc.comparative_statements
            SET state = 'Locked',
                locked_at = now(),
                locked_by_user_id = $2::uuid,
                recommendation = $3::jsonb,
                award_mode = $5,
                override_reason = $4
          WHERE id = $1::uuid AND state = 'Generated'
        RETURNING id, cs_number, state, locked_at, award_mode`,
        [
          csId, userId,
          JSON.stringify(recommendation),
          body.overrideReason ?? null,
          decision.awardMode,
        ],
      );
      if (locked.rowCount === 0) {
        throw new BadRequestException('the CS changed while you were locking it — reload and try again');
      }

      // W5-G item 4: the WINNER SELECTION itself was never audited. Track F logs
      // each line award and each phone negotiation, but the act of locking the
      // CS — the decision that goes to the MC and becomes the approved pack —
      // wrote no audit row at all. It is the single most consequential write in
      // sourcing, so it gets its own entry with the full before/after.
      await run(
        `INSERT INTO audit.audit_log
           (actor_user_id, entity, entity_id, action, before, after, reason)
         VALUES ($1::uuid, 'proc.comparative_statements', $2::text, $3,
                 $4::jsonb, $5::jsonb, $6)`,
        [
          userId, csId,
          isSplit ? 'cs_split_lock' : 'approve',
          JSON.stringify({ state: 'Generated', award_mode: isSplit ? 'SPLIT' : 'SINGLE' }),
          JSON.stringify(recommendation),
          body.reason
            ?? (isSplit
              ? `CS ${c.cs_number} locked as a split award across ${new Set(split.map((s: any) => s.vendor_id)).size} vendor(s)`
              : `CS ${c.cs_number} locked — winner ${winner.legal_name}`),
        ],
      );

      // Award the winner, reject the rest. The DB vocabulary already has
      // Awarded/Rejected (Q1); this is where those states come from.
      //
      // For a SPLIT this is per VENDOR, not per line: every vendor who won at
      // least one line has an awarded quote, and every vendor who won none is
      // rejected. The previous behaviour — mark exactly one quote 'Awarded' and
      // every other quote 'Rejected' — would have recorded vendor B's live quote
      // as REJECTED on a CS where B had just won line 2.
      const winnerVendorIds = isSplit
        ? [...new Set(split.map((s: any) => s.vendor_id))]
        : [winner.vendor_id];
      await run(
        `UPDATE proc.quotations SET state = 'Awarded'
          WHERE id IN (
            SELECT DISTINCT ON (vendor_id) id
              FROM proc.quotations
             WHERE rfq_id = $1::uuid AND state = 'Submitted'
               AND vendor_id = ANY($2::uuid[])
             ORDER BY vendor_id, version DESC)`,
        [theRfqId, winnerVendorIds],
      );
      await run(
        `UPDATE proc.quotations SET state = 'Rejected'
          WHERE rfq_id = $1::uuid AND NOT (vendor_id = ANY($2::uuid[])) AND state = 'Submitted'`,
        [theRfqId, winnerVendorIds],
      );
      // The RFQ is reached through proc.rfq.pr_id rather than the CS's own
      // rfq_id, which would be a shorter path but would make this UPDATE depend
      // on a column a lock written before W5-F may not have populated. The join
      // holds for every historical row.
      // `Closed` is admitted here as well as `Open`, and the reason is the
      // hand-off (migration 064). Procurement now closes the RFQ the moment it
      // forwards the PR to CS, so by the time the committee locks, the RFQ reads
      // `Closed` — and this UPDATE was `AND state = 'Open'`, so it matched ZERO
      // rows and the RFQ stayed `Closed` forever after a successful award.
      //
      // That failure is silent: the lock still moved the PR to CS_LOCKED and the
      // comparative statement still recorded a winner, so every screen looked
      // correct while the RFQ never reached `Awarded` — the state the MC-rejection
      // reopen keys on (governance.service sets `Awarded` -> `Open`). Round 2
      // would have been unreachable.
      //
      // `Cancelled` is still excluded: a cancelled RFQ must not be awarded.
      await run(
        `UPDATE proc.rfq SET state = 'Awarded'
          WHERE id = (SELECT rf.id
                        FROM proc.rfq rf
                        JOIN proc.comparative_statements cs ON cs.pr_id = rf.pr_id
                       WHERE cs.id = $1)
            AND state IN ('Open','Closed')`,
        [csId],
      );

      // ── the PR now enters the governance chain (Wave 3, decision 1A) ──────
      // Q4 parked the PR here for two waves because no governance stage was
      // storable. Migration 027 added the prototype's own stage values, so the
      // CS lock now moves the PR exactly as csLock() does at line 7201-7215.
      //
      //   STANDARD / BOARD -> CS_LOCKED   (the committee now has something to vote on)
      //   FAST_TRACK       -> PACK_LOCKED (MC and CFO skipped, not auto-approved)
      //
      // This is a STAGE change only. What the PR now needs is the MC's vote.
      const routing = c.routing_key || 'STANDARD';
      const fastTrack = routing === 'FAST_TRACK';
      const nextStage = fastTrack ? 'PACK_LOCKED' : 'CS_LOCKED';

      let pack = null;
      if (fastTrack) {
        pack = await lockPack(run, {
          prId: c.pr_id,
          prNumber: c.pr_number,
          userId,
          csId: csId,
          csNumber: c.cs_number,
          csRound: Number(c.cs_round || 1),
          // A split has no single winner. lockPack() hashes the CS document
          // from the DB row (which carries `recommendation`, and therefore the
          // split) and the compliance checklist over every winning vendor.
          winner: isSplit ? null : winner,
          split: isSplit ? split : undefined,
          quote: decision.winnerQuote,
          reason: `CS ${c.cs_number} locked on a FAST_TRACK route (MC + CFO skipped)`,
          routingKey: 'FAST_TRACK',
          mcCfoSkipped: true,
          mcApprovedAt: null,
          cfoApprovedAt: null,
        });
      }

      await run(
        `UPDATE proc.purchase_requisitions SET status = $2 WHERE id = $1::uuid`,
        [c.pr_id, nextStage],
      );

      const vendorSummary = isSplit
        ? `${new Set(split.map((s: any) => s.vendor_id)).size} vendors across ${split.length} line(s)`
        : winner.legal_name;

      return {
        cs: {
          id: locked.rows[0].id,
          cs_number: locked.rows[0].cs_number,
          state: 'Locked',
          locked_at: locked.rows[0].locked_at,
          award_mode: locked.rows[0].award_mode,
        },
        // `winner` stays present and populated for a SINGLE lock, because six
        // downstream readers and the prototype's own copy depend on that shape.
        // For a SPLIT it is explicitly null and `split` carries the decision —
        // a UI that renders `winner.vendor_name` on a split CS would print
        // "undefined", which is louder than a null it was told to expect.
        winner: isSplit
          ? null
          : {
              vendor_id: winner.vendor_id,
              vendor_name: winner.legal_name,
              total: decision.winnerQuote ? Number(decision.winnerQuote.total_amount) : null,
              lead_time_days: decision.winnerQuote?.lead_time_days ?? null,
              is_override: isOverride,
              top_ranked: { vendor_id: topRank.vendor_id, vendor_name: topRank.legal_name },
            },
        split: isSplit ? split : null,
        routing_key: routing,
        stage: nextStage,
        pack,
        // The prototype's own pushEvent lines and next-step text.
        event: fastTrack
          ? {
              action: isSplit ? 'CS locked as a split (fast-track)' : 'CS locked (fast-track)',
              detail: isSplit
                ? `Split award: ${vendorSummary} — MC + CFO skipped (${c.expense_split})`
                : `Winner: ${winner.legal_name} — MC + CFO skipped (${c.expense_split})`,
            }
          : isSplit
            ? {
                action: 'Comparative Statement locked as a split award',
                detail: `Split award: ${vendorSummary} (${c.expense_split})`,
              }
            : {
                action: 'Comparative Statement locked',
                detail: `Winner: ${winner.legal_name} @ PKR ` +
                  `${((decision.winnerQuote ? Number(decision.winnerQuote.total_amount) : 0) / 1000000).toFixed(2)} M ` +
                  `(${c.expense_split})`,
              },
        next:
          routing === 'FAST_TRACK'
            ? 'CS locked. FAST-TRACK: MC + CFO skipped. Pack auto-locked. Ready to push to D365.'
            : isSplit
              ? `CS locked as a split award across ${vendorSummary}. Switch to MC Member to vote.`
              : c.routing_key === 'BOARD'
                ? 'CS locked. Winner: ' + winner.legal_name + '. Switch to MC Member to vote, then Board.'
                : 'CS locked. Winner: ' + winner.legal_name + '. Switch to MC Member to vote.',
      };
    });
  }

  // ── GET /pr/:id/cs ───────────────────────────────────────────────────────
  /** The CS screen payload — renderCS's data, with the real scores attached. */
  async forPr(prId: string, userId: string, role: string, costCenterIds: string[]) {
    const ctx = { userId, role, costCenterIds };

    // Distinguish "this PR exists but has no CS yet" from "no such PR".
    // The first is a normal screen state the CS page renders with a Generate
    // button; the second is a 404. Querying comparative_statements alone
    // cannot tell them apart, and returning 200 for a non-existent PR would
    // hide a broken link instead of surfacing it.
    const prExists = await this.db.query<any>(
      `SELECT 1 AS ok FROM proc.purchase_requisitions WHERE id = $1::uuid`,
      [prId],
      ctx,
    );
    if (prExists.rows.length === 0) throw new NotFoundException('PR not found');

    // ONLY THE LIVE ROUND IS THE SCREEN. This filter is not cosmetic: after an MC
    // reject the PR carries a Locked round 1 AND a Generated round 2, and this
    // query used to return whichever row the planner liked — no ORDER BY, no
    // round predicate. In practice that was round 1, so the screen reported
    // "CS locked, winner X, awaiting MC vote", rendered no lock card (the state
    // it read was Locked), and the live round 2 became impossible to lock from
    // the UI. generate() and lock() both resolve the round through
    // fn_latest_cs_round(); the read path now agrees with them.
    const cs = await this.db.query<any>(
      `SELECT cs.id, cs.cs_number, cs.pr_id, cs.cs_round, cs.state, cs.generated_at, cs.locked_at,
              cs.scores, cs.weights, cs.recommendation, cs.override_reason,
              cs.award_mode,
              pr.pr_number, pr.routing_key, pr.expense_type AS expense_split,
              pr.currency, pr.status AS pr_status,
              -- The originating department's NAME, for the header bar. The id was
              -- already available; a reviewer reading a blind statement still has
              -- to know whose money this is, and an id is not that.
              dep.name AS department_name
         FROM proc.comparative_statements cs
         JOIN proc.purchase_requisitions pr ON pr.id = cs.pr_id
         LEFT JOIN core.departments dep ON dep.id = pr.department_id
        WHERE cs.pr_id = $1::uuid
          AND cs.cs_round = proc.fn_latest_cs_round($1::uuid)
        LIMIT 1`,
      [prId],
      ctx,
    );
    if (cs.rows.length === 0) {
      // No statement exists yet, and this is EXACTLY where a freshly forwarded
      // PR lands: procurement hands the competition over and the very next
      // screen is this one. So the empty case is not an error state to be
      // rendered as a shrug — it is the screen's main event, and it has to be
      // able to offer the generate action.
      //
      // Before this, `detail()` returned `ready: false` and the page drew an
      // empty bid table with no control anywhere in the UI that calls
      // POST /pr/:id/cs. The hand-off therefore landed the buyer on a screen
      // with nothing to click, and the only way forward was to know the
      // endpoint existed.
      const meta = await this.db.query<any>(
        `SELECT pr.pr_number, pr.status AS pr_status,
                (SELECT count(DISTINCT q.vendor_id)::int
                   FROM proc.quotations q
                   JOIN proc.rfq rf ON rf.id = q.rfq_id
                  WHERE rf.pr_id = pr.id AND q.state = 'Submitted') AS live_quotes
           FROM proc.purchase_requisitions pr
          WHERE pr.id = $1::uuid`,
        [prId],
        ctx,
      );
      const m = meta.rows[0] || {};
      const live = Number(m.live_quotes ?? 0);
      const mayGenerate = roleAllowed(role, CS_ROLES);
      return {
        cs: null,
        lines: [],
        weights: FALLBACK_WEIGHTS,
        ready: false,
        pr_number: m.pr_number ?? null,
        pr_status: m.pr_status ?? null,
        live_quotes: live,
        can_generate: live > 0 && mayGenerate,
        generate_blocked_reason: mayGenerate
          ? (live === 0
            ? 'No quotations have been received yet, so there is nothing to compare.'
            : null)
          : 'Only Procurement or CS can generate a comparative statement.',
      };
    }
    const c = cs.rows[0];

    // `missing` — which scored dimensions this vendor never stated — is recorded
    // by the scorer and persisted in cs.scores, but the read path dropped it. The
    // scoring model documents it as the thing that "lets the CS screen render an
    // em-dash next to the score", and no screen could ever do that: a reviewer
    // saw a 0 with no way to learn whether it meant "offered nothing" or "the
    // system never captured it" — which is exactly the confusion that made the
    // per-line warranty bug invisible for as long as it was.
    //
    // Read through parseJsonb: cs.scores is jsonb and arrives from the CSV bridge
    // as a STRING, so a plain property access on it is undefined forever.
    const scoresJson = parseJsonb(c.scores) as any;
    const missingByVendor: Record<string, string[]> = {};
    for (const row of scoresJson?.ranked || []) {
      if (row?.vendor_id) missingByVendor[row.vendor_id] = row.missing || [];
    }

    // The commercial terms are joined back in from the quote that was scored.
    // proc.cs_lines holds only scores and a rank, so without this the CS screen
    // would show a weighted score with no amount, lead time or warranty behind
    // it — a number the reviewer is asked to trust with nothing to check it
    // against. DISTINCT ON picks the same live version generate() scored, so a
    // later revision can never silently change the numbers under a locked CS.
    const lines = await this.db.query<any>(
      `SELECT DISTINCT ON (l.vendor_id)
              l.vendor_id, l.commercial_score, l.technical_score, l.warranty_score,
              l.weighted_score, l.rank,
              v.legal_name, v.vendor_code, v.state AS vendor_state,
              q.total_amount, q.lead_time_days, q.warranty_months, q.version
         FROM proc.cs_lines l
         JOIN core.vendors v ON v.id = l.vendor_id
         LEFT JOIN LATERAL (
           SELECT q2.total_amount, q2.lead_time_days, q2.version,
                  -- Same floor-across-lines fallback as the scoring path, so the
                  -- numbers printed beside a score are the numbers that produced
                  -- it. Reading the raw header here would show an em-dash next
                  -- to a non-zero warranty_score and the CS would look broken.
                  COALESCE(
                    q2.warranty_months,
                    (SELECT min(ql.warranty_months) FROM proc.quotation_lines ql
                      WHERE ql.quotation_id = q2.id AND ql.warranty_months IS NOT NULL)
                  ) AS warranty_months
             FROM proc.quotations q2
             JOIN proc.rfq rf ON rf.id = q2.rfq_id
            WHERE rf.pr_id = $2::uuid
              AND q2.vendor_id = l.vendor_id
              AND q2.state IN ('Submitted','Awarded','Rejected')
            ORDER BY q2.version DESC LIMIT 1
         ) q ON true
        WHERE l.cs_id = $1::uuid
        ORDER BY l.vendor_id, l.rank`,
      [c.id, c.pr_id],
      ctx,
    );
    lines.rows.sort((a: any, b: any) => Number(a.rank) - Number(b.rank));

    const compliance = await this.complianceFor(
      lines.rows.map((r: any) => r.vendor_id), ctx,
    );

    const rec = parseJson(c.recommendation);
    const routing = c.routing_key || 'STANDARD';
    const skipMc = routing === 'FAST_TRACK';

    // ── BLIND REVIEW (migration 065) ──────────────────────────────────────
    // The statement is withheld from the originating department's approver
    // while it is at REQUESTER_REVIEW, so they confirm on the basis of the
    // comparison itself rather than on who won.
    //
    // This is SERVER-SIDE, and that is the whole point. Masking in the UI would
    // leave the ranking, the prices and the scores in the JSON response — a
    // masked payload that a curl can still read is not a control. The fields are
    // STRIPPED HERE, before the object is returned, so they are absent from the
    // response body rather than hidden by a stylesheet.
    const blind = await this.review.blindScope(c.pr_id, userId, ctx);
    const isBlindReviewer =
      String(blind.subState) === 'REQUESTER_REVIEW' && blind.isRequesterReviewer === true;

    const maskedLine = (r: any) => ({
      vendor_id: null,
      vendor_name: 'Withheld — blind review',
      vendor_code: null,
      total_amount: null,
      lead_time_days: null,
      warranty_months: null,
      commercial_score: null,
      technical_score: null,
      warranty_score: null,
      weighted_score: null,
      missing: [],
      rank: null,
      compliance: { status: 'unknown', label: '—' },
      is_winner: false,
      // The count is NOT secret. A reviewer must be able to see that three
      // vendors were compared; only WHO they are and what they offered is
      // withheld. Reporting an empty list here would render as "no vendors
      // quoted", which is a different and false statement.
      is_masked: true,
    });

    const shapedLines = lines.rows.map((r: any) => ({
      vendor_id: r.vendor_id,
      vendor_name: r.legal_name,
      vendor_code: r.vendor_code,
      // The quote's own figures, so a score is never shown without the
      // numbers behind it.
      total_amount: r.total_amount === null ? null : Number(r.total_amount),
      lead_time_days: r.lead_time_days === null ? null : Number(r.lead_time_days),
      warranty_months: r.warranty_months === null ? null : Number(r.warranty_months),
      commercial_score: Number(r.commercial_score),
      technical_score: Number(r.technical_score),
      warranty_score: Number(r.warranty_score),
      weighted_score: Number(r.weighted_score),
      // Which scored dimensions this vendor never stated. Empty array means it
      // stated everything — never null, so "stated all" and "not in the model"
      // cannot render the same.
      missing: missingByVendor[r.vendor_id] || [],
      rank: Number(r.rank),
      // D5: unknown compliance renders as an em-dash, never a fabricated pass.
      compliance: compliance.get(r.vendor_id) ?? { status: 'unknown', label: '—' },
      is_winner: Boolean(rec && rec.winner_vendor_id === r.vendor_id),
      is_masked: false,
    }));

    // The winner block is stripped too. A blind reviewer who can read
    // `winner.vendor_name` has been told the answer.
    const shapedWinner = rec?.winner_vendor_id ? {
      vendor_id: rec.winner_vendor_id,
      vendor_name: rec.winner_vendor_name,
      total: rec.winner_total === undefined ? null : Number(rec.winner_total),
      is_new_vendor: rec.winner_is_new_vendor === true,
    } : null;

    if (isBlindReviewer) {
      return {
        cs: {
          id: c.id,
          cs_number: c.cs_number,
          cs_round: Number(c.cs_round || 1),
          state: c.state,
          generated_at: c.generated_at,
          locked_at: c.locked_at,
          pr_number: c.pr_number,
          expense_split: c.expense_split,
          // Present on the MASKED payload too. Withholding the vendor tells a
          // reviewer nothing about who they are reviewing spend for, and the
          // department is not a vendor attribute.
          department_name: c.department_name ?? null,
          routing_key: routing,
          override_reason: null,
          award_mode: c.award_mode ?? 'SINGLE',
          split: null,
          winner: null,
          is_masked: true,
        },
        // Weights are the scoring rubric, not the result. Keeping them lets the
        // reviewer judge the comparison method without seeing the outcome.
        weights: parseJson(c.weights) ?? FALLBACK_WEIGHTS,
        scores: null,
        lines: lines.rows.map(maskedLine),
        vendor_count: lines.rows.length,
        masked_for_viewer: true,
        // Names WHAT is withheld rather than listing everything masked. It used to
        // claim prices were withheld, which contradicted the blind panel: the
        // reviewer is shown the rates precisely BECAUSE confirming them is the
        // job. `blindAwardDetail` states the rule in full.
        mask_reason:
          'Blind review: which vendor won, and the scores and recommendation behind it, are '
          + 'withheld until you confirm. The number of vendors compared is shown so you know '
          + 'the field.',
        ready: false,
        skip_mc: skipMc,
      };
    }

    // A review in force disables the legacy Lock route, and the screen is told so
  // from the same flag that drives the API refusal. The UI must not be the
  // only thing standing between a reviewer and a bypass: if a future payload
  // ever set `ready` while a review was open, the server would still refuse.
  const reviewState = await this.review.activeReviewState(c.id, ctx);

  return {
      cs: {
        id: c.id,
        cs_number: c.cs_number,
        // The round is part of the CS's identity: without it a screen cannot
        // explain why a PR carries two statements. Round 1 is the common case
        // and reads as noise, so the UI only surfaces it when there is history.
        cs_round: Number(c.cs_round || 1),
        state: c.state,
        generated_at: c.generated_at,
        locked_at: c.locked_at,
        pr_number: c.pr_number,
        expense_split: c.expense_split,
        department_name: c.department_name ?? null,
        routing_key: routing,
        override_reason: c.override_reason,
        // W5-G: `award_mode` tells the screen which shape the decision took, and
        // `split` carries the per-line winners. A split has `winner: null` by
        // design — rendering `winner.vendor_name` on a split would print
        // "undefined", which reads as a bug rather than as "this was split".
        award_mode: c.award_mode ?? 'SINGLE',
        split: Array.isArray(rec?.split) && rec.split.length > 0
          ? rec.split.map((s: any) => ({
              line_no: Number(s.line_no),
              vendor_id: s.vendor_id,
              vendor_name: s.vendor_name ?? null,
              vendor_code: s.vendor_code ?? null,
              awarded_qty: s.awarded_qty === undefined ? null : Number(s.awarded_qty),
              justification: s.justification ?? null,
            }))
          : null,
        winner: shapedWinner,
        is_masked: false,
      },
      weights: parseJson(c.weights) ?? FALLBACK_WEIGHTS,
      scores: parseJson(c.scores),
      // Built above so the blind branch and this branch cannot drift: the masked
      // and unmasked payloads are two renderings of ONE list, not two queries.
      lines: shapedLines,
      vendor_count: lines.rows.length,
      masked_for_viewer: false,
      // renderCS's `ready` gate: the lock buttons only appear when the CS is
      // still Generated, the actor is procurement or CS, AND no review is in force.
      ready: c.state === 'Generated' && roleAllowed(role, CS_ROLES) && !reviewState,
      review_in_progress: reviewState,
      skip_mc: skipMc,
    };
  }

  // ── internals ───────────────────────────────────────────────────────────

  /** Live (Submitted) quotes on the PR's RFQ, newest version per vendor. */
  private async liveQuotes(prId: string, ctx: Ctx) {
    const r = await this.db.query<any>(
      `SELECT DISTINCT ON (q.vendor_id)
              q.id, q.rfq_id, q.vendor_id, q.version, q.total_amount, q.currency,
              q.lead_time_days, q.warranty_months,
              -- SCORING MUST SEE THE WARRANTY THE VENDOR ACTUALLY QUOTED.
              --
              -- The Receive Quotation grid captures warranty PER LINE and never
              -- writes the header column, so q.warranty_months is NULL for every
              -- quote recorded through the UI while the real figure sits in
              -- proc.quotation_lines. Reading the header alone therefore scored
              -- the warranty dimension as 0 for vendors who had quoted one:
              -- on CS-2026-200428 all four vendors scored 0.00, including a
              -- vendor that had offered 10/12/24 months across its lines.
              --
              -- That is the D5 rule firing backwards. "A missing value scores
              -- zero, it never wins by silence" is meant to stop a vendor
              -- collecting a perfect score by saying nothing; here it was
              -- treating a vendor who DID speak exactly like one who did not,
              -- and listing it under 'missing' as though it had stayed silent.
              --
              -- The FLOOR across the quote's lines is used, not the max: a
              -- vendor promising 24 months on one line and 10 on another has
              -- not promised 24 months for this order. This is the same
              -- fallback award.service.ts:132 already applied on the buyer side.
              COALESCE(
                q.warranty_months,
                (SELECT min(ql.warranty_months) FROM proc.quotation_lines ql
                  WHERE ql.quotation_id = q.id AND ql.warranty_months IS NOT NULL)
              ) AS warranty_months,
              v.legal_name, v.vendor_code
         FROM proc.quotations q
         JOIN proc.rfq rf ON rf.id = q.rfq_id
         JOIN core.vendors v ON v.id = q.vendor_id
        WHERE rf.pr_id = $1::uuid AND q.state = 'Submitted'
        ORDER BY q.vendor_id, q.version DESC`,
      [prId],
      ctx,
    );
    return r.rows;
  }

  /**
   * D5, applied to the CS screen: compliance is read from
   * `core.vendor_due_diligence` and is only ever a real pass or unknown.
   */
  private async complianceMap(
    vendorIds: string[],
    ctx: Ctx,
  ): Promise<Map<string, { status: 'pass' | 'unknown' | 'fail'; label: string }>> {
    const map = new Map<string, { status: 'pass' | 'unknown' | 'fail'; label: string }>();
    for (const id of vendorIds) map.set(id, { status: 'unknown', label: '—' });
    if (vendorIds.length === 0) return map;

    const r = await this.db.query<any>(
      `SELECT DISTINCT ON (vendor_id) vendor_id, state
         FROM core.vendor_due_diligence
        WHERE vendor_id = ANY($1::uuid[])
        ORDER BY vendor_id, started_by_user_id DESC`,
      [`{${vendorIds.join(',')}}`],
      ctx,
    );
    for (const row of r.rows) {
      const st = String(row.state || '');
      if (st === 'Approved' || st === 'Manager_Approved' || st === 'DD_Approved') {
        map.set(row.vendor_id, { status: 'pass', label: '✓ Pass' });
      } else if (st === 'Rejected') {
        map.set(row.vendor_id, { status: 'fail', label: '✕ Failed' });
      }
    }
    return map;
  }

  private complianceFor(vendorIds: string[], ctx: Ctx) {
    return this.complianceMap(vendorIds, ctx);
  }
}

function parseJson(v: unknown): any {
  if (v === null || v === undefined) return null;
  if (typeof v === 'object') return v;
  if (typeof v === 'string') {
    try { return JSON.parse(v); } catch { return null; }
  }
  return null;
}
