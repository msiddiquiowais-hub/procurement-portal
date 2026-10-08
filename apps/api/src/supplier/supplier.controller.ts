import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { IsArray, IsInt, IsNumber, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { SupplierGuard } from './supplier.guard';
import { SupplierService } from './supplier.service';
import type { AuthenticatedUser } from '../auth/auth.service';

class SupplierLineDto {
  /** 1-based, matching proc.rfq_lines.line_no. */
  @IsInt() @Min(1) lineNo!: number;
  /**
   * The prototype's unit-price box. NULL is a real state and is NOT the same
   * as 0: the engine refuses a quote with any unpriced line rather than
   * storing a zero-priced line the vendor never agreed to.
   */
  @IsOptional() @IsNumber() @Min(0) unitPrice!: number | null;
}

class SupplierQuoteDto {
  @IsArray() lines!: SupplierLineDto[];
  /** The prototype's "Total amount (PKR) *" field. */
  @IsOptional() @IsNumber() @Min(0) totalAmount?: number | null;
  /** Select LABELS ("7 days"), converted to integers by the service. */
  @IsOptional() @IsString() @MaxLength(40) leadTime?: string;
  @IsOptional() @IsString() @MaxLength(40) warranty?: string;
  @IsOptional() @IsString() @MaxLength(40) paymentTerms?: string;
  @IsOptional() @IsString() @MaxLength(2000) remarks?: string;
}

class DeclineDto {
  @IsOptional() @IsString() @MaxLength(2000) reason?: string;
}

/**
 * The Wave 4 supplier API.
 *
 * Guard order matters and is declared in this order: JwtAuthGuard populates
 * req.user, SupplierGuard then refuses anything without a vendor link. A
 * reverse order would read an empty user and pass.
 */
@UseGuards(JwtAuthGuard, SupplierGuard)
@Controller('supplier')
export class SupplierController {
  constructor(private readonly svc: SupplierService) {}

  /** `GET /supplier/inbox` — the Supplier RFQ Inbox screen. */
  @Get('inbox')
  async inbox(@Req() req: any) {
    return this.svc.inbox(req.user as AuthenticatedUser);
  }

  /** `GET /supplier/rfq/:invitationId` — the Submit Quote screen. */
  @Get('rfq/:invitationId')
  async form(@Param('invitationId') invitationId: string, @Req() req: any) {
    return this.svc.quoteForm(req.user as AuthenticatedUser, invitationId);
  }

  /**
   * `POST /supplier/rfq/:invitationId/quote` — submit, or revise by
   * re-submitting. Append-only: a prior version is superseded, never rewritten.
   */
  @Post('rfq/:invitationId/quote')
  async quote(
    @Param('invitationId') invitationId: string,
    @Body() body: SupplierQuoteDto,
    @Req() req: any,
  ) {
    return this.svc.submitQuote(req.user as AuthenticatedUser, invitationId, body);
  }

  /** `POST /supplier/rfq/:invitationId/decline` */
  @Post('rfq/:invitationId/decline')
  async decline(
    @Param('invitationId') invitationId: string,
    @Body() body: DeclineDto,
    @Req() req: any,
  ) {
    return this.svc.decline(req.user as AuthenticatedUser, invitationId, body?.reason);
  }
}
