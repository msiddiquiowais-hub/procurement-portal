import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import {
  IsArray, IsBoolean, IsISO8601, IsOptional, IsString, Matches, MaxLength,
} from 'class-validator';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { RfqService } from './rfq.service';

// Dev-only: accept any 8-4-4-4-12 hex UUID. Matches PrController — the seed
// carries placeholder UUIDs that class-validator's @IsUUID rejects.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class IssueRfqDto {
  /**
   * Explicit roster. Omit to auto-pick the first 3 approved vendors, which is
   * what `rfqIssue()` does ("sent to 3 vendors"). Naming vendors explicitly is
   * how a new/unapproved vendor gets onto the RFQ (Q3 — badged "Pending
   * approval" in the roster card, never blocked).
   */
  @IsOptional() @IsArray() @IsString({ each: true }) vendorIds?: string[];
  /** Display-only per decision Q2 — no timer reads this. */
  @IsOptional() @IsISO8601() deadlineAt?: string;
  @IsOptional() @IsString() @MaxLength(300) title?: string;
  @IsOptional() @IsString() @MaxLength(8) currency?: string;
  @IsOptional() @IsString() @MaxLength(32) incoterm?: string;
  @IsOptional() @IsBoolean() singleSource?: boolean;
  @IsOptional() @IsString() @MaxLength(2000) singleSourceJustification?: string;
}

class InviteVendorDto {
  @Matches(UUID_RE, { message: 'vendorId must be a UUID' }) vendorId!: string;
}

/** Re-issue takes the roster and the deadline only — see RfqIssueController. */
class ReissueRfqDto {
  @IsOptional() @IsArray() @IsString({ each: true }) vendorIds?: string[];
  @IsOptional() @IsISO8601() deadlineAt?: string;
}

@UseGuards(JwtAuthGuard)
@Controller('rfq')
export class RfqController {
  constructor(private readonly svc: RfqService) {}

  @Get()
  async list(@Req() req: any) {
    const u = req.user;
    return this.svc.list(u.id, u.role, u.costCenterIds);
  }

  @Get(':id')
  async get(@Param('id') id: string, @Req() req: any) {
    const u = req.user;
    return this.svc.get(id, u.id, u.role, u.costCenterIds);
  }

  @Post(':id/invite')
  async invite(@Param('id') id: string, @Body() body: InviteVendorDto, @Req() req: any) {
    const u = req.user;
    return this.svc.invite(id, u.id, u.role, u.costCenterIds, body);
  }
}

/**
 * Issue-RFQ lives under `pr/` because the prototype issues it FROM a PR
 * (`rfqIssue()` mutates `STATE.pr`). Split into its own controller so the
 * `@Controller('pr')` prefix does not collide with PrController's routes.
 */
@UseGuards(JwtAuthGuard)
@Controller('pr')
export class RfqIssueController {
  constructor(private readonly svc: RfqService) {}

  @Post(':id/rfq')
  async issue(@Param('id') id: string, @Body() body: IssueRfqDto, @Req() req: any) {
    const u = req.user;
    return this.svc.issue(id, u.id, u.role, u.costCenterIds, body);
  }

  /**
   * `POST /pr/:id/rfq/reissue` — the prototype's "Re-issue RFQ".
   *
   * Declared after the first issue because the paths differ in segment count, so
   * there is no shadowing. The SAME dialog posts here instead of there once the
   * PR carries an RFQ; what changes is the endpoint, not the form.
   *
   * The body is a strict subset of `IssueRfqDto` on purpose. A re-issue adds
   * vendors to an RFQ that already exists, so there is no title, currency or
   * incoterm left to choose — those were fixed at issue and the prototype
   * carries them across untouched. Accepting them here would imply they were
   * editable and silently drop them.
   */
  @Post(':id/rfq/reissue')
  async reissue(@Param('id') id: string, @Body() body: ReissueRfqDto, @Req() req: any) {
    const u = req.user;
    return this.svc.reissue(id, u.id, u.role, u.costCenterIds, body);
  }

  /**
   * `GET /pr/:id/rfq/candidates` — what Issue RFQ WOULD send to.
   *
   * The modal the procurement officer opens before sending. It is a preview, so
   * it must be read-only and must never mint a token, create an RFQ or write to
   * the outbox — only `POST :id/rfq` followed by `POST /rfq/:id/dispatch` does
   * that. Declared after the POST because the paths differ in segment count
   * (`pr/:id/rfq` vs `pr/:id/rfq/candidates`), so there is no shadowing.
   */
  @Get(':id/rfq/candidates')
  async candidates(@Param('id') id: string, @Req() req: any) {
    const u = req.user;
    return this.svc.rfqCandidates(id, u.role);
  }

  /**
   * `GET /pr/:id/sourcing` — the single call that powers BOTH detail-page
   * cards (_lightProcurementCard and _lightRosterCard read the same object in
   * the prototype, so one request serves both).
   */
  @Get(':id/sourcing')
  async sourcing(@Param('id') id: string, @Req() req: any) {
    const u = req.user;
    return this.svc.sourcing(id, u.id, u.role, u.costCenterIds);
  }
}
