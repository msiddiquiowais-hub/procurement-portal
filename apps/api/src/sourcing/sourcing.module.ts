import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RfqController, RfqIssueController } from './rfq.controller';
import { RfqService } from './rfq.service';
import { QuotationController } from './quotation.controller';
import { QuotationService } from './quotation.service';
import { CsService } from './cs.service';
import { CsReviewService } from './cs.review.service';
// CsReviewService.confirm() routes the PR through the configured cs_review step,
// the same way PrService does. The workflow module is therefore a real
// dependency here, not a convenience import.
import { WorkflowModule } from '../workflow/workflow.module';

/**
 * Wave 2 — sourcing. Step 1 ships RFQ issue + invitations; step 2 adds
 * quotations with append-only version chains; steps 6-8 add the Comparative
 * Statement and the approved pack.
 *
 * `imports: [AuthModule]` mirrors PrModule: the JwtAuthGuard on the controllers
 * needs AuthService, which is not global.
 */
@Module({
  imports: [AuthModule, WorkflowModule],
  controllers: [RfqController, RfqIssueController, QuotationController],
  providers: [RfqService, QuotationService, CsService, CsReviewService],
  exports: [RfqService, QuotationService, CsService, CsReviewService],
})
export class SourcingModule {}
