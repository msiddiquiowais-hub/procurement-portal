import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AwardController } from './award.controller';
import { AwardService } from './award.service';

@Module({
  imports: [AuthModule],
  controllers: [AwardController],
  providers: [AwardService],
})
export class AwardModule {}
