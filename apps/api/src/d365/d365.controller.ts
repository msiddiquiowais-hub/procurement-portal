import { Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { D365Service } from './d365.service';

/**
 * Wave 3 step 3 — the D365 push, status and payload.
 *
 * Mounted under `pr/` like RfqIssueController and GovernanceController, because
 * all four surfaces act ON a PR and the flat `d365/:prId` shape used by the old
 * stub had no room for a status or a payload read.
 */
@UseGuards(JwtAuthGuard)
@Controller('pr')
export class D365Controller {
  constructor(private readonly svc: D365Service) {}

  /**
   * The exact payload the push will send. renderD365Push prints this as the
   * screen's own content, so previewing it and sending it must be the same
   * object — hence one builder and one endpoint, not two implementations.
   */
  @Get(':id/d365/payload')
  async payload(@Param('id') id: string, @Req() req: any) {
    const u = req.user;
    return this.svc.payload(id, u.id, u.role, u.costCenterIds);
  }

  /** d365Push() — OData POST to PurchPurchaseOrderHeadersV2. Idempotent. */
  @Post(':id/d365/push')
  async push(@Param('id') id: string, @Req() req: any) {
    const u = req.user;
    return this.svc.push(id, u.id, u.role, u.costCenterIds);
  }

  /** renderD365Status — the six-row event stream and the PO line table. */
  @Get(':id/d365/status')
  async status(@Param('id') id: string, @Req() req: any) {
    const u = req.user;
    return this.svc.status(id, u.id, u.role, u.costCenterIds);
  }

  /**
   * Observe the PO's state and record it. The ONLY thing that advances a D365
   * status — the prototype's setTimeout(2500) is deliberately not ported.
   */
  @Post(':id/d365/sync')
  async sync(@Param('id') id: string, @Req() req: any) {
    const u = req.user;
    return this.svc.sync(id, u.id, u.role, u.costCenterIds);
  }
}
