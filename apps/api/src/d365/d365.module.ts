import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { GovernanceModule } from '../governance/governance.module';
import { D365Controller } from './d365.controller';
import { D365Service } from './d365.service';

/**
 * Wave 3 step 3 — the D365 push.
 *
 * `imports: [GovernanceModule]` because D365Service asks GovernanceService
 * whether a pack is frozen. That is a deliberate dependency rather than a
 * duplicated query: "is this PR pushable?" has one answer in this codebase, and
 * the answer lives with the governance gates that produced the pack.
 */
@Module({
  imports: [AuthModule, GovernanceModule],
  controllers: [D365Controller],
  providers: [D365Service],
  exports: [D365Service],
})
export class D365Module {}
