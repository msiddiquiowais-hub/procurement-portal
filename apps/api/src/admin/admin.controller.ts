// REST surface for the Wave 5 admin screens (blueprint Part 8).
//
// Every route is a real read or write against the Track A tables. Nothing here
// returns configuration the application does not actually honour, which is the
// failure that made the pre-remediation admin screens dead control panels.

import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { AdminService, type AuthorityBand } from './admin.service';
import type { AuthenticatedUser } from '../auth/auth.service';

@UseGuards(JwtAuthGuard)
@Controller('admin')
export class AdminController {
  constructor(private readonly svc: AdminService) {}

  // ─── settings ─────────────────────────────────────────────────────────────

  @Get('settings')
  async getSettings(@Req() req: any) {
    const u = req.user as AuthenticatedUser;
    return this.svc.getSettings(u.role);
  }

  /**
   * PATCH /admin/settings — partial update.
   *
   * `mgmtThresholdCr` in the body is routed to workflow.config, NOT to
   * core.settings, so the screen's threshold and the engine's routing decision
   * can never disagree. See AdminService.patchSettings.
   */
  @Patch('settings')
  async patchSettings(@Body() body: Record<string, unknown>, @Req() req: any) {
    const u = req.user as AuthenticatedUser;
    return this.svc.patchSettings(body ?? {}, u.role, u.id);
  }

  // ─── authority matrix ─────────────────────────────────────────────────────

  @Get('authority-matrix')
  async getAuthorityMatrix(@Req() req: any) {
    const u = req.user as AuthenticatedUser;
    return this.svc.getAuthorityMatrix(u.role);
  }

  /**
   * PUT /admin/authority-matrix — the whole set, or a refusal.
   *
   * Rejected when the submitted bands would overlap or leave a gap, because a
   * partial edge edit is the change that silently strands requests.
   */
  @Put('authority-matrix')
  async putAuthorityMatrix(@Body() body: { bands?: AuthorityBand[] }, @Req() req: any) {
    const u = req.user as AuthenticatedUser;
    return this.svc.putAuthorityMatrix(Array.isArray(body?.bands) ? body.bands : [], u.role, u.id);
  }

  // ─── dimensions ───────────────────────────────────────────────────────────

  @Get('dimensions')
  async getDimensions(@Req() req: any) {
    const u = req.user as AuthenticatedUser;
    return this.svc.getDimensions(u.role);
  }

  @Post('dimensions/:key/values')
  async postValue(@Param('key') key: string, @Body() body: { code: string; name: string }, @Req() req: any) {
    const u = req.user as AuthenticatedUser;
    return this.svc.postDimensionValue(key, body, u.role);
  }

  @Put('dimensions/:key/values')
  async putValue(
    @Param('key') key: string,
    @Body() body: { id?: string; code?: string; name?: string; active?: boolean },
    @Req() req: any,
  ) {
    const u = req.user as AuthenticatedUser;
    return this.svc.putDimensionValue(key, body ?? {}, u.role);
  }

  @Delete('dimensions/:key/values/:id')
  async deleteValue(@Param('key') key: string, @Param('id') id: string, @Req() req: any) {
    const u = req.user as AuthenticatedUser;
    return this.svc.deleteDimensionValue(key, id, u.role);
  }

  // ─── UOM ──────────────────────────────────────────────────────────────────

  @Get('uom')
  async getUoms(@Req() req: any) {
    const u = req.user as AuthenticatedUser;
    return this.svc.getUoms(u.role);
  }

  @Post('uom')
  async postUom(@Body() body: { code: string; name: string }, @Req() req: any) {
    const u = req.user as AuthenticatedUser;
    return this.svc.postUom(body ?? ({} as any), u.role);
  }

  @Put('uom/:code')
  async putUom(
    @Param('code') code: string,
    @Body() body: { name?: string; active?: boolean; lightFlow?: boolean; inD365Catalog?: boolean },
    @Req() req: any,
  ) {
    const u = req.user as AuthenticatedUser;
    return this.svc.putUom(code, body ?? {}, u.role);
  }

  /**
   * DELETE /admin/uom/:code
   *
   * The FK from pr_lines is ON DELETE RESTRICT, so a UOM still referenced by a
   * posted line is refused BY THE DATABASE. The reason is translated into a 400
   * naming the unit, because "violates foreign key constraint" tells an admin
   * nothing about which lines are in the way.
   */
  @Delete('uom/:code')
  async deleteUom(@Param('code') code: string, @Req() req: any) {
    const u = req.user as AuthenticatedUser;
    return this.svc.deleteUom(code, u.role);
  }

  // ─── Line categories ──────────────────────────────────────────────────────────
  // Read by the /pr/new dropdown, written only from here or by
  // scripts/import_categories.mjs. See AdminService for why a new row is
  // "selectable" but not yet "routable", and why that is reported rather than
  // glossed over.

  @Get('categories')
  async getCategories(@Req() req: any) {
    const u = req.user as AuthenticatedUser;
    return this.svc.getCategories(u.role);
  }

  @Post('categories')
  async postCategory(
    @Body() body: { code?: string; name?: string; description?: string; active?: boolean },
    @Req() req: any,
  ) {
    const u = req.user as AuthenticatedUser;
    return this.svc.postCategory(body ?? {}, u.role);
  }

  @Put('categories/:code')
  async putCategory(
    @Param('code') code: string,
    @Body() body: { name?: string; description?: string; active?: boolean },
    @Req() req: any,
  ) {
    const u = req.user as AuthenticatedUser;
    return this.svc.putCategory(code, body ?? {}, u.role);
  }

  /**
   * DELETE /admin/categories/:code
   *
   * Refused with the dependent row counts when the category is in use, rather
   * than letting the FK fail with a constraint name.
   */
  @Delete('categories/:code')
  async deleteCategory(@Param('code') code: string, @Req() req: any) {
    const u = req.user as AuthenticatedUser;
    return this.svc.deleteCategory(code, u.role);
  }

  /**
   * POST /admin/categories/import — bulk load from CSV text.
   *
   * The body carries the raw CSV rather than a multipart upload, so the same
   * endpoint serves a pasted block and a file the browser read as text. That
   * also means the working script (scripts/import_categories.mjs) and the screen
   * exercise identical validation, instead of two parsers that drift.
   */
  @Post('categories/import')
  async importCategories(
    @Body() body: { csv?: string; mode?: string; skipInvalid?: boolean },
    @Req() req: any,
  ) {
    const u = req.user as AuthenticatedUser;
    return this.svc.importCategories(body ?? {}, u.role);
  }
}
