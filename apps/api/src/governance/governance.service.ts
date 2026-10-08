import {
  BadRequestException, ConflictException, ForbiddenException,
  Injectable, NotFoundException,
} from '@nestjs/common';
import { DbService, type SessionContext } from '../db/db.service';
import { roleAllowed } from '@procurement/roles';
import {
  CFO_DECIDE_ROLES, MC_VOTE_ROLES, PACK_LOCK_ROLES,
  canPushToD365, cfoAlert, cfoSummary, formatDigest, isUnanimous, mcAlert, mcNext, mcTally,
  packDocuments, stagePill, type McDecision,
} from '@procurement/workflow-engine';
import { lockPack, type Run } from './pack.lock';
import { parseJsonb } from '../sourcing/rfq.status';

// Wave 3 step 2 — the governance gates: MC vote, CFO decision, pack lock.
//
// Port of mcVote (line 7221), mcAutoComplete (7251), cfoDecide (7264) and
// packLock (7281). Every rule here lives in the SERVICE, never in the controller
// or the UI — the same principle that put the FAST_TRACK auto-pack-lock in
// cs.service (decision 10) rather than in a button's disabled state. A coupling
// that lives in the UI is a coupling the API will happily skip.

const CS_LOCKED = 'CS_LOCKED';
const MC_APPROVED = 'MC_APPROVED';
const CFO_APPROVED = 'CFO_APPROVED';
const QUOTES_RECEIVED = 'QUOTES_RECEIVED';
const PACK_LOCKED = 'PACK_LOCKED';
const MC_STEP = 'mc_approval';
const CFO_STEP = 'cfo_approval';

type Ctx = SessionContext;

@Injectable()
export class GovernanceService {
  constructor(private readonly db: DbService) {}

  // ── GET /pr/:id/mc — renderMCVote's data (line 7866) ─────────────────────

  /**
   * The MC screen's entire payload.
   *
   * The panel is read from `workflow.mc_panel`, not from a hardcoded name list.
   * The prototype hardcodes `memberList` (line 7870); making it rows is what
   * turns "5/5" from a magic number into a consequence of who is appointed.
   */
  async mc(prId: string, userId: string, role: string, costCenterIds: string[]) {
    const ctx: Ctx = { userId, role, costCenterIds };
    const st = await this.state(prId, ctx);
    if (!st) throw new NotFoundException('PR not found');

    const ready = st.status === CS_LOCKED;

    const panelRows = await this.db.query<any>(
      `SELECT p.user_id, p.seat, p.chair, u.display_name, u.email
         FROM workflow.mc_panel p JOIN core.users u ON u.id = p.user_id
        ORDER BY p.seat`,
      [],
      ctx,
    );

    // One query for the round's votes, shaped into a member-keyed map. The
    // prototype keys STATE.pr.mcVotes by member NAME; we key by user id, because
    // a display name is not an identity and two people may share one.
    const voteRows = await this.db.query<any>(
      `SELECT v.voter_user_id, v.decision, v.reason, v.voted_at
         FROM workflow.approval_votes v
        WHERE v.pr_id = $1::uuid AND v.step_id = $2`,
      [prId, MC_STEP],
      ctx,
    );
    const votes: Record<string, McDecision> = {};
    for (const v of voteRows.rows) votes[v.voter_user_id] = v.decision;

    const reasonBy: Record<string, string> = {};
    for (const v of voteRows.rows) if (v.reason) reasonBy[v.voter_user_id] = v.reason;

    const tally = mcTally(votes, panelRows.rows.length);
    const round = mcNext(votes, panelRows.rows.length);

    const session = await this.db.query<any>(
      `SELECT id, opened_at, closed_at, outcome, chair_user_id
         FROM workflow.mc_sessions WHERE pr_id = $1::uuid
        ORDER BY opened_at DESC LIMIT 1`,
      [prId],
      ctx,
    );

    const me = panelRows.rows.find((p: any) => p.user_id === userId) || null;
    const canVote = ready && roleAllowed(role, MC_VOTE_ROLES.join(','));

    return {
      pr: st.pr,
      stage: st.status,
      stage_label: st.status_label,
      stage_pill: st.pill,
      ready,
      winner: st.winner,
      // W5-G: a split-award CS has no winner, so every screen that renders
      // `winner` must also be able to render the per-line decision.
      split: st.split,
      alert: mcAlert(st.status),
      panel: panelRows.rows.map((p: any) => ({
        user_id: p.user_id,
        name: p.display_name,
        email: p.email,
        seat: p.seat,
        chair: p.chair,
        vote: votes[p.user_id] || null,
        note: votes[p.user_id] ? 'Voted' : '-',
        reason: reasonBy[p.user_id] || null,
      })),
      tally,
      round,
      // The prototype's vote-row pills: Approve / Reject / Pending.
      quorum: { required: panelRows.rows.length, unanimous: true, text: `${panelRows.rows.length}/${panelRows.rows.length}` },
      unanimous: isUnanimous(votes, panelRows.rows.length),
      you: me ? { user_id: me.user_id, name: me.display_name, chair: me.chair } : null,
      can_vote: canVote,
      // The prototype renders the chair's name here; we render the authenticated
      // user's, because the vote is attributed to a real voter_user_id.
      session: session.rows[0] || null,
      next: this.mcNextText(st, round),
      demo_helper_allowed: process.env.DEMO_HELPERS === '1',
      ...(await this.widgets(prId, ctx)),
    };
  }

  // ── POST /pr/:id/mc/vote — mcVote (line 7221) ────────────────────────────

  async mcVote(
    prId: string, userId: string, role: string, costCenterIds: string[],
    body: { decision: McDecision; reason?: string },
  ) {
    if (!roleAllowed(role, MC_VOTE_ROLES.join(','))) {
      throw new ForbiddenException('Only MC members can vote.');
    }
    if (body?.decision !== 'approve' && body?.decision !== 'reject') {
      throw new BadRequestException("decision must be 'approve' or 'reject'");
    }
    const ctx: Ctx = { userId, role, costCenterIds };

    return this.db.withTransaction(ctx, async (run) => {
      const st = await this.state(prId, ctx, run);
      if (!st) throw new NotFoundException('PR not found');

      // The prototype's own gate, verbatim: 'Voting not yet open (stage: X)'.
      if (st.status !== CS_LOCKED) {
        throw new ConflictException(
          `Voting not yet open (stage: ${st.status_label})`,
        );
      }

      // Only an appointed panel member may vote. A user with role 'mc' who is
      // not on the panel has no seat, and a seat is what a vote is.
      const panel = await run<any>(
        `SELECT user_id FROM workflow.mc_panel ORDER BY seat`,
      );
      if (!panel.rows.some((p: any) => p.user_id === userId)) {
        throw new ForbiddenException('you are not a member of the MC panel');
      }
      const panelSize = panel.rows.length;

      const session = await this.openSession(run, prId, userId);
      // For a SPLIT there is no single awarded total, and `awarded_qty` is a
      // QUANTITY rather than money, so a split total cannot be derived from it.
      // Null here renders an em-dash on the MC screen, which is the honest
      // reading — the PR's own amount_text carries the figure the MC cares about.
      const quote = st.winner ? Number(st.winner.total ?? NaN) : null;

      // Re-voting is an upsert, not an error: the prototype overwrites
      // STATE.pr.mcVotes[m] on every call.
      await run(
        `INSERT INTO workflow.approval_votes
           (pr_id, step_id, voter_user_id, decision, reason)
         VALUES ($1::uuid, $2, $3::uuid, $4, $5)
         ON CONFLICT (pr_id, step_id, voter_user_id)
         DO UPDATE SET decision = EXCLUDED.decision,
                       reason = EXCLUDED.reason,
                       voted_at = now()`,
        [prId, MC_STEP, userId, body.decision, body.reason ?? null],
      );

      const all = await run<any>(
        `SELECT voter_user_id, decision FROM workflow.approval_votes
          WHERE pr_id = $1::uuid AND step_id = $2`,
        [prId, MC_STEP],
      );
      const votes: Record<string, McDecision> = {};
      for (const v of all.rows) votes[v.voter_user_id] = v.decision;

      const round = mcNext(votes, panelSize);
      const tally = mcTally(votes, panelSize);

      // ── one reject collapses the round (prototype line 7226-7232) ────────
      if (round === 'rejected') {
        await this.writeAudit(run, userId, prId, 'reject', {
          session_id: session.id, gate: MC_STEP, reason: body.reason ?? null,
          votes_at_rejection: votes,
        });
        await this.closeSession(run, session.id, 'rejected');
        // The prototype sets STATE.pr.mcVotes = {} before returning to
        // QUOTES_RECEIVED. We do the same, and the audit row above is what
        // keeps the objection answerable once the ledger is cleared.
        await run(
          `DELETE FROM workflow.approval_votes WHERE pr_id = $1::uuid AND step_id = $2`,
          [prId, MC_STEP],
        );
        // The CS lock marked the winner Awarded and the rest Rejected. That
        // award was a CONSEQUENCE of a decision the committee has now withdrawn,
        // so it is withdrawn too — otherwise the PR arrives back at sourcing
        // with no live quote left and round 2 could never be scored.
        //
        // This is a lifecycle transition, not a rewrite: the prices, the line
        // splits and the version chain are untouched, and the CS row itself
        // stays Locked so the rejected round remains answerable.
        const restored = await run<{ n: number }>(
          `UPDATE proc.quotations
              SET state = 'Submitted'
            WHERE rfq_id = (SELECT rf.id FROM proc.rfq rf
                             JOIN proc.comparative_statements cs ON cs.pr_id = rf.pr_id
                            WHERE cs.pr_id = $1::uuid
                              AND cs.cs_round = proc.fn_latest_cs_round($1::uuid))
              AND state IN ('Awarded','Rejected')
          RETURNING 1 AS n`,
          [prId],
        );
        await run(
          `UPDATE proc.rfq SET state = 'Open'
            WHERE pr_id = $1::uuid AND state = 'Awarded'`,
          [prId],
        );
        await run(
          `UPDATE proc.purchase_requisitions SET status = $2 WHERE id = $1::uuid`,
          [prId, QUOTES_RECEIVED],
        );
        return {
          round, tally, session_id: session.id, cleared: true,
          quotes_reopened: restored.rowCount ?? 0,
          stage: QUOTES_RECEIVED,
          event: { action: 'MC vote: reject', detail: 'Returned to CS for re-evaluation' },
          next: 'MC rejected. CS must revise.',
          winner_amount: quote,
        };
      }

      // ── 5/5 approves (prototype line 7234-7242) ──────────────────────────
      if (round === 'approved') {
        const approvedAt = await run<any>(
          `UPDATE workflow.mc_sessions
              SET closed_at = now(), outcome = 'approved', chair_user_id = coalesce(chair_user_id, $2::uuid)
            WHERE id = $1::uuid
          RETURNING closed_at`,
          [session.id, userId],
        );
        await this.writeAudit(run, userId, prId, 'approve', {
          session_id: session.id, gate: MC_STEP, votes: votes, unanimous: true,
        });
        await run(
          `UPDATE proc.purchase_requisitions SET status = $2 WHERE id = $1::uuid`,
          [prId, MC_APPROVED],
        );
        const board = st.pr.routing_key === 'BOARD';
        return {
          round, tally, session_id: session.id, cleared: false,
          stage: MC_APPROVED, approved_at: approvedAt.rows[0]?.closed_at ?? null,
          event: { action: 'MC approved', detail: `Unanimous ${panelSize}/${panelSize} (${st.pr.expense_split})` },
          next: board
            ? 'MC unanimously approved. Switch to Board to confirm (Board approval step).'
            : 'MC unanimously approved. Switch to CFO to finalize.',
          winner_amount: quote,
        };
      }

      return {
        round, tally, session_id: session.id, cleared: false,
        stage: st.status,
        event: { action: 'MC vote recorded', detail: `Approve votes so far: ${tally.approves}/${panelSize}` },
        next: `Vote recorded. Need ${panelSize}/${panelSize} to approve (${tally.text} so far).`,
        winner_amount: quote,
      };
    });
  }

  // ── POST /pr/:id/mc/auto-complete — mcAutoComplete (line 7251) ───────────

  /**
   * The prototype's demo helper: it records the other four members' approvals
   * so a walkthrough can reach the CFO screen in one click.
   *
   * It is gated (F3) because the prototype gates it only by hiding it behind a
   * tooltip. In an app that writes real approval rows, an unguarded "approve the
   * rest of the committee" button is a governance hole. With DEMO_HELPERS=1 it
   * writes genuine rows for genuine panel members — the same rows a real vote
   * round would contain, attributed to the people who would cast them.
   */
  async mcAutoComplete(prId: string, userId: string, role: string, costCenterIds: string[]) {
    if (!roleAllowed(role, MC_VOTE_ROLES.join(','))) {
      throw new ForbiddenException('Only MC members can vote.');
    }
    if (process.env.DEMO_HELPERS !== '1') {
      throw new ForbiddenException(
        'the MC auto-complete helper is a demo affordance and is disabled (set DEMO_HELPERS=1 to enable)',
      );
    }
    const ctx: Ctx = { userId, role, costCenterIds };

    return this.db.withTransaction(ctx, async (run) => {
      const st = await this.state(prId, ctx, run);
      if (!st) throw new NotFoundException('PR not found');
      if (st.status !== CS_LOCKED) {
        throw new ConflictException(`Voting not yet open (stage: ${st.status_label})`);
      }
      const panel = await run<any>(`SELECT user_id FROM workflow.mc_panel ORDER BY seat`);
      if (!panel.rows.some((p: any) => p.user_id === userId)) {
        throw new ForbiddenException('you are not a member of the MC panel');
      }
      const panelSize = panel.rows.length;

      const session = await this.openSession(run, prId, userId);
      for (const p of panel.rows) {
        await run(
          `INSERT INTO workflow.approval_votes (pr_id, step_id, voter_user_id, decision, reason)
           VALUES ($1::uuid, $2, $3::uuid, 'approve', 'demo helper')
           ON CONFLICT (pr_id, step_id, voter_user_id)
           DO UPDATE SET decision = 'approve', voted_at = now()`,
          [prId, MC_STEP, p.user_id],
        );
      }
      const votes: Record<string, McDecision> = {};
      for (const p of panel.rows) votes[p.user_id] = 'approve';
      const round = mcNext(votes, panelSize);

      const closed = await run<any>(
        `UPDATE workflow.mc_sessions
            SET closed_at = now(), outcome = 'approved', chair_user_id = coalesce(chair_user_id, $2::uuid)
          WHERE id = $1::uuid RETURNING closed_at`,
        [session.id, userId],
      );
      await this.writeAudit(run, userId, prId, 'approve', {
        session_id: session.id, gate: MC_STEP, unanimous: true, via: 'demo_helper',
      });
      await run(
        `UPDATE proc.purchase_requisitions SET status = $2 WHERE id = $1::uuid`,
        [prId, MC_APPROVED],
      );

      return {
        round, session_id: session.id, panel: panelSize, demo: true,
        stage: MC_APPROVED, approved_at: closed.rows[0]?.closed_at ?? null,
        event: { action: 'MC approved (all 5)', detail: `Unanimous — recorded by ${st.chair_name ?? 'the chair'} (${st.pr.expense_split})` },
        next: st.pr.routing_key === 'BOARD'
          ? 'All 5 MC members voted Approve. Board confirmation still required.'
          : 'All 5 MC members voted Approve. Switch to CFO to finalize.',
      };
    });
  }

  // ── GET /pr/:id/cfo — renderCFO's data (line 7894) ───────────────────────

  async cfo(prId: string, userId: string, role: string, costCenterIds: string[]) {
    const ctx: Ctx = { userId, role, costCenterIds };
    const st = await this.state(prId, ctx);
    if (!st) throw new NotFoundException('PR not found');

    const panelSize = await this.db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM workflow.mc_panel`, [], ctx,
    );
    const approves = await this.db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM workflow.approval_votes
        WHERE pr_id = $1::uuid AND step_id = $2 AND decision = 'approve'`,
      [prId, MC_STEP], ctx,
    );

    // F1: risk class is DERIVED, never asserted. The prototype hardcodes
    // "Medium — within delegation"; we read the winner's due-diligence risk
    // score, and return null when no record exists so the screen prints an
    // em-dash instead of a rating nobody computed.
    const risk = await this.riskClass(prId, ctx);

    const rows = cfoSummary({
      // W5-G: a split has no single winner, so name every winning vendor rather
      // than printing nothing next to the amount the CFO is approving.
      winnerName: st.winner?.vendor_name
        ?? (st.split ? [...new Set(st.split.map((s: any) => s.vendor_name))].join(' + ') : null),
      amountText: st.pr.amount_text,
      capexAmount: st.pr.capex_amount === null ? null : Number(st.pr.capex_amount),
      opexAmount: st.pr.opex_amount === null ? null : Number(st.pr.opex_amount),
      capexGlText: st.pr.capex_gl,
      opexGlText: st.pr.opex_gl,
      expenseSplit: st.pr.expense_split,
      mcApproves: Number(approves.rows[0]?.n || 0),
      mcPanelSize: Number(panelSize.rows[0]?.n || 0),
      riskClass: risk,
    });

    return {
      pr: st.pr,
      stage: st.status,
      stage_label: st.status_label,
      stage_pill: st.pill,
      ready: st.status === MC_APPROVED,
      winner: st.winner,
      // W5-G: a split-award CS has no winner, so every screen that renders
      // `winner` must also be able to render the per-line decision.
      split: st.split,
      alert: cfoAlert(st.status),
      summary: rows,
      risk_source: risk === null ? 'unknown' : 'core.vendor_due_diligence',
      can_decide: st.status === MC_APPROVED && roleAllowed(role, CFO_DECIDE_ROLES.join(',')),
      ...(await this.widgets(prId, ctx)),
    };
  }

  // ── POST /pr/:id/cfo/decide — cfoDecide (line 7264) ─────────────────────

  async cfoDecide(
    prId: string, userId: string, role: string, costCenterIds: string[],
    body: { approve: boolean; reason?: string },
  ) {
    if (!roleAllowed(role, CFO_DECIDE_ROLES.join(','))) {
      throw new ForbiddenException('Only the CFO can decide at this gate.');
    }
    if (typeof body?.approve !== 'boolean') {
      throw new BadRequestException('approve must be a boolean');
    }
    const ctx: Ctx = { userId, role, costCenterIds };

    return this.db.withTransaction(ctx, async (run) => {
      const st = await this.state(prId, ctx, run);
      if (!st) throw new NotFoundException('PR not found');

      // The prototype's own gate, verbatim: 'Not yet MC-approved (stage: X)'.
      if (st.status !== MC_APPROVED) {
        throw new ConflictException(`Not yet MC-approved (stage: ${st.status_label})`);
      }

      if (body.approve) {
        const at = await run<any>(
          `UPDATE proc.purchase_requisitions SET status = $2 WHERE id = $1::uuid RETURNING last_updated_at`,
          [prId, CFO_APPROVED],
        );
        await this.writeAudit(run, userId, prId, 'approve', {
          gate: CFO_STEP, reason: body.reason ?? null, within_budget: true,
        });
        return {
          approved: true,
          stage: CFO_APPROVED,
          approved_at: at.rows[0]?.last_updated_at ?? null,
          event: { action: 'CFO approved', detail: `Approved within ${st.pr.expense_split} budget` },
          next: 'CFO approved. CS can now lock the approved pack.',
        };
      }

      // ── CFO reject returns to the MC gate, NOT to sourcing ───────────────
      // Prototype line 7275. The distinction matters: the CFO's objection is
      // about budget, so the committee's unanimous recommendation stands and the
      // CS is not reopened. What does reset is the vote ledger, because
      // approval_votes is UNIQUE(pr_id, step_id, voter_user_id) and a fresh
      // round has to be able to record the same five voters again.
      await this.writeAudit(run, userId, prId, 'reject', {
        gate: CFO_STEP, reason: body.reason ?? null,
      });
      await run(
        `DELETE FROM workflow.approval_votes WHERE pr_id = $1::uuid AND step_id = $2`,
        [prId, MC_STEP],
      );
      await run(
        `UPDATE workflow.mc_sessions
            SET closed_at = now(), outcome = 'rejected', chair_user_id = coalesce(chair_user_id, $2::uuid)
          WHERE pr_id = $1::uuid AND closed_at IS NULL`,
        [prId, userId],
      );
      await run(
        `UPDATE proc.purchase_requisitions SET status = $2 WHERE id = $1::uuid`,
        [prId, CS_LOCKED],
      );

      return {
        approved: false,
        stage: CS_LOCKED,
        votes_cleared: true,
        event: { action: 'CFO rejected', detail: 'Returned to MC' },
        next: 'CFO rejected. The MC must re-affirm before the CFO will sign.',
      };
    });
  }

  /**
   * The two widgets every governance screen renders.
   *
   * The prototype calls `purposeAndAckWidget(pr)` and
   * `imageGalleryCard(pr,'viewer')` from all five governance screens. Shared
   * here so a fix to the acknowledgement logic lands in one place, and so D365
   * can reuse it without its own copy.
   *
   * The summary line is null when there is no purpose detail to show:
   * `proc.purchase_requisitions.purpose` stores the scenario TYPE, and the
   * prototype's per-scenario `purposeFields` (employee name, project id, …) have
   * no column. Rendering a partially-known scenario as if it were complete is
   * the same class of error as a fabricated hash, so the pill renders and the
   * detail line does not.
   */
  async widgets(prId: string, ctx: Ctx) {
    const r = await this.db.query<any>(
      `SELECT pr.purpose,
              coalesce((
                SELECT jsonb_agg(jsonb_build_object(
                          'id', a.id, 'name', a.name, 'email', a.email,
                          'role', a.tagged_role, 'acknowledged', a.acknowledged,
                          'acknowledged_at', a.acknowledged_at
                        ) ORDER BY a.tagged_at)
                  FROM proc.pr_acknowledgements a WHERE a.pr_id = pr.id), '[]'::jsonb) AS approvers
         FROM proc.purchase_requisitions pr WHERE pr.id = $1::uuid`,
      [prId], ctx,
    );
    const row = r.rows[0] || {};
    const raw = parseJsonb(row.approvers);
    const approvers = Array.isArray(raw) ? raw : [];
    const pending = approvers.filter((a: any) => a.acknowledged !== true).length;

    const imgs = await this.db.query<any>(
      `SELECT i.id, i.line_id, i.mime_type, i.size_bytes, i.sort_order, i.created_at
         FROM proc.pr_images i WHERE i.pr_id = $1::uuid ORDER BY i.sort_order`,
      [prId], ctx,
    );

    return {
      purpose_ack: row.purpose
        ? {
            purpose_type: row.purpose,
            summary: null,
            approvers,
            total: approvers.length,
            pending,
          }
        : null,
      // The prototype stores images in IndexedDB; ours live in proc.pr_images.
      // The binary itself is not served by this endpoint — Wave 4 wires signed
      // URLs — so the card renders the manifest honestly.
      images: imgs.rows.map((i: any) => ({
        id: i.id,
        line_id: i.line_id,
        caption: null,
        mime_type: i.mime_type,
        size_bytes: i.size_bytes,
        sort_order: Number(i.sort_order || 0),
        uploaded_at: i.created_at,
        url: null,
      })),
    };
  }

  // ── GET /pr/:id/pack — renderPack's data (line 7920) ─────────────────────

  async pack(prId: string, userId: string, role: string, costCenterIds: string[]) {
    const ctx: Ctx = { userId, role, costCenterIds };
    const st = await this.state(prId, ctx);
    if (!st) throw new NotFoundException('PR not found');

    // Read through the session context so the RLS policy on approved_packs
    // applies — a governance pack is not readable by every role on the system.
    const frozen = await this.db.query<any>(
      `SELECT id, pack_hash, payload, frozen_at
         FROM proc.approved_packs WHERE pr_id = $1::uuid`,
      [prId], ctx,
    );
    const p = frozen.rows[0] || null;
    const packPayload = parseJsonb(p?.payload);

    // The document manifest is frozen with the pack. Before the lock there is
    // nothing to hash, so the screen shows the same six names with no digests —
    // never a preview hash that could be mistaken for the real one.
    const documents = p
      ? ((packPayload?.documents || []) as any[])
      : packDocuments({ routingKey: st.pr.routing_key });

    return {
      pr: st.pr,
      stage: st.status,
      stage_label: st.status_label,
      stage_pill: st.pill,
      ready: st.status === CFO_APPROVED,
      winner: st.winner,
      // W5-G: a split-award CS has no winner, so every screen that renders
      // `winner` must also be able to render the per-line decision.
      split: st.split,
      alert: this.packAlert(st.status),
      financial: {
        capex: st.pr.capex_amount === null ? null : Number(st.pr.capex_amount),
        opex: st.pr.opex_amount === null ? null : Number(st.pr.opex_amount),
        capex_gl: st.pr.capex_gl,
        opex_gl: st.pr.opex_gl,
      },
      pack: p
        ? {
            id: p.id, pack_hash: p.pack_hash, frozen_at: p.frozen_at,
            display_hash: formatDigest(p.pack_hash),
            routing_key: packPayload?.routing_key ?? null,
            mc_cfo_skipped: packPayload?.mc_cfo_skipped === true,
            cs_round: packPayload?.cs_round ?? null,
            reason: packPayload?.reason ?? null,
          }
        : null,
      documents: documents.map((d: any) => ({ ...d, display_hash: formatDigest(d.sha256) })),
      can_lock: st.status === CFO_APPROVED
        && !p
        && roleAllowed(role, PACK_LOCK_ROLES.join(',')),
      ...(await this.widgets(prId, ctx)),
    };
  }

  // ── POST /pr/:id/pack/lock — packLock (line 7281) ────────────────────────

  /**
   * Freeze the approved pack. Delegates to the SHARED lockPack() so the
   * FAST_TRACK path in cs.service and this path cannot diverge (risk R7).
   */
  async packLock(prId: string, userId: string, role: string, costCenterIds: string[]) {
    if (!roleAllowed(role, PACK_LOCK_ROLES.join(','))) {
      throw new ForbiddenException('Only CS can lock the approved pack.');
    }
    const ctx: Ctx = { userId, role, costCenterIds };

    return this.db.withTransaction(ctx, async (run) => {
      const st = await this.state(prId, ctx, run);
      if (!st) throw new NotFoundException('PR not found');

      // IDEMPOTENCY FIRST. A retry after a dropped connection must not 409 just
      // because the first attempt already moved the PR to PACK_LOCKED — by then
      // the CFO gate has correctly closed behind us. Check whether the pack is
      // already frozen before asking whether it is legal to freeze it.
      const frozen = await run<any>(
        `SELECT id FROM proc.approved_packs WHERE pr_id = $1::uuid`,
        [prId],
      );
      if (frozen.rows.length > 0) {
        // A frozen pack implies a locked DECISION existed at freeze time. That
        // decision is now either a winner or a split (W5-G); before this track a
        // split CS had no winner_vendor_id at all and would have fallen straight
        // through, re-entering the normal guards and 409-ing on an already-locked
        // pack instead of returning it.
        if (st.winner || st.split) {
          const pack = await lockPack(run, {
            prId, prNumber: st.pr.pr_number, userId,
            csId: st.cs?.id ?? '', csNumber: st.cs?.cs_number ?? '',
            csRound: Number(st.cs?.cs_round || 1),
            winner: st.winner ? { vendor_id: st.winner.vendor_id, vendor_name: st.winner.vendor_name } : null,
            split: st.split ?? undefined,
            quote: st.quote, reason: 'already frozen', routingKey: st.pr.routing_key,
            mcCfoSkipped: false, mcApprovedAt: st.mc_approved_at, cfoApprovedAt: null,
          });
          return {
            pack,
            stage: st.status,
            already_locked: true,
            event: { action: 'Approved pack already locked', detail: 'No action taken' },
            next: 'Pack was already locked.',
          };
        }
      }

      // The prototype's own gate, verbatim: 'CFO approval pending.'
      if (st.status !== CFO_APPROVED) {
        throw new ConflictException('CFO approval pending.');
      }
      if (!st.cs) throw new BadRequestException('this PR has no Comparative Statement to pack');
      // W5-G: the packed decision is a winner OR a split. A split CS carries no
      // winner_vendor_id, so this guard used to refuse to pack one at all —
      // which would have stranded every split-award PR at CFO_APPROVED forever.
      if (!st.winner && !st.split) {
        throw new BadRequestException('this PR has no locked CS decision to pack');
      }

      const pack = await lockPack(run, {
        prId,
        prNumber: st.pr.pr_number,
        userId,
        csId: st.cs.id,
        csNumber: st.cs.cs_number,
        csRound: Number(st.cs.cs_round || 1),
        winner: st.winner ? { vendor_id: st.winner.vendor_id, vendor_name: st.winner.vendor_name } : null,
        split: st.split ?? undefined,
        quote: st.quote,
        reason: `Approved pack locked after CFO approval of ${st.cs.cs_number} (round ${st.cs.cs_round || 1})`,
        routingKey: st.pr.routing_key || 'STANDARD',
        mcCfoSkipped: false,
        mcApprovedAt: st.mc_approved_at,
        cfoApprovedAt: new Date().toISOString(),
      });

      if (!pack.already_locked) {
        await this.writeAudit(run, userId, prId, 'pack_freeze', {
          pack_id: pack.id, pack_hash: pack.pack_hash, cs_number: st.cs.cs_number,
        });
        await run(
          `UPDATE proc.purchase_requisitions SET status = $2 WHERE id = $1::uuid`,
          [prId, PACK_LOCKED],
        );
      }

      return {
        pack,
        stage: pack.already_locked ? st.status : PACK_LOCKED,
        already_locked: pack.already_locked,
        event: pack.already_locked
          ? { action: 'Approved pack already locked', detail: 'No action taken' }
          : { action: 'Approved pack locked', detail: `${pack.documents.filter((d: any) => d.state === 'present').length} documents hashed and signed — ready for D365` },
        next: pack.already_locked
          ? 'Pack was already locked.'
          : 'Pack locked. Ready to push to D365 F&O.',
      };
    });
  }

  // ── GET /pr/:id/d365/status — the read half of step 3 ────────────────────

  /**
   * Shared by the pack screen and the D365 status screen: "is this pushable?"
   * Wave 3 step 3 owns the push itself.
   */
  async pushable(prId: string, role: string, costCenterIds: string[]) {
    const ctx: Ctx = { role, costCenterIds };
    const st = await this.state(prId, ctx);
    if (!st) throw new NotFoundException('PR not found');
    const frozen = await this.db.query<any>(
      `SELECT id, pack_hash FROM proc.approved_packs WHERE pr_id = $1::uuid`,
      [prId], ctx,
    );
    return {
      stage: st.status,
      pack: frozen.rows[0] || null,
      ready: canPushToD365(st.status, frozen.rows.length > 0),
    };
  }

  // ── internals ────────────────────────────────────────────────────────────

  /**
   * Everything the five governance screens need about a PR, in one query.
   * The winner and the CS come from the LATEST round (migration 027), so a PR
   * that the MC sent back is described by round 2, not by the round it rejected.
   */
  private async state(prId: string, ctx: Ctx, run?: Run) {
    const q = run
      ? <T = any>(sql: string, params: any[] = []) => run<T>(sql, params)
      : <T = any>(sql: string, params: any[] = []) => this.db.query<T>(sql, params, ctx);

    const r = await q<any>(
      `SELECT pr.id, pr.pr_number, pr.title, pr.status, pr.estimated_amount,
              pr.currency, pr.expense_type AS expense_split, pr.routing_key,
              pr.capex_amount, pr.opex_amount, pr.d365_po_number, pr.d365_status,
              cs.id AS cs_id, cs.cs_number, cs.cs_round, cs.state AS cs_state,
              cs.locked_at AS cs_locked_at, cs.recommendation
         FROM proc.purchase_requisitions pr
         LEFT JOIN proc.comparative_statements cs
                ON cs.id = (SELECT c2.id FROM proc.comparative_statements c2
                             WHERE c2.pr_id = pr.id
                               AND c2.cs_round = proc.fn_latest_cs_round(pr.id))
        WHERE pr.id = $1::uuid`,
      [prId],
    );
    if (r.rows.length === 0) return null;
    const row = r.rows[0];

    // jsonb arrives as a STRING through the dev psql CSV bridge, so
    // `recommendation` is not an object until it is parsed. Reading
    // `rec.winner_vendor_id` off the raw string yields undefined and the CS
    // silently looks like it has no winner.
    const rec = parseJsonb(row.recommendation);
    const winner = rec && rec.winner_vendor_id
      ? {
          vendor_id: rec.winner_vendor_id,
          vendor_name: rec.winner_vendor_name ?? null,
          total: rec.winner_total ?? null,
          currency: rec.winner_currency ?? null,
          lead_time_days: rec.lead_time_days ?? null,
          is_override: rec.overrode_rank != null,
        }
      : null;

    // W5-G: a split-award CS carries no winner_vendor_id, so `winner` above is
    // null by design rather than because the decision is missing. Read the
    // per-line decision out so the pack screen and lockPack() can see it.
    const split = Array.isArray(rec?.split) && rec.split.length > 0
      ? rec.split.map((s: any) => ({
          line_no: Number(s.line_no),
          vendor_id: s.vendor_id,
          vendor_name: s.vendor_name ?? null,
          awarded_qty: s.awarded_qty === undefined ? null : Number(s.awarded_qty),
          justification: s.justification ?? null,
        }))
      : null;

    let quote = null;
    if (row.cs_id) {
      const qq = await q<any>(
        `SELECT id, version, total_amount, currency, lead_time_days
           FROM proc.quotations WHERE id = $1::uuid`,
        [rec?.winner_quotation_id ?? null],
      );
      quote = qq.rows[0] || null;
    }

    // The governing GL account per bucket, taken from the awarded lines. The
    // prototype hardcodes GL 1710-00 / GL 6320-00; those are its demo values, so
    // the real ones are read here and the screen falls back to an em-dash.
    const gl = await q<any>(
      `SELECT DISTINCT ON (l.classification) l.classification, l.gl_account
         FROM proc.pr_lines l WHERE l.pr_id = $1::uuid AND l.gl_account IS NOT NULL
        ORDER BY l.classification, l.line_no`,
      [prId],
    );
    const glFor = (c: string) => {
      const hit = gl.rows.find((g: any) => String(g.classification || '').toUpperCase().startsWith(c));
      return hit ? hit.gl_account : null;
    };

    const mc = await q<any>(
      `SELECT max(closed_at) AS at FROM workflow.mc_sessions
        WHERE pr_id = $1::uuid AND outcome = 'approved'`,
      [prId],
    );

    const chair = await q<any>(
      `SELECT u.display_name FROM workflow.mc_panel p JOIN core.users u ON u.id = p.user_id
        WHERE p.chair LIMIT 1`,
    );

    const amount = row.capex_amount !== null || row.opex_amount !== null
      ? Number(row.capex_amount || 0) + Number(row.opex_amount || 0)
      : Number(row.estimated_amount || 0);

    return {
      status: row.status,
      status_label: stagePill(row.status).label,
      pill: stagePill(row.status).cls,
      chair_name: chair.rows[0]?.display_name ?? null,
      mc_approved_at: mc.rows[0]?.at ?? null,
      winner,
      split,
      quote,
      cs: row.cs_id
        ? {
            id: row.cs_id, cs_number: row.cs_number,
            cs_round: row.cs_round ?? 1, state: row.cs_state,
            locked_at: row.cs_locked_at,
          }
        : null,
      pr: {
        id: row.id,
        pr_number: row.pr_number,
        title: row.title,
        status: row.status,
        estimated_amount: Number(row.estimated_amount || 0),
        amount_text: `PKR ${amount.toLocaleString('en-PK')}`,
        currency: row.currency,
        expense_split: row.expense_split,
        routing_key: row.routing_key || 'STANDARD',
        capex_amount: row.capex_amount,
        opex_amount: row.opex_amount,
        capex_gl: glFor('CAPEX'),
        opex_gl: glFor('OPEX'),
        d365_po_number: row.d365_po_number ?? null,
        d365_status: row.d365_status ?? null,
      },
    };
  }

  /**
   * F1 — derive a risk class, or return null so the screen prints an em-dash.
   *
   * W5-G: for a SPLIT award this reads EVERY winning vendor and returns the
   * WORST score among them. A package is only as trustworthy as its
   * least-screened supplier, so taking the best (or the first) would certify a
   * split on the strength of one vendor while the other went unchecked. The old
   * join on `winner_vendor_id` simply returned no row for a split, which reads
   * as "no risk information" — the same em-dash as "no records at all", and so
   * indistinguishable from a vendor that was never screened.
   */
  private async riskClass(prId: string, ctx: Ctx): Promise<string | null> {
    const r = await this.db.query<any>(
      `SELECT dd.risk_score, dd.state
         FROM core.vendor_due_diligence dd
         JOIN proc.comparative_statements cs ON cs.pr_id = $1::uuid
        WHERE cs.cs_round = proc.fn_latest_cs_round($1::uuid)
          AND (
            cs.recommendation->>'winner_vendor_id' = dd.vendor_id::text
            OR dd.vendor_id::text IN (
                 -- jsonb_array_elements (NOT the _elements_text form): that one
                 -- yields plain text, and ->> on a text value is not an operator
                 -- Postgres has. That broke every CFO / MC / pack read.
                 SELECT s.value ->> 'vendor_id'
                   FROM proc.comparative_statements c2,
                        LATERAL jsonb_array_elements(
                          CASE WHEN jsonb_typeof(c2.recommendation->'split') = 'array'
                               THEN c2.recommendation->'split' ELSE '[]'::jsonb END
                        ) AS s(value)
                  WHERE c2.pr_id = cs.pr_id
                    AND c2.cs_round = cs.cs_round
                    AND s.value ->> 'vendor_id' IS NOT NULL
               )
          )
        ORDER BY dd.risk_score DESC NULLS LAST, dd.id DESC LIMIT 1`,
      [prId], ctx,
    );
    const row = r.rows[0];
    if (!row || row.risk_score === null || row.risk_score === undefined) return null;
    const score = Number(row.risk_score);
    if (!Number.isFinite(score)) return null;
    // A band, from the score the due-diligence record actually carries. The
    // prototype's "Medium — within delegation" is a label we cannot honestly
    // reproduce without a delegation matrix, so only the class is stated.
    const band = score >= 70 ? 'High' : score >= 40 ? 'Medium' : 'Low';
    return `${band} (risk score ${Math.round(score)}/100)`;
  }

  /**
   * The current MC round, opening one if needed. Any stale open session is
   * closed first, so "at most one open session per PR" holds even if a previous
   * request died between the two writes.
   */
  private async openSession(run: Run, prId: string, userId: string) {
    const open = await run<any>(
      `SELECT id FROM workflow.mc_sessions WHERE pr_id = $1::uuid AND closed_at IS NULL LIMIT 1`,
      [prId],
    );
    if (open.rows.length > 0) return open.rows[0];

    // A stale open session is closed but keeps outcome='pending', which is the
    // CHECK's own word for "opened, never concluded". Inventing a sixth outcome
    // value would need a migration, and 'abandoned' would be a lie anyway: the
    // committee may simply not have met yet.
    await run(
      `UPDATE workflow.mc_sessions
          SET closed_at = now()
        WHERE pr_id = $1::uuid AND closed_at IS NULL`,
      [prId],
    );
    const ins = await run<any>(
      `INSERT INTO workflow.mc_sessions (pr_id, chair_user_id, outcome)
       VALUES ($1::uuid, $2::uuid, 'pending')
       RETURNING id, opened_at, chair_user_id`,
      [prId, userId],
    );
    return ins.rows[0];
  }

  private async closeSession(run: Run, sessionId: string, outcome: 'approved' | 'rejected') {
    await run(
      `UPDATE workflow.mc_sessions SET closed_at = now(), outcome = $2 WHERE id = $1::uuid`,
      [sessionId, outcome],
    );
  }

  private async writeAudit(
    run: Run, userId: string, prId: string, action: string, detail: any,
  ) {
    await run(
      `INSERT INTO audit.audit_log (actor_user_id, entity, entity_id, action, after)
       VALUES ($1::uuid, 'purchase_requisition', $2, $3, $4::jsonb)`,
      [userId, prId, action, JSON.stringify(detail ?? {})],
    );
  }

  /** The prototype's pack-screen alerts (line 7933-7934). */
  private packAlert(stage: string): { cls: string; text: string } | null {
    if (stage === CFO_APPROVED) {
      return { cls: 'success', text: 'CFO approved. Lock the pack to enable D365 push.' };
    }
    if (stage === PACK_LOCKED) {
      return { cls: 'success', text: 'Pack locked. Switch to CS role and click Push to D365 F&O.' };
    }
    return null;
  }

  /** The prototype's next-step line, which differs for BOARD routing. */
  private mcNextText(st: { status: string; pr: { routing_key: string } }, round: string) {
    if (round === 'approved') {
      return st.pr.routing_key === 'BOARD'
        ? 'Switch to Board to confirm (Board approval step).'
        : 'Switch to CFO to finalize.';
    }
    if (round === 'rejected') return 'CS must revise.';
    return `Vote recorded. Need 5/5 to approve.`;
  }
}
