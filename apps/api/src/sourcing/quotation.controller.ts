import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import {
  IsArray, IsBoolean, IsIn, IsNumber, IsOptional, IsString, Matches, MaxLength, Min, MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { QuotationService } from './quotation.service';
import { CsService } from './cs.service';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class QuotationLineDto {
  /** 1-based, matching proc.rfq_lines.line_no. */
  @IsNumber() @Min(1) rfqLineNo!: number;
  @IsNumber() @Min(0) unitPrice!: number;
  /** The prototype's per-line "declined" checkbox: will not supply this line. */
  @IsOptional() @IsBoolean() declined?: boolean;
  @IsOptional() @IsString() @MaxLength(1000) remarks?: string;
}

class QuotationBodyDto {
  @Matches(UUID_RE, { message: 'vendorId must be a UUID' }) vendorId!: string;
  @IsOptional() @IsIn(['total', 'per_line']) quoteMode?: 'total' | 'per_line';
  @IsOptional() @IsNumber() @Min(0) totalAmount?: number;
  @IsOptional() @IsNumber() @Min(0) subtotal?: number;
  @IsOptional() @IsNumber() @Min(0) taxPercent?: number;
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
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => QuotationLineDto)
  lines?: QuotationLineDto[];
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

@UseGuards(JwtAuthGuard)
@Controller()
export class QuotationController {
  constructor(private readonly svc: QuotationService, private readonly cs: CsService) {}

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
}
