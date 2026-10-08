import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { DispatchService } from './dispatch.service';
import type { AuthenticatedUser } from '../auth/auth.service';

@UseGuards(JwtAuthGuard)
@Controller()
export class DispatchController {
  constructor(private readonly svc: DispatchService) {}

  /**
   * POST /rfq/:id/dispatch — the one-click dispatch.
   *
   * Declared on the bare `rfq` prefix rather than inside RfqController so the
   * dispatch concern (outbox, token minting, transport) lives in one module and
   * can be read without wading through the RFQ lifecycle.
   */
  @Post('rfq/:id/dispatch')
  async dispatch(@Param('id') id: string, @Body() body: any, @Req() req: any) {
    const u = req.user as AuthenticatedUser;
    return this.svc.dispatch(id, u.id, u.role, u.costCenterIds ?? [], {
      vendorIds: Array.isArray(body?.vendorIds) ? body.vendorIds : undefined,
      channel: body?.channel === 'manual' ? 'manual' : 'email',
    });
  }

  /** GET /outbox — what has actually been sent, and what is still waiting. */
  @Get('outbox')
  async outbox(@Query('limit') limit: string, @Req() req: any) {
    const u = req.user as AuthenticatedUser;
    return this.svc.outbox(u.role, Number(limit));
  }

  /**
   * GET /admin/vendors-missing-email — F1's dashboard intimation.
   *
   * A literal segment declared before any ':id' route in this controller, and
   * routed under /admin because it is an administrative alert rather than part
   * of the vendor surface.
   */
  @Get('admin/vendors-missing-email')
  async missingEmail(@Req() req: any) {
    const u = req.user as AuthenticatedUser;
    return this.svc.missingEmails(u.role);
  }
}
