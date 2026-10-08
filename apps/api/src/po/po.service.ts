import {
  BadRequestException, ConflictException, ForbiddenException,
  Injectable, NotFoundException,
} from '@nestjs/common';
import { DbService, type SessionContext } from '../db/db.service';
import { roleAllowed } from '@procurement/roles';
import { parseJsonb } from '../sourcing/rfq.status';
import { pushPurchaseOrder } from '@procurement/d365-client';

/**
 * WAVE 5 TRACK H — Purchase Order generation.
 *
 * The gap this closes, stated as a chain of consequences
 *
 * A PR is approved, the pack is frozen, and then the system asks "where is the
 * purchase order?" There was no answer. `proc.approved_packs` is a hash document
 * describing an approval; it is not an order, and it names no supplier. The
 * only PO-like thing that existed was a `Math.random()` string written by a stub
 * directly onto the PR row, so:
 *
 *   - there was no record of WHAT was ordered, per supplier;
 *   - a split award had nowhere to live at all — Track G refused the D365 push
 *     for exactly this reason, and the fan-out it deferred is built here;
 *   - "issued" was not a state. A PO could not be generated, issued, or
 *     tracked; it went straight from approval to a number on the PR.
 *
 * THE RULE THAT MATTERS
 *
 * A purchase order may only exist for lines that WON. Lines that were held,
 * stock-fulfilled, rejected or never awarded get an explicit exclusion row
 * rather than silently vanishing, and `proc.fn_pr_line_po_coverage` reports the
 * gap. The generator refuses when a line is neither covered nor explained,
 * because "we approved a PR and one line quietly never got ordered" is the
 * failure mode that costs real money and leaves no trace.
 */

// Lowercase, because that is what `core.users.role` actually stores — the
// CHECK constraint lists 'procurement','cs','mc','cfo','admin', never
// 'Procurement'. A capitalized list here matched nothing, so 403 denied every
// real user and the feature was dead on arrival. There is also no 'Manager'
// role: the managerial vocabularies are procurement_manager,
// department_manager and management.
//
// `admin` is not listed as a special case — ROLE_ALIASES expands it to the
// union of the roles it covers.
const PO_ROLES = 'procurement,cs,procurement_manager,management,cfo,mc,hod,admin';

type Ctx = { userId: string; role: string; costCenterIds: string[] };

@Injectable()
export class PoService {
  constructor(private readonly db: DbService) {}

  /**
   * Build the local PO number.
   *
   * Deliberately NOT shaped like an F&O number (`PO-2026-000123`). A local
   * placeholder and a real purchase order must be impossible to confuse in a
   * report, a reconciliation or a screenshot.
   *
   * Allocated from a SEQUENCE, deliberately not from max(po_number) + 1.
   * That read-modify-write was wrong twice over: the old regex
   * `LOCAL-(\d+)$` could not match the string it produced, so every PO came
   * out as ...-000001; and the lookup ran on a different connection from the
   * inserts, so two POs created in one transaction saw the same maximum. A
   * split award therefore failed on the second vendor, every single time.
   * Sequences are allocation-safe within a transaction and under concurrency.
   */
  private async nextPoNumber(): Promise<string> {
    const r = await this.db.query<{ n: number }>(
      `SELECT nextval('proc.seq_po_number') AS n`,
      [], { role: 'system', bypassRls: true } as any,
    );
    const n = Number(r.rows[0]?.n ?? 1);
    return `LOCAL-PO-${new Date().getFullYear()}-${String(n).padStart(6, '0')}`;
  }

  /**
   * POST /pr/:id/po — generate purchase orders for a frozen, approved package.
   *
   * `mode`:
   *   'AUTO'     — PER_LINE when the CS is a split award, SINGLE otherwise.
   *                The default, and the only one that is safe: a split can
   *                never be expressed as a single PO.
   *   'SINGLE'   — one PO covering every awarded line. REFUSED for a split
   *                award, because one PO header carries one VendorAccount and
   *                would misattribute half the supply.
   *   'PER_LINE' — one PO per winning vendor. Refused for a single-winner award
   *                unless `force` is set, because it would produce several POs
   *                for one supplier for no reason.
   */
  async generate(
    prId: string, userId: string, role: string, costCenterIds: string[],
    body: { mode?: 'AUTO' | 'SINGLE' | 'PER_LINE'; reason?: string } = {},
  ) {
    if (!roleAllowed(role, PO_ROLES)) {
      throw new ForbiddenException('You do not have permission to generate purchase orders.');
    }
    const ctx: Ctx = { userId, role, costCenterIds };

    const pr = await this.db.query<any>(
      `SELECT id, pr_number, status, currency FROM proc.purchase_requisitions WHERE id = $1::uuid`,
      [prId], ctx,
    );
    if (pr.rows.length === 0) throw new NotFoundException('Purchase Request not found');
    const p = pr.rows[0];

    // Generating a PO before the approval chain has finished would let an
    // unapproved commitment exist as a document. Refuse at the door with the
    // stage named, rather than producing a PO that later has to be voided.
    if (p.status !== 'PACK_LOCKED') {
      throw new BadRequestException(
        `Purchase orders are generated from an APPROVED package. PR ${p.pr_number} is at ` +
        `${p.status}, not PACK_LOCKED.`,
      );
    }

    const cs = await this.db.query<any>(
      `SELECT id, cs_number, award_mode, recommendation
         FROM proc.comparative_statements
        WHERE pr_id = $1::uuid AND cs_round = proc.fn_latest_cs_round($1::uuid)
        ORDER BY state = 'Locked' DESC LIMIT 1`,
      [prId], ctx,
    );
    if (cs.rows.length === 0) throw new BadRequestException('this PR has no comparative statement');
    const c = cs.rows[0];

    const rec = parseJsonb(c.recommendation) || {};
    const isSplit = c.award_mode === 'SPLIT' || Array.isArray(rec.split);
    const split = Array.isArray(rec.split) ? rec.split : [];
    const winnerId = rec.winner_vendor_id ?? null;

    const requested = body.mode ?? 'AUTO';
    const mode = requested === 'AUTO' ? (isSplit ? 'PER_LINE' : 'SINGLE') : requested;

    if (mode === 'SINGLE' && isSplit) {
      throw new BadRequestException(
        `PR ${p.pr_number} was awarded as a SPLIT across ` +
        `${new Set(split.map((s: any) => s.vendor_id)).size} vendors. One purchase order ` +
        `carries one VendorAccount, so a single PO would name one supplier for ` +
        `lines a different supplier won. Generate PER_LINE instead.`,
      );
    }
    if (mode === 'PER_LINE' && !isSplit) {
      const rows = await this.db.query<any>(
        `SELECT 1 FROM proc.purchase_orders WHERE pr_id = $1::uuid LIMIT 1`, [prId], ctx,
      );
      if (rows.rows.length > 0) {
        throw new ConflictException(
          'purchase orders already exist for this PR; regenerate is not supported — ' +
          'cancel them first so the old orders stay on record',
        );
      }
    }

    // Which vendor gets which lines.
    const assignment: { vendor_id: string; line_nos: number[] }[] = isSplit
      ? (() => {
          const byVendor = new Map<string, number[]>();
          for (const s of split) {
            const list = byVendor.get(s.vendor_id) ?? [];
            list.push(Number(s.line_no));
            byVendor.set(s.vendor_id, list);
          }
          return [...byVendor.entries()].map(([vendor_id, line_nos]) => ({ vendor_id, line_nos }));
        })()
      : winnerId
        ? [{ vendor_id: winnerId, line_nos: [] }]   // every awardable line
        : [];

    if (assignment.length === 0) {
      throw new BadRequestException(
        'this comparative statement records no winner — nothing to generate a purchase order for',
      );
    }

    return this.db.withTransaction(ctx, async (run) => {
      // Refuse to double-order. The unique index on pr_line_id would stop the
      // duplicate line, but the PO header would already exist and the operator
      // would be left with one live PO and one refused half-write.
      const existing = await run<any>(
        `SELECT po.po_number, v.vendor_code
           FROM proc.purchase_orders po JOIN core.vendors v ON v.id = po.vendor_id
          WHERE po.pr_id = $1::uuid AND po.state <> 'Cancelled'`,
        [prId],
      );
      if (existing.rows.length > 0) {
        throw new ConflictException(
          `PR ${p.pr_number} already has purchase order(s): ` +
          existing.rows.map((r: any) => `${r.po_number} (${r.vendor_code})`).join(', ') +
          `. Cancel them before generating new ones — a PO is a commitment record, ` +
          `not a scratch value.`,
        );
      }

      // The candidate lines: every live PR line, priced from the RFQ.
      const cand = await run<any>(
        `SELECT pl.id, pl.line_no, pl.item_id, pl.description, pl.quantity, pl.uom,
                pl.gl_account, pl.classification, pl.financial_dimensions, pl.held,
                rl.line_no AS rfq_line_no,
                ql.unit_price
           FROM proc.pr_lines pl
           LEFT JOIN proc.rfq_lines rl
                  ON rl.rfq_id = (SELECT r.id FROM proc.rfq r WHERE r.pr_id = pl.pr_id)
                 AND rl.line_no = pl.line_no
           LEFT JOIN proc.quotation_lines ql
                  ON ql.rfq_line_no = rl.line_no
                 AND ql.quotation_id = (
                       SELECT q.id FROM proc.quotations q
                        WHERE q.rfq_id = rl.rfq_id AND q.state IN ('Submitted','Awarded')
                        ORDER BY q.version DESC LIMIT 1)
          WHERE pl.pr_id = $1::uuid AND NOT pl.rejected
          ORDER BY pl.line_no`,
        [prId],
      );
      if (cand.rows.length === 0) {
        throw new BadRequestException('this PR has no live lines to order');
      }

      // Partition, then explain every line that did not make it onto a PO.
      const byRfqLine = new Map<number, any>();
      for (const r of cand.rows as any[]) {
        if (r.rfq_line_no !== null && r.rfq_line_no !== undefined) byRfqLine.set(Number(r.rfq_line_no), r);
      }

      const planned: { vendor_id: string; rows: any[] }[] = [];
      const excluded: { pr_line_id: string; reason: string; detail: string | null }[] = [];
      const claimed = new Set<string>();

      for (const a of assignment) {
        const chosen = a.line_nos.length > 0
          // PER_LINE: exactly the lines this vendor was awarded.
          ? a.line_nos.map((n) => byRfqLine.get(n)).filter(Boolean)
          // SINGLE: every awardable line — awarded is implied, not per-line.
          : (cand.rows as any[]).filter((r) => r.rfq_line_no !== null || true);

        const rows = chosen.filter((r: any) => {
          if (r.held) return false;
          // A free-text line has no catalogue item (migration 052), and
          // proc.purchase_order_lines.item_id is still NOT NULL + FK — a PO is a
          // commitment to a vendor against a real product code, so this genuinely
          // cannot be ordered as-is.
          //
          // Without this filter the INSERT would fail with a raw not-null
          // violation on a constraint name and no explanation, AFTER the award
          // had already been decided. Excluding it here means the requester gets
          // the reason below, which is the difference between "fix your data" and
          // "something is broken".
          if (!r.item_id) return false;
          claimed.add(r.id);
          return true;
        });
        planned.push({ vendor_id: a.vendor_id, rows });

        for (const r of chosen as any[]) {
          if (r.held) {
            excluded.push({
              pr_line_id: r.id, reason: 'HELD',
              detail: r.held_reason ?? 'the line is held and was never released',
            });
          } else if (!r.item_id) {
            excluded.push({
              pr_line_id: r.id, reason: 'NO_CATALOGUE_ITEM',
              detail: 'the line is free text with no catalogue item, so there is no '
                    + 'product code to order against — match it to a catalogue item first',
            });
          }
        }
      }

      // Everything not on a PO must be EXPLAINED. This is the difference
      // between a traceable short order and a silent one.
      for (const r of cand.rows as any[]) {
        if (claimed.has(r.id)) continue;
        if (excluded.some((e) => e.pr_line_id === r.id)) continue;
        excluded.push({
          pr_line_id: r.id,
          reason: r.rfq_line_no === null || r.unit_price === null ? 'NOT_AWARDED' : 'NOT_AWARDED',
          detail: r.rfq_line_no === null
            ? 'the line never reached an RFQ'
            : 'no line award covers this line',
        });
      }

      // Refuse rather than order a line at no price.
      const priceless = planned.flatMap((x) => x.rows).filter((r: any) =>
        r.unit_price === null || r.unit_price === undefined);
      if (priceless.length > 0) {
        throw new BadRequestException(
          `these lines have no awarded unit price and cannot be ordered: ` +
          `${priceless.map((r: any) => `#${r.line_no}`).join(', ')}. ` +
          `A purchase order with a zero-price line is not a purchase order.`,
        );
      }

      const created: any[] = [];

      for (const plan of planned) {
        if (plan.rows.length === 0) continue;

        const totals = plan.rows.reduce(
          (n: number, r: any) => n + Math.round(Number(r.quantity) * Number(r.unit_price) * 100) / 100, 0,
        );

        const po = await run<any>(
          `INSERT INTO proc.purchase_orders
             (po_number, pr_id, cs_id, vendor_id, generation_mode, state, currency,
              total_amount, created_by_user_id)
           VALUES ($1, $2::uuid, $3::uuid, $4::uuid, $5, 'Generated', $6, $7, $8::uuid)
           RETURNING id, po_number, total_amount`,
          [await this.nextPoNumber(), prId, c.id, plan.vendor_id, mode, p.currency || 'PKR', totals, userId],
        );
        const newPo = po.rows[0];

        for (let i = 0; i < plan.rows.length; i++) {
          const r = plan.rows[i];
          await run(
            `INSERT INTO proc.purchase_order_lines
               (po_id, line_no, pr_line_id, item_id, description, quantity, uom,
                unit_price, classification, gl_account, financial_dimensions)
             VALUES ($1::uuid, $2, $3::uuid, $4::uuid, $5, $6, $7, $8, $9, $10, $11::jsonb)`,
            [
              newPo.id, i + 1, r.id, r.item_id, r.description, Number(r.quantity),
              r.uom, Number(r.unit_price), r.classification ?? null, r.gl_account ?? null,
              JSON.stringify(r.financial_dimensions ?? {}),
            ],
          );
        }

        // W5-H item 3: PO generation is an auditable commercial event.
        await run(
          `INSERT INTO audit.audit_log
             (actor_user_id, entity, entity_id, action, after, reason)
           VALUES ($1::uuid, 'proc.purchase_orders', $2, 'po_generate', $3::jsonb, $4)`,
          [
            userId, newPo.id,
            JSON.stringify({
              po_number: newPo.po_number, vendor_id: plan.vendor_id,
              generation_mode: mode, lines: plan.rows.length, total: totals,
            }),
            body.reason ?? `PO generated for PR ${p.pr_number} (${mode})`,
          ],
        );

        created.push({
          id: newPo.id,
          po_number: newPo.po_number,
          vendor_id: plan.vendor_id,
          line_count: plan.rows.length,
          total_amount: Number(newPo.total_amount),
        });
      }

      // Record the exclusions as durable rows, not as a count in a log line.
      for (const e of excluded) {
        await run(
          `INSERT INTO proc.pr_line_po_exclusions (pr_line_id, reason, detail)
           VALUES ($1::uuid, $2, $3)
           ON CONFLICT (pr_line_id) DO UPDATE SET reason = EXCLUDED.reason, detail = EXCLUDED.detail`,
          [e.pr_line_id, e.reason, e.detail],
        );
      }

      const coverage = await run<any>(
        `SELECT * FROM proc.fn_pr_line_po_coverage($1::uuid)`, [prId],
      );

      return {
        pr_id: prId,
        pr_number: p.pr_number,
        cs_number: c.cs_number,
        award_mode: c.award_mode,
        generation_mode: mode,
        purchase_orders: created,
        po_count: created.length,
        excluded_lines: excluded.length,
        // Reported so an operator can SEE the gap rather than trust that it is
        // zero. It should always be, because of the check above — and a
        // non-zero value here would mean the exclusion logic missed a line.
        coverage: coverage.rows[0] ?? null,
        event: {
          action: mode === 'PER_LINE'
            ? `${created.length} purchase orders generated (split award)`
            : 'Purchase order generated',
          detail: created.map((x) => `${x.po_number} — ${x.line_count} line(s), PKR ${x.total_amount}`).join(' · '),
        },
        next:
          `Purchase order${created.length === 1 ? '' : 's'} generated. They must be ` +
          `ISSUED (which requires the pack to be locked) before they can be pushed to D365.`,
      };
    });
  }

  /**
   * POST /po/:id/issue — the FINAL managerial approval, as a state change.
   *
   * The gate itself is proc.fn_po_issue() in the database: this method only
   * chooses to call it and to translate the refusal. That ordering is
   * deliberate — the rule must hold for any future caller, including a script.
   */
  async issue(poId: string, userId: string, role: string, costCenterIds: string[]) {
    if (!roleAllowed(role, PO_ROLES)) {
      throw new ForbiddenException('You do not have permission to issue purchase orders.');
    }
    const ctx: Ctx = { userId, role, costCenterIds };

    try {
      const r = await this.db.query<{ fn_po_issue: string }>(
        `SELECT proc.fn_po_issue($1::uuid, $2::uuid) AS fn_po_issue`, [poId, userId], ctx,
      );
      const id = r.rows[0]?.fn_po_issue;
      if (!id) throw new BadRequestException('the purchase order could not be issued');

      const po = await this.db.query<any>(
        `SELECT po.po_number, po.state, po.issued_at, po.total_amount,
                v.vendor_code, v.legal_name, pr.pr_number, pr.status AS pr_status
           FROM proc.purchase_orders po
           JOIN core.vendors v ON v.id = po.vendor_id
           JOIN proc.purchase_requisitions pr ON pr.id = po.pr_id
          WHERE po.id = $1::uuid`,
        [poId], ctx,
      );
      const row = po.rows[0];

      await this.db.query(
        `INSERT INTO audit.audit_log
           (actor_user_id, entity, entity_id, action, before, after, reason)
         VALUES ($1::uuid, 'proc.purchase_orders', $2, 'po_issue',
                 $3::jsonb, $4::jsonb, $5)`,
        [
          userId, poId,
          JSON.stringify({ state: 'Generated' }),
          JSON.stringify({ state: 'Issued', issued_at: row.issued_at }),
          `PO ${row.po_number} issued after managerial approval of PR ${row.pr_number}`,
        ], ctx,
      );

      return {
        po_id: poId,
        po_number: row.po_number,
        state: 'Issued',
        issued_at: row.issued_at,
        vendor: { code: row.vendor_code, name: row.legal_name },
        total_amount: Number(row.total_amount),
        event: { action: 'Purchase order issued', detail: `${row.po_number} → ${row.legal_name}` },
        next: 'Ready to push to D365 F&O.',
      };
    } catch (e: any) {
      // The database refusal is already a precise, honest sentence. Pass it
      // through rather than replacing it with a generic message.
      if (e?.status && e.status !== 500) throw e;
      const msg = String(e?.message || e);
      if (/cannot be issued/.test(msg)) throw new BadRequestException(msg.replace(/^.*ERROR:\s*/, ''));
      if (/already/.test(msg)) throw new ConflictException(msg.replace(/^.*ERROR:\s*/, ''));
      throw e;
    }
  }

  /**
   * POST /po/:id/push — send ONE issued purchase order to D365 F&O.
   *
   * This is the path that makes a SPLIT award shippable. Track G refused to
   * push a split package because a PO header carries one VendorAccount; the
   * fan-out is now real, so each generated PO is pushed on its own, with its own
   * vendor and only that vendor's awarded lines.
   *
   * The order must be ISSUED. A generated-but-unissued PO is a draft, and
   * pushing it would place a commitment in F&O that no manager approved.
   */
  async push(poId: string, userId: string, role: string, costCenterIds: string[]) {
    if (!roleAllowed(role, PO_ROLES)) {
      throw new ForbiddenException('You do not have permission to push purchase orders.');
    }
    const ctx: Ctx = { userId, role, costCenterIds };

    const head = await this.db.query<any>(
      `SELECT po.id, po.po_number, po.state, po.currency, po.total_amount,
              po.generation_mode, po.d365_po_number,
              v.vendor_code, v.legal_name, pr.id AS pr_id, pr.pr_number, pr.status AS pr_status
         FROM proc.purchase_orders po
         JOIN core.vendors v ON v.id = po.vendor_id
         JOIN proc.purchase_requisitions pr ON pr.id = po.pr_id
        WHERE po.id = $1::uuid`,
      [poId], ctx,
    );
    if (head.rows.length === 0) throw new NotFoundException('Purchase Order not found');
    const po = head.rows[0];

    if (po.d365_po_number) {
      return {
        pushed: true, already_pushed: true, po_number: po.d365_po_number,
        local_po_number: po.po_number,
        message: `Already pushed. ${po.d365_po_number} exists in D365 F&O.`,
      };
    }
    if (po.state === 'Generated') {
      throw new BadRequestException(
        `PO ${po.po_number} has not been ISSUED. The managerial approval chain must ` +
        `finish before an order reaches F&O.`,
      );
    }
    if (po.state === 'Cancelled') {
      throw new ConflictException(`PO ${po.po_number} was cancelled and cannot be pushed`);
    }

    const lines = await this.db.query<any>(
      `SELECT l.line_no, i.item_code, l.quantity, l.uom, l.unit_price
         FROM proc.purchase_order_lines l JOIN core.items i ON i.id = l.item_id
        WHERE l.po_id = $1::uuid ORDER BY l.line_no`,
      [poId], ctx,
    );
    if (lines.rows.length === 0) {
      throw new BadRequestException(`PO ${po.po_number} has no lines — refusing to push an empty order`);
    }

    const result = await pushPurchaseOrder(this.config(), {
      prNumber: po.pr_number,
      // Traceability: an F&O user can read this and find the PR.
      sourceReference: `${po.pr_number}/${po.po_number}`,
      vendorCode: po.vendor_code,
      amount: Number(po.total_amount ?? 0),
      currency: po.currency || 'PKR',
      lines: (lines.rows as any[]).map((l) => ({
        lineNo: Number(l.line_no),
        itemCode: l.item_code,
        quantity: Number(l.quantity),
        uom: l.uom || 'EA',
        unitPrice: Number(l.unit_price),
      })),
    });

    await this.db.query(
      `UPDATE proc.purchase_orders
          SET d365_po_number = $2, d365_po_id = $3, d365_pushed_at = now(),
              state = 'D365_PUSHED'
        WHERE id = $1::uuid`,
      [poId, result.poNumber, result.poId ?? null], ctx,
    );

    await this.db.query(
      `INSERT INTO audit.audit_log
         (actor_user_id, entity, entity_id, action, before, after, reason)
       VALUES ($1::uuid, 'proc.purchase_orders', $2, 'po_push',
               $3::jsonb, $4::jsonb, $5)`,
      [
        userId, poId,
        JSON.stringify({ d365_po_number: po.d365_po_number, state: po.state }),
        JSON.stringify({ d365_po_number: result.poNumber, stubbed: result.stubbed, lines: lines.rows.length }),
        `PO ${po.po_number} → ${result.poNumber} for ${po.legal_name}` +
        (result.stubbed ? ' (STUB — no order exists in F&O)' : ''),
      ], ctx,
    );

    // The PR carries its own d365_po_number, which is a SINGLE column. On a
    // split it is left null rather than naming one supplier for the whole
    // package — the same reason the PO header fan-out was necessary.
    const others = await this.db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM proc.purchase_orders
        WHERE pr_id = $1::uuid AND state = 'D365_PUSHED'`,
      [po.pr_id], ctx,
    );
    const allPushed = Number(others.rows[0]?.n ?? 0) === (await this.countPos(po.pr_id, ctx));

    if (allPushed) {
      await this.db.query(
        `UPDATE proc.purchase_requisitions
            SET d365_po_number = $2, d365_status = 'Submitted', status = 'D365_PUSHED'
          WHERE id = $1::uuid`,
        [po.pr_id, result.poNumber], ctx,
      );
    }

    return {
      pushed: true,
      already_pushed: false,
      local_po_number: po.po_number,
      po_number: result.poNumber,
      po_id: result.poId ?? null,
      vendor: { vendor_code: po.vendor_code, legal_name: po.legal_name },
      lines: lines.rows.length,
      stubbed: result.stubbed === true,
      all_orders_pushed: allPushed,
      event: {
        action: result.stubbed ? 'PO pushed (STUB — nothing sent to F&O)' : 'Purchase order pushed to D365',
        detail: `${po.po_number} → ${result.poNumber} (${po.legal_name}, ${lines.rows.length} line(s))`,
      },
      next: result.stubbed
        ? `STUB MODE: no order exists in D365. ${result.poNumber} is a local placeholder.`
        : allPushed
          ? `All ${others.rows[0]?.n} purchase orders for PR ${po.pr_number} are in F&O.`
          : `PO ${po.pr_number} is in F&O. Other orders for PR ${po.pr_number} still need pushing.`,
    };
  }

  private async countPos(prId: string, ctx: Ctx): Promise<number> {
    const r = await this.db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM proc.purchase_orders
        WHERE pr_id = $1::uuid AND state <> 'Cancelled'`,
      [prId], ctx,
    );
    return Number(r.rows[0]?.n ?? 0);
  }

  private config() {
    return {
      mode: (process.env.D365_MODE as 'stub' | 'live') || 'stub',
      baseUrl: process.env.D365_BASE_URL,
      tenantId: process.env.D365_TENANT_ID,
      clientId: process.env.D365_CLIENT_ID,
      clientSecret: process.env.D365_CLIENT_SECRET,
      company: process.env.D365_COMPANY || 'PKE',
    };
  }

  /** GET /pr/:id/po — the orders for a PR, with their lines and coverage. */
  async forPr(prId: string, userId: string, role: string, costCenterIds: string[]) {
    const ctx: Ctx = { userId, role, costCenterIds };
    const orders = await this.db.query<any>(
      `SELECT po.id, po.po_number, po.state, po.currency, po.total_amount,
              po.generation_mode, po.d365_po_number, po.d365_pushed_at, po.issued_at,
              v.vendor_code, v.legal_name, cs.cs_number, cs.award_mode
         FROM proc.purchase_orders po
         JOIN core.vendors v ON v.id = po.vendor_id
         LEFT JOIN proc.comparative_statements cs ON cs.id = po.cs_id
        WHERE po.pr_id = $1::uuid
        ORDER BY po.po_number`,
      [prId], ctx,
    );
    if (orders.rows.length === 0) return { pr_id: prId, purchase_orders: [], coverage: null };

    const lines = await this.db.query<any>(
      `SELECT l.po_id, l.line_no, l.description, l.quantity, l.uom, l.unit_price,
              l.line_total, l.classification, i.item_code
         FROM proc.purchase_order_lines l
         JOIN core.items i ON i.id = l.item_id
        WHERE l.po_id = ANY($1::uuid[])
        ORDER BY l.po_id, l.line_no`,
      [orders.rows.map((o: any) => o.id)], ctx,
    );
    const byPo = new Map<string, any[]>();
    for (const l of lines.rows as any[]) {
      const arr = byPo.get(l.po_id) ?? [];
      arr.push({
        line_no: Number(l.line_no), item_code: l.item_code, description: l.description,
        quantity: Number(l.quantity), uom: l.uom, unit_price: Number(l.unit_price),
        line_total: Number(l.line_total), classification: l.classification,
      });
      byPo.set(l.po_id, arr);
    }

    const coverage = await this.db.query<any>(
      `SELECT * FROM proc.fn_pr_line_po_coverage($1::uuid)`, [prId], ctx,
    );

    return {
      pr_id: prId,
      purchase_orders: orders.rows.map((o: any) => ({
        id: o.id, po_number: o.po_number, state: o.state, currency: o.currency,
        total_amount: o.total_amount === null ? null : Number(o.total_amount),
        generation_mode: o.generation_mode, award_mode: o.award_mode,
        cs_number: o.cs_number,
        vendor: { vendor_code: o.vendor_code, legal_name: o.legal_name },
        d365_po_number: o.d365_po_number,
        pushed: !!o.d365_pushed_at,
        issued_at: o.issued_at,
        lines: byPo.get(o.id) ?? [],
      })),
      coverage: coverage.rows[0] ?? null,
    };
  }
}
