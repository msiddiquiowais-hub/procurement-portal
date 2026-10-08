// Role gating + screen registry — parity with the prototype's roleAllowed()
// and sidebar markup. Run: node --test dist/__tests__/roles.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ROLE_ALIASES,
  ROLE_LABELS,
  ROLE_SELECT_OPTIONS,
  SCREENS,
  NAV_SECTIONS,
  roleAllowed,
  rolesFor,
  navFor,
  screenById,
  allowedScreenIds,
} from '../index';

// 34, and the count is a COMPLETENESS check, not a cap.
//
// It was 33 (the prototype's own screens) until `admin-categories` was added
// alongside the existing Wave 5 library screens — admin-matrix,
// admin-dimensions and admin-uom are all additions too, and all three are real
// API-backed screens rather than control panels. The assertion exists to catch a
// screen that was added to the sidebar and never registered (or registered twice,
// which R2 covers), so it has to move when a screen is deliberately added.
// Raising it without adding a screen would be the failure it is meant to catch.
test('R1 the registry has all 34 registered screens', () => {
  assert.equal(SCREENS.length, 34);
});

test('R2 screen ids are unique', () => {
  const ids = SCREENS.map(s => s.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('R3 every screen has a role CSV and a label', () => {
  for (const s of SCREENS) {
    assert.ok(s.roles, `${s.id} has no roles`);
    assert.ok(s.label, `${s.id} has no label`);
    assert.ok(s.icon, `${s.id} has no icon`);
  }
});

test('R4 every screen declares a known nav section', () => {
  for (const s of SCREENS) {
    if (s.section) assert.ok(NAV_SECTIONS.includes(s.section), `${s.id} -> ${s.section}`);
  }
});

test('R5 only the two public surfaces are full-screen', () => {
  const fs = SCREENS.filter(s => s.fullScreen).map(s => s.id).sort();
  assert.deepEqual(fs, ['login', 'vendor-onboard-public']);
});

test('R6 light-pr-detail is reachable but not in the sidebar', () => {
  const d = screenById('light-pr-detail')!;
  assert.ok(d, 'light-pr-detail must exist');
  assert.equal(d.hiddenInNav, true);
  assert.equal(d.section, undefined);
});

test('R7 exact role CSVs match the prototype data-roles', () => {
  const expected: Record<string, string> = {
    dashboard: 'all',
    kpi: 'all',
    'pr-detail': 'all',
    'pr-review': 'hod',
    'rfq-detail': 'procurement,cs,hod,vendor,mc,cfo',
    cs: 'procurement,cs,hod,mc,cfo',
    'mc-vote': 'mc',
    'cfo-approve': 'cfo',
    pack: 'cs,procurement,cfo',
    'd365-push': 'cs,procurement',
    'd365-status': 'all',
    'my-prs': 'requester,hod,procurement,cs,mc,cfo',
    'pr-create': 'requester',
    'light-pr-new': 'requester,hod,procurement,finance,cfo,management',
    'light-pr-list': 'requester,hod,procurement,finance,cfo,management',
    approvals: 'hod,mc,cfo,cs',
    'rfq-list': 'procurement,cs',
    'supplier-rfq': 'vendor',
    'supplier-quote': 'vendor',
    vendors: 'procurement,hod,cs',
    'vendor-detail': 'procurement,hod,cs',
    'vendor-risk': 'procurement,hod,cs',
    audit: 'procurement,cs,cfo,hod',
    'audit-report': 'all',
    'admin-matrix': 'cs,procurement,cfo',
    'admin-workflow': 'cs,procurement',
    'admin-dimensions': 'cs,procurement,cfo',
    'admin-uom': 'cs,procurement,cfo',
    settings: 'all',
    acknowledge: 'all',
  };
  for (const [id, roles] of Object.entries(expected)) {
    assert.equal(screenById(id)!.roles, roles, `${id} role CSV drifted from the prototype`);
  }
});

// ─── roleAllowed ──────────────────────────────────────────────────────────

test('R8 "all" admits every role', () => {
  for (const r of ['admin', 'requester', 'hod', 'vendor', 'mc']) {
    assert.equal(roleAllowed(r, 'all'), true, r);
  }
});

test('R9 direct membership works without aliases', () => {
  assert.equal(roleAllowed('cfo', 'cfo'), true);
  assert.equal(roleAllowed('cfo', 'cs,procurement,cfo'), true);
  assert.equal(roleAllowed('hod', 'cfo'), false);
});

test('R10 admin sees every internal screen through its alias', () => {
  assert.equal(roleAllowed('admin', 'hod'), true);
  assert.equal(roleAllowed('admin', 'cfo'), true);
  assert.equal(roleAllowed('admin', 'mc'), true);
  assert.equal(roleAllowed('admin', 'cs,procurement'), true);
  assert.equal(roleAllowed('admin', 'requester'), false, 'admin is not aliased to requester');
  assert.equal(roleAllowed('admin', 'vendor'), false, 'admin is not aliased to vendor');
});

test('R11 non-alias roles are not widened', () => {
  assert.equal(roleAllowed('requester', 'hod'), false);
  assert.equal(roleAllowed('mc', 'cfo'), false);
  assert.equal(roleAllowed('vendor', 'procurement'), false);
});

test('R12 roleAllowed tolerates whitespace in the CSV', () => {
  assert.equal(roleAllowed('hod', ' cs , hod , cfo '), true);
});

// ─── rolesFor ─────────────────────────────────────────────────────────────

test('R13 rolesFor inverts the alias for a restricted screen', () => {
  const roles = rolesFor('cfo');
  assert.ok(roles.includes('cfo'));
  assert.ok(roles.includes('admin'), 'admin inherits cfo access');
  assert.ok(!roles.includes('vendor'));
});

test('R14 rolesFor on "all" returns every role', () => {
  assert.ok(rolesFor('all').length > 10);
});

// ─── navFor ───────────────────────────────────────────────────────────────

test('R15 requester sees the requester screens and not the gated ones', () => {
  const ids = navFor('requester').flatMap(g => g.items.map(i => i.id));
  assert.ok(ids.includes('pr-create'));
  assert.ok(ids.includes('light-pr-new'));
  assert.ok(ids.includes('my-prs'));
  assert.ok(!ids.includes('admin-workflow'));
  assert.ok(!ids.includes('mc-vote'));
  assert.ok(!ids.includes('cfo-approve'));
  assert.ok(!ids.includes('supplier-rfq'));
});

test('R16 mc sees mc-vote but not cfo-approve or the admin config', () => {
  const ids = navFor('mc').flatMap(g => g.items.map(i => i.id));
  assert.ok(ids.includes('mc-vote'), 'mc-vote is gated to mc');
  assert.ok(!ids.includes('cfo-approve'), 'cfo-approve is gated to cfo only');
  assert.ok(!ids.includes('admin-workflow'), 'admin-workflow is cs,procurement only');
  assert.ok(ids.includes('cs'), 'mc is in the cs role CSV');
});

test('R17 admin sees far more than the 2 screens the old Shell showed', () => {
  const ids = navFor('admin').flatMap(g => g.items.map(i => i.id));
  assert.ok(ids.length >= 28, `admin should see most screens, saw ${ids.length}`);
  assert.ok(ids.includes('admin-workflow'));
  assert.ok(ids.includes('admin-matrix'));
  assert.ok(ids.includes('mc-vote'));
  assert.ok(ids.includes('cfo-approve'));
  assert.ok(ids.includes('audit'));
  assert.ok(!ids.includes('supplier-rfq'), 'admin is not a vendor');
});

test('R18 navFor never emits an empty section', () => {
  for (const role of ['requester', 'admin', 'vendor', 'cfo', 'mc', 'hod']) {
    for (const g of navFor(role)) {
      assert.ok(g.items.length > 0, `${role}/${g.section} is empty`);
    }
  }
});

test('R19 navFor omits hidden screens', () => {
  const all = navFor('admin').flatMap(g => g.items.map(i => i.id));
  assert.ok(!all.includes('light-pr-detail'));
});

test('R20 every nav item respects its own role CSV', () => {
  for (const role of ['requester', 'admin', 'cfo', 'vendor']) {
    for (const g of navFor(role)) {
      for (const item of g.items) {
        assert.equal(roleAllowed(role, item.roles), true, `${role} should not see ${item.id}`);
      }
    }
  }
});

// ─── labels / options ─────────────────────────────────────────────────────

test('R21 every role used in a screen CSV has a display label', () => {
  for (const s of SCREENS) {
    if (s.roles === 'all') continue;
    for (const r of s.roles.split(',')) {
      assert.ok(ROLE_LABELS[r.trim()], `no label for role ${r}`);
    }
  }
});

test('R22 the header role pill offers the prototype 11 options', () => {
  assert.equal(ROLE_SELECT_OPTIONS.length, 11);
  assert.equal(ROLE_SELECT_OPTIONS[0].value, 'admin');
});

test('R23 aliases are a subset of the known roles', () => {
  for (const members of Object.values(ROLE_ALIASES)) {
    for (const m of members) {
      assert.ok(typeof m === 'string' && m.length > 0, 'alias member must be a role string');
    }
  }
});

test('R24 allowedScreenIds includes unrestricted screens for every role', () => {
  for (const role of ['requester', 'admin', 'vendor', 'mc']) {
    const ids = allowedScreenIds(role);
    for (const open of ['dashboard', 'kpi', 'settings', 'audit-report', 'acknowledge']) {
      assert.ok(ids.includes(open as never), `${role} should see ${open}`);
    }
  }
});
