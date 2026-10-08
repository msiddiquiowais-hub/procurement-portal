import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { IsBoolean, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { GovernanceService } from './governance.service';

/**
 * Wave 3 — governance. Split from the sourcing controller so the `@Controller('pr')`
 * prefix does not collide with PrController's routes, exactly as RfqIssueController
 * is split from RfqController.
 *
 * Every rule — who may vote, when voting opens, what 5/5 means — lives in the
 * service. These DTOs exist to reject malformed bodies at the edge, not to
 * decide anything.
 */

class McVoteDto {
  /**
   * The prototype's mcVote() takes 'approve' or 'reject' and nothing else
   * (lines 7221-7246). The schema's approval_votes CHECK also permits 'return'
   * and 'abstain'; they are deliberately NOT offered here, because the prototype
   * has no UI for them and an endpoint that accepts a value no screen can send
   * is an untested path.
   */
  @IsIn(['approve', 'reject']) decision!: 'approve' | 'reject';
  @IsOptional() @IsString() @MaxLength(2000) reason?: string;
}

class CfoDecideDto {
  @IsBoolean() approve!: boolean;
  @IsOptional() @IsString() @MaxLength(2000) reason?: string;
}

@UseGuards(JwtAuthGuard)
@Controller('pr')
export class GovernanceController {
  constructor(private readonly svc: GovernanceService) {}

  /** renderMCVote — the whole screen in one call. */
  @Get(':id/mc')
  async mc(@Param('id') id: string, @Req() req: any) {
    const u = req.user;
    return this.svc.mc(id, u.id, u.role, u.costCenterIds);
  }

  /** mcVote() — one member's decision for the current round. */
  @Post(':id/mc/vote')
  async mcVote(@Param('id') id: string, @Body() body: McVoteDto, @Req() req: any) {
    const u = req.user;
    return this.svc.mcVote(id, u.id, u.role, u.costCenterIds, body);
  }

  /**
   * mcAutoComplete() — the prototype's demo helper, gated on DEMO_HELPERS=1.
   * It writes real approval rows for the real panel, not synthetic ones.
   */
  @Post(':id/mc/auto-complete')
  async mcAutoComplete(@Param('id') id: string, @Req() req: any) {
    const u = req.user;
    return this.svc.mcAutoComplete(id, u.id, u.role, u.costCenterIds);
  }

  /** renderCFO — the seven-row pack summary plus the decision gate. */
  @Get(':id/cfo')
  async cfo(@Param('id') id: string, @Req() req: any) {
    const u = req.user;
    return this.svc.cfo(id, u.id, u.role, u.costCenterIds);
  }

  /** cfoDecide() — approve, or send back to the MC gate. */
  @Post(':id/cfo/decide')
  async cfoDecide(@Param('id') id: string, @Body() body: CfoDecideDto, @Req() req: any) {
    const u = req.user;
    return this.svc.cfoDecide(id, u.id, u.role, u.costCenterIds, body);
  }

  /** renderPack — documents, hashes and the lock gate. */
  @Get(':id/pack')
  async pack(@Param('id') id: string, @Req() req: any) {
    const u = req.user;
    return this.svc.pack(id, u.id, u.role, u.costCenterIds);
  }

  /** packLock() — freeze the pack. Delegates to the shared lockPack(). */
  @Post(':id/pack/lock')
  async packLock(@Param('id') id: string, @Req() req: any) {
    const u = req.user;
    return this.svc.packLock(id, u.id, u.role, u.costCenterIds);
  }

  /** Is this PR pushable? Shared by the pack and D365 screens. */
  @Get(':id/d365/pushable')
  async pushable(@Param('id') id: string, @Req() req: any) {
    const u = req.user;
    return this.svc.pushable(id, u.role, u.costCenterIds);
  }
}
