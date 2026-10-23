import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import {
  IsArray, IsBoolean, IsIn, IsNumber, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { QuotationService } from './quotation.service';
import { CsService } from './cs.service';
import { CsReviewService } from './cs.review.service';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class QuotationLineDto {
  /** 1-based, matching proc.rfq_lines.line_no. */
  @IsNumber() @Min(1) rfqLineNo!: number;
  @IsNumber() @Min(0) unitPrice!: number;
  /** The prototype's per-line "declined" checkbox: will not supply this line. */
  @IsOptional() @IsBoolean() declined?: boolean;
  @IsOptional() @IsString() @MaxLength(1000) remarks?: string;

  /**
   * The three AUTHORITATIVE per-line inputs behind the waterfall.
   *
   * gross_amount, discount_amount, net_amount, tax_amount and line_total are
   * NOT accepted from the client — they are derived server-side in
   * QuotationService.priceLines(). Accepting them would let a UI that has not
   * recalculated, or a hand-rolled request, persist a total that disagrees with
   * its own inputs, and that disagreement would surface later as an unexplained
   * gap in the comparative statement. One source of truth per figure: the
   * officer types the rate, the server does the arithmetic.
   */
  @IsOptional() @IsNumber() @Min(0) @Max(100) discountPercent?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(100) taxPercent?: number;
  /** Warranty for THIS item — a quote can mix a 5yr desktop and a 1yr chair. */
  @IsOptional() @IsNumber() @Min(0) warrantyMonths?: number;
}

class QuotationBodyDto {
  @Matches(UUID_RE, { message: 'vendorId must be a UUID' }) vendorId!: string;
  @IsOptional() @IsIn(['total', 'per_line']) quoteMode?: 'total' | 'per_line';
  @IsOptional() @IsNumber() @Min(0) totalAmount?: number;
  @IsOptional() @IsNumber() @Min(0) subtotal?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(100) taxPercent?: number;
  @IsOptional() @IsNumber() @Min(0) taxAmount?: number;
  @IsOptional() @IsNumber() @Min(0) freight?: number;
  @IsOptional() @IsString() @MaxLength(8) currency?: string;
  @IsOptional() @IsNumber() fxRate?: number;
  @IsOptional() @IsNumber() @Min(0) leadTimeDays?: number;
  @IsOptional() @IsNumber() @Min(0) warrantyMonths?: number;
  @IsOptional() @IsNumber() @Min(1) validityDays?: number;
  @IsOptional() @IsBoolean() taxesIncluded?: boolean;
  @IsOptional() @IsString() @MaxLength(500) paymentTerms?: string;
  @IsOptional() @IsString() @MaxLength(4000) notes?: string;
  /**
   * core.files.id of the vendor's quotation document, uploaded via
   * POST /pr/:id/attachments.
   *
   * Optional AT THE DTO LEVEL ON PURPOSE. Making it a required decorator would
   * also reject the supplier portal's own submit path, which uploads through a
   * different endpoint and would then be unable to submit at all. The
   * requirement is enforced in QuotationService.insertQuotation() on the
   * procurement path only — see `strictForm`.
   */
  @IsOptional() @Matches(UUID_RE, { message: 'attachmentId must be a UUID' }) attachmentId?: string;

  /**
   * The officer answered YES to "you are missing the attachment" on a REVISION.
   *
   * Must be declared here or the ValidationPipe's whitelist strips it and the
   * service never sees the confirmation — which reads as the rule being broken
   * rather than the field being dropped, and is exactly the kind of silent
   * failure a declared DTO field is supposed to prevent.
   *
   * A boolean flag, not a string: it is an assertion by the client, and the
   * authority to act on it stays in insertQuotation.
   */
  @IsOptional() @IsBoolean() allowMissingAttachment?: boolean;
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => QuotationLineDto)
  lines?: QuotationLineDto[];

  /**
   * The expiry date the VENDOR stated, as YYYY-MM-DD.
   *
   * The form collects a date; `validity_days` is an integer the vendor never
   * actually said. Both are stored — this one is authoritative because it is
   * what appears on the vendor's own quotation.
   */
  @IsOptional() @IsString() @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'validUntil must be a YYYY-MM-DD date',
  }) validUntil?: string;

  /**
   * Whether a line discount reduces the TAXABLE base or is taken off after tax.
   *
   *   before_tax — tax is computed on the discounted net.  (default)
   *   after_tax  — tax is computed on the gross, discount comes off afterwards.
   *
   * These differ on money: on 62,500 with 5% off at 17.5%, before_tax totals
   * 69,765.63 and after_tax totals 70,312.50. Neither is "right" — it depends
   * on the jurisdiction and on what the vendor's own paperwork says — so the
   * officer records which one applies and the server honours it.
   */
  @IsOptional() @IsIn(['before_tax', 'after_tax']) discountBasis?: 'before_tax' | 'after_tax';
}

class SupersedeBodyDto extends QuotationBodyDto {
  /** The prototype's revision-reason field on the "Save as new revision" flow. */
  @IsOptional() @IsString() @MinLength(3) @MaxLength(2000) reason?: string;
}

class WithdrawBodyDto {
  @IsOptional() @IsString() @MinLength(3) @MaxLength(2000) reason?: string;
}

class LockCsDto {
  /**
   * Optional (W5-G).
   *
   * This was `@Matches(UUID_RE)` and MANDATORY, which made a split-award lock
   * unrepresentable at the very first gate: the validation pipe refused the
   * request before the service could look at the recorded line awards. An
   * officer who had correctly awarded line 1 to one vendor and line 2 to
   * another was told "winnerVendorId must be a UUID" and given no way forward.
   *
   * Optional does NOT mean unchecked — CsService decides the mode from the
   * recorded line awards and refuses the lock when neither a winner nor a
   * complete split is present. Relaxing the DTO hands that decision to the code
   * that has the evidence, instead of to a required field that cannot express
   * the answer.
   */
  @IsOptional() @Matches(UUID_RE, { message: 'winnerVendorId must be a UUID' }) winnerVendorId?: string;
  @IsOptional() @IsString() @MaxLength(2000) reason?: string;
  /** Required when the winner is not the top-ranked vendor. */
  @IsOptional() @IsString() @MaxLength(2000) overrideReason?: string;
}

/**
 * The body of a CS revert (migration 065).
 *
 * `reason` is REQUIRED and length-checked. A revert is an audit-trail entry: if
 * the statement went back for negotiation, the record has to say why, and an
 * empty string would otherwise reach the service as a shrug with a timestamp on
 * it. The table enforces the same rule, so a direct SQL write cannot bypass it.
 */
class RevertBodyDto {
  @IsString()
  @MinLength(3, { message: 'A revert must record a reason.' })
  @MaxLength(2000)
  reason!: string;

  /**
   * Per-line negotiation flags from the blind commercial review (migration
   * 066). Optional because a buyer may return a whole statement without naming
   * a line; when present, EVERY entry must carry a target rate or reason.
   */
  @IsOptional() @IsArray()
  revertLines?: Array<{
    lineNo: number;
    decision: string;
    targetRemarks?: string;
  }>;
}

@UseGuards(JwtAuthGuard)
@Controller()
export class QuotationController {
  constructor(
    private readonly svc: QuotationService,
    private readonly cs: CsService,
    private readonly review: CsReviewService,
  ) {}

  /**
   * `GET /pr/:id/quotes` — the Versions Panel payload: every version of every
   * quote on the PR's RFQ, grouped by vendor.
   */
  @Get('pr/:id/quotes')
  async forPr(@Param('id') id: string, @Req() req: any) {
    const u = req.user;
    return this.svc.forPr(id, u.id, u.role, u.costCenterIds);
  }

  /** `POST /rfq/:id/quotations` — record a quote as V1. */
  @Post('rfq/:id/quotations')
  async record(@Param('id') id: string, @Body() body: QuotationBodyDto, @Req() req: any) {
    const u = req.user;
    return this.svc.record(id, u.id, u.role, u.costCenterIds, body);
  }

  /**
   * `POST /quotations/:id/supersede` — mint the next version. Append-only:
   * the prior row is marked Superseded and never rewritten.
   */
  @Post('quotations/:id/supersede')
  async supersede(@Param('id') id: string, @Body() body: SupersedeBodyDto, @Req() req: any) {
    const u = req.user;
    return this.svc.supersede(id, u.id, u.role, u.costCenterIds, body, body?.reason);
  }

  /** `POST /quotations/:id/withdraw` — the prototype's VOID, stored as Withdrawn. */
  @Post('quotations/:id/withdraw')
  async withdraw(@Param('id') id: string, @Body() body: WithdrawBodyDto, @Req() req: any) {
    const u = req.user;
    return this.svc.withdraw(id, u.id, u.role, u.costCenterIds, body?.reason);
  }

  // ── Comparative Statement ────────────────────────────────────────────────

  /** `GET /pr/:id/cs` — the `cs` screen payload (renderCS). */
  @Get('pr/:id/cs')
  async csForPr(@Param('id') id: string, @Req() req: any) {
    const u = req.user;
    return this.cs.forPr(id, u.id, u.role, u.costCenterIds);
  }

  /** `POST /pr/:id/cs` — generate the CS with real `cs_lines` scores. */
  @Post('pr/:id/cs')
  async generateCs(@Param('id') id: string, @Req() req: any) {
    const u = req.user;
    return this.cs.generate(id, u.id, u.role, u.costCenterIds);
  }

  /**
   * `POST /cs/:id/lock` — lock the CS and record the winner. Terminal; on a
   * FAST_TRACK route it also auto-locks the approved pack.
   */
  @Post('cs/:id/lock')
  async lockCs(@Param('id') id: string, @Body() body: LockCsDto, @Req() req: any) {
    const u = req.user;
    return this.cs.lock(id, u.id, u.role, u.costCenterIds, body);
  }

  // ── CS review sub-workflow (migration 065) ───────────────────────────────

  /** `GET /pr/:id/cs/review` — the chain state, and who may act next. */
  @Get('pr/:id/cs/review')
  async reviewForPr(@Param('id') id: string, @Req() req: any) {
    const u = req.user;
    return this.review.forPr(id, u.id, u.role, u.costCenterIds);
  }

  /** `POST /cs/:id/review/submit` — DRAFT|REVERTED -> PROC_REVIEW. */
  @Post('cs/:id/review/submit')
  async submitReview(@Param('id') id: string, @Req() req: any) {
    const u = req.user;
    return this.review.submitForProcReview(id, u.id, u.role, u.costCenterIds);
  }

  /** `POST /cs/:id/review/send-to-requester` — PROC_REVIEW -> REQUESTER_REVIEW (blind). */
  @Post('cs/:id/review/send-to-requester')
  async sendToRequester(@Param('id') id: string, @Req() req: any) {
    const u = req.user;
    return this.review.sendToRequester(id, u.id, u.role, u.costCenterIds);
  }

  /** `POST /cs/:id/review/confirm` — REQUESTER_REVIEW -> CONFIRMED, moves the PR. */
  @Post('cs/:id/review/confirm')
  async confirmReview(@Param('id') id: string, @Req() req: any) {
    const u = req.user;
    return this.review.confirm(id, u.id, u.role, u.costCenterIds);
  }

  /**
   * `POST /cs/:id/review/revert-soft` — back for negotiation. The RFQ and every
   * quotation survive; nothing is cancelled.
   */
  @Post('cs/:id/review/revert-soft')
  async revertSoft(@Param('id') id: string, @Body() body: RevertBodyDto, @Req() req: any) {
    const u = req.user;
    // The per-line flags arrive camelCase from the client and are stored as
    // snake_case; mapping happens here so the service sees one vocabulary and
    // the migration column keeps the names the domain uses.
    const flags = (body?.revertLines ?? []).map((f) => ({
      line_no: f?.lineNo,
      decision: f?.decision,
      target_remarks: f?.targetRemarks ?? null,
    }));
    return this.review.revertSoft(id, u.id, u.role, u.costCenterIds, body?.reason, flags);
  }

  /** `POST /cs/:id/review/revert-hard` — withdraw the statement for a fresh round. */
  @Post('cs/:id/review/revert-hard')
  async revertHard(@Param('id') id: string, @Body() body: RevertBodyDto, @Req() req: any) {
    const u = req.user;
    return this.review.revertHard(id, u.id, u.role, u.costCenterIds, body?.reason);
  }
}
