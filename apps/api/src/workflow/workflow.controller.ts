// REST surface for the Dynamic Workflow Visual Builder (blueprint Part 7).
//
// Every route here is backed by a real read or write against
// workflow.steps_config / workflow.config. There is no endpoint that returns
// hardcoded data dressed as configuration, which is what made the previous
// "admin" screen a dead control panel.

import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { WorkflowService } from './workflow.service';
import type { AuthenticatedUser } from '../auth/auth.service';
import type { Step } from '@procurement/workflow-engine';

@UseGuards(JwtAuthGuard)
@Controller('workflow')
export class WorkflowController {
  constructor(private readonly svc: WorkflowService) {}

  /**
   * GET /workflow/config — what the Part 7 grid renders.
   *
   * `source` is the honest signal that matters to an admin: 'db' means their
   * configuration is live, 'fallback' means routing is running on canonical
   * defaults because the table could not be read, and their edits would do
   * nothing. The UI surfaces this rather than hiding it.
   */
  @Get('config')
  async getConfig(@Req() req: any) {
    const u = req.user as AuthenticatedUser;
    return this.svc.getBuilderModel(u.role);
  }

  /**
   * GET /workflow/threshold — the management gate value only.
   *
   * Deliberately separate from /workflow/config, which is role-gated. The PR
   * detail screen has to show "Management gate: REQUIRED" and the threshold
   * figure to whoever is looking at the PR — including a plain requester — and
   * widening /workflow/config to everyone would expose the whole routing table
   * (actor roles, per-line rules, thresholds) to roles that must not see it.
   * One number is shown on screen already; the route table is not.
   */
  @Get('threshold')
  async getThreshold() {
    const cfg = await this.svc.getLiveConfig();
    return { managementThreshold: cfg.managementThreshold, source: cfg.source };
  }

  /** GET /workflow/config/raw — the engine-facing shape, for diagnostics. */
  @Get('config/raw')
  async getRaw(@Req() req: any) {
    const u = req.user as AuthenticatedUser;
    this.svc.assertCanRead(u.role);
    return this.svc.getLiveConfig();
  }

  /**
   * PUT /workflow/config — persist the whole table.
   *
   * Saved as one unit: the grid autosaves after each edit, but a reorder and a
   * condition change must not be able to land as a half-applied mix. The service
   * validates before writing, so a rejected payload leaves the live table
   * untouched.
   */
  @Put('config')
  async saveConfig(@Body() body: { steps?: Step[]; managementThreshold?: number }, @Req() req: any) {
    const u = req.user as AuthenticatedUser;
    return this.svc.saveConfig(
      Array.isArray(body?.steps) ? body.steps : [],
      Number(body?.managementThreshold),
      u.role,
      u.id,
    );
  }

  /** PUT /workflow/config/threshold — the Part 7 threshold editor. */
  @Put('config/threshold')
  async setThreshold(@Body() body: { managementThreshold?: number }, @Req() req: any) {
    const u = req.user as AuthenticatedUser;
    return this.svc.setThreshold(Number(body?.managementThreshold), u.role, u.id);
  }

  /** POST /workflow/config/reset — "Reset to defaults". */
  @Post('config/reset')
  async reset(@Req() req: any) {
    const u = req.user as AuthenticatedUser;
    return this.svc.resetToDefaults(u.role, u.id);
  }

  /** DELETE /workflow/config/steps/:key — the grid's per-row delete. */
  @Delete('config/steps/:key')
  async deleteStep(@Param('key') key: string, @Req() req: any) {
    const u = req.user as AuthenticatedUser;
    return this.svc.deleteStep(key, u.role);
  }
}
