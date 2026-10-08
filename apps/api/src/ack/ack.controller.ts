import {
  Body, Controller, Get, Ip, Headers, Param, Post, Req, UseGuards,
} from '@nestjs/common';
import {
  IsArray, IsEmail, IsIn, IsOptional, IsString, ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { AckService, ACK_ROLES, type AckRole } from './ack.service';

class TagDto {
  @IsIn(ACK_ROLES as unknown as string[]) taggedRole!: AckRole;
  @IsString() name!: string;
  @IsEmail() email!: string;
  @IsOptional() @IsString() deptCode?: string;
}

class TagManyDto {
  @IsArray() @ValidateNested({ each: true }) @Type(() => TagDto)
  approvers!: TagDto[];
}

@Controller()
export class AckController {
  constructor(private readonly svc: AckService) {}

  // ── authenticated views ─────────────────────────────────────────────────

  @UseGuards(JwtAuthGuard)
  @Get('ack')
  async inbox(@Req() req: any) {
    const u = req.user;
    return this.svc.inbox(u.id, u.role, u.costCenterIds);
  }

  @UseGuards(JwtAuthGuard)
  @Get('pr/:id/acknowledgements')
  async forPr(@Param('id') id: string, @Req() req: any) {
    const u = req.user;
    return this.svc.forPr(id, u.id, u.role, u.costCenterIds);
  }

  @UseGuards(JwtAuthGuard)
  @Post('pr/:id/acknowledgements')
  async tag(@Param('id') id: string, @Body() body: TagManyDto, @Req() req: any) {
    const u = req.user;
    return this.svc.tag(id, u.id, u.role, u.costCenterIds, body.approvers);
  }

  // ── public deep-link endpoints (token is the credential) ────────────────

  /** Peek at who a token belongs to, so the UI can render the banner. */
  @Get('ack/resolve/:token')
  async resolve(@Param('token') token: string) {
    return { approver: await this.svc.resolveToken(token) };
  }

  /**
   * Accept. Intentionally unguarded: the prototype's `#ack=<token>` link is
   * followed from an email client, usually logged out. The unguessable token
   * is the credential and the write is idempotent.
   */
  @Post('ack/:token/accept')
  async accept(
    @Param('token') token: string,
    @Ip() ip: string,
    @Headers('user-agent') userAgent: string,
    @Req() req: any,
  ) {
    return this.svc.accept(token, {
      userId: req.user?.id ?? null,   // null when the link is followed logged out
      ip,
      userAgent,
    });
  }
}
