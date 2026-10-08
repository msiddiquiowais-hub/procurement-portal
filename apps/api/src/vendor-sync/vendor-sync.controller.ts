import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import type { AuthenticatedUser } from '../auth/auth.service';
import { VendorSyncService } from './vendor-sync.service';

/**
 * Wave 5 Track H — vendor master sync to D365 F&O (outbound).
 *
 * Absolute paths on a bare `@Controller()`, for the same reason as
 * D365SyncController: `D365Controller` is declared on `@Controller('pr')`, so a
 * `d365/...` route declared under that prefix would be swallowed by it. These
 * routes are about vendor master, not about a PR.
 */
@UseGuards(JwtAuthGuard)
@Controller()
export class VendorSyncController {
  constructor(private readonly svc: VendorSyncService) {}

  /**
   * What is pending, and why. Read-only — no network call, no writes — so an
   * operator can see whether there is anything to push without pushing it.
   */
  @Get('d365/sync/vendors/preview')
  async preview(@Req() req: any) {
    const u = req.user as AuthenticatedUser;
    return this.svc.preview(u.id, u.role, u.costCenterIds ?? []);
  }

  /**
   * Push vendor master to F&O: onboarding status, hold controls and category
   * mappings, plus the tax and payment fields F&O needs to raise a PO.
   */
  @Post('d365/sync/vendors')
  async push(@Req() req: any, @Body() body: any) {
    const u = req.user as AuthenticatedUser;
    return this.svc.push(u.id, u.role, u.costCenterIds ?? [], body ?? {});
  }
}
