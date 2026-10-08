import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { IsArray, IsBoolean, IsIn, IsNumber, IsObject, IsOptional, IsString, Matches, Max, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { CLASSIFICATIONS } from '@procurement/d365-client';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { PrService } from './pr.service';

// Dev-only: accept any 8-4-4-4-12 hex UUID. class-validator's @IsUUID uses
// validator.js which rejects the placeholder UUIDs in our seed (all-1s etc).
// Production should swap to @IsUUID('all') + real v4 UUIDs.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class TagApproverDto {
  @IsIn(['employee', 'dept_head', 'director', 'project_lead', 'requester_self', 'new_employee'])
  taggedRole!: string;
  @IsString() name!: string;
  @IsString() email!: string;
  @IsOptional() @IsString() deptCode?: string;
}

class CreatePrLineDto {
  // OPTIONAL since migration 052 — a line may be free text.
  //
  // Omitting itemId means "the requester described this in their own words and no
  // catalogue row matched", which is a legitimate, common answer: an ergonomic
  // chair with a mesh back and no arms is not an SKU. The form used to force a
  // match, which produced lines that lied about what was requested rather than
  // lines that said it plainly.
  //
  // The FK to core.items is still enforced in the database, so SENDING an itemId
  // that is not a real catalogue row is still refused with a constraint name. What
  // changed is that omitting it is no longer an error. That is the line between
  // "describe it your way" and "invent a product code", and only the second one
  // is still closed.
  @IsOptional() @Matches(UUID_RE, { message: 'itemId must be a UUID' })
  itemId?: string;
  @IsNumber() @Min(0) quantity!: number;
  @IsString() uom!: string;
  // Optional on purpose. A requisition can legitimately be raised before the
  // price is known - the cost comes back with the RFQ quotes. Omitting it
  // records NULL, and a PR whose lines all omit it is stored with
  // amount_status = 'UNKNOWN' rather than a fabricated 0. Sending a number
  // still means "this is what I think it costs".
  @IsOptional() @IsNumber() @Min(0) unitPriceEst?: number;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @Matches(UUID_RE, { message: 'preferredVendorId must be a UUID' })
  preferredVendorId?: string;
  // Per-line routing category override. Omitted -> falls back to
  // core.items.category, which is what resolveLineCategory() reads.
  @IsOptional() @IsString() category?: string;
  @IsOptional() @IsObject() financialDimensions?: Record<string, string>;
}

class CreatePrDepartmentDto {
  @Matches(UUID_RE, { message: 'departmentId must be a UUID' }) departmentId!: string;
  @IsOptional() @IsBoolean() suggested?: boolean;
  // NOTE: there is deliberately no `hodUserId` here any more.
  //
  // It used to be accepted from the browser and written straight into
  // proc.pr_departments, which made the approving department head a
  // client-controlled field. The approver is now resolved server-side from
  // core.fn_resolve_department_hod() - the department's own hod_user_id - and
  // proc.fn_pr_departments_approver_gate() refuses any row naming anyone else.
  // ValidationPipe runs with whitelist: true, so a client still sending the
  // old field has it stripped rather than honoured.
}

class CreatePrImageDto {
  @Matches(UUID_RE, { message: 'fileId must be a UUID' }) fileId!: string;
  @IsOptional() @IsNumber() @Min(0) lineIndex?: number;
  @IsIn(['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif'])
  mimeType!: string;
  @IsNumber() @Min(1) @Max(2_097_152) sizeBytes!: number;   // 2 MB, per prototype MAX_IMAGE_BYTES
}

class CreatePrDto {
  @IsString() scope!: string;
  @IsIn(['CAPEX', 'OPEX', 'MIXED']) expenseType!: 'CAPEX' | 'OPEX' | 'MIXED';
  @Matches(UUID_RE, { message: 'costCenterId must be a UUID' }) costCenterId!: string;
  @IsString() requiredByDate!: string;
  @IsOptional() @IsIn(['routine', 'urgent', 'force_majeure'])
  urgency?: 'routine' | 'urgent' | 'force_majeure';
  @IsOptional() @IsString() title?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() purpose?: string;
  // Multi-department HOD routing. The prototype's create form suggests one HOD
  // per department on the PR.
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => CreatePrDepartmentDto)
  departments?: CreatePrDepartmentDto[];
  // Per-line reference images. DB triggers enforce max 3 per PR / 5 MB total.
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => CreatePrImageDto)
  images?: CreatePrImageDto[];
  @IsArray() @ValidateNested({ each: true }) @Type(() => CreatePrLineDto)
  lines!: CreatePrLineDto[];
}

class CapitalPrLineDto {
  @Matches(UUID_RE, { message: 'itemId must be a UUID' }) itemId!: string;
  @IsNumber() @Min(0) quantity!: number;
  @IsString() uom!: string;
  @IsNumber() @Min(0) unitPriceEst!: number;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() glAccount?: string;
  // Per-line Capex/Opex class. Required on submit — the capital-PR screen
  // blocks until every line is classified.
  @IsOptional() @IsIn(CLASSIFICATIONS.map(c => c.value))
  classification?: string;
  @IsOptional() @IsString() remarks?: string;
  @IsOptional() @IsObject() financialDimensions?: Record<string, string>;
  @IsOptional() @Matches(UUID_RE, { message: 'preferredVendorId must be a UUID' })
  preferredVendorId?: string;
}

class CapitalPrDto {
  @IsString() title!: string;
  @IsOptional() @Matches(UUID_RE, { message: 'departmentId must be a UUID' }) departmentId?: string;
  @Matches(UUID_RE, { message: 'costCenterId must be a UUID' }) costCenterId!: string;
  @IsOptional() @IsString() scope?: string;
  @IsIn(['CAPEX', 'OPEX', 'MIXED']) expenseType!: 'CAPEX' | 'OPEX' | 'MIXED';
  @IsString() requiredByDate!: string;
  @IsOptional() @IsIn(['routine', 'urgent', 'force_majeure'])
  urgency?: 'routine' | 'urgent' | 'force_majeure';
  @IsOptional() @IsString() justification?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() purpose?: string;
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => TagApproverDto)
  taggedApprovers?: TagApproverDto[];
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => CreatePrImageDto)
  images?: CreatePrImageDto[];
  @IsArray() @ValidateNested({ each: true }) @Type(() => CapitalPrLineDto)
  lines!: CapitalPrLineDto[];
  @IsOptional() submit?: boolean;
}

class AdvancePrDto {
  @IsOptional() wantWarehouse?: boolean;
  @IsOptional() inStock?: boolean;
  @IsOptional() lineRejected?: boolean;
  @IsOptional() @IsString() reason?: string;
  // Per-line HOD disposition, keyed by ZERO-BASED line index. These become
  // the `lineDecisions` the line-routing evaluator filters on, and are
  // persisted to proc.pr_lines.approved / .rejected / .held.
  @IsOptional() @IsObject() lineDecisions?: Record<number, 'approved' | 'rejected' | 'held'>;
}

@UseGuards(JwtAuthGuard)
@Controller('pr')
export class PrController {
  constructor(private readonly svc: PrService) {}

  @Get()
  async list(@Req() req: any) {
    const u = req.user;
    return this.svc.list(u.id, u.role, u.costCenterIds);
  }

  @Get('capital/my')
  async myPrs(@Req() req: any) {
    const u = req.user;
    return this.svc.myPrs(u.id, u.role, u.costCenterIds);
  }

  @Get('capital/:id/detail')
  async capitalDetail(@Param('id') id: string, @Req() req: any) {
    const u = req.user;
    return this.svc.capitalDetail(id, u.id, u.role, u.costCenterIds);
  }

  @Post('capital')
  async createCapital(@Body() body: CapitalPrDto, @Req() req: any) {
    const u = req.user;
    return this.svc.createCapital(u.id, u.role, u.costCenterIds, body);
  }

  @Get('light/list')
  async lightList(@Req() req: any) {
    const u = req.user;
    return this.svc.lightList(u.id, u.role, u.costCenterIds);
  }

  @Get('approvals/queue')
  async approvalsQueue(@Req() req: any) {
    const u = req.user;
    return this.svc.approvalsQueue(u.id, u.role, u.costCenterIds);
  }

  @Get(':id/history')
  async history(@Param('id') id: string, @Req() req: any) {
    const u = req.user;
    return this.svc.history(id, u.id, u.role, u.costCenterIds);
  }

  @Get(':id')
  async get(@Param('id') id: string, @Req() req: any) {
    const u = req.user;
    return this.svc.get(id, u.id, u.role, u.costCenterIds);
  }

  @Post()
  async create(@Body() body: CreatePrDto, @Req() req: any) {
    const u = req.user;
    return this.svc.create(u.id, u.role, u.costCenterIds, body);
  }

  @Post(':id/advance')
  async advance(
    @Param('id') id: string,
    @Body() body: AdvancePrDto,
    @Req() req: any,
  ) {
    const u = req.user;
    return this.svc.advance(id, body, u.id, u.role, u.costCenterIds);
  }

  /**
   * Hold / "Revert for revision" — port of the prototype's lightOnHold and
   * lightHodRevertForRevision, both of which call
   * `lightTransition(pr, 'ON_HOLD', {...})` DIRECTLY (prototype lines 3486,
   * 3662, 6603) rather than walking the step table.
   *
   * That is why this is its own endpoint and not a Decision flag: ON_HOLD is
   * not the target of any step in DEFAULT_WORKFLOW_STEPS, so routing it through
   * the engine would fail with "no workflow step matched". Adding a synthetic
   * step would have meant adding a 13th step the prototype does not have.
   *
   * `resume: true` walks it back to the stage it was held from, which is the
   * prototype's resume branch in lightOnHold.
   */
  @Post(':id/hold')
  async hold(
    @Param('id') id: string,
    @Body() body: { reason?: string; resume?: boolean },
    @Req() req: any,
  ) {
    const u = req.user;
    return this.svc.hold(id, u.id, u.role, u.costCenterIds, body?.reason, body?.resume === true);
  }
}
