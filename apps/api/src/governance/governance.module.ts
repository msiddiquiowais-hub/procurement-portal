import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { GovernanceController } from './governance.controller';
import { GovernanceService } from './governance.service';

/**
 * Wave 3 step 2 — governance. The MC vote, the CFO decision and the pack lock.
 *
 * `imports: [AuthModule]` mirrors SourcingModule: the JwtAuthGuard on the
 * controller needs AuthService, which is not global.
 *
 * GovernanceService is EXPORTED because step 3's D365 module needs to know
 * whether a pack is frozen before it will build a payload — and that question
 * has one answer in this codebase, not two.
 */
@Module({
  imports: [AuthModule],
  controllers: [GovernanceController],
  providers: [GovernanceService],
  exports: [GovernanceService],
})
export class GovernanceModule {}
