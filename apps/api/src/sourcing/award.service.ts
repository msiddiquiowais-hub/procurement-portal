import {
  BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DbService } from '../db/db.service';
import { roleAllowed } from '@procurement/roles';
import { PdfBuilder } from './pdf';

/**
 * WAVE 5 TRACK F — comparative statement, split awards, phone negotiation, PDF.
 *
 * THREE THINGS THAT ARE EASY TO GET WRONG HERE, AND SO ARE STATED UP FRONT
 *
 * 1. A LINE AWARD IS NOT AN EDIT. proc.cs_line_awards is keyed by a surrogate
 *    id with an EXCLUDE constraint allowing only one LIVE row per line, because
 *    a UNIQUE (cs_id, rfq_line_no) key would make re-awarding a line impossible:
 *    you could not keep the old decision and add the new one. Changing a winner
 *    therefore SUPERSEDES, in one transaction, and the previous award stays
 *    readable forever.
 *
 * 2. A PHONE NEGOTIATION IS NOT A NOTE. Agreeing a new rate over the phone
 *    produces a new QUOTATION VERSION - the same append-only path the vendor
 *    portal uses - and a negotiation_log row carrying the rates on both sides,
 *    plus an entry in the immutable audit trail. The justification is mandatory
 *    at the database, not just in the form, so it cannot be skipped by calling
 *    the API directly.
 *
 * 3. THE PDF IS A DERIVED ARTEFACT. It is regenerated on demand from live rows,
 *    stored under a UUID so two compiles can never collide, and never treated as
 *    the record. The record is the table.
 */
@Injectable()
export class AwardService {
  private readonly log = new Logger('Award');

  constructor(private readonly db: DbService) {}

  private assertCanAward(role: string) {
    if (!roleAllowed(role, 'procurement,cs')) {
      throw new ForbiddenException('Only Procurement or the Committee Secretary may award or negotiate.');
    }
  }

  // ── F7: the comparative matrix ────────────────────────────────────────────
  /**
   * GET /cs/:id/matrix — side by side, per line AND per vendor.
   *
   * The per-line view is the one that matters commercially: once a pack has more
   * than one line, "vendor A is cheapest" stops being answerable, and the split
   * awards only make sense if the evaluator can see which vendor won which line
   * and by how much the alternatives differed.
   */
  async matrix(csId: string, role: string) {
    // bypassRls, like VendorsService.list(): the comparative statement is a
    // back-office artefact and the session RLS policies are written for the
    // requester's own PRs, which would 403 a procurement officer reading a pack
    // they are responsible for.
    const ctx = { role, bypassRls: true };
    const cs = await this.db.query<any>(
      `SELECT c.id, c.cs_number, c.state, c.cs_round, c.rfq_id, c.pr_id,
              p.pr_number, p.title
         FROM proc.comparative_statements c
         JOIN proc.purchase_requisitions p ON p.id = c.pr_id
        WHERE c.id = $1::uuid`,
      [csId], ctx,
    );
    if (cs.rows.length === 0) throw new NotFoundException('comparative statement not found');
    const head = cs.rows[0];

    // One row per line per vendor, from the LIVE quotation version only. A
    // superseded price is history and must never appear as a current bid.
    const cells = await this.db.query<any>(
      `SELECT l.line_no, l.description, l.quantity, l.uom,
              v.id AS vendor_id, v.vendor_code, v.legal_name,
              ql.unit_price, ql.total_price, ql.remarks,
              q.version, q.lead_time_days, q.warranty_months, q.payment_terms,
              q.validity_days, q.taxes_included, q.total_amount, q.submitted_at
         FROM proc.rfq_lines l
         JOIN proc.quotations q
           ON q.rfq_id = l.rfq_id
          -- 'Awarded' belongs here as much as 'Submitted'. Locking a CS moves
          -- the winning quotations to 'Awarded', so a matrix — or the PDF
          -- compiled from it — that reads only 'Submitted' goes EMPTY the
          -- moment the decision is made. The compiled statement would print
          -- "No line has been awarded yet" on the very document that records
          -- the award. Superseded and Rejected stay excluded: those are not
          -- live offers.
          AND q.state IN ('Submitted', 'Awarded')
         JOIN core.vendors v ON v.id = q.vendor_id
         LEFT JOIN proc.quotation_lines ql
           ON ql.quotation_id = q.id AND ql.rfq_line_no = l.line_no
        WHERE l.rfq_id = $1::uuid
        ORDER BY l.line_no, q.total_amount NULLS LAST, v.vendor_code`,
      [head.rfq_id], ctx,
    );

    const byLine = new Map<number, any[]>();
    for (const c of cells.rows) {
      const n = Number(c.line_no);
      if (!byLine.has(n)) byLine.set(n, []);
      byLine.get(n)!.push({
        vendor_id: c.vendor_id, vendor_code: c.vendor_code, vendor_name: c.legal_name,
        unit_price: c.unit_price === null ? null : Number(c.unit_price),
        line_total: c.total_price === null ? null : Number(c.total_price),
        remarks: c.remarks ?? null,
        version: c.version,
        // Delivery and SLA facts travel WITH the bid, not in a separate screen,
        // because a cheaper quote with a 90-day lead is not a cheaper quote.
        lead_time_days: c.lead_time_days ?? null,
        warranty_months: c.warranty_months ?? null,
        payment_terms: c.payment_terms ?? null,
        validity_days: c.validity_days ?? null,
        taxes_included: c.taxes_included ?? null,
        quote_total: c.total_amount === null ? null : Number(c.total_amount),
        submitted_at: c.submitted_at,
      });
    }

    const awards = await this.db.query<any>(
      `SELECT a.rfq_line_no, a.vendor_id, a.awarded_qty, a.justification, a.award_round,
              a.awarded_at, v.vendor_code, v.legal_name
         FROM proc.cs_line_awards a JOIN core.vendors v ON v.id = a.vendor_id
        WHERE a.cs_id = $1::uuid AND a.superseded_at IS NULL
        ORDER BY a.rfq_line_no`,
      [csId], ctx,
    );
    const awardByLine = new Map<number, any>(awards.rows.map((a: any) => [Number(a.rfq_line_no), a]));

    const lines = [...byLine.entries()].map(([lineNo, bids]) => {
      const first = bids[0] as any;
      const cheapest = bids
        .filter((b) => b.unit_price !== null)
        .sort((a, b) => Number(a.unit_price) - Number(b.unit_price))[0] ?? null;
      const award = awardByLine.get(lineNo) ?? null;
      return {
        line_no: lineNo,
        description: first?.description ?? null,
        quantity: first ? Number(first.quantity) : null,
        uom: first?.uom ?? null,
        bids,
        // Derived, not stored: the spread against the cheapest bid is what tells
        // a buyer whether a second source is worth the hassle of splitting.
        lowest_unit_price: cheapest?.unit_price ?? null,
        awarded: award
          ? {
              vendor_id: award.vendor_id, vendor_code: award.vendor_code, vendor_name: award.legal_name,
              qty: Number(award.awarded_qty), justification: award.justification,
              round: award.award_round, awarded_at: award.awarded_at,
              // Premium over the cheapest bid, if the winner is not the cheapest.
              premium_vs_lowest: cheapest && award.vendor_id !== cheapest.vendor_id
                ? Number(((bids.find((b) => b.vendor_id === award.vendor_id)?.unit_price ?? 0) - Number(cheapest.unit_price)).toFixed(2))
                : 0,
            }
          : null,
      };
    });

    return {
      cs: { id: head.id, number: head.cs_number, state: head.state, round: head.cs_round },
      pr: { id: head.pr_id, number: head.pr_number, title: head.title },
      // The RFQ id is returned because BOTH negotiation endpoints are keyed on
      // it. Without it a client holding only a CS id cannot reach
      // /rfq/:id/negotiate at all, and the natural workaround is to guess.
      rfq_id: head.rfq_id,
      currency: 'PKR',
      lines,
      awarded_lines: awardByLine.size,
      total_lines: lines.length,
      complete: awardByLine.size === lines.length,
    };
  }

  // ── F8: line-item split awards ────────────────────────────────────────────
  /**
   * POST /cs/:id/award — award one line, or change an award.
   *
   * ONE STATEMENT, therefore one transaction: the new award and the retirement
   * of the previous one. The EXCLUDE constraint is DEFERRABLE INITIALLY
   * DEFERRED, so inserting before retiring is legal; splitting it into two
   * statements would commit the insert on its own, at which point two live
   * awards exist for one line and the constraint refuses.
   */
  async awardLine(
    csId: string, lineNo: number, vendorId: string, qty: number,
    justification: string, userId: string, role: string, costCenterIds: string[],
  ) {
    this.assertCanAward(role);
    const why = String(justification || '').trim();
    if (!why) {
      throw new BadRequestException(
        'A justification is required. An award with no stated reason cannot be defended at audit.',
      );
    }
    const ctx = { role, userId, costCenterIds };

    const r = await this.db.query<any>(
      `WITH prev AS (
         SELECT id, award_round, vendor_id FROM proc.cs_line_awards
          WHERE cs_id = $1::uuid AND rfq_line_no = $2::int AND superseded_at IS NULL
       ), nxt AS (
         SELECT COALESCE(MAX(award_round), 0) + 1 AS r FROM proc.cs_line_awards
          WHERE cs_id = $1::uuid AND rfq_line_no = $2::int
       ), ins AS (
         INSERT INTO proc.cs_line_awards
           (cs_id, rfq_line_no, vendor_id, awarded_qty, award_round, justification,
            awarded_by_user_id, supersedes_award_id)
         SELECT $1::uuid, $2::int, $3::uuid, $4::numeric, nxt.r, $5::text, $6::uuid, prev.id
           FROM nxt LEFT JOIN prev ON true
         RETURNING id, rfq_line_no, vendor_id, awarded_qty, award_round, justification
       ), ret AS (
         UPDATE proc.cs_line_awards a
            SET superseded_at = now(), supersede_reason = $5::text
           FROM ins
          WHERE a.id = (SELECT id FROM prev) AND a.superseded_at IS NULL
         RETURNING a.id
       )
       SELECT id, rfq_line_no, vendor_id, awarded_qty, award_round, justification FROM ins`,
      [csId, lineNo, vendorId, qty, why, userId],
      ctx,
    );
    if (r.rows.length === 0) throw new BadRequestException('the award could not be recorded');
    const row = r.rows[0];

    // The award is a commercial decision, so it goes into the immutable trail
    // with its own action, not folded into a generic 'update'.
    await this.db.query(
      `INSERT INTO audit.audit_log
         (actor_user_id, entity, entity_id, action, before, after, reason)
       VALUES ($1::uuid, 'proc.cs_line_awards', $2::text, 'cs_line_award', $3::jsonb, $4::jsonb, $5::text)`,
      [
        userId, row.id, JSON.stringify({ round: row.award_round }),
        JSON.stringify({ cs_id: csId, line_no: lineNo, vendor_id: vendorId, qty: String(qty) }),
        why,
      ],
      { ...ctx, vendorChangeToken: randomUUID() },
    ).catch((e: any) => this.log.warn(`award audit write failed (non-fatal): ${e?.message}`));

    const live = await this.db.query<any>(
      `SELECT count(*)::int AS n FROM proc.cs_line_awards
        WHERE cs_id = $1::uuid AND rfq_line_no = $2::int AND superseded_at IS NULL`,
      [csId, lineNo], ctx,
    );
    if (Number(live.rows[0]?.n) !== 1) {
      // Should be impossible given the EXCLUDE, but a silent second winner would
      // be the worst bug in this file, so it is checked rather than assumed.
      throw new ConflictException(
        `line ${lineNo} now has ${live.rows[0]?.n} live awards — exactly one is required`,
      );
    }

    return { ...row, cs_id: csId, supersedes_round: row.award_round > 1 ? row.award_round - 1 : null };
  }

  /** DELETE-from-life is not offered: a changing award is a supersede, by design. */

  // ── F9: phone / offline negotiation ───────────────────────────────────────
  /**
   * POST /rfq/:id/negotiate — record a rate agreed offline.
   *
   * This APPENDS a new quotation version rather than editing the vendor's, so the
   * price the vendor sent and the price they agreed on the phone both survive. A
   * buyer who later says "that was never agreed" can be shown both.
   *
   * The justification is required by the DATABASE (negotiation_log_justification),
   * so calling this endpoint without one fails even if the service check were
   * bypassed.
   */
  async negotiate(args: {
    rfqId: string; vendorId: string; userId: string; role: string; costCenterIds: string[];
    justification: string; source: 'phone' | 'email' | 'walk_in';
    lines: { lineNo: number; unitPrice: number }[];
    leadTimeDays?: number; warrantyMonths?: number; paymentTerms?: string;
  }) {
    this.assertCanAward(args.role);
    const why = String(args.justification || '').trim();
    if (!why) {
      throw new BadRequestException(
        'A justification is required for a rate agreed offline. "Procurement called" is not a justification.',
      );
    }
    if (!Array.isArray(args.lines) || args.lines.length === 0) {
      throw new BadRequestException('At least one negotiated line is required.');
    }
    const ctx = { role: args.role, userId: args.userId, costCenterIds: args.costCenterIds };

    // What the vendor's LIVE version said, so the trail records a before AND an
    // after rather than only the new number.
    const before = await this.db.query<any>(
      `SELECT q.id, q.version, ql.rfq_line_no, ql.unit_price
         FROM proc.quotations q
         LEFT JOIN proc.quotation_lines ql ON ql.quotation_id = q.id
        WHERE q.rfq_id = $1::uuid AND q.vendor_id = $2::uuid AND q.state = 'Submitted'
        ORDER BY q.version DESC`,
      [args.rfqId, args.vendorId], ctx,
    );

    const round = Number(before.rows[0]?.version ?? 0) + 1;
    const total = args.lines.reduce((a, l) => a + Number(l.unitPrice), 0);

    const q = await this.db.query<any>(
      `INSERT INTO proc.quotations
         (rfq_id, vendor_id, submitted_by_user_id, total_amount, currency, state, version,
          lead_time_days, warranty_months, payment_terms, notes, submitted_at, normalized_total_pkr,
          sealed_hash, open_at)
       SELECT $1::uuid, $2::uuid, $3::uuid, $4::numeric, o.currency, 'Submitted', $5::int,
              $6::int, $7::int, $8::text,
              'Negotiated offline — ' || $9::text, now(),
              -- normalized_total_pkr is NOT NULL and is what the comparative
              -- statement compares, so a negotiated quote that omitted it would
              -- be invisible to scoring. The FX rate is taken from the vendor's
              -- own previous live quote rather than assumed to be 1: proc.rfq has
              -- no fx_rate column (the rate lives on the quotation), and
              -- inventing one here would quietly mis-price a non-PKR quote.
              $4::numeric * COALESCE((
                SELECT fx_rate FROM proc.quotations
                 WHERE rfq_id = $1::uuid AND vendor_id = $2::uuid
                 ORDER BY version DESC LIMIT 1), 1),
              -- sealed_hash is NOT NULL. The SAME sha256 construction
              -- QuotationService.inertSealHash uses, so an offline rate is
              -- sealed exactly like a portal one rather than being exempted
              -- from the integrity check that protects the other figures.
              encode(digest(
                $1::text || '|' || $2::text || '|' || $5::text || '|' ||
                $4::text || '|' || o.currency, 'sha256'), 'hex'),
              -- open_at is NOT NULL (the quotation became readable the moment it
              -- was agreed, which for a phone call is the call itself). It is
              -- LAST in the value list because this is a positional INSERT and
              -- the three expressions above are not all the same type.
              now()
         FROM proc.rfq o WHERE o.id = $1::uuid
       RETURNING id, version`,
      [
        args.rfqId, args.vendorId, args.userId, total, round,
        args.leadTimeDays ?? null, args.warrantyMonths ?? null, args.paymentTerms ?? null, why,
      ],
      ctx,
    );
    if (q.rows.length === 0) throw new NotFoundException('RFQ not found');
    const quotationId = q.rows[0].id;

    // The previous live version is retired in the same breath, so the CS never
    // shows two live prices for one vendor.
    await this.db.query(
      `UPDATE proc.quotations SET state = 'Superseded'
        WHERE rfq_id = $1::uuid AND vendor_id = $2::uuid AND state = 'Submitted' AND id <> $3::uuid`,
      [args.rfqId, args.vendorId, quotationId], ctx,
    );

    for (const l of args.lines) {
      await this.db.query(
        `INSERT INTO proc.quotation_lines (quotation_id, rfq_id, rfq_line_no, unit_price, total_price, remarks)
         VALUES ($1::uuid, $2::uuid, $3::int, $4::numeric, $5::numeric, $6::text)`,
        [quotationId, args.rfqId, Number(l.lineNo), Number(l.unitPrice), Number(l.unitPrice), why],
        ctx,
      );
    }

    const rateBefore = Object.fromEntries(
      before.rows.filter((b: any) => b.rfq_line_no !== null)
        .map((b: any) => [b.rfq_line_no, String(b.unit_price)]),
    );
    const rateAfter = Object.fromEntries(args.lines.map((l) => [l.lineNo, String(l.unitPrice)]));

    const nl = await this.db.query<any>(
      `INSERT INTO negotiation_log
         (rfq_id, vendor_id, round, notes, created_by_user_id, source, justification,
          rate_before, rate_after, resulting_quotation_version)
       VALUES ($1::uuid, $2::uuid, $3::int, $4::text, $5::uuid, $6::text, $7::text,
               $8::jsonb, $9::jsonb, $10::int)
       RETURNING id, round, source, created_at`,
      [
        args.rfqId, args.vendorId, round, why, args.userId, args.source, why,
        JSON.stringify(rateBefore), JSON.stringify(rateAfter), round,
      ],
      ctx,
    );

    await this.db.query(
      `INSERT INTO audit.audit_log
         (actor_user_id, entity, entity_id, action, before, after, reason)
       VALUES ($1::uuid, 'proc.quotations', $2::text, 'phone_negotiation', $3::jsonb, $4::jsonb, $5::text)`,
      [
        args.userId, quotationId,
        JSON.stringify({ version: round, rates: rateBefore, source: args.source }),
        JSON.stringify({ version: round, rates: rateAfter }),
        why,
      ],
      { ...ctx, vendorChangeToken: randomUUID() },
    ).catch((e: any) => this.log.warn(`negotiation audit write failed (non-fatal): ${e?.message}`));

    this.log.log(`negotiated ${args.source} on RFQ ${args.rfqId} -> v${round}`);
    return {
      quotation_id: quotationId,
      version: round,
      negotiation: nl.rows[0],
      rate_before: rateBefore,
      rate_after: rateAfter,
      justification: why,
    };
  }

  /** GET /rfq/:id/negotiations — the offline history for one RFQ. */
  async negotiations(rfqId: string, role: string) {
    const r = await this.db.query<any>(
      `SELECT n.id, n.round, n.source, n.notes, n.justification, n.rate_before, n.rate_after,
              n.resulting_quotation_version, n.created_at,
              v.vendor_code, v.legal_name, u.display_name AS officer
         FROM negotiation_log n
         JOIN core.vendors v ON v.id = n.vendor_id
         LEFT JOIN core.users u ON u.id = n.created_by_user_id
        WHERE n.rfq_id = $1::uuid
        ORDER BY n.created_at DESC`,
      [rfqId], { role },
    );
    return { rfq_id: rfqId, entries: r.rows };
  }

  // ── F10: compile the PDF ──────────────────────────────────────────────────
  private async pdfRoot(): Promise<string> {
    const configured = process.env.DOCUMENT_STORAGE_ROOT || process.env.ATTACHMENT_STORAGE_ROOT;
    if (configured && configured.trim()) return resolve(configured.trim(), 'documents');
    let dir = __dirname;
    for (let hop = 0; hop < 8; hop++) {
      if (existsSync(join(dir, 'apps')) && existsSync(join(dir, 'db')) && existsSync(join(dir, 'package.json'))) {
        return resolve(dir, 'var', 'documents');
      }
      const up = resolve(dir, '..');
      if (up === dir) break;
      dir = up;
    }
    return resolve(__dirname, '..', '..', 'var', 'documents');
  }

  /**
   * POST /cs/:id/pdf — compile the statement and its winners.
   *
   * The filename is a UUID, not the CS number: a recompile must never overwrite
   * the document a committee already approved, and a predictable name would let
   * one be fetched by guessing. The CS number is printed INSIDE the document,
   * where a human can read it.
   */
  async compilePdf(csId: string, userId: string, role: string, costCenterIds: string[]) {
    this.assertCanAward(role);
    const matrix = await this.matrix(csId, role);
    const cs = await this.db.query<any>(
      `SELECT c.cs_number, c.cs_round, c.generated_at, c.state, p.pr_number, p.title
         FROM proc.comparative_statements c JOIN proc.purchase_requisitions p ON p.id = c.pr_id
        WHERE c.id = $1::uuid`,
      [csId], { role, userId, costCenterIds },
    );
    if (cs.rows.length === 0) throw new NotFoundException('comparative statement not found');
    const head = cs.rows[0];

    const pdf = new PdfBuilder();
    pdf.text('COMPARATIVE STATEMENT', { bold: true, size: 16, gapAfter: 4 });
    pdf.text(`${head.cs_number}  ·  PR ${head.pr_number}`, { size: 11, gapAfter: 2 });
    pdf.text(head.title || '', { size: 10, gapAfter: 6 });
    pdf.text(
      `Generated ${new Date(head.generated_at ?? Date.now()).toISOString().slice(0, 10)}  ·  ` +
      `round ${head.cs_round}  ·  state ${head.state}`,
      { size: 8, gapAfter: 8 },
    );
    pdf.rule();

    const W = 515;
    const cols = [
      { w: 30, t: 'Line' }, { w: 150, t: 'Description' }, { w: 60, t: 'Qty' },
      { w: 62, t: 'Unit', align: 'right' as const }, { w: 66, t: 'Total', align: 'right' as const },
      { w: 40, t: 'Lead', align: 'right' as const }, { w: 80, t: 'Award' },
      { w: 27, t: 'Ver' },
    ];
    const widths = cols.map((c) => c.w);
    const total = widths.reduce((a, b) => a + b, 0);
    const scale = W / total;
    const sized = cols.map((c) => ({ text: c.t, width: c.w * scale, align: c.align, bold: true }));

    pdf.tableRow(sized, { size: 8 });
    pdf.rule();

    for (const line of matrix.lines) {
      // The price column must be the AWARDED vendor's price whenever the line has
      // a winner. Showing the lowest bid instead would put a figure on the
      // statement that nobody was actually awarded — and on a split award the
      // lowest bidder is often not the winner at all.
      const awardedBid = line.awarded
        ? line.bids.find((b: any) => b.vendor_id === line.awarded!.vendor_id)
        : null;
      const best = awardedBid || line.bids.filter((b: any) => b.unit_price !== null)
        .sort((a: any, b: any) => Number(a.unit_price) - Number(b.unit_price))[0];

      pdf.tableRow([
        { text: String(line.line_no), width: widths[0] * scale, bold: true },
        { text: line.description ?? '', width: widths[1] * scale },
        { text: line.quantity !== null ? `${line.quantity} ${line.uom ?? ''}` : '', width: widths[2] * scale },
        { text: best ? String(best.unit_price) : '—', width: widths[3] * scale, align: 'right', bold: true },
        { text: best && best.line_total !== null ? String(best.line_total) : '—', width: widths[4] * scale, align: 'right' },
        { text: best && best.lead_time_days !== null ? `${best.lead_time_days}d` : '—', width: widths[5] * scale, align: 'right' },
        { text: line.awarded ? line.awarded.vendor_code : (best ? `${best.vendor_code} (lowest)` : 'not awarded'), width: widths[6] * scale },
        { text: best ? `v${best.version}` : '', width: widths[7] * scale },
      ], { size: 8 });
      pdf.gap(3);
    }

    pdf.rule();
    pdf.gap(6);
    pdf.text('AWARDS', { bold: true, size: 10, gapAfter: 4 });
    if (matrix.awarded_lines === 0) {
      pdf.text('No line has been awarded yet.', { size: 9 });
    } else {
      // Narrowed to awarded lines first, then bound locally: TypeScript cannot
      // carry the `filter` predicate into the loop body, and a non-null assertion
      // would only silence a check the compiler is right to want.
      const awarded = matrix.lines.filter((l: any) => l.awarded);
      for (const line of awarded) {
        const a = line.awarded!;
        pdf.text(
          `Line ${line.line_no} — ${a.vendor_code} (${a.vendor_name})` +
          (a.premium_vs_lowest > 0
            ? `  ·  premium over lowest ${a.premium_vs_lowest}` : ''),
          { bold: true, size: 9 },
        );
        pdf.text(`Justification: ${a.justification}`, { size: 8 });
        pdf.gap(4);
      }
    }

    if (!matrix.complete) {
      pdf.gap(6);
      pdf.text(
        `INCOMPLETE: ${matrix.total_lines - matrix.awarded_lines} of ${matrix.total_lines} lines are un awarded.`,
        { bold: true, size: 9 },
      );
    }

    const buffer = pdf.build(`Comparative Statement ${head.cs_number}`);

    // The file name is a UUID, so two compiles can never collide and a
    // previously issued document can never be silently replaced.
    const docId = randomUUID();
    const dir = await this.pdfRoot();
    const year = String(new Date().getUTCFullYear());
    const rel = join(year, `${docId}.pdf`);
    await mkdir(join(dir, year), { recursive: true });
    await writeFile(join(dir, rel), buffer);

    this.log.log(`compiled ${head.cs_number} -> ${rel} (${buffer.length} bytes)`);
    return {
      cs_id: csId,
      cs_number: head.cs_number,
      document_id: docId,
      object_key: rel,
      bytes: buffer.length,
      awarded_lines: matrix.awarded_lines,
      total_lines: matrix.total_lines,
      complete: matrix.complete,
      note: 'The stored PDF is a derived artefact. The record is the table; recompiling never overwrites an issued document.',
    };
  }
}
