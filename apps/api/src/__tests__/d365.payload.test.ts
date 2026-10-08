// Wave 3 step 3 — the D365 purchase-order payload builder.
// Run with: node --test dist/__tests__/d365.payload.test.js (after `npm run build`)
//
// The builder is pure, so the load-bearing properties are proven here rather
// than through a browser:
//
//   1. NOTHING THE PROTOTYPE INVENTS SURVIVES. Its PO-2026-00781, V-000123,
//      pr.amount||2400000 and "a3f9c1..." all become null.
//   2. A fixed-asset field on an opex line would tell D365 to capitalise an
//      expense, so those keys exist only on capex lines.
//   3. All 9 financial dimensions are emitted, always, in D365 order.
//   4. The bearer acknowledgement token is NOT sent, and NOT rendered.
//   5. The event stream's states are computed from the ladder, not hardcoded.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  D365_FIXED_ASSET_GROUP,
  D365_PURCHASE_ORDER_ENTITY,
  D365_STATUS_LADDER,
  DEFAULT_USEFUL_LIFE_YEARS,
  PURPOSE_LABEL,
  ROLE_LABEL,
  buildPurchaseOrderPayload,
  d365EventStream,
  financialDimensionsJson,
  inventoryProfile,
  mainAccountId,
  roleLabel,
  statusIndex,
  type D365LineInput,
  type D365PayloadInput,
} from '../d365/d365.payload';

function line(over: Partial<D365LineInput> = {}): D365LineInput {
  return {
    line_no: 1,
    sku: 'PKB-LT-001',
    quantity: 4,
    uom: 'EA',
    unit_price: 50_000,
    classification: 'OPEX_CONSUMABLE',
    gl_account: '6320-00 Office Supplies',
    remarks: null,
    financial_dimensions: {
      BusinessUnit: 'PKE', Department: 'IT', CostCenter: 'PKB-LHR-001',
      Location: 'LHR-01', Project: 'PRJ-1', Worker: '', ItemGroup: 'LAPTOP', Customer: '', Vendor: '',
    },
    ...over,
  };
}

function input(over: Partial<D365PayloadInput> = {}): D365PayloadInput {
  return {
    pr_id: 'pr-1',
    pr_number: 'PR-2026-00234',
    po_number: null,
    vendor_code: null,
    expense_split: 'OPEX',
    purpose: null,
    delivery_to: null,
    currency: 'PKR',
    total_amount: 200_000,
    capex_amount: null,
    opex_amount: 200_000,
    routing_key: 'STANDARD',
    acknowledgements: [],
    pack_hash: null,
    lines: [line()],
    ...over,
  };
}

// ─── 1 · nothing the prototype invents survives ────────────────────────────

test('before the push there is no PO number and no vendor account', () => {
  const p = buildPurchaseOrderPayload(input());
  // The prototype hardcodes 'PO-2026-00781' and 'V-000123' here (line 7962-7963).
  assert.equal(p.header.PurchaseOrderNumber, null);
  assert.equal(p.header.VendorAccount, null);
});

test('a real PO number and vendor account are used when they exist', () => {
  const p = buildPurchaseOrderPayload(input({ po_number: 'PO-2026-000123', vendor_code: 'V-000123' }));
  assert.equal(p.header.PurchaseOrderNumber, 'PO-2026-000123');
  assert.equal(p.header.VendorAccount, 'V-000123');
});

test('the total is the real awarded amount, never a 2,400,000 fallback', () => {
  // The prototype writes `pr.amount||2400000` (line 7970).
  const p = buildPurchaseOrderPayload(input({ total_amount: 187_500 }));
  assert.equal(p.header.TotalAmount, 187_500);
  assert.notEqual(p.header.TotalAmount, 2_400_000);
});

test('the pack hash is the REAL frozen hash, or null (D1)', () => {
  // The prototype writes the literal "a3f9c1..." (line 8012).
  assert.equal(buildPurchaseOrderPayload(input()).envelope.PortalPackHash, null);
  const real = 'sha256:' + 'a3'.repeat(32);
  assert.equal(buildPurchaseOrderPayload(input({ pack_hash: real })).envelope.PortalPackHash, real);
});

test('a zero total is a zero, not a fallback', () => {
  assert.equal(buildPurchaseOrderPayload(input({ total_amount: 0 })).header.TotalAmount, 0);
});

// ─── 2 · capex-only fixed-asset fields ─────────────────────────────────────

test('a capex line carries FixedAssetGroup and DepreciationPeriod', () => {
  const p = buildPurchaseOrderPayload(input({
    lines: [line({ classification: 'CAPEX_ASSET', gl_account: '1710-00 IT Equipment' })],
  }));
  const l = p.lines[0];
  assert.equal(l.FixedAssetGroup, D365_FIXED_ASSET_GROUP);
  // 4 years x 12 months — the prototype's own policy default (line 7991).
  assert.equal(l.DepreciationPeriod, DEFAULT_USEFUL_LIFE_YEARS * 12);
});

test('an OPEX line carries NEITHER — capitalising an expense is a real bug', () => {
  const p = buildPurchaseOrderPayload(input());
  const l = p.lines[0];
  assert.equal('FixedAssetGroup' in l, false);
  assert.equal('DepreciationPeriod' in l, false);
  assert.equal(l.ProcurementCategory, 'OPEX');
});

test('an explicit useful life overrides the default', () => {
  const p = buildPurchaseOrderPayload(input({
    lines: [line({ classification: 'CAPEX_INFRA', useful_life_years: 7 })],
  }));
  assert.equal(p.lines[0].DepreciationPeriod, 84);
});

test('every CLASSIFICATIONS value routes to the right category', () => {
  for (const capex of ['CAPEX_ASSET', 'CAPEX_INFRA']) {
    const p = buildPurchaseOrderPayload(input({ lines: [line({ classification: capex })] }));
    assert.equal(p.lines[0].ProcurementCategory, 'CAPEX', capex);
    assert.equal(p.lines[0].InventoryProfile, 'Capitalised→FixedAssetRegister', capex);
  }
  for (const opex of ['OPEX_CONSUMABLE', 'OPEX_SERVICE', 'OPEX_MAINT']) {
    const p = buildPurchaseOrderPayload(input({ lines: [line({ classification: opex })] }));
    assert.equal(p.lines[0].ProcurementCategory, 'OPEX', opex);
  }
});

// ─── 3 · the GL helpers ────────────────────────────────────────────────────

test('mainAccountId takes the account code, not the description', () => {
  // The prototype does glAccount.split(' ')[0] (line 7990).
  assert.equal(mainAccountId('1710-00 IT Equipment'), '1710-00');
  assert.equal(mainAccountId('6320-00 Office Supplies'), '6320-00');
  // A code with no description is returned whole, not mangled.
  assert.equal(mainAccountId('1710-00'), '1710-00');
  assert.equal(mainAccountId(null), null);
  assert.equal(mainAccountId(''), null);
});

test('inventoryProfile names the register for capex and the GL for opex', () => {
  assert.equal(inventoryProfile(line({ classification: 'CAPEX_ASSET' })), 'Capitalised→FixedAssetRegister');
  assert.equal(inventoryProfile(line({ classification: 'OPEX_MAINT' })), 'Expensed→GL6320-00');
  // No GL and no capex: nothing to claim, so nothing is claimed.
  assert.equal(inventoryProfile(line({ classification: 'OPEX_MAINT', gl_account: null })), null);
});

// ─── 4 · all 9 financial dimensions, always ───────────────────────────────

test('every D365 dimension is emitted, blank when unset', () => {
  const p = buildPurchaseOrderPayload(input({ lines: [line({ financial_dimensions: {} })] }));
  const dims = p.lines[0].FinancialDimensions as Record<string, string>;
  assert.equal(Object.keys(dims).length, 9);
  for (const k of ['BusinessUnit', 'Department', 'CostCenter', 'Location', 'Project',
                   'Worker', 'ItemGroup', 'Customer', 'Vendor']) {
    assert.ok(k in dims, `${k} missing from the payload`);
  }
  assert.equal(dims.CostCenter, '');
});

test('the dimensions keep the real values and the D365 order', () => {
  const dims = financialDimensionsJson({ CostCenter: 'PKB-LHR-001', BusinessUnit: 'PKE' });
  assert.equal(dims[0], '"BusinessUnit": "PKE"');
  assert.equal(dims[2], '"CostCenter": "PKB-LHR-001"');
});

test('a line with no financial_dimensions at all still emits all 9', () => {
  const p = buildPurchaseOrderPayload(input({ lines: [line({ financial_dimensions: null })] }));
  assert.equal(Object.keys(p.lines[0].FinancialDimensions as object).length, 9);
});

// ─── 5 · acknowledgements ──────────────────────────────────────────────────

const acks = [
  { email: 'owais@pakboxes.pk', name: 'Owais Siddiqui', role: 'employee', role_label: 'employee', acknowledged: true, acknowledged_at: '2026-09-30T10:00:00Z' },
  { email: 'aamir@pakboxes.pk', name: 'Aamir Hussain', role: 'dept_head', role_label: 'dept_head', acknowledged: false, acknowledged_at: null },
];

test('acknowledgement status is a real count', () => {
  const p = buildPurchaseOrderPayload(input({ acknowledgements: acks }));
  assert.equal(p.header.AcknowledgementStatus, 'PENDING 1/2');
  const done = buildPurchaseOrderPayload(input({
    acknowledgements: acks.map((a) => ({ ...a, acknowledged: true })),
  }));
  assert.equal(done.header.AcknowledgementStatus, 'COMPLETE');
});

test('no tagged approvers is null, not "COMPLETE"', () => {
  // "COMPLETE" on zero recipients would be a claim nobody can verify.
  assert.equal(buildPurchaseOrderPayload(input()).header.AcknowledgementStatus, null);
});

test('the raw bearer token is NOT sent to D365 and NOT rendered', () => {
  // proc.pr_acknowledgements.token is a bearer credential: holding it lets you
  // acknowledge the request. It must never leave the portal.
  const p = buildPurchaseOrderPayload(input({ acknowledgements: acks }));
  // The KEY name is the prototype's D365 contract and stays; no VALUE named
  // token may exist anywhere in the object.
  const walk = (v: any): void => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (v && typeof v === 'object') {
      for (const [k, val] of Object.entries(v)) {
        assert.notEqual(k.toLowerCase(), 'token', `payload carries a bearer token at "${k}"`);
        walk(val);
      }
    }
  };
  walk(p);
  const sent = p.lines[0].AcknowledgementTokens as any[];
  assert.equal(sent.length, 2);
  assert.equal(sent[0].email, 'owais@pakboxes.pk');
  assert.equal(sent[0].acknowledged, true);
  assert.equal(sent[1].acknowledged, false);
  // ...but the D365 contract key is preserved, so the payload still matches the
  // prototype's field list.
  assert.ok('AcknowledgementTokens' in p.lines[0]);
});

test('the header recipient is the FIRST tagged approver, as the prototype resolves it', () => {
  const p = buildPurchaseOrderPayload(input({ acknowledgements: acks }));
  assert.equal(p.header.DeliveryEmail, 'owais@pakboxes.pk');
  assert.equal(p.header.RecipientRole, ROLE_LABEL.employee);
  assert.equal(roleLabel('dept_head'), 'Department Head');
  assert.equal(roleLabel('nonsense'), 'nonsense');
  assert.equal(roleLabel(null), null);
});

test('purchase purpose uses the prototype\'s own labels', () => {
  const p = buildPurchaseOrderPayload(input({ purpose: 'NEW_EMPLOYEE' }));
  assert.equal(p.header.PurchasePurpose, PURPOSE_LABEL.NEW_EMPLOYEE);
  assert.equal(p.header.PurchasePurpose, 'For New Employee');
  assert.equal(buildPurchaseOrderPayload(input()).header.PurchasePurpose, null);
});

// ─── 6 · the envelope ──────────────────────────────────────────────────────

test('the envelope carries the entity, both PR references and the Lines array', () => {
  const p = buildPurchaseOrderPayload(input({ pack_hash: 'sha256:abc' }));
  assert.equal(p.envelope.Entity, D365_PURCHASE_ORDER_ENTITY);
  assert.equal(p.envelope.Entity, 'PurchPurchaseOrderHeadersV2');
  assert.equal(p.envelope.PortalPRId, 'pr-1');
  assert.equal(p.envelope.PortalPRNumber, 'PR-2026-00234');
  assert.ok(Array.isArray(p.envelope.Lines));
  assert.equal((p.envelope.Lines as unknown[]).length, 1);
  // The header keys are hoisted onto the envelope, so the POST body is one
  // object rather than a header plus a separate Lines member.
  assert.equal(p.envelope.TotalAmount, 200_000);
});

test('purchase type follows the expense split', () => {
  assert.equal(buildPurchaseOrderPayload(input({ expense_split: 'CAPEX' })).header.PurchaseType, 'IT Capex');
  assert.equal(buildPurchaseOrderPayload(input({ expense_split: 'OPEX' })).header.PurchaseType, 'Operating Expense');
  assert.equal(buildPurchaseOrderPayload(input({ expense_split: 'MIXED' })).header.PurchaseType, 'Mixed Capex+Opex');
});

test('routing key defaults to STANDARD, as the prototype does', () => {
  assert.equal(buildPurchaseOrderPayload(input({ routing_key: null })).header.RoutingKey, 'STANDARD');
});

test('the header key order matches the prototype exactly', () => {
  const p = buildPurchaseOrderPayload(input());
  assert.deepEqual(Object.keys(p.header), [
    'PurchaseOrderNumber', 'VendorAccount', 'PurchaseType', 'PurchasePurpose',
    'DeliveryTo', 'DeliveryEmail', 'RecipientRole', 'Currency', 'TotalAmount',
    'CapexAmount', 'OpexAmount', 'RoutingKey', 'AcknowledgementStatus',
  ]);
});

test('the line key order matches the prototype exactly', () => {
  const opex = Object.keys(buildPurchaseOrderPayload(input()).lines[0]);
  assert.deepEqual(opex, [
    'ItemId', 'Quantity', 'PurchUnit', 'UnitPrice', 'ProcurementCategory',
    'InventoryProfile', 'MainAccountId', 'DeliveryTo', 'FinancialDimensions',
    'LineRemarks', 'AcknowledgementTokens',
  ]);
  const capex = Object.keys(
    buildPurchaseOrderPayload(input({ lines: [line({ classification: 'CAPEX_ASSET' })] })).lines[0],
  );
  // The two fixed-asset keys sit between MainAccountId and DeliveryTo.
  assert.deepEqual(capex.slice(0, 9), [
    'ItemId', 'Quantity', 'PurchUnit', 'UnitPrice', 'ProcurementCategory',
    'InventoryProfile', 'MainAccountId', 'FixedAssetGroup', 'DepreciationPeriod',
  ]);
});

test('an empty PR still produces a well-formed payload', () => {
  const p = buildPurchaseOrderPayload(input({ lines: [], acknowledgements: [] }));
  assert.deepEqual(p.lines, []);
  assert.equal(p.header.AcknowledgementStatus, null);
});

// ─── 7 · the status ladder and event stream ────────────────────────────────

test('the ladder is the prototype\'s six steps, in order', () => {
  assert.deepEqual([...D365_STATUS_LADDER], [
    'CONFIRMED', 'INVENTORY_RESERVED', 'AWAITING_GRN',
    'INVOICE_SUBMITTED', 'THREE_WAY_MATCHED', 'PAID',
  ]);
  assert.equal(statusIndex('CONFIRMED'), 0);
  assert.equal(statusIndex('PAID'), 5);
  assert.equal(statusIndex('NONSENSE'), -1);
  assert.equal(statusIndex(null), -1);
});

test('the stream is the six prototype rows, in order, with their own labels', () => {
  const e = d365EventStream({ poNumber: 'PO-2026-00781', status: 'CONFIRMED' });
  assert.deepEqual(e.map((x) => x.action), [
    'PO confirmed', 'Inventory reserved', 'Awaiting GRN',
    'Awaiting vendor invoice', '3-way match', 'Payment run',
  ]);
  // The PENDING rows keep the prototype's relative labels verbatim.
  assert.deepEqual(e.slice(1).map((x) => x.ts), ['+2 sec', '+1 hour', '+3 days', '+5 days', '+7 days']);
});

test('a COMPLETED row with no recorded observation time shows an em-dash', () => {
  // "Just now" is a claim about when. If no observation was timestamped, the
  // honest rendering is — , not the prototype's relative label. The push and
  // every sync write a d365_sync_log row, so in practice the real time is
  // always there; this is the case where it is not.
  const e = d365EventStream({ poNumber: 'PO-1', status: 'CONFIRMED' });
  assert.equal(e[0].state, 'done');
  assert.equal(e[0].ts, '—');
  assert.equal(e[0].reachedAt, null);
});

test('states are COMPUTED from the ladder, not hardcoded per row', () => {
  assert.deepEqual(d365EventStream({ poNumber: 'PO-1', status: 'CONFIRMED' }).map((x) => x.state),
    ['done', 'pending', 'pending', 'pending', 'pending', 'pending']);
  assert.deepEqual(d365EventStream({ poNumber: 'PO-1', status: 'INVENTORY_RESERVED' }).map((x) => x.state),
    ['done', 'done', 'pending', 'pending', 'pending', 'pending']);
  assert.deepEqual(d365EventStream({ poNumber: 'PO-1', status: 'PAID' }).map((x) => x.state),
    ['done', 'done', 'done', 'done', 'done', 'done']);
});

test('an unknown status marks NOTHING done, rather than everything', () => {
  const e = d365EventStream({ poNumber: 'PO-1', status: 'WAT' });
  assert.ok(e.every((x) => x.state === 'pending'));
});

test('a completed step shows its REAL observation time; a pending one keeps +N', () => {
  const observedAt = { CONFIRMED: '2026-09-30 10:00', INVENTORY_RESERVED: '2026-09-30 10:05' };
  const e = d365EventStream({ poNumber: 'PO-1', status: 'INVENTORY_RESERVED', observedAt });
  assert.equal(e[0].ts, '2026-09-30 10:00');
  assert.equal(e[1].ts, '2026-09-30 10:05');
  assert.equal(e[2].ts, '+1 hour');
  assert.equal(e[2].reachedAt, null);
});

test('the confirmed row never invents a PO number', () => {
  const e = d365EventStream({ poNumber: null, status: null });
  assert.equal(/PO-2026-\d+/.test(e[0].detail), false, e[0].detail);
  assert.match(e[0].detail, /awaiting a PO number/);
});
