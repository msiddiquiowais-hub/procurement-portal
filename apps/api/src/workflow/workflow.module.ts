import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DbModule } from '../db/db.module';
import { WorkflowController } from './workflow.controller';
import { WorkflowRepository } from './workflow.repository';
import { WorkflowService } from './workflow.service';

@Module({
  imports: [AuthModule, DbModule],
  controllers: [WorkflowController],
  providers: [WorkflowService, WorkflowRepository],
  // Exported so PrModule can route PRs off the live configuration.
  exports: [WorkflowService, WorkflowRepository],
})
export class WorkflowModule {}
