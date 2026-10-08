import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { VendorsController } from './vendors.controller';
import { VendorsService } from './vendors.service';
import { VendorGovernanceService } from './vendor-governance.service';

@Module({
  imports: [AuthModule],
  controllers: [VendorsController],
  providers: [VendorsService, VendorGovernanceService],
})
export class VendorsModule {}
