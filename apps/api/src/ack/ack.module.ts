import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AckController } from './ack.controller';
import { AckService } from './ack.service';

@Module({
  // JwtAuthGuard injects AuthService, so AckModule must import AuthModule.
  imports: [AuthModule],
  controllers: [AckController],
  providers: [AckService],
  exports: [AckService],
})
export class AckModule {}
