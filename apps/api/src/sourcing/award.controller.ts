import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { AwardService } from './award.service';
import type { AuthenticatedUser } from '../auth/auth.service';

@UseGuards(JwtAuthGuard)
@Controller()
export class AwardController {
  constructor(private readonly svc: AwardService) {}

  /** GET /cs/:id/matrix — the side-by-side comparative matrix. */
  @Get('cs/:id/matrix')
  async matrix(@Param('id') id: string, @Req() req: any) {
    const u = req.user as AuthenticatedUser;
    return this.svc.matrix(id, u.role);
  }

  /**
   * POST /cs/:id/award — award or re-award ONE line.
   *
   * Declared as :id/award so the literal segment cannot be swallowed by a
   * parameterised route declared after it.
   */
  @Post('cs/:id/award')
  async award(@Param('id') id: string, @Body() body: any, @Req() req: any) {
    const u = req.user as AuthenticatedUser;
    return this.svc.awardLine(
      id, Number(body?.lineNo), String(body?.vendorId ?? ''),
      Number(body?.qty), String(body?.justification ?? ''),
      u.id, u.role, u.costCenterIds ?? [],
    );
  }

  /** POST /cs/:id/pdf — compile the statement and its winners to the VPS disk. */
  @Post('cs/:id/pdf')
  async pdf(@Param('id') id: string, @Req() req: any) {
    const u = req.user as AuthenticatedUser;
    return this.svc.compilePdf(id, u.id, u.role, u.costCenterIds ?? []);
  }

  /** POST /rfq/:id/negotiate — record a rate agreed by phone or in person. */
  @Post('rfq/:id/negotiate')
  async negotiate(@Param('id') id: string, @Body() body: any, @Req() req: any) {
    const u = req.user as AuthenticatedUser;
    return this.svc.negotiate({
      rfqId: id,
      vendorId: String(body?.vendorId ?? ''),
      userId: u.id,
      role: u.role,
      costCenterIds: u.costCenterIds ?? [],
      justification: String(body?.justification ?? ''),
      source: ['phone', 'email', 'walk_in'].includes(body?.source) ? body.source : 'phone',
      lines: Array.isArray(body?.lines) ? body.lines : [],
      leadTimeDays: body?.leadTimeDays !== undefined ? Number(body.leadTimeDays) : undefined,
      warrantyMonths: body?.warrantyMonths !== undefined ? Number(body.warrantyMonths) : undefined,
      paymentTerms: body?.paymentTerms,
    });
  }

  /** GET /rfq/:id/negotiations — every offline agreement on this RFQ. */
  @Get('rfq/:id/negotiations')
  async negotiations(@Param('id') id: string, @Req() req: any) {
    const u = req.user as AuthenticatedUser;
    return this.svc.negotiations(id, u.role);
  }
}
