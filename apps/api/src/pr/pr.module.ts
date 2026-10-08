import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { WorkflowModule } from '../workflow/workflow.module';
import { PrController } from './pr.controller';
import { PrService } from './pr.service';

@Module({
  // WorkflowModule is required: PrService routes off the live configuration and
  // writes a per-PR snapshot of it.
  imports: [AuthModule, WorkflowModule],
  controllers: [PrController],
  providers: [PrService],
  exports: [PrService],
})
export class PrModule {}
