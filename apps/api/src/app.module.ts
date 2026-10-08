import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DbModule } from './db/db.module';
import { AuthModule } from './auth/auth.module';
import { PrModule } from './pr/pr.module';
import { VendorsModule } from './vendors/vendors.module';
import { D365Module } from './d365/d365.module';
import { D365SyncModule } from './d365-sync/d365-sync.module';
import { PoModule } from './po/po.module';
import { VendorSyncModule } from './vendor-sync/vendor-sync.module';
import { HealthController } from './health.controller';
import { LookupsModule } from './lookups/lookups.module';
import { AckModule } from './ack/ack.module';
import { SourcingModule } from './sourcing/sourcing.module';
import { GovernanceModule } from './governance/governance.module';
import { SupplierModule } from './supplier/supplier.module';
import { OnboardingModule } from './onboarding/onboarding.module';
import { WorkflowModule } from './workflow/workflow.module';
import { AdminModule } from './admin/admin.module';
import { AttachmentsModule } from './attachments/attachments.module';
import { DispatchModule } from './dispatch/dispatch.module';
import { VendorPortalModule } from './vendor-portal/vendor-portal.module';
import { AwardModule } from './sourcing/award.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    DbModule,
    AuthModule,
    PrModule,
    VendorsModule,
    D365Module,
    D365SyncModule,
    PoModule,
    VendorSyncModule,
    LookupsModule,
    AckModule,
    SourcingModule,
    GovernanceModule,
    SupplierModule,
    OnboardingModule,
    // Must load before PrModule so the PR service can route off live config.
    WorkflowModule,
    // Wave 5 Track B: settings / authority matrix / dimensions / UOM.
    // Imports WorkflowModule because the management threshold written from the
    // settings screen must land in workflow.config, where the engine reads it.
    AdminModule,
    // Wave 5 Track E: the attachment write path. Files go to disk under
    // ATTACHMENT_STORAGE_ROOT; only the path and its metadata reach the database.
    AttachmentsModule,
    // Wave 5 Track F: one-click dispatch (tokenised, time-bound links through a
    // real outbox) and the vendor's own line-scoped portal.
    DispatchModule,
    VendorPortalModule,
    // Wave 5 Track F: comparative statement — split awards, phone negotiation,
    // and the compiled PDF.
    AwardModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
