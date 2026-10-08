import { Module } from '@nestjs/common';
import { DbModule } from '../db/db.module';
import { AuthModule } from '../auth/auth.module';
import { VendorSyncController } from './vendor-sync.controller';
import { VendorSyncService } from './vendor-sync.service';

/**
 * Wave 5 Track H — vendor master sync to D365 F&O.
 *
 * AuthModule is required, not optional: `@UseGuards(JwtAuthGuard)` makes Nest
 * instantiate the guard in THIS module's context, and JwtAuthGuard takes
 * AuthService in its constructor. AuthModule is not `@Global()`, so omitting
 * this import fails at boot with "Nest can't resolve dependencies of the
 * JwtAuthGuard (?)".
 *
 * D365SyncModule is deliberately NOT imported. Both talk to F&O through the
 * `@procurement/d365-client` transport directly, so neither needs the other;
 * coupling them would drag the inbound master-data cache into a feature that
 * only writes outward.
 */
@Module({
  imports: [DbModule, AuthModule],
  controllers: [VendorSyncController],
  providers: [VendorSyncService],
  exports: [VendorSyncService],
})
export class VendorSyncModule {}
