import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RfqController, RfqIssueController } from './rfq.controller';
import { RfqService } from './rfq.service';
import { QuotationController } from './quotation.controller';
import { QuotationService } from './quotation.service';
import { CsService } from './cs.service';

/**
 * Wave 2 — sourcing. Step 1 ships RFQ issue + invitations; step 2 adds
 * quotations with append-only version chains; steps 6-8 add the Comparative
 * Statement and the approved pack.
 *
 * `imports: [AuthModule]` mirrors PrModule: the JwtAuthGuard on the controllers
 * needs AuthService, which is not global.
 */
@Module({
  imports: [AuthModule],
  controllers: [RfqController, RfqIssueController, QuotationController],
  providers: [RfqService, QuotationService, CsService],
  exports: [RfqService, QuotationService, CsService],
})
export class SourcingModule {}
