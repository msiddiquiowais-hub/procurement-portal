import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { VendorsService } from './vendors.service';
import { VendorGovernanceService } from './vendor-governance.service';
import type { AuthenticatedUser } from '../auth/auth.service';

@UseGuards(JwtAuthGuard)
@Controller('vendors')
export class VendorsController {
  constructor(
    private readonly svc: VendorsService,
    private readonly gov: VendorGovernanceService,
  ) {}

  /**
   * GET /vendors — Vendor Master (blueprint 9.3).
   */
  @Get()
  async list(@Req() req: any) {
    const u = req.user as AuthenticatedUser;
    return this.svc.list(u.role);
  }

  /**
   * GET /vendors/risk — Vendor Risk Review (blueprint 9.5).
   *
   * Declared BEFORE `@Get(':id')`. Nest matches in declaration order, so a
   * literal segment declared after a parameterised one would be swallowed by it
   * and `/vendors/risk` would be read as a vendor id — a 404 that looks like a
   * missing vendor rather than a route-ordering mistake.
   */
  @Get('risk')
  async risk(@Req() req: any) {
    const u = req.user as AuthenticatedUser;
    return this.svc.riskMatrix(u.role);
  }

  /**
   * GET /vendors/applications — Wave 4's read side.
   *
   * 'applications' is a literal segment declared before ':id' for the same
   * reason as 'risk' above.
   */
  @Get('applications')
  async applications(@Req() req: any) {
    const u = req.user as AuthenticatedUser;
    return this.svc.applications(u.role);
  }

  /**
   * GET /vendors/:id/audit — the vendor's immutable change history (rule 5).
   *
   * Declared BEFORE `@Get(':id')` for the same route-ordering reason as
   * 'risk' and 'applications' above: a literal segment declared after a
   * parameterised one is swallowed by it.
   */
  @Get(':id/audit')
  async audit(@Param('id') id: string, @Query('limit') limit: string, @Req() req: any) {
    const u = req.user as AuthenticatedUser;
    return this.gov.auditTrail(id, u.role, Number(limit));
  }

  /**
   * GET /vendors/categories — the ItemGroup library the picker and the
   * "Manage Vendors" list read from.
   *
   * Declared BEFORE `@Get(':id')`. Nest matches in declaration order and ':id'
   * matches ANY single segment, so a literal 'categories' declared after it is
   * swallowed: the request would reach the vendor-detail handler with
   * id='categories' and 404 as a missing vendor rather than as the
   * route-ordering mistake it actually is.
   */
  @Get('categories')
  async categoryLibrary(@Req() req: any) {
    const u = req.user as AuthenticatedUser;
    return this.gov.categoryLibrary(u.role);
  }

  /**
   * GET /vendors/categories/:code — the REVERSE read for "Manage Vendors".
   *
   * Declared before '@id' for the same route-ordering reason as 'risk',
   * 'applications' and 'categories' above.
   */
  @Get('categories/:code')
  async vendorsForCategory(@Param('code') code: string, @Req() req: any) {
    const u = req.user as AuthenticatedUser;
    return this.gov.vendorsForCategory(code, u.role);
  }

  /**
   * POST /vendors/categories/import — bulk-load the mapping from CSV.
   *
   * A literal segment with a fixed depth, so it is declared before '@id' for the
   * same reason as the GET above.
   */
  @Post('categories/import')
  async importCategoryMappings(@Body() body: { csv?: string; mode?: string; skipInvalid?: boolean }, @Req() req: any) {
    const u = req.user as AuthenticatedUser;
    return this.gov.importCategoryMappings(body, u.id, u.role, u.costCenterIds ?? []);
  }

  /**
   * GET /vendors/:id — Vendor Detail (blueprint 9.4).
   */
  @Get(':id')
  async detail(@Param('id') id: string, @Req() req: any) {
    const u = req.user as AuthenticatedUser;
    return this.svc.detail(id, u.role);
  }

  // ── Rule 5: the only vendor status a local portal user may control ──────

  /** POST /vendors/:id/hold */
  @Post(':id/hold')
  async hold(@Param('id') id: string, @Body() body: { reason?: string }, @Req() req: any) {
    const u = req.user as AuthenticatedUser;
    return this.gov.hold(id, u.id, u.role, u.costCenterIds ?? [], body?.reason);
  }

  /** POST /vendors/:id/unhold */
  @Post(':id/unhold')
  async unhold(@Param('id') id: string, @Body() body: { reason?: string }, @Req() req: any) {
    const u = req.user as AuthenticatedUser;
    return this.gov.unhold(id, u.id, u.role, u.costCenterIds ?? [], body?.reason);
  }

  /** PATCH /vendors/:id/categories — rule 3, managed in-portal. */
  @Post(':id/categories')
  async categories(
    @Param('id') id: string,
    @Body() body: { categories?: string[]; reason?: string },
    @Req() req: any,
  ) {
    const u = req.user as AuthenticatedUser;
    return this.gov.setCategories(
      id, u.id, u.role, u.costCenterIds ?? [], body?.categories ?? [], body?.reason,
    );
  }

  // ── Vendor <-> item group mapping ───────────────────────────────────────────
  // The two-way relationship lives in core.vendor_categories (migration 048).
  // Disabling a link and unlinking it are deliberately DIFFERENT operations:
  // disabling stops routing and keeps the relationship readable, unlinking
  // forgets it. Both are audited.

  /** GET /vendors/:id/categories — forward read, active AND inactive links. */
  @Get(':id/categories')
  async vendorCategories(@Param('id') id: string, @Req() req: any) {
    const u = req.user as AuthenticatedUser;
    return this.gov.vendorCategories(id, u.role);
  }

  /** PATCH — enable or disable one mapping. */
  @Patch(':id/categories/:code')
  async setCategoryStatus(
    @Param('id') id: string,
    @Param('code') code: string,
    @Body() body: { isActive?: boolean; reason?: string },
    @Req() req: any,
  ) {
    const u = req.user as AuthenticatedUser;
    return this.gov.setCategoryStatus(
      id, code, body?.isActive !== false, u.id, u.role, u.costCenterIds ?? [], body?.reason,
    );
  }

  /** DELETE — remove the link entirely, keeping only the audit record. */
  @Delete(':id/categories/:code')
  async unlinkCategory(
    @Param('id') id: string,
    @Param('code') code: string,
    @Body() body: { reason?: string },
    @Req() req: any,
  ) {
    const u = req.user as AuthenticatedUser;
    return this.gov.unlinkCategory(id, code, u.id, u.role, u.costCenterIds ?? [], body?.reason);
  }
}
