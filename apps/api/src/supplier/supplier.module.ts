import { Module } from '@nestjs/common';
import { SupplierController } from './supplier.controller';
import { SupplierService } from './supplier.service';
import { SupplierGuard } from './supplier.guard';
import { SourcingModule } from '../sourcing/sourcing.module';
import { AuthModule } from '../auth/auth.module';

/**
 * Imports SourcingModule because SupplierService delegates every quote write to
 * QuotationService.submitAsVendor(). The version-chain rules live there, once
 * (R4) — the supplier module supplies the GATE, not a second implementation of
 * the rules.
 *
 * AuthModule is imported for the same reason SourcingModule imports it: the
 * JwtAuthGuard on the controller needs AuthService, which is not global. A
 * guard that cannot resolve its dependency is an opaque DI boot failure.
 */
@Module({
  imports: [SourcingModule, AuthModule],
  controllers: [SupplierController],
  providers: [SupplierService, SupplierGuard],
  exports: [SupplierService, SupplierGuard],
})
export class SupplierModule {}
