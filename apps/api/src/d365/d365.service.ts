import {
  BadRequestException, ConflictException, ForbiddenException,
  Injectable, NotFoundException,
} from '@nestjs/common';
import { DbService, type SessionContext } from '../db/db.service';
import { roleAllowed } from '@procurement/roles';
import { pushPurchaseOrder, type D365Config, type PurchaseOrderPush } from '@procurement/d365-client';
import { D365_PUSH_ROLES, formatDigest, canPushToD365 } from '@procurement/workflow-engine';
import { parseJsonb } from '../sourcing/rfq.status';
import { GovernanceService } from '../governance/governance.service';
import {
  D365_PURCHASE_ORDER_ENTITY, D365_STATUS_LADDER, buildPurchaseOrderPayload,
  d365EventStream, statusIndex, type D365PayloadInput,
} from './d365.payload';

// Wave 3 step 3 — the D365 push.
//
// REPLACES a 63-line stub that hardcoded `vendorCode: 'TBD'`, bypassed RLS,
// carried no role check, no idempotency, and never wrote proc.d365_pushes —
// which is the very table the d365-status screen is meant to read from.
//
// THREE RULES THIS FILE EXISTS TO ENFORCE
//
// 1. THE PREVIEW IS THE PAYLOAD. renderD365Push prints the JSON as the screen's
//    own content, so it is built once, here, and returned by
//    GET /pr/:id/d365/payload. The screen renders that response; the push sends
//    the same object. They cannot drift.
//
// 2. A PUSH HAPPENS ONCE. `proc.d365_pushes.idempotency_key` is UNIQUE and is
//    derived from the PR and the FROZEN PACK HASH, so re-posting returns the
//    original push instead of creating a second PO in the ERP. attempt_no is
//    capped at 5 by the schema; the fifth failure is a dead letter.
//
// 3. NOTHING ADVANCES ON A TIMER. The prototype's `setTimeout(..., 2500)`
//    (line 7302) that flipped the status to INVENTORY_RESERVED is not ported.
//    Status moves only when POST /pr/:id/d365/sync observes a new state from
//    D365 and writes a proc.d365_sync_log row. Same spirit as decision Q2.

const MAX_ATTEMPTS = 5;

type Ctx = SessionContext;
type Run = <U = any>(sql: string, params?: any[]) => Promise<{ rows: U[]; rowCount: number }>;

@Injectable()
export class D365Service {
  constructor(private readonly db: DbService, private readonly governance: GovernanceService) {}

  // ── GET /pr/:id/d365/payload — renderD365Push's data (line 7953) ─────────

  async payload(prId: string, userId: string, role: string, costCenterIds: string[]) {
    const ctx: Ctx = { userId, role, costCenterIds };
    const input = await this.payloadInput(prId, ctx);
    const built = buildPurchaseOrderPayload(input);
    // W5-G: a split award has several receiving vendors, and a D365 PO HEADER
    // carries exactly one VendorAccount. Pushing this would name vendor A on a
    // purchase order half of whose lines vendor B supplies. So the split is
    // surfaced here and the push is REFUSED until it fans out into one PO per
    // vendor — rather than sending a plausible PO that misattributes half the
    // spend. A split CS simply could not be locked before this track, so there
    // is no pre-existing split PO this withholds.
    const splitAward = input.split_award === true;

    const pushes = await this.db.query<any>(
      `SELECT id, attempt_no, status, d365_po_number, last_error, started_at, finished_at
         FROM proc.d365_pushes WHERE pr_id = $1::uuid ORDER BY started_at DESC`,
      [prId], ctx,
    );

    return {
      pr: {
        id: input.pr_id,
        pr_number: input.pr_number,
        expense_split: input.expense_split,
        routing_key: input.routing_key,
      },
      stage: input.stage,
      ready: canPushToD365(input.stage, Boolean(input.pack_hash)),
      can_push: canPushToD365(input.stage, Boolean(input.pack_hash))
        && roleAllowed(role, D365_PUSH_ROLES.join(','))
        && !splitAward,
      entity: D365_PURCHASE_ORDER_ENTITY,
      // W5-G — the award's shape and every receiving vendor.
      award_mode: input.award_mode ?? 'SINGLE',
      split_award: splitAward,
      vendors: (input.vendors || []).map((v: any) => ({
        vendor_id: v.vendor_id, vendor_code: v.vendor_code, legal_name: v.legal_name,
      })),
      // W5-H: the envelope push is blocked for a split, but the split is no
      // longer a dead end — the per-PO route carries it. Naming that route is
      // the difference between "this cannot be done" and "do it this way".
      push_blocked_reason: splitAward
        ? 'This PR was awarded as a SPLIT across ' +
          `${(input.vendors || []).length} vendors. A D365 purchase-order header carries ` +
          'one VendorAccount, so this package is pushed as one PO per vendor rather than ' +
          'as a single envelope. Generate the orders with POST /pr/:id/po (PER_LINE), ' +
          'issue each with POST /po/:id/issue, then push each with POST /po/:id/push.'
        : null,
      // The exact object the push will send. The screen renders THIS.
      payload: built.envelope,
      header: built.header,
      lines: built.lines,
      pack_hash: input.pack_hash,
      pack_hash_display: formatDigest(input.pack_hash),
      po_number: input.po_number,
      pushes: pushes.rows,
      pushed: Boolean(input.po_number),
      // The same two widgets every governance screen renders, from the one
      // place that builds them.
      ...(await this.governance.widgets(prId, ctx)),
    };
  }

  // ── POST /pr/:id/d365/push — d365Push() (line 7292) ─────────────────────

  async push(prId: string, userId: string, role: string, costCenterIds: string[]) {
    if (!roleAllowed(role, D365_PUSH_ROLES.join(','))) {
      throw new ForbiddenException('Only CS can push to D365.');
    }
    const ctx: Ctx = { userId, role, costCenterIds };

    return this.db.withTransaction(ctx, async (run) => {
      const input = await this.payloadInput(prId, ctx, run);

      // W5-G: refuse a SPLIT-award push. A D365 PO header carries one
      // VendorAccount, and pushing a split would name one supplier on a purchase
      // order whose other lines belong to a different supplier. Checked here as
      // well as in payload(): a guard that only greys out a button is a guard the
      // API still lets you walk around.
      //
      // W5-H changed the remedy, not the rule. Track G could only say "the
      // fan-out is not built yet". It now exists: `POST /pr/:id/po` produces one
      // PO per winning vendor, each carrying only that vendor's lines, and
      // `POST /po/:id/push` sends them one at a time. So the refusal now names
      // the route that works rather than only the reason it cannot.
      if (input.split_award === true) {
        const orders = await this.db.query<any>(
          `SELECT count(*)::int AS n FROM proc.purchase_orders
            WHERE pr_id = $1::uuid AND state <> 'Cancelled'`,
          [prId], ctx,
        );
        const n = Number(orders.rows[0]?.n ?? 0);
        throw new BadRequestException(
          `This PR was awarded as a SPLIT across ${(input.vendors || []).length} vendors, and a ` +
          `D365 purchase-order header carries one VendorAccount — so this PR is pushed ONE ` +
          `PURCHASE ORDER AT A TIME, not as a single envelope. ` +
          (n > 0
            ? `${n} purchase order(s) already exist: generate/issue them via POST /pr/${prId}/po ` +
              `and POST /po/:id/issue, then push each with POST /po/:id/push.`
            : `Generate them first with POST /pr/${prId}/po (mode PER_LINE), issue each, then ` +
              `push each with POST /po/:id/push.`),
        );
      }

      // ── IDEMPOTENCY FIRST, before any stage gate ────────────────────────
      // Keyed on the PACK, not the PR: if the pack is the same, the PO that
      // should exist is the same, whatever happened last time.
      //
      // This must PRECEDE the gate below, because the gate reads the CURRENT
      // stage — and after a successful push that stage is D365_PUSHED, which is
      // correctly no longer pushable. A replay is not a new push.
      if (!input.pack_hash) throw new ConflictException('Pack not yet locked.');

      const key = `${prId}:${input.pack_hash}`;
      const prior = await run<any>(
        `SELECT id, attempt_no, status, d365_po_number, d365_response, last_error
           FROM proc.d365_pushes WHERE idempotency_key = $1`,
        [key],
      );

      if (prior.rows.length > 0 && prior.rows[0].status === 'succeeded') {
        return {
          pushed: true,
          already_pushed: true,
          po_number: prior.rows[0].d365_po_number,
          status: input.d365_status || D365_STATUS_LADDER[0],
          attempt_no: prior.rows[0].attempt_no,
          stage: input.stage,
          event: { action: 'Already pushed to D365', detail: `PO ${prior.rows[0].d365_po_number} — no second PO created` },
          next: `Already pushed. PO ${prior.rows[0].d365_po_number} is confirmed in D365.`,
        };
      }

      // The prototype's own gate, verbatim: 'Pack not yet locked.'
      if (!canPushToD365(input.stage, true)) {
        throw new ConflictException('Pack not yet locked.');
      }
      if (!input.vendor_code) {
        throw new BadRequestException('the CS winner has no vendor code to push against');
      }

      const attempt = prior.rows.length > 0 ? Number(prior.rows[0].attempt_no) + 1 : 1;
      if (attempt > MAX_ATTEMPTS) {
        throw new ConflictException(
          `this pack has already been pushed ${MAX_ATTEMPTS} times without success — ` +
          `the last error was: ${prior.rows[0]?.last_error ?? 'unknown'}`,
        );
      }

      // Claim the attempt BEFORE calling out, so a crash mid-request cannot
      // leave the key unclaimed and permit a duplicate PO on retry.
      let pushId: string;
      if (prior.rows.length > 0) {
        const upd = await run<any>(
          `UPDATE proc.d365_pushes
              SET attempt_no = $2, status = 'pending', started_at = now(), last_error = NULL
            WHERE idempotency_key = $1
          RETURNING id`,
          [key, attempt],
        );
        pushId = upd.rows[0].id;
      } else {
        const ins = await run<any>(
          `INSERT INTO proc.d365_pushes (pr_id, pack_id, idempotency_key, attempt_no, status)
           VALUES ($1::uuid, $2::uuid, $3, $4, 'pending')
           RETURNING id`,
          [prId, input.pack_id, key, attempt],
        );
        pushId = ins.rows[0].id;
      }

      const poInput: PurchaseOrderPush = {
        prNumber: input.pr_number,
        vendorCode: input.vendor_code,
        amount: input.total_amount,
        currency: input.currency || 'PKR',
        lines: input.lines.map((l) => ({
          lineNo: l.line_no,
          itemCode: l.sku,
          quantity: l.quantity,
          uom: l.uom || 'EA',
          unitPrice: l.unit_price,
        })),
      };

      let result: Awaited<ReturnType<typeof pushPurchaseOrder>>;
      try {
        result = await pushPurchaseOrder(this.config(), poInput);
      } catch (err: any) {
        // Record the failure against the attempt we just claimed. The row stays
        // so the next attempt is attempt_no + 1, not a fresh claim.
        const dead = attempt >= MAX_ATTEMPTS;
        await run(
          `UPDATE proc.d365_pushes
              SET status = $2, last_error = $3, finished_at = now()
            WHERE id = $1::uuid`,
          [pushId, dead ? 'dead_letter' : 'failed', String(err?.message || err).slice(0, 2000)],
        );
        throw new BadRequestException(
          `the D365 push failed: ${String(err?.message || err).slice(0, 300)}` +
          (dead ? ` — attempt ${MAX_ATTEMPTS} is a dead letter; escalate rather than retry` : ''),
        );
      }

      const poNumber = result.poNumber || null;
      await run(
        `UPDATE proc.d365_pushes
            SET status = 'succeeded', d365_po_number = $2, d365_request_id = $3,
                d365_response = $4::jsonb, finished_at = now()
          WHERE id = $1::uuid`,
        [pushId, poNumber, `req-${pushId}`, JSON.stringify(result)],
      );

      await run(
        `UPDATE proc.purchase_requisitions
            SET d365_po_number = $2, d365_status = $3, status = $4
          WHERE id = $1::uuid`,
        [prId, poNumber, D365_STATUS_LADDER[0], 'D365_PUSHED'],
      );
      // No d365_sync_log row here. That table's `source` is CHECKed to
      // poll|webhook|reconciliation — a push is none of those, and the ERP's
      // response to our push already has a home: d365_pushes.d365_response.
      // d365_sync_log is a log of OBSERVATIONS, and a push is not one.
      await run(
        `INSERT INTO audit.audit_log (actor_user_id, entity, entity_id, action, after)
         VALUES ($1::uuid, 'purchase_requisition', $2, 'pack_push', $3::jsonb)`,
        [userId, prId, JSON.stringify({ push_id: pushId, po_number: poNumber, attempt })],
      );

      return {
        pushed: true,
        already_pushed: false,
        po_number: poNumber,
        // W5-H: whether this PO exists in F&O at all. The stub used to return
        // `PO-2026-004271`, which is indistinguishable from a real number in
        // every downstream report. It now returns `STUB-PO-…`, and this flag
        // says so explicitly so a screen can refuse to present it as a
        // commitment.
        stubbed: result.stubbed === true,
        po_id: result.poId ?? null,
        status: D365_STATUS_LADDER[0],
        attempt_no: attempt,
        stage: 'D365_PUSHED',
        // The prototype's own pushEvent line (line 7299).
        event: { action: 'Pushed to D365 F&O', detail: `OData POST ${D365_PURCHASE_ORDER_ENTITY} succeeded — ${poNumber}` },
        next: result.stubbed
          ? `STUB MODE: no purchase order exists in D365 F&O. ${poNumber} is a local placeholder.`
          : `Pushed to D365. ${poNumber} confirmed.`,
      };
    });
  }

  // ── GET /pr/:id/d365/status — renderD365Status's data (line 8020) ───────

  async status(prId: string, userId: string, role: string, costCenterIds: string[]) {
    const ctx: Ctx = { userId, role, costCenterIds };
    const input = await this.payloadInput(prId, ctx);

    const log = await this.db.query<any>(
      `SELECT d365_status, source, observed_at, raw
         FROM proc.d365_sync_log WHERE pr_id = $1::uuid
        ORDER BY observed_at ASC`,
      [prId], ctx,
    );

    // The FIRST time each status was seen — that is the honest timestamp for a
    // completed step, rather than the prototype's relative "+2 sec".
    const observedAt: Record<string, string> = {};
    for (const r of log.rows) {
      if (r.d365_status && !observedAt[r.d365_status]) observedAt[r.d365_status] = r.observed_at;
    }
    // The push is not a sync observation (d365_sync_log's `source` CHECK has no
    // 'push'), so the CONFIRMED timestamp comes from the push row instead —
    // which is when the ERP first actually told us.
    if (input.po_number && !observedAt[D365_STATUS_LADDER[0]]) {
      const pushRow = await this.db.query<any>(
        `SELECT finished_at FROM proc.d365_pushes
          WHERE pr_id = $1::uuid AND status = 'succeeded'
          ORDER BY finished_at LIMIT 1`,
        [prId], ctx,
      );
      if (pushRow.rows[0]?.finished_at) observedAt[D365_STATUS_LADDER[0]] = pushRow.rows[0].finished_at;
    }

    const current = input.d365_status
      || (log.rows.length ? log.rows[log.rows.length - 1].d365_status : null);

    return {
      pr: {
        id: input.pr_id,
        pr_number: input.pr_number,
        expense_split: input.expense_split,
      },
      stage: input.stage,
      pushed: Boolean(input.po_number),
      po_number: input.po_number,
      d365_status: current,
      status_index: statusIndex(current),
      // The prototype's six rows, in its order, with states COMPUTED.
      events: d365EventStream({ poNumber: input.po_number, status: current, observedAt }),
      // The 10-column PO line table, shown only once pushed.
      lines: input.po_number ? input.lines : [],
      sync_log: log.rows.map((r: any) => ({ ...r, raw: parseJsonb(r.raw) })),
      // The prototype has no sync control because its status advanced on a
      // timer. Here something has to ask.
      can_sync: Boolean(input.po_number) && roleAllowed(role, D365_PUSH_ROLES.join(',')),
      ...(await this.governance.widgets(prId, ctx)),
    };
  }

  // ── POST /pr/:id/d365/sync — observe, never advance on a timer ──────────

  /**
   * Poll D365 for the PO's current state and record it.
   *
   * The ONLY thing that moves a PO's status. In stub mode the "ERP" advances
   * one ladder step per observed poll, so the behaviour is deterministic and
   * testable: call sync and the status moves; don't call it and nothing moves.
   */
  async sync(prId: string, userId: string, role: string, costCenterIds: string[]) {
    if (!roleAllowed(role, D365_PUSH_ROLES.join(','))) {
      throw new ForbiddenException('Only CS can push to D365.');
    }
    const ctx: Ctx = { userId, role, costCenterIds };

    const input = await this.payloadInput(prId, ctx);
    if (!input.po_number) {
      throw new BadRequestException('this PR has not been pushed to D365 yet');
    }

    const observed = await this.observeStatus(input);

    // Unchanged is a legitimate observation, not an error — and it is NOT
    // written, because d365_sync_log is a record of CHANGES.
    if (observed.status === input.d365_status) {
      return {
        changed: false,
        status: observed.status,
        status_index: statusIndex(observed.status),
        po_number: input.po_number,
        next: `${observed.status} — unchanged since the last observation.`,
      };
    }

    await this.db.query(
      `INSERT INTO proc.d365_sync_log (pr_id, d365_status, source, raw)
       VALUES ($1::uuid, $2, 'poll', $3::jsonb)`,
      [prId, observed.status, JSON.stringify(observed.raw)],
      ctx,
    );
    await this.db.query(
      `UPDATE proc.purchase_requisitions SET d365_status = $2 WHERE id = $1::uuid`,
      [prId, observed.status],
      ctx,
    );

    return {
      changed: true,
      status: observed.status,
      status_index: statusIndex(observed.status),
      po_number: input.po_number,
      next: `D365 reports ${observed.status}.`,
    };
  }

  // ── internals ────────────────────────────────────────────────────────────

  /**
   * Read the PO's state from D365.
   *
   * The stub advances ONE ladder step per observation, counting from the PO's
   * CURRENT known status rather than from a row count — so the ladder's base is
   * real state, not an assumption about how many polls have happened. A
   * clock-based stub would reintroduce exactly the fake async the prototype has
   * (its `setTimeout(..., 2500)`), and a count-based one desynchronises the
   * moment a poll fails.
   */
  private async observeStatus(input: D365PayloadInput & { d365_status: string | null }) {
    if (this.config().mode === 'live') {
      // No live adapter yet. Refusing loudly beats inventing a plausible value.
      throw new BadRequestException(
        'D365 live mode is not implemented; set D365_MODE=stub to use the deterministic stub',
      );
    }
    const current = statusIndex(input.d365_status);
    const idx = Math.min((current < 0 ? 0 : current) + 1, D365_STATUS_LADDER.length - 1);
    return {
      status: D365_STATUS_LADDER[idx],
      raw: {
        stub: true, from: input.d365_status, to: D365_STATUS_LADDER[idx],
        po_number: input.po_number,
        note: 'deterministic stub: one ladder step per observed poll, no clock',
      },
    };
  }

  /**
   * Everything the payload needs, read once.
   *
   * Reads through the session context — NOT `bypassRls`, which the old stub
   * used unconditionally. A purchase order's vendor, price and financial
   * dimensions are not readable by every authenticated user in the system.
   */
  private async payloadInput(prId: string, ctx: Ctx, run?: Run) {
    const q = run
      ? <T = any>(sql: string, params: any[] = []) => run<T>(sql, params)
      : <T = any>(sql: string, params: any[] = []) => this.db.query<T>(sql, params, ctx);

    const pr = await q<any>(
      `SELECT pr.id, pr.pr_number, pr.status, pr.currency, pr.estimated_amount,
              pr.expense_type AS expense_split, pr.routing_key, pr.purpose,
              pr.d365_po_number, pr.d365_status, pr.capex_amount, pr.opex_amount,
              p.id AS pack_id, p.pack_hash
         FROM proc.purchase_requisitions pr
         LEFT JOIN proc.approved_packs p ON p.pr_id = pr.id
        WHERE pr.id = $1::uuid`,
      [prId],
    );
    if (pr.rows.length === 0) throw new NotFoundException('PR not found');
    const row = pr.rows[0];

    // W5-G: a SPLIT award carries no winner_vendor_id, so the old INNER JOIN on
    // that key produced NO ROW AT ALL for a split CS — a silently empty vendor
    // on a PO that was otherwise ready to push. The winners are now read from
    // whichever shape the locked CS actually used.
    const winners = await q<any>(
      `WITH cs AS (
         SELECT id, award_mode, recommendation
           FROM proc.comparative_statements
          WHERE pr_id = $1::uuid
            AND cs_round = proc.fn_latest_cs_round($1::uuid)
            AND state = 'Locked'
       )
       SELECT DISTINCT ON (vendor_id)
              vendor_id::text AS vendor_id, vendor_code, legal_name,
              total_amount, quotation_id, (SELECT award_mode FROM cs) AS award_mode
         FROM (
         SELECT c.recommendation->>'winner_vendor_id' AS vendor_id,
                q.id AS quotation_id, q.total_amount
           FROM cs c
           -- The single-winner branch MUST still carry the awarded quotation:
           -- its total is the PO's TotalAmount. Dropping this join made 'awarded'
           -- null for every ordinary CS and silently pushed the PR ESTIMATE to
           -- D365 as if it were a commitment — the precise mistake the
           -- "TotalAmount is what the vendor was AWARDED" rule exists to stop.
           LEFT JOIN proc.quotations q
                  ON q.id = (c.recommendation->>'winner_quotation_id')::uuid
          WHERE c.recommendation->>'winner_vendor_id' IS NOT NULL
           UNION ALL
           -- A split has no single awarded quotation: the total is computed from
           -- the awarded LINES in payloadInput instead.
           SELECT s.value ->> 'vendor_id', NULL::uuid, NULL::numeric
             FROM cs c, LATERAL jsonb_array_elements(
                    CASE WHEN jsonb_typeof(c.recommendation->'split') = 'array'
                         THEN c.recommendation->'split' ELSE '[]'::jsonb END) AS s(value)
            WHERE s.value ->> 'vendor_id' IS NOT NULL
         ) w
         JOIN core.vendors v ON v.id = w.vendor_id::uuid
        ORDER BY vendor_id, vendor_code`,
      [prId],
    );
    const w = winners.rows[0] || null;
    // The mode, not the vendor count. A split where one vendor happens to win
    // every line has the same vendor set as a SINGLE lock and must still be
    // treated as a split — it has no `winner_total` to fall back on.
    const awardMode: string | null = w?.award_mode ?? null;
    const isSplitAward = awardMode === 'SPLIT';

    // The awarded quotation supplies the REAL prices; the PR's own lines are
    // the fallback for a PR that never went through sourcing.
    //
    // W5-G: on a split, each line is priced from ITS OWN winner's quotation.
    // The previous `q.state='Awarded' … LIMIT 1` picked one vendor's prices and
    // applied them to every line, which on a split would have pushed one
    // supplier's unit price onto lines a different supplier had won. The second
    // LATERAL is the original single-winner path, kept intact so a SINGLE award
    // behaves exactly as it did before.
    const lines = await q<any>(
      `SELECT pl.line_no, i.item_code AS sku, pl.quantity, pl.uom,
              coalesce(split_price.unit_price, single_price.unit_price, pl.unit_price_est) AS unit_price,
              pl.classification, pl.gl_account, pl.remarks, pl.financial_dimensions
         FROM proc.pr_lines pl
         LEFT JOIN core.items i ON i.id = pl.item_id
         LEFT JOIN LATERAL (
              SELECT ql.unit_price
                FROM proc.cs_line_awards a
                JOIN proc.comparative_statements cs
                  ON cs.id = a.cs_id AND cs.state = 'Locked'
                 AND cs.pr_id = pl.pr_id
                 AND cs.cs_round = proc.fn_latest_cs_round(pl.pr_id)
                JOIN proc.quotation_lines ql ON ql.rfq_line_no = a.rfq_line_no
                JOIN proc.quotations q
                  ON q.id = ql.quotation_id
                 AND q.vendor_id = a.vendor_id
                 AND q.state = 'Awarded'
               WHERE a.rfq_line_no = pl.line_no AND a.superseded_at IS NULL
               LIMIT 1
         ) split_price ON true
         LEFT JOIN LATERAL (
              SELECT ql.unit_price
                FROM proc.quotation_lines ql
                JOIN proc.quotations q
                  ON q.id = ql.quotation_id AND q.state = 'Awarded'
                 AND q.rfq_id = (SELECT rf.id FROM proc.rfq rf WHERE rf.pr_id = pl.pr_id)
               WHERE ql.rfq_line_no = pl.line_no
               ORDER BY q.version DESC
               LIMIT 1
         ) single_price ON true
        WHERE pl.pr_id = $1::uuid AND NOT pl.rejected AND NOT pl.held
        ORDER BY pl.line_no`,
      [prId],
    );

    const acks = await q<any>(
      `SELECT name, email, tagged_role, acknowledged, acknowledged_at
         FROM proc.pr_acknowledgements WHERE pr_id = $1::uuid
        ORDER BY tagged_at`,
      [prId],
    );

    // TotalAmount on a D365 PO is what the vendor was AWARDED, not what the PR
    // estimated. Once a CS is locked the awarded quotation total is the only
    // defensible figure; the PR estimate is a budget request, not a commitment.
    // A PR that never went through sourcing falls back to its own estimate.
    const awarded = w?.total_amount === null || w?.total_amount === undefined
      ? null
      : Number(w.total_amount);
    const splitTotal = row.capex_amount !== null || row.opex_amount !== null
      ? Number(row.capex_amount || 0) + Number(row.opex_amount || 0)
      : null;

    // A split has no single quotation total, so a PO total built from the sum of
    // the PR's OWN lines — each already priced from its actual winner above — is
    // the only defensible figure. Falling back to the PR estimate here would be
    // the exact mistake the comment above warns about: pushing a budget request
    // to F&O as if it were a commitment.
    const lineTotal = lines.rows.reduce(
      (n: number, l: any) => n + Number(l.unit_price ?? 0) * Number(l.quantity ?? 0), 0);

    const total = isSplitAward
      ? lineTotal
      : (awarded ?? (splitTotal || null) ?? Number(row.estimated_amount || 0));

    return {
      pr_id: row.id,
      pr_number: row.pr_number,
      stage: row.status,
      po_number: row.d365_po_number || null,
      d365_status: row.d365_status || null,
      pack_id: row.pack_id || null,
      pack_hash: row.pack_hash || null,
      vendor_code: w?.vendor_code || null,
      // W5-G: a split PO has several vendors. `vendor_code` stays as the first
      // for backward compatibility with the single-vendor screen, and
      // `vendors` carries the real set so the UI can show every recipient.
      award_mode: awardMode,
      split_award: isSplitAward,
      vendors: winners.rows.map((v: any) => ({
        vendor_id: v.vendor_id, vendor_code: v.vendor_code, legal_name: v.legal_name,
      })),
      expense_split: row.expense_split,
      purpose: row.purpose || null,
      currency: row.currency || 'PKR',
      total_amount: total,
      capex_amount: row.capex_amount === null ? null : Number(row.capex_amount),
      opex_amount: row.opex_amount === null ? null : Number(row.opex_amount),
      routing_key: row.routing_key || 'STANDARD',
      // The prototype's recipientName precedence (line 7960): the first tagged
      // approver's name, or an em-dash when nobody is tagged.
      delivery_to: acks.rows[0]?.name || null,
      acknowledgements: acks.rows.map((a: any) => ({
        email: a.email,
        name: a.name,
        role: a.tagged_role,
        role_label: a.tagged_role,
        acknowledged: a.acknowledged === true,
        acknowledged_at: a.acknowledged_at || null,
      })),
      lines: lines.rows.map((l: any) => ({
        line_no: Number(l.line_no),
        sku: l.sku,
        quantity: Number(l.quantity || 0),
        uom: l.uom || null,
        unit_price: Number(l.unit_price || 0),
        classification: l.classification || null,
        gl_account: l.gl_account || null,
        remarks: l.remarks || null,
        financial_dimensions: parseJsonb(l.financial_dimensions) || {},
      })),
    } as D365PayloadInput & { stage: string; d365_status: string | null; pack_id: string | null };
  }

  private config(): D365Config {
    return {
      mode: (process.env.D365_MODE as 'stub' | 'live') || 'stub',
      baseUrl: process.env.D365_BASE_URL,
      tenantId: process.env.D365_TENANT_ID,
      clientId: process.env.D365_CLIENT_ID,
      clientSecret: process.env.D365_CLIENT_SECRET,
      company: process.env.D365_COMPANY || 'PKE',
    };
  }

  /** Exposed for anything that needs "is this PR pushable?" without duplicating it. */
  async isPushable(prId: string) {
    return this.governance.pushable(prId, 'system', []);
  }
}
