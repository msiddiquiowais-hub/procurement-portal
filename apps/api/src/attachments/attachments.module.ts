import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AttachmentsController } from './attachments.controller';
import { AttachmentsService } from './attachments.service';
import { AttachmentLimitsService } from './limits.service';
import { StorageAdapter } from './storage.adapter';

@Module({
  imports: [AuthModule],
  controllers: [AttachmentsController],
  providers: [AttachmentsService, AttachmentLimitsService, StorageAdapter],
  exports: [AttachmentsService, AttachmentLimitsService, StorageAdapter],
})
export class AttachmentsModule {}
