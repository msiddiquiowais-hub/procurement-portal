import { Module } from '@nestjs/common';
import { DbModule } from '../db/db.module';
import { AuthModule } from '../auth/auth.module';
import { D365SyncController } from './d365-sync.controller';
import { D365SyncService } from './d365-sync.service';

/**
 * Wave 5 Track H — D365 master-data sync.
 *
 * `imports: [DbModule, AuthModule]`.
 *
 * AuthModule is required, not optional. `@UseGuards(JwtAuthGuard)` on a
 * controller makes Nest instantiate that guard IN THIS MODULE'S CONTEXT, and
 * JwtAuthGuard takes AuthService in its constructor. AuthModule is not marked
 * `@Global()`, so omitting the import fails at boot with
 * "Nest can't resolve dependencies of the JwtAuthGuard (?)" — which reads like
 * a DI mystery and is really just a missing import. D365Module does the same.
 *
 * D365Module is deliberately NOT imported: the sync talks to F&O through the
 * `@procurement/d365-client` transport directly, so it depends on the client,
 * not on the PR-scoped push service — and a master-data sync has no business
 * pulling in governance state.
 */
@Module({
  imports: [DbModule, AuthModule],
  controllers: [D365SyncController],
  providers: [D365SyncService],
  exports: [D365SyncService],
})
export class D365SyncModule {}
