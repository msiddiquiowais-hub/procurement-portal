import { CanActivate, ExecutionContext, Injectable, ForbiddenException } from '@nestjs/common';
import { canUseSupplierSurfaces } from '@procurement/workflow-engine';
import type { AuthenticatedUser } from '../auth/auth.service';

/**
 * The Wave 4 supplier gate. Two conditions, both required:
 *
 *   1. the session's role is exactly 'vendor'
 *   2. core.users.vendor_id is set (migration 028)
 *
 * Condition 2 is what actually SCOPES the session. Condition 1 is what stops a
 * back-office user from being talked into the endpoints at all.
 *
 * `admin` is deliberately NOT admitted, even though ROLE_ALIASES gives it most
 * other back-office powers. A super-role able to reach the supplier surfaces
 * would be a super-role able to read and write another company's quotations,
 * which defeats the vendor scoping the whole of Wave 4 exists to guarantee.
 * Asserted by canUseSupplierSurfaces' own tests, and re-asserted here so the
 * decision is visible at the point it bites.
 *
 * Runs AFTER JwtAuthGuard, which is what populates req.user. Composing them as
 * @UseGuards(JwtAuthGuard, SupplierGuard) guarantees the order.
 */
@Injectable()
export class SupplierGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest();
    const user: AuthenticatedUser | undefined = req.user;

    if (!user) {
      // JwtAuthGuard already refused; nothing to add.
      return false;
    }
    if (!canUseSupplierSurfaces(user.role)) {
      throw new ForbiddenException('The supplier portal is for supplier accounts only.');
    }
    if (!user.vendorId) {
      // Unreachable for a real supplier: ck_users_vendor_role makes vendor_id
      // NOT NULL whenever role = 'vendor'. A vendor login with no vendor is a
      // broken link, and silently serving an unscoped inbox would be far worse
      // than a clear refusal — an unscoped inbox is every vendor's RFQs.
      throw new ForbiddenException(
        'This supplier account is not linked to a vendor record. Ask an administrator to link it.',
      );
    }
    return true;
  }
}
