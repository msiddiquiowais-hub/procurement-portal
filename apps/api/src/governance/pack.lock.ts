// The approved pack — ONE implementation, two entry points.
//
// Wave 3 steps 2 and 3. `cs.service.ts` locks the pack automatically on a
// FAST_TRACK route (prototype line 7205, decision 10); `governance.service.ts`
// locks it from the pack screen on a STANDARD route once the CFO has signed.
// Both call the function below, because the once-only and immutability rules
// must not depend on which screen the user happened to be standing on.
//
// WHY A SEPARATE FILE
// The risk that made this its own module (R7 in WAVE3_PLAN.md) was two
// divergent copies of "freeze the pack": one that hashes documents and one that
// doesn't, or one that enforces UNIQUE(pr_id) and one that does not. A shared
// module makes the second implementation an import, not a decision.
//
// THE HASHES ARE REAL
// Decision D1. The prototype printed `Math.random().toString(16).slice(2,10)`
// in the SHA-256 column (line 7946) — decorative. Every digest below is a real
// SHA-256 over a canonical JSON snapshot, computed by proc.fn_pack_hash(), and
// frozen into the pack payload so it can be re-verified later by anyone holding
// the pack.
//
// A digest is either real or absent. There is no fallback that invents one.

import { BadRequestException } from '@nestjs/common';
import { packDocuments, formatDigest, type PackDigests, type PackDocument } from '@procurement/workflow-engine';

export type Run = <U = any>(
  sql: string,
  params?: any[],
) => Promise<{ rows: U[]; rowCount: number }>;

export type PackSplitLine = {
  line_no: number;
  vendor_id: string;
  vendor_name: string;
  awarded_qty: number;
  justification: string;
};

export type LockPackArgs = {
  prId: string;
  prNumber: string;
  userId: string;
  csId: string;
  csNumber: string;
  csRound: number;
  /**
   * NULL for a split-award pack (W5-G). A split has no single winner, and
   * inventing one would put a false vendor name inside a frozen, hashed
   * document — the worst place in the system to be approximately right.
   */
  winner: { vendor_id: string; vendor_name: string } | null;
  /** Present only when `winner` is null. */
  split?: PackSplitLine[];
  quote: any | null;
  /** Why the pack exists, frozen into the payload itself. */
  reason: string;
  routingKey: string;
  /** True on FAST_TRACK, where the MC and CFO gates never ran. */
  mcCfoSkipped: boolean;
  mcApprovedAt: string | null;
  cfoApprovedAt: string | null;
};

/**
 * Hash each of the prototype's six pack documents from its real record.
 *
 * The documents are records, not uploads: there is no PR->file link table in
 * this schema (`core.files` is unattached except for `proc.pr_images`), so a
 * "PR Form (signed)" is the PR header plus its lines, canonically serialised and
 * hashed. When Wave 4 wires real attachment uploads, a file-backed document
 * supplies core.files.sha256 instead and `sources[slot] = 'file'`.
 *
 * Note the asymmetry, which is deliberate:
 *   - `compliance_checklist` hashes whatever the vendor's due-diligence state
 *     ACTUALLY is, including "no records exist". An empty digest is a truthful
 *     attestation that nothing was on file at freeze time.
 *   - `mc_vote_record` and `cfo_approval` return NULL when the gate never ran.
 *     A hash over a non-event would be a fabricated approval, so the engine's
 *     packDocuments() marks them `skipped` and the screen prints no hash.
 */
async function buildDocumentDigests(run: Run, a: LockPackArgs): Promise<PackDigests> {
  const out: PackDigests = {};

  // 1. PR Form (signed) — the header and its lines, as approved.
  const prForm = await run<{ d: string }>(
    `SELECT proc.fn_pack_hash(jsonb_build_object(
              'kind','pr_form',
              'pr_id', pr.id, 'pr_number', pr.pr_number, 'title', pr.title,
              'description', pr.description, 'purpose', pr.purpose,
              'amount', pr.estimated_amount, 'currency', pr.currency,
              'expense_type', pr.expense_type, 'routing_key', pr.routing_key,
              'requester', pr.requester_user_id, 'lines', coalesce((
                SELECT jsonb_agg(jsonb_build_object(
                          'line_no', pl.line_no, 'item', pl.item_id,
                          'qty', pl.quantity, 'uom', pl.uom,
                          'unit_price_est', pl.unit_price_est,
                          'gl_account', pl.gl_account,
                          'classification', pl.classification,
                          'financial_dimensions', pl.financial_dimensions
                        ) ORDER BY pl.line_no)
                  FROM proc.pr_lines pl WHERE pl.pr_id = pr.id), '[]'::jsonb)
            )) AS d
       FROM proc.purchase_requisitions pr WHERE pr.id = $1::uuid`,
    [a.prId],
  );
  out.pr_form = prForm.rows[0]?.d ?? null;

  // 2. Vendor quotes — the awarded quotation and its priced lines.
  if (a.quote?.id) {
    const q = await run<{ d: string }>(
      `SELECT proc.fn_pack_hash(jsonb_build_object(
                'kind','vendor_quotes',
                'quotation_id', q.id, 'rfq_id', q.rfq_id, 'vendor_id', q.vendor_id,
                'version', q.version, 'total_amount', q.total_amount,
                'currency', q.currency, 'lead_time_days', q.lead_time_days,
                'warranty_months', q.warranty_months, 'state', q.state,
                'lines', coalesce((
                  SELECT jsonb_agg(jsonb_build_object(
                            'rfq_line_no', ql.rfq_line_no,
                            'unit_price', ql.unit_price,
                            'total_price', ql.total_price,
                            'declined', ql.declined,
                            'remarks', ql.remarks
                          ) ORDER BY ql.rfq_line_no)
                    FROM proc.quotation_lines ql WHERE ql.quotation_id = q.id), '[]'::jsonb)
              )) AS d
         FROM proc.quotations q WHERE q.id = $1::uuid`,
      [a.quote.id],
    );
    out.vendor_quotes = q.rows[0]?.d ?? null;
  }

  // 3. Comparative Statement — the locked CS, its scores and its recommendation.
  const cs = await run<{ d: string }>(
    `SELECT proc.fn_pack_hash(jsonb_build_object(
              'kind','comparative_statement',
              'cs_id', cs.id, 'cs_number', cs.cs_number, 'cs_round', cs.cs_round,
              'state', cs.state, 'generated_at', cs.generated_at,
              'locked_at', cs.locked_at, 'locked_by', cs.locked_by_user_id,
              'recommendation', cs.recommendation,
              'weights', cs.weights, 'scores', cs.scores,
              'lines', coalesce((
                SELECT jsonb_agg(jsonb_build_object(
                          'vendor_id', cl.vendor_id, 'rank', cl.rank,
                          'commercial', cl.commercial_score, 'technical', cl.technical_score,
                          'warranty', cl.warranty_score, 'weighted', cl.weighted_score
                        ) ORDER BY cl.rank)
                  FROM proc.cs_lines cl WHERE cl.cs_id = cs.id), '[]'::jsonb)
            )) AS d
       FROM proc.comparative_statements cs WHERE cs.id = $1::uuid`,
    [a.csId],
  );
  out.comparative_statement = cs.rows[0]?.d ?? null;

  // 4. MC vote record — NULL unless the committee actually approved.
  if (!a.mcCfoSkipped && a.mcApprovedAt) {
    const mc = await run<{ d: string }>(
      `SELECT proc.fn_pack_hash(jsonb_build_object(
                'kind','mc_vote_record',
                'session_id', s.id, 'opened_at', s.opened_at,
                'closed_at', s.closed_at, 'outcome', s.outcome,
                'chair', s.chair_user_id,
                'panel', coalesce((
                  SELECT jsonb_agg(jsonb_build_object('user_id', p.user_id, 'seat', p.seat)
                                   ORDER BY p.seat) FROM workflow.mc_panel p), '[]'::jsonb),
                'votes', coalesce((
                  SELECT jsonb_agg(jsonb_build_object(
                            'voter', v.voter_user_id, 'decision', v.decision,
                            'voted_at', v.voted_at)
                           ORDER BY v.voter_user_id)
                    FROM workflow.approval_votes v
                   WHERE v.pr_id = s.pr_id AND v.step_id = 'mc_approval'), '[]'::jsonb)
              )) AS d
         FROM workflow.mc_sessions s
        WHERE s.pr_id = $1::uuid AND s.outcome = 'approved'
        ORDER BY s.closed_at DESC NULLS LAST LIMIT 1`,
      [a.prId],
    );
    out.mc_vote_record = mc.rows[0]?.d ?? null;
  }

  // 5. CFO approval — NULL unless the CFO actually signed.
  if (!a.mcCfoSkipped && a.cfoApprovedAt) {
    // A split has no single winner to name, so the frozen document records the
    // whole set. Writing one vendor here would be a fabricated attribution
    // inside a hashed artefact.
    const who = a.winner
      ? a.winner.vendor_name
      : (a.split ?? []).map((s) => s.vendor_name).join(', ') || '(split award)';
    const cfo = await run<{ d: string }>(
      `SELECT proc.fn_pack_hash(jsonb_build_object(
                'kind','cfo_approval',
                'cfo_user_id', $2::uuid, 'approved_at', $3::timestamptz,
                'winner', $4::text, 'total', $5::text
              )) AS d`,
      [a.prId, a.userId, a.cfoApprovedAt, who,
       a.quote ? String(a.quote.total_amount) : null],
    );
    out.cfo_approval = cfo.rows[0]?.d ?? null;
  }

  // 6. Internal compliance checklist — hashes the due-diligence state that
  //    actually exists, empty set included. D5: an absent record is unknown,
  //    never an assumed pass, and this attests to that honestly.
  //
  //    For a SPLIT (W5-G) the checklist covers EVERY winning vendor, not one.
  //    Hashing only a lead vendor's due diligence would attest that the others
  //    were checked when the document says nothing about them at all.
  const ddVendorIds = a.winner
    ? [a.winner.vendor_id]
    : [...new Set((a.split ?? []).map((s) => s.vendor_id))];

  if (ddVendorIds.length === 0) {
    throw new BadRequestException(
      'the pack has neither a winner nor a split award — there is nothing to attest to',
    );
  }

  const dd = await run<{ d: string }>(
    `SELECT proc.fn_pack_hash(jsonb_build_object(
              'kind','compliance_checklist',
              'vendor_ids', $2::uuid[],
              'records', coalesce((
                SELECT jsonb_agg(jsonb_build_object(
                          'vendor_id', d.vendor_id,
                          'dd_id', d.id,
                          'state', d.state,
                          'risk_score', d.risk_score,
                          'checklist', d.checklist,
                          'manager_justification', d.manager_justification,
                          'approved_by_officer_at', d.approved_by_officer_at,
                          'approved_by_manager_at', d.approved_by_manager_at
                        ) ORDER BY d.vendor_id, d.id)
                  FROM core.vendor_due_diligence d WHERE d.vendor_id = ANY($2::uuid[])), '[]'::jsonb),
              'no_records_on_file', NOT EXISTS (
                SELECT 1 FROM core.vendor_due_diligence d WHERE d.vendor_id = ANY($2::uuid[]))
            )) AS d`,
    [a.prId, ddVendorIds],
  );
  out.compliance_checklist = dd.rows[0]?.d ?? null;

  return out;
}

/**
 * Freeze the approved pack.
 *
 * The pack is an INSERT and never an UPDATE. `frozen_at` / `frozen_by_user_id`
 * are NOT NULL, so there is no draft-pack state, and `UNIQUE(pr_id)` makes it
 * once-only. `proc.fn_reject_pack_mutation` enforces the immutability with a
 * trigger on top of that.
 *
 * Already-frozen is NOT an error: a second lock returns the existing pack. The
 * prototype's pack screen shows the locked state rather than a button, and a
 * retry after a dropped connection should not 400.
 */
export async function lockPack(run: Run, a: LockPackArgs) {
  const existing = await run<any>(
    `SELECT id, pack_hash, frozen_at, payload
       FROM proc.approved_packs WHERE pr_id = $1::uuid`,
    [a.prId],
  );
  if (existing.rows.length > 0) {
    const p = existing.rows[0];
    return {
      id: p.id,
      pack_hash: p.pack_hash,
      display_hash: formatDigest(p.pack_hash),
      frozen_at: p.frozen_at,
      already_locked: true,
      auto_locked: false,
      documents: ((p.payload?.documents || []) as PackDocument[]).map((d: PackDocument) => ({
        ...d, display_hash: formatDigest(d.sha256),
      })),
    };
  }

  const digests = await buildDocumentDigests(run, a);

  const payload = {
    kind: 'approved_pack',
    version: 1,
    pr_id: a.prId,
    pr_number: a.prNumber,
    cs_id: a.csId,
    cs_number: a.csNumber,
    cs_round: a.csRound,
    // `winner` is null for a split and the per-line decision lives in `split`.
    // Both are present in the payload so the frozen document is unambiguous
    // about which kind of decision it froze.
    winner: a.winner ? { vendor_id: a.winner.vendor_id, vendor_name: a.winner.vendor_name } : null,
    award_mode: a.winner ? 'SINGLE' : 'SPLIT',
    split: a.split ?? null,
    quotation: a.quote
      ? {
          id: a.quote.id,
          version: a.quote.version,
          total_amount: a.quote.total_amount,
          currency: a.quote.currency,
          lead_time_days: a.quote.lead_time_days,
        }
      : null,
    // WHY the pack exists, recorded in the frozen payload itself.
    reason: a.reason,
    routing_key: a.routingKey,
    mc_cfo_skipped: a.mcCfoSkipped,
    documents: packDocuments({
      routingKey: a.routingKey,
      mcApprovedAt: a.mcApprovedAt,
      cfoApprovedAt: a.cfoApprovedAt,
      digests,
    }),
  };

  const ins = await run<any>(
    `INSERT INTO proc.approved_packs (pr_id, pack_hash, payload, frozen_at, frozen_by_user_id)
     VALUES ($1::uuid, proc.fn_pack_hash($2::jsonb), $2::jsonb, now(), $3::uuid)
     RETURNING id, pack_hash, frozen_at`,
    [a.prId, JSON.stringify(payload), a.userId],
  );

  return {
    id: ins.rows[0].id,
    pack_hash: ins.rows[0].pack_hash,
    display_hash: formatDigest(ins.rows[0].pack_hash),
    frozen_at: ins.rows[0].frozen_at,
    already_locked: false,
    auto_locked: a.mcCfoSkipped,
    // display_hash travels WITH each document so the pack screen never has to
    // re-derive it — and so the FAST_TRACK path in cs.service and the STANDARD
    // path here return byte-identical document rows.
    documents: payload.documents.map((d: PackDocument) => ({
      ...d, display_hash: formatDigest(d.sha256),
    })),
  };
}

/** Read the frozen pack manifest, or null when the pack is not locked yet. */
export async function readPack(run: Run, prId: string) {
  const r = await run<any>(
    `SELECT id, pack_hash, payload, frozen_at
       FROM proc.approved_packs WHERE pr_id = $1::uuid`,
    [prId],
  );
  if (r.rows.length === 0) return null;
  const p = r.rows[0];
  return {
    id: p.id,
    pack_hash: p.pack_hash,
    frozen_at: p.frozen_at,
    payload: p.payload,
    documents: (p.payload?.documents || []) as PackDocument[],
  };
}
