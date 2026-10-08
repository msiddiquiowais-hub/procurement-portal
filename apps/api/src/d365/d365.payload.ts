// The D365 purchase-order payload — a pure builder.
//
// Wave 3 step 3. The prototype's renderD365Push (line 7961-7996) prints this
// JSON as the SCREEN'S OWN CONTENT, which makes it easy to get wrong: build it
// twice (once to preview, once to send) and the two drift, and the reviewer
// approves a payload that was never sent.
//
// So it is built ONCE, here, and returned by `GET /pr/:id/d365/payload`. The
// screen renders that response verbatim and the push sends the same object.
//
// Key order below matches the prototype exactly, so the preview diffs cleanly
// against PROCUREMENT_PORTAL_PROTOTYPE.html:7961-8013.

import { D365_DIMENSIONS, splitPill } from '@procurement/d365-client';

/**
 * Depreciation for a capitalised line, in months.
 *
 * There is no useful_life column on proc.pr_lines or core.items, so the
 * prototype's own policy default (4 years, line 7991) is the only honest
 * source. It is named a DEFAULT rather than inlined at the call site so that
 * nobody later reads it as a measured figure for the asset in question.
 */
export const DEFAULT_USEFUL_LIFE_YEARS = 4;

export const D365_PURCHASE_ORDER_ENTITY = 'PurchPurchaseOrderHeadersV2';
export const D365_FIXED_ASSET_GROUP = 'IT-EQUIP';

/** The prototype's PURPOSES (line 1531) — k -> label. */
export const PURPOSE_LABEL: Record<string, string> = {
  EXISTING_EMPLOYEE: 'For Existing Employee',
  NEW_EMPLOYEE: 'For New Employee',
  BACKUP: 'Backup / Spare',
  NEW_PROJECT: 'New Project Setup',
};

/** The prototype's roleLabel() (line 9918). */
export const ROLE_LABEL: Record<string, string> = {
  employee: 'Employee / Recipient',
  requester_self: 'Self (Requester)',
  dept_head: 'Department Head',
  director: 'Director',
  project_lead: 'Project Lead',
  new_employee: 'New Hire',
};

export function roleLabel(role: string | null | undefined): string | null {
  if (!role) return null;
  return ROLE_LABEL[role] || role;
}

export type D365Acknowledgement = {
  email: string;
  name: string | null;
  role: string | null;
  role_label: string | null;
  acknowledged: boolean;
  acknowledged_at: string | null;
};

export type D365LineInput = {
  line_no: number;
  sku: string;
  quantity: number;
  uom: string | null;
  unit_price: number;
  classification: string | null;
  gl_account: string | null;
  remarks: string | null;
  financial_dimensions: Record<string, string> | null;
  useful_life_years?: number | null;
};

export type D365PayloadInput = {
  pr_id: string;
  pr_number: string;
  /** The real D365 PO number, or null before the push. */
  po_number: string | null;
  /** The CS winner's real vendor code, or null when there is no winner. */
  vendor_code: string | null;
  /**
   * W5-G — which shape the CS award took. 'SPLIT' means the package was awarded
   * line by line and `vendor_code` above is only the FIRST winning vendor, not
   * "the" vendor. A PO header carries one VendorAccount, so the push is refused
   * for a split rather than misnaming half the supply.
   */
  award_mode?: string | null;
  split_award?: boolean;
  /** Every winning vendor. Single-winner CSs carry exactly one entry. */
  vendors?: { vendor_id: string; vendor_code: string; legal_name: string }[];
  expense_split: string | null;
  purpose: string | null;
  delivery_to: string | null;
  currency: string | null;
  /** The AWARDED total — never the PR's estimate once a CS is locked. */
  total_amount: number;
  capex_amount: number | null;
  opex_amount: number | null;
  routing_key: string | null;
  acknowledgements: D365Acknowledgement[];
  /** The frozen pack's real hash, or null. Replaces the prototype's "a3f9c1...". */
  pack_hash: string | null;
  lines: D365LineInput[];
};

const isCapex = (c: string | null | undefined): boolean => !!c && c.startsWith('CAPEX');

/**
 * D365 wants the ACCOUNT code, not "1710-00 IT Equipment". The prototype takes
 * `glAccount.split(' ')[0]` (line 7990); a code with no space is returned whole.
 */
export function mainAccountId(glAccount: string | null | undefined): string | null {
  const g = (glAccount || '').trim();
  if (!g) return null;
  return g.split(/\s+/)[0];
}

/**
 * The prototype's InventoryProfile string (line 7990): a capex line announces
 * the fixed-asset register, an opex line announces its GL.
 */
export function inventoryProfile(line: D365LineInput): string | null {
  const gl = mainAccountId(line.gl_account);
  if (isCapex(line.classification)) return 'Capitalised→FixedAssetRegister';
  if (!gl) return null;
  return `Expensed→GL${gl}`;
}

/**
 * All 9 dimensions, in D365_DIMENSIONS order, with an empty string for the
 * ones not set. The prototype emits every key unconditionally (line 7983-7985)
 * so the payload shape is stable regardless of which dims a line carries.
 */
export function financialDimensionsJson(dims: Record<string, string> | null | undefined) {
  const d = dims || {};
  return D365_DIMENSIONS.map(
    (x) => `${JSON.stringify(x.apiName)}: ${JSON.stringify(String(d[x.key] || ''))}`,
  );
}

export type BuiltD365Payload = {
  header: Record<string, unknown>;
  lines: Record<string, unknown>[];
  envelope: Record<string, unknown>;
};

/**
 * Build the payload.
 *
 * NOTHING IS FABRICATED. Where the prototype supplies a placeholder — the PO
 * number `PO-2026-00781`, the vendor `V-000123`, the total `pr.amount||2400000`,
 * the pack hash `"a3f9c1..."` — this returns `null`, and the screen prints an
 * em-dash. A D365 payload with `null` in three fields is obviously not ready;
 * one with plausible values is dangerously ready.
 */
export function buildPurchaseOrderPayload(input: D365PayloadInput): BuiltD365Payload {
  const split = splitPill(input.expense_split);
  const purchaseType = split === 'CAPEX' ? 'IT Capex'
    : split === 'OPEX' ? 'Operating Expense'
    : 'Mixed Capex+Opex';

  const ackedCount = input.acknowledgements.filter((a) => a.acknowledged).length;
  const totalRecipients = input.acknowledgements.length;
  const acknowledgementStatus =
    totalRecipients === 0
      ? null
      : ackedCount === totalRecipients
        ? 'COMPLETE'
        : `PENDING ${ackedCount}/${totalRecipients}`;

  const header: Record<string, unknown> = {
    PurchaseOrderNumber: input.po_number,
    VendorAccount: input.vendor_code,
    PurchaseType: purchaseType,
    PurchasePurpose: input.purpose ? (PURPOSE_LABEL[input.purpose] || input.purpose) : null,
    DeliveryTo: input.delivery_to,
    DeliveryEmail: input.acknowledgements[0]?.email ?? null,
    RecipientRole: roleLabel(input.acknowledgements[0]?.role),
    Currency: input.currency,
    TotalAmount: input.total_amount,
    CapexAmount: input.capex_amount,
    OpexAmount: input.opex_amount,
    // The prototype writes `pr.routingKey||'STANDARD'` (line 7973). The default
    // belongs HERE rather than in the service, because this builder is the
    // prototype's render function: whatever renders the payload owns the
    // payload's defaults.
    RoutingKey: input.routing_key || 'STANDARD',
    AcknowledgementStatus: acknowledgementStatus,
  };

  const lines = input.lines.map((ln) => {
    const capex = isCapex(ln.classification);
    const life = ln.useful_life_years ?? DEFAULT_USEFUL_LIFE_YEARS;
    const row: Record<string, unknown> = {
      ItemId: ln.sku,
      Quantity: ln.quantity,
      PurchUnit: ln.uom,
      UnitPrice: ln.unit_price,
      ProcurementCategory: capex ? 'CAPEX' : 'OPEX',
      InventoryProfile: inventoryProfile(ln),
      MainAccountId: mainAccountId(ln.gl_account),
    };
    // Fixed-asset fields exist ONLY on a capitalised line. Emitting them on an
    // opex line would tell D365 to capitalise an expense.
    if (capex) {
      row.FixedAssetGroup = D365_FIXED_ASSET_GROUP;
      row.DepreciationPeriod = (Number(life) || DEFAULT_USEFUL_LIFE_YEARS) * 12;
    }
    row.DeliveryTo = input.delivery_to;
    row.FinancialDimensions = Object.fromEntries(
      D365_DIMENSIONS.map((x) => [x.apiName, String(ln.financial_dimensions?.[x.key] || '')]),
    );
    row.LineRemarks = ln.remarks;
    row.AcknowledgementTokens = input.acknowledgements.map((a) => ({
      // NOTE: the raw portal acknowledgement token is deliberately NOT sent.
      // It is a BEARER credential — whoever holds it can acknowledge the
      // request (see the invitation-token rule in Wave 2 decision 5), and the
      // push screen would also RENDER it. D365 needs to know who and whether;
      // it does not need the ability to act as them.
      email: a.email,
      name: a.name,
      role: a.role_label,
      acknowledged: a.acknowledged,
      acknowledgedAt: a.acknowledged_at,
    }));
    return row;
  });

  const envelope: Record<string, unknown> = {
    ...header,
    Entity: D365_PURCHASE_ORDER_ENTITY,
    Lines: lines,
    PortalPRId: input.pr_id,
    PortalPRNumber: input.pr_number,
    // D1: the real frozen pack hash, replacing the prototype's literal.
    PortalPackHash: input.pack_hash,
  };

  return { header, lines, envelope };
}

/**
 * The D365 status ladder, in the prototype's event order (line 8021-8028).
 *
 * A PO's status only ever moves because something OBSERVED it moving — a poll
 * or a webhook. Nothing in this file is a timer, and the prototype's
 * `setTimeout(..., 2500)` that flipped status to INVENTORY_RESERVED is
 * deliberately not ported.
 */
export const D365_STATUS_LADDER = [
  'CONFIRMED',
  'INVENTORY_RESERVED',
  'AWAITING_GRN',
  'INVOICE_SUBMITTED',
  'THREE_WAY_MATCHED',
  'PAID',
] as const;

export type D365Status = (typeof D365_STATUS_LADDER)[number];

/** Where `status` sits on the ladder, or -1 when it is not on it. */
export function statusIndex(status: string | null | undefined): number {
  if (!status) return -1;
  return (D365_STATUS_LADDER as readonly string[]).indexOf(status);
}

/**
 * The six-row event stream, with each row's state COMPUTED from the real
 * status instead of the prototype's single `d365Status === 'INVENTORY_RESERVED'`
 * check. `ts` is the real `observed_at` for a completed step and the
 * prototype's relative label for a pending one — the relative labels are the
 * prototype's design, not a claim about when anything happened.
 */
export function d365EventStream(input: {
  poNumber: string | null;
  status: string | null;
  /** status -> the timestamp it was first observed, from d365_sync_log. */
  observedAt?: Record<string, string | null>;
  entity?: string;
  /** Pin a ladder step directly. Lets a test walk the stream without
   *  inventing a status string, and lets a caller render a hypothetical. */
  statusIndexOverride?: number;
}) {
  const at = input.statusIndexOverride ?? statusIndex(input.status);
  const entity = input.entity || D365_PURCHASE_ORDER_ENTITY;
  const po = input.poNumber;

  // `state` is deliberately absent from the literals: it is COMPUTED from the
  // ladder index below, so writing one here would be a second source of truth.
  type StreamRow = { key: string; ts: string; action: string; detail: string };
  const rows: StreamRow[] = [
    {
      key: 'confirmed',
      // The prototype hardcodes the PO number here (line 8022).
      action: 'PO confirmed',
      detail: po ? `${entity} → ${po}` : `${entity} → awaiting a PO number`,
      ts: 'Just now',
    },
    {
      key: 'reserved',
      action: 'Inventory reserved',
      detail: 'Warehouse allocation complete (Capex lines → Fixed Asset Register)',
      ts: '+2 sec',
    },
    {
      key: 'grn',
      action: 'Awaiting GRN',
      detail: 'Goods Receipt Note from warehouse',
      ts: '+1 hour',
    },
    {
      key: 'invoice',
      action: 'Awaiting vendor invoice',
      detail: 'Vendor submits invoice via portal',
      ts: '+3 days',
    },
    {
      key: 'match',
      action: '3-way match',
      detail: 'GRN + PO + Invoice → AP team (Capex: invoice → asset; Opex: invoice → P&L)',
      ts: '+5 days',
    },
    {
      key: 'paid',
      action: 'Payment run',
      detail: 'Disbursed to vendor bank account',
      ts: '+7 days',
    },
  ];

  return rows.map((r, i) => ({
    ...r,
    state: (i <= at ? 'done' : 'pending') as 'done' | 'pending',
    // A completed step shows when it was actually observed; a pending one keeps
    // the prototype's own relative label.
    ts: i <= at ? (input.observedAt?.[D365_STATUS_LADDER[i]] || '—') : r.ts,
    reachedAt: i <= at ? (input.observedAt?.[D365_STATUS_LADDER[i]] || null) : null,
  }));
}
