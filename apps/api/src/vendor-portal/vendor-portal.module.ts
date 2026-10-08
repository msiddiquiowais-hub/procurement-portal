import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SourcingModule } from '../sourcing/sourcing.module';
import { VendorPortalController } from './vendor-portal.controller';
import { VendorPortalService } from './vendor-portal.service';

@Module({
  // SourcingModule for QuotationService, so a token submission goes through the
  // SAME append-and-version path the logged-in portal uses. A second, looser
  // write path for token users would be exactly the kind of drift rule 5 exists
  // to prevent.
  imports: [AuthModule, SourcingModule],
  controllers: [VendorPortalController],
  providers: [VendorPortalService],
})
export class VendorPortalModule {}
