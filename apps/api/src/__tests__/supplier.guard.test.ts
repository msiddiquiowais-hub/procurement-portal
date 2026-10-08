// SupplierGuard test suite.
//
// The guard is the whole scoping story for Wave 4, and it is the cheapest thing
// in the module to test — no database, no HTTP, no Nest container. These
// assertions are about WHO may reach the supplier surfaces and, just as
// importantly, about what happens when a session is a supplier with no vendor.
//
// Run with: node --test dist/__tests__/supplier.guard.test.js (after build)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ForbiddenException } from '@nestjs/common';
import { ExecutionContext } from '@nestjs/common';

import { SupplierGuard } from '../supplier/supplier.guard';
import type { AuthenticatedUser } from '../auth/auth.service';

const V00081 = '44444444-4444-4444-4444-444444444401';

function user(over: Partial<AuthenticatedUser> = {}): AuthenticatedUser {
  return {
    id: '33333333-3333-3333-3333-33333333330e',
    email: 'vendor1@example.com',
    displayName: 'Acme Supplies',
    role: 'vendor',
    costCenterIds: [],
    vendorId: V00081,
    ...over,
  };
}

/** A minimal ExecutionContext: the guard only reads switchToHttp().getRequest(). */
function ctxFor(u: AuthenticatedUser | undefined): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user: u }) }),
  } as unknown as ExecutionContext;
}

const guard = new SupplierGuard();

test('W1 a supplier with a vendor record is admitted', () => {
  assert.equal(guard.canActivate(ctxFor(user())), true);
});

test('W2 a missing session is refused WITHOUT throwing', () => {
  // JwtAuthGuard has already run and set nothing, so the correct answer is
  // "no" — Nest turns a false return into 403. Throwing here would turn an
  // unauthenticated call into a different error than every other endpoint
  // produces.
  assert.equal(guard.canActivate(ctxFor(undefined)), false);
});

test('W3 every non-supplier role is refused', () => {
  for (const role of [
    'requester', 'procurement', 'cs', 'cfo', 'finance', 'hod', 'mc',
    'admin', 'store_incharge', 'hr', 'audit',
  ]) {
    assert.throws(
      () => guard.canActivate(ctxFor(user({ role }))),
      (e: unknown) => e instanceof ForbiddenException,
      `${role} must not reach the supplier surfaces`,
    );
  }
});

test('W4 admin is refused even though ROLE_ALIASES gives it most other powers', () => {
  // Deliberate. A super-role that can read and write another company's
  // quotations defeats the vendor scoping migration 028 exists to guarantee.
  assert.throws(() => guard.canActivate(ctxFor(user({ role: 'admin' }))), ForbiddenException);
});

test('W5 a supplier with NO vendor record is refused loudly, never unscoped', () => {
  // Unreachable while ck_users_vendor_role holds (role='vendor' => vendor_id
  // NOT NULL), so this is the broken-link case. Serving an unscoped inbox would
  // be every vendor's RFQs, which is far worse than a clear error.
  const u = user({ vendorId: null });
  assert.throws(
    () => guard.canActivate(ctxFor(u)),
    (e: unknown) =>
      e instanceof ForbiddenException && /not linked to a vendor/i.test((e as Error).message),
  );
});

test('W6 the refusal message names the problem instead of saying "forbidden"', () => {
  let caught: unknown;
  try {
    guard.canActivate(ctxFor(user({ role: 'admin' })));
  } catch (e) { caught = e; }
  assert.ok(caught instanceof ForbiddenException);
  assert.match((caught as Error).message, /supplier accounts only/i);
});

test('W7 the guard never mutates the session', () => {
  // It reads req.user and nothing else. A guard that rewrote the session would
  // make the scoping depend on guard ORDER, which is exactly the coupling this
  // design is trying to remove.
  const u = user();
  const before = JSON.stringify(u);
  guard.canActivate(ctxFor(u));
  assert.equal(JSON.stringify(u), before);
});

test('W8 a vendor role is required — a non-vendor with a vendorId is still refused', () => {
  // vendorId alone is not a pass. A row that somehow carries a vendor_id but
  // is not a supplier login is not a supplier session.
  const u = user({ role: 'requester', vendorId: V00081 });
  assert.throws(() => guard.canActivate(ctxFor(u)), ForbiddenException);
});
