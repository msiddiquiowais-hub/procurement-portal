import { Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import type { AuthenticatedUser } from '../auth/auth.service';
import { D365SyncService } from './d365-sync.service';

/**
 * Wave 5 Track H — D365 master-data sync.
 *
 * ABSOLUTE paths on a bare `@Controller()`, deliberately. `D365Controller` is
 * declared on `@Controller('pr')`, and a second `d365/...` route under that
 * prefix would be swallowed by it — the route-ordering mistake this codebase
 * has already had to document for /vendors and again for /po.
 *
 * These routes are NOT under `pr/`, because they are not about a PR: they
 * reconcile the whole ERP master data against the local cache.
 */
@UseGuards(JwtAuthGuard)
@Controller()
export class D365SyncController {
  constructor(private readonly svc: D365SyncService) {}

  /** Pull OMOperatingUnits into core.d365_operating_units. */
  @Post('d365/sync/operating-units')
  async operatingUnits(@Req() req: any) {
    const u = req.user as AuthenticatedUser;
    return this.svc.syncOperatingUnits(u.id, u.role, u.costCenterIds ?? []);
  }

  /** Pull HcmWorkers into core.d365_workers. */
  @Post('d365/sync/workers')
  async workers(@Req() req: any) {
    const u = req.user as AuthenticatedUser;
    return this.svc.syncWorkers(u.id, u.role, u.costCenterIds ?? []);
  }

  /** Pull FinancialDimensionValues into core.d365_financial_dimension_values. */
  @Post('d365/sync/dimensions')
  async dimensions(@Req() req: any) {
    const u = req.user as AuthenticatedUser;
    return this.svc.syncDimensionValues(u.id, u.role, u.costCenterIds ?? []);
  }

  /**
   * Row counts, last sync per cache table, and the D365 mode. Read-only, and
   * it answers in stub mode too — which is exactly when an operator needs to
   * know that the caches are as empty as they look.
   */
  @Get('d365/sync/status')
  async status(@Req() req: any) {
    const u = req.user as AuthenticatedUser;
    return this.svc.status(u.id, u.role, u.costCenterIds ?? []);
  }
}
