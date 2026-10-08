import { Body, Controller, Get, Module, Param, Post, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import type { AuthenticatedUser } from '../auth/auth.service';
import { PoService } from './po.service';
import { DbModule } from '../db/db.module';
import { AuthModule } from '../auth/auth.module';

/**
 * WAVE 5 TRACK H — Purchase orders.
 *
 * Declared on its own `@Controller()` with absolute paths so a future
 * `@Controller('pr')` cannot swallow `/po/:id/issue` — the route-ordering
 * mistake the codebase has already had to document twice for /vendors.
 */
@UseGuards(JwtAuthGuard)
@Controller()
export class PoController {
  constructor(private readonly svc: PoService) {}

  /** POST /pr/:id/po — generate the orders for an approved package. */
  @Post('pr/:id/po')
  async generate(
    @Param('id') id: string,
    @Body() body: { mode?: 'AUTO' | 'SINGLE' | 'PER_LINE'; reason?: string },
    @Req() req: any,
  ) {
    const u = req.user as AuthenticatedUser;
    return this.svc.generate(id, u.id, u.role, u.costCenterIds ?? [], body ?? {});
  }

  /** GET /pr/:id/po — the orders, their lines, and the line-coverage report. */
  @Get('pr/:id/po')
  async forPr(@Param('id') id: string, @Req() req: any) {
    const u = req.user as AuthenticatedUser;
    return this.svc.forPr(id, u.id, u.role, u.costCenterIds ?? []);
  }

  /** POST /po/:id/issue — the final managerial approval gate. */
  @Post('po/:id/issue')
  async issue(@Param('id') id: string, @Req() req: any) {
    const u = req.user as AuthenticatedUser;
    return this.svc.issue(id, u.id, u.role, u.costCenterIds ?? []);
  }

  /** POST /po/:id/push — send one issued order to D365 (the split-aware path). */
  @Post('po/:id/push')
  async push(@Param('id') id: string, @Req() req: any) {
    const u = req.user as AuthenticatedUser;
    return this.svc.push(id, u.id, u.role, u.costCenterIds ?? []);
  }
}

@Module({
  // AuthModule is REQUIRED: `@UseGuards(JwtAuthGuard)` makes Nest build that
  // guard in this module's context, and it takes AuthService. AuthModule is not
  // `@Global()`, so without the import the app fails to boot with "Nest can't
  // resolve dependencies of the JwtAuthGuard (?)".
  imports: [DbModule, AuthModule],
  controllers: [PoController],
  providers: [PoService],
  exports: [PoService],
})
export class PoModule {}
