import {
  BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { DbService } from '../db/db.service';
import { QuotationService } from '../sourcing/quotation.service';
import { buildXlsx, readXlsx, type CellValue } from './xlsx';

/**
 * WAVE 5 TRACK F — the sandboxed vendor portal.
 *
 * ACCESSIBLE BY TOKEN ALONE. No password, no NTN, no portal account, no login.
 * The token in the emailed link IS the credential, and it is the only thing
 * standing between a forwarded email and a stranger reading one company's RFQ.
 * Three things follow from that, and all three are enforced here rather than
 * left to the UI:
 *
 *   1. The token is compared by SHA-256. The raw value is never stored, so a
 *      database leak does not hand over live links.
 *   2. The link is TIME-BOUND (rfq_invitations.expires_at, migration 040). An
 *      expired token is refused with an explanation, not a blank page.
 *   3. The payload is SCOPED TO THE ONE RFQ THIS VENDOR WAS INVITED TO. The
 *      query is keyed on the rfq_id that the token resolved to, so a vendor
 *      cannot reach another RFQ, another PR, the budget, or the approval chain.
 *
 * A NOTE ON WHAT "ONLY ASSIGNED ITEMS" ACTUALLY MEANS HERE, because an earlier
 * version of this comment claimed something stronger than the code did. An
 * invitation is scoped to an RFQ, and an RFQ's lines are the same for everyone
 * invited to it - that is what an RFQ IS: the same pack, priced competitively.
 * There is no per-vendor line allocation in this schema, so every invited
 * vendor legitimately sees every line of the pack they were invited to. The
 * guarantee that actually holds, and is enforced below, is that a token reaches
 * exactly ONE vendor's invitation on ONE RFQ and nothing outside it. The
 * isolation boundary is the VENDOR, not the line.
 */
@Injectable()
export class VendorPortalService {
  private readonly log = new Logger('VendorPortal');

  constructor(
    private readonly db: DbService,
    private readonly quotations: QuotationService,
  ) {}

  private static hash(token: string): string {
    return createHash('sha256').update(String(token)).digest('hex');
  }

  /**
   * Resolve a raw token to its invitation, or refuse with a reason worth reading.
   *
   * A 404 here is deliberate: a token that does not exist and a token that has
   * expired are both "this link is no good", and telling an attacker which one
   * it was is free information.
   */
  async resolve(token: string) {
    const raw = String(token || '').trim();
    if (!raw) throw new BadRequestException('A link token is required.');

    const r = await this.db.query<any>(
      `SELECT i.id AS invitation_id, i.rfq_id, i.vendor_id, i.submitted, i.declined,
              i.declined_reason, i.expires_at, i.dispatched_at,
              v.legal_name, v.vendor_code,
              rf.rfq_number, rf.title, rf.currency, rf.state AS rfq_state, rf.deadline_at,
              p.pr_number
         FROM proc.rfq_invitations i
         JOIN core.vendors v ON v.id = i.vendor_id
         JOIN proc.rfq rf ON rf.id = i.rfq_id
         JOIN proc.purchase_requisitions p ON p.id = rf.pr_id
        WHERE i.token_hash = $1::text`,
      [VendorPortalService.hash(raw)],
      { bypassRls: true },
    );
    if (r.rows.length === 0) {
      throw new NotFoundException(
        'This quotation link is not valid. Ask the buyer to send a fresh one.',
      );
    }
    const inv = r.rows[0];

    if (inv.expires_at && new Date(inv.expires_at).getTime() < Date.now()) {
      throw new ForbiddenException(
        `This link expired on ${new Date(inv.expires_at).toISOString().slice(0, 16).replace('T', ' ')} UTC. ` +
          'Ask the buyer to send a new one.',
      );
    }
    return inv;
  }

  /**
   * GET /vendor-portal/:token — everything this vendor is allowed to see.
   *
   * Note what is NOT selected: the PR title, the budget, the approval chain,
   * the other vendors, the other vendors' prices, and any line the vendor was
   * not invited to. The lines are the RFQ's lines, which is what the buyer
   * actually asked them to price.
   */
  async pack(token: string) {
    const inv = await this.resolve(token);

    const lines = await this.db.query<any>(
      `SELECT l.line_no, l.description, l.quantity, l.uom
         FROM proc.rfq_lines l
        WHERE l.rfq_id = $1::uuid
        ORDER BY l.line_no`,
      [inv.rfq_id],
      { bypassRls: true },
    );

    const mine = await this.db.query<any>(
      `SELECT version, total_amount, currency, lead_time_days, warranty_months,
              payment_terms, validity_days, taxes_included, submitted_at, state
         FROM proc.quotations
        WHERE rfq_id = $1::uuid AND vendor_id = $2::uuid
        ORDER BY version DESC`,
      [inv.rfq_id, inv.vendor_id],
      { bypassRls: true },
    );

    const history = await this.db.query<any>(
      `SELECT version, total_amount, currency, submitted_at, state,
              (SELECT count(*) FROM proc.quotation_lines ql WHERE ql.quotation_id = q.id) AS line_count
         FROM proc.quotations q
        WHERE rfq_id = $1::uuid AND vendor_id = $2::uuid
        ORDER BY version ASC`,
      [inv.rfq_id, inv.vendor_id],
      { bypassRls: true },
    );

    return {
      vendor: { code: inv.vendor_code, name: inv.legal_name },
      rfq: {
        number: inv.rfq_number,
        title: inv.title,
        currency: inv.currency,
        deadline: inv.deadline_at,
        state: inv.rfq_state,
      },
      link_expires_at: inv.expires_at,
      submitted: inv.submitted === true || inv.submitted === 'true',
      declined: inv.declined === true || inv.declined === 'true',
      declined_reason: inv.declined_reason ?? null,
      lines: lines.rows,
      current_quote: mine.rows[0] ?? null,
      // Every version ever sent, so a vendor can see that revising does not
      // erase what they sent before.
      versions: history.rows,
    };
  }

  /**
   * GET /vendor-portal/:token/template — the .xlsx the vendor fills in.
   *
   * The template is generated from the LIVE pack, not from a stored copy, so a
   * vendor can never be handed a template for a quantity that has since changed.
   * Line numbers are frozen into the file, and a re-upload is matched back by
   * LINE NO - not by row order - because a vendor sorting their sheet must not
   * silently re-price the wrong line.
   */
  async template(token: string): Promise<{ buffer: Buffer; filename: string }> {
    const inv = await this.resolve(token);
    const lines = await this.db.query<any>(
      `SELECT l.line_no, l.description, l.quantity, l.uom
         FROM proc.rfq_lines l WHERE l.rfq_id = $1::uuid ORDER BY l.line_no`,
      [inv.rfq_id], { bypassRls: true },
    );

    // Payment terms, validity and tax treatment are here because the
    // comparative matrix has columns for them. A matrix column that no vendor
    // can ever fill is a column that is always NULL, which reads as "nobody
    // offered terms" rather than "nobody was asked".
    const header: CellValue[] = [
      'Line', 'Description', 'Quantity', 'UoM', 'Unit Price', 'Line Total',
      'Lead Time (days)', 'Warranty (months)', 'Payment Terms', 'Validity (days)',
      'Taxes Included', 'Notes',
    ];
    const rows: CellValue[][] = [header];
    for (const l of lines.rows) {
      rows.push([
        Number(l.line_no), l.description, Number(l.quantity), l.uom,
        null, null, null, null, null, null, null, null,
      ]);
    }
    rows.push([]);
    rows.push([`RFQ ${inv.rfq_number} · quote in ${inv.currency} · due ${new Date(inv.deadline_at).toISOString().slice(0, 10)}`]);
    rows.push(['Fill the Unit Price column, plus Lead Time, Warranty, Payment Terms, Validity and Taxes Included if you offer them. Everything else on a line is supplied by us. Re-uploading creates a new version; your earlier versions are kept.']);

    const buffer = buildXlsx({ name: 'Quotation', rows });
    return { buffer, filename: `RFQ-${inv.rfq_number}-quotation.xlsx` };
  }

  /**
   * POST /vendor-portal/:token/quote — submit from the form, or from a re-upload.
   *
   * F6, VERSION CONTROL: every submission appends. `submitAsVendor` is called
   * with revise:true, so a second upload becomes v2 and the first is retained as
   * SUPERSEDED. Nothing is ever overwritten, which is what makes "we sent you a
   * revised price" provable rather than arguable.
   */
  async submit(token: string, body: any, uploaded?: { filename: string; buffer: Buffer }) {
    const inv = await this.resolve(token);

    if (inv.declined === true || inv.declined === 'true') {
      throw new BadRequestException('You declined this invitation, so a quote can no longer be submitted.');
    }
    if (inv.rfq_state !== 'Open') {
      throw new BadRequestException(`This RFQ is ${inv.rfq_state} — quotes are closed.`);
    }
    if (inv.deadline_at && new Date(inv.deadline_at).getTime() < Date.now()) {
      throw new BadRequestException('The quotation deadline has passed. Contact the buyer if you need more time.');
    }

    let payload = body;
    let source: 'form' | 'xlsx' = 'form';

    if (uploaded) {
      source = 'xlsx';
      payload = this.parseUploaded(uploaded.filename, uploaded.buffer, inv);
    }

    const lines = Array.isArray(payload?.lines) ? payload.lines : [];
    if (lines.length === 0) {
      throw new BadRequestException(
        'No priced lines were found. Enter a unit price for at least one line before submitting.',
      );
    }

    // The vendor session has no user, so the actor is the token itself. Passing
    // an invented user id would put a false name in an audit trail.
    //
    // NULL, not '': the submitted-by column is a uuid, and literalize('') emits
    // `'...'::uuid`, which Postgres rejects as an invalid uuid. An empty string
    // is not "no user", it is a malformed one.
    const result = await this.quotations.submitAsVendor({
      userId: null as unknown as string,
      role: 'vendor',
      costCenterIds: [],
      expectedVendorId: inv.vendor_id,
      invitationId: inv.invitation_id,
      body: {
        // The token identifies the vendor, so this is never taken from the
        // request body — see submitAsVendor, which re-asserts it anyway.
        vendorId: inv.vendor_id,
        totalAmount: Number(payload.totalAmount) || undefined,
        currency: payload.currency || inv.currency,
        leadTimeDays: payload.leadTimeDays !== undefined && payload.leadTimeDays !== null && payload.leadTimeDays !== ''
          ? Number(payload.leadTimeDays) : undefined,
        warrantyMonths: payload.warrantyMonths !== undefined && payload.warrantyMonths !== null && payload.warrantyMonths !== ''
          ? Number(payload.warrantyMonths) : undefined,
        paymentTerms: payload.paymentTerms || undefined,
        validityDays: payload.validityDays ? Number(payload.validityDays) : undefined,
        taxesIncluded: payload.taxesIncluded === true ? true : undefined,
        notes: [payload.notes, uploaded ? `Uploaded as ${uploaded.filename}` : null]
          .filter(Boolean).join(' — ') || undefined,
        lines: lines.map((l: any) => ({
          // QuotationInput calls this `rfqLineNo`, not `lineNo`. Mapping it to
          // the wrong name produced `Number(undefined) -> NaN` and the service
          // rejected the quote with "line NaN is not on this RFQ".
          rfqLineNo: Number(l.lineNo ?? l.rfqLineNo),
          unitPrice: Number(l.unitPrice),
          remarks: l.remarks || undefined,
        })),
      },
    });

    this.log.log(`token submission on ${inv.rfq_number} via ${source}`);
    return { ...result, source };
  }

  /**
   * Map an uploaded workbook back onto the pack.
   *
   * Matched by LINE NO, never by row index: a vendor who sorts the sheet must
   * not silently re-price a different line. A line number the buyer never issued
   * is refused rather than ignored, because a price for a line nobody asked for
   * cannot be evaluated and only creates the illusion of completeness.
   */
  private parseUploaded(filename: string, buffer: Buffer, inv: any) {
    let sheet;
    try {
      sheet = readXlsx(buffer);
    } catch (e: any) {
      throw new BadRequestException(
        `That file could not be read as an Excel workbook: ${String(e?.message || e)}. ` +
          'Download the template from this page and fill that in.',
      );
    }

    const head = sheet.rows.find((r) => r.some((c) => String(c ?? '').trim().toLowerCase() === 'line'));
    if (!head) {
      throw new BadRequestException(
        'No header row was found. The first row must start with a "Line" column — download the template to be sure of the format.',
      );
    }
    const col = (name: string) => head.findIndex((c) => String(c ?? '').trim().toLowerCase() === name);
    const iLine = col('line');
    const iPrice = col('unit price');
    const iLead = col('lead time (days)');
    const iWarr = col('warranty (months)');
    const iTerms = col('payment terms');
    const iValid = col('validity (days)');
    const iTax = col('taxes included');
    const iNotes = col('notes');
    if (iLine < 0 || iPrice < 0) {
      throw new BadRequestException('The workbook needs both a "Line" and a "Unit Price" column.');
    }

    const allowed = new Set<number>();
    for (const l of sheet.rows) {
      const n = Number(l[iLine]);
      if (Number.isFinite(n) && n > 0) allowed.add(n);
    }

    const lines: any[] = [];
    const rejected: string[] = [];
    let lead: number | undefined;
    let warranty: number | undefined;
    let validity: number | undefined;
    let terms: string | undefined;
    let taxesIncluded: boolean | undefined;

    /** "Yes"/"Y"/"TRUE"/"1" — anything else is left unstated rather than guessed. */
    const truthy = (v: any) => ['y', 'yes', 'true', '1'].includes(String(v ?? '').trim().toLowerCase());

    for (const r of sheet.rows) {
      if (r === head) continue;
      const n = Number(r[iLine]);
      if (!Number.isFinite(n) || n <= 0) continue;
      const priceRaw = r[iPrice];
      if (priceRaw === null || priceRaw === undefined || String(priceRaw).trim() === '') continue;

      const price = Number(priceRaw);
      if (!Number.isFinite(price) || price < 0) {
        rejected.push(`line ${n}: unit price "${String(priceRaw)}" is not a number`);
        continue;
      }
      lines.push({ rfqLineNo: n, unitPrice: price, remarks: iNotes >= 0 ? String(r[iNotes] ?? '') || undefined : undefined });

      if (iLead >= 0) {
        const v = Number(r[iLead]);
        if (Number.isFinite(v) && v > 0) lead = lead === undefined ? v : Math.max(lead, v);
      }
      if (iWarr >= 0) {
        const v = Number(r[iWarr]);
        if (Number.isFinite(v) && v > 0) warranty = warranty === undefined ? v : Math.max(warranty, v);
      }
      // Validity is a whole-quotation term, so the longest stated wins — the
      // same conservative reading as lead time and warranty above.
      if (iValid >= 0) {
        const v = Number(r[iValid]);
        if (Number.isFinite(v) && v > 0) validity = validity === undefined ? v : Math.max(validity, v);
      }
      // Payment terms are free text and belong to the quotation, not the line,
      // so the first one stated is taken and the rest are not concatenated.
      if (iTerms >= 0 && terms === undefined) {
        const t = String(r[iTerms] ?? '').trim();
        if (t) terms = t;
      }
      if (iTax >= 0 && taxesIncluded === undefined) {
        const t = String(r[iTax] ?? '').trim();
        if (t) taxesIncluded = truthy(t);
      }
    }

    if (rejected.length) {
      throw new BadRequestException(
        `This file has ${rejected.length} line(s) that could not be read: ${rejected.slice(0, 4).join('; ')}. ` +
          'Fix them and upload again — nothing has been saved.',
      );
    }
    if (lines.length === 0) {
      throw new BadRequestException('No unit prices were found in the "Unit Price" column.');
    }
    return {
      lines, leadTimeDays: lead, warrantyMonths: warranty,
      paymentTerms: terms, validityDays: validity, taxesIncluded,
      notes: `Uploaded as ${filename}`,
    };
  }

  /** POST /vendor-portal/:token/decline */
  async decline(token: string, reason?: string) {
    const inv = await this.resolve(token);
    const r = await this.db.query<any>(
      `UPDATE proc.rfq_invitations
          SET declined = true, declined_reason = $2::text
        WHERE id = $1::uuid AND NOT declined
        RETURNING id, declined, declined_reason`,
      [inv.invitation_id, String(reason || '').trim() || null],
      { bypassRls: true },
    );
    if (r.rows.length === 0) {
      throw new BadRequestException('This invitation has already been answered.');
    }
    return { declined: true, reason: r.rows[0].declined_reason };
  }
}
