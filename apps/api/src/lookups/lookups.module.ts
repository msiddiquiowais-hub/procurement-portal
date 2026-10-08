import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { LookupsController } from './lookups.controller';

@Module({
  imports: [AuthModule],
  controllers: [LookupsController],
})
export class LookupsModule {}
