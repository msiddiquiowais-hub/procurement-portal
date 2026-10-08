// D365 F&O client.
//
// Transport lives in ./oauth (Entra ID client-credentials) and ./odata (OData
// v4). This file keeps the public surface the API already depends on:
// `pushPurchaseOrder` and the vocabulary constants.
//
// THE STUB IS NOW OBVIOUSLY FAKE.
//
// It used to invent `PO-2026-004271` — indistinguishable from a real F&O number
// in every downstream report, and a silent data-integrity hazard. It now
// returns `STUB-PO-…`, so a local run can never be mistaken for a real
// commitment, and `liveRequired()` makes the live path fail loudly rather than
// quietly serving the stub.

import {
  EntraTokenProvider, D365ConfigError, missingConfig, type EntraConfig,
} from './oauth';
import { ODataClient, D365_ENTITY_SETS } from './odata';

export { EntraTokenProvider, D365ConfigError, missingConfig, assertConfigured, tokenEndpoint, resourceScope } from './oauth';
export type { EntraConfig, AccessToken } from './oauth';
export { ODataClient, D365ODataError, D365_ENTITY_SETS, D365_QUERIES, D365_VENDOR_FIELDS } from './odata';
export type { ODataPage } from './odata';

export type D365Config = {
  baseUrl?: string;
  tenantId?: string;
  clientId?: string;
  clientSecret?: string;
  company?: string;
  mode: 'stub' | 'live';
};

export type PurchaseOrderPush = {
  prNumber: string;
  vendorCode: string;
  amount: number;
  currency: string;
  /** Correlates the PO back to this system. F&O stores it as a free-text field. */
  sourceReference?: string;
  lines: Array<{
    lineNo: number;
    itemCode: string;
    quantity: number;
    uom: string;
    unitPrice: number;
  }>;
};

export type PushResult = {
  ok: boolean;
  poNumber: string;
  /** F&O's surrogate key. Needed to poll status afterwards. */
  poId: string | null;
  message: string;
  pushedAt: string;
  /** True when this result came from the local stub and represents no real PO. */
  stubbed: boolean;
};

/**
 * D365Config calls the F&O root `baseUrl`; EntraConfig calls the same string
 * `resourceUrl`. They are the same value under two names.
 *
 * This used to be bridged with `config as EntraConfig`, a cast that told
 * TypeScript the two shapes were interchangeable when they are not. The
 * consequence was silent and total: `missingConfig` reads `cfg.resourceUrl`,
 * which is always `undefined` on a `D365Config`, so EVERY live config was
 * reported as missing `D365_BASE_URL` — including a correctly configured
 * deployment. Live PO push could never succeed, and the only symptom was a
 * config error pointing at a variable that was plainly set.
 *
 * A cast across a shape mismatch is not a type assertion, it is a silenced
 * bug report.
 */
function asEntra(config: D365Config): EntraConfig {
  return {
    tenantId: config.tenantId,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    resourceUrl: config.baseUrl,
  };
}

/** Throws unless the config can actually reach D365. Never silently stubs. */
export function assertLiveConfig(config: D365Config): void {
  if (config.mode !== 'live') return;
  const missing = missingConfig(asEntra(config));
  if (missing.length > 0) throw new D365ConfigError(missing);
}

/**
 * Push one purchase order.
 *
 * LIVE: acquires an Entra token, POSTs the order to
 * PurchPurchaseOrderHeadersV2 and returns the number F&O assigned. The number
 * in the response is the ONLY source of `poNumber` — nothing here derives one.
 */
export async function pushPurchaseOrder(
  config: D365Config,
  payload: PurchaseOrderPush,
  deps: { fetch?: typeof fetch } = {},
): Promise<PushResult> {
  const ts = new Date().toISOString();

  // Fail closed. A live deployment with a missing secret must not receive a
  // fabricated purchase order.
  assertLiveConfig(config);

  if (config.mode === 'stub' || !config.baseUrl) {
    const seq = Math.floor(Math.random() * 1_000_000).toString().padStart(6, '0');
    return {
      ok: true,
      poNumber: `STUB-PO-${new Date().getFullYear()}-${seq}`,
      poId: null,
      message:
        `[STUB] PR ${payload.prNumber} was NOT sent to D365. No purchase order ` +
        `exists in F&O; this number is local and carries no commitment.`,
      pushedAt: ts,
      stubbed: true,
    };
  }

  const tokens = new EntraTokenProvider(asEntra(config), { fetch: deps.fetch });
  const odata = new ODataClient({
    baseUrl: config.baseUrl,
    company: config.company,
    tokens,
    fetch: deps.fetch,
  });

  const created = await odata.post<any>(D365_ENTITY_SETS.purchaseOrders, {
    PurchaseOrderNumber: null,          // F&O assigns it
    VendorAccount: payload.vendorCode,
    Currency: payload.currency,
    TotalAmount: payload.amount,
    // The PR number, so an F&O user can trace any PO back to this application.
    PurchaseOrderSourceReference: payload.sourceReference ?? payload.prNumber,
    PurchaseType: 'PurchOrder',
    PurchasePurpose: 'Purchase requisition approved and issued',
    PurchasingOrganizationId: null,
    PurchaseOrderLines: payload.lines.map((l) => ({
      LineNumber: l.lineNo,
      ItemNumber: l.itemCode,
      QuantityOrdered: l.quantity,
      PurchasingUnitOfMeasure: l.uom,
      LineAmount: Math.round(l.quantity * l.unitPrice * 100) / 100,
    })),
  });

  const poNumber = created?.PurchaseOrderNumber ?? null;
  if (!poNumber) {
    // A 200 with no number is not a success. Treating it as one is how a
    // "pushed" PR ends up with a null PO number and nobody notices.
    throw new Error(
      'D365 accepted the purchase order but returned no PurchaseOrderNumber. ' +
      'Treating that as success would leave the PR marked pushed with no PO in F&O.',
    );
  }

  return {
    ok: true,
    poNumber: String(poNumber),
    poId: created?.PurchPurchaseOrderId ? String(created.PurchPurchaseOrderId) : null,
    message: `PO ${poNumber} created in D365 F&O`,
    pushedAt: ts,
    stubbed: false,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Capital-PR vocabulary — ported from the prototype.
//
// The capital-PR trio (`my-prs` / `pr-create` / `pr-detail`) depends on three
// fixed contracts. They live here rather than in the DB because they are D365
// contracts, not data.
// ═══════════════════════════════════════════════════════════════════════════

/** Per-line Capex/Opex classification. Order matters — the create screen
 *  renders the chips in exactly this order. */
export const CLASSIFICATIONS = [
  { value: 'CAPEX_ASSET',     label: 'Capex — Asset',      cls: 'capex',       gl: '1xxx (Fixed Assets)',    capex: true },
  { value: 'CAPEX_INFRA',     label: 'Capex — Infra',      cls: 'infra',       gl: '1xxx (Fixed Assets)',    capex: true },
  { value: 'OPEX_CONSUMABLE', label: 'Opex — Consumable',  cls: 'consumable',  gl: '6xxx (Operating Exp)',   capex: false },
  { value: 'OPEX_SERVICE',    label: 'Opex — Service',     cls: 'service',     gl: '6xxx (Operating Exp)',   capex: false },
  { value: 'OPEX_MAINT',      label: 'Opex — Maintenance', cls: 'maintenance', gl: '6xxx (Operating Exp)',   capex: false },
] as const;

export type Classification = typeof CLASSIFICATIONS[number]['value'];

export const CLASSIFICATION_LABEL: Record<string, string> =
  Object.fromEntries(CLASSIFICATIONS.map(c => [c.value, c.label]));

export const CLASSIFICATION_CLASS: Record<string, string> =
  Object.fromEntries(CLASSIFICATIONS.map(c => [c.value, c.cls]));

export const isCapex = (c: string | null | undefined): boolean =>
  !!c && c.startsWith('CAPEX_');

/**
 * The 9 D365 financial dimensions. The first 4 are MANDATORY: the prototype's
 * create screen blocks submit until all four are picked on every line.
 */
export const D365_DIMENSIONS = [
  { key: 'BusinessUnit', label: 'Business Unit', apiName: 'BusinessUnit', mandatory: true,  desc: 'Legal entity / business unit the purchase belongs to.' },
  { key: 'Department',   label: 'Department',    apiName: 'Department',   mandatory: true,  desc: 'Owning department — drives approval routing and reporting.' },
  { key: 'CostCenter',   label: 'Cost Center',   apiName: 'CostCenter',   mandatory: true,  desc: 'Cost center code that absorbs the expense (Capex) or charge (Opex).' },
  { key: 'Location',     label: 'Location',      apiName: 'Location',     mandatory: true,  desc: 'Physical site / warehouse / office where the item will be received and used.' },
  { key: 'Project',      label: 'Project',       apiName: 'Project',      mandatory: false, desc: 'Internal project / WBS element the purchase is tied to (blank if N/A).' },
  { key: 'Worker',       label: 'Worker',        apiName: 'Worker',       mandatory: false, desc: 'Employee / worker tag — for HR-cost-attribution workflows.' },
  { key: 'ItemGroup',    label: 'Item Group',    apiName: 'ItemGroup',    mandatory: false, desc: 'Procurement category that maps to GL / vendor selection.' },
  { key: 'Customer',     label: 'Customer',      apiName: 'Customer',     mandatory: false, desc: 'If the purchase is for a specific external customer (project work).' },
  { key: 'Vendor',       label: 'Vendor',        apiName: 'Vendor',       mandatory: false, desc: 'Suggested vendor dimension (overrides default vendor on the PO line).' },
] as const;

export const D365_MANDATORY_DIMS = D365_DIMENSIONS.filter(d => d.mandatory).map(d => d.key);

export type FinancialDimensions = Record<string, string>;

/** Mandatory dimensions missing on a line — the create screen blocks on this. */
export function missingMandatoryDims(dims: FinancialDimensions | null | undefined): string[] {
  const d = dims || {};
  return D365_MANDATORY_DIMS.filter(k => !String(d[k] || '').trim());
}

/** All 9 dimensions missing on a line — the accordion's "N dims missing" chip. */
export function missingDims(dims: FinancialDimensions | null | undefined): string[] {
  const d = dims || {};
  return D365_DIMENSIONS.map(x => x.key).filter(k => !String(d[k] || '').trim());
}

/**
 * deriveRouting — port of the prototype's deriveRouting(pr). Also implemented
 * server-side as proc.fn_derive_routing(); the two must agree, and
 * `deriveRouting.ts` in workflow-engine carries the same thresholds.
 */
export type RoutingKey = 'STANDARD' | 'FAST_TRACK' | 'BOARD';

export type Routing = { key: RoutingKey; label: string; reason: string };

export function deriveRouting(capex: number, opex: number, total: number): Routing {
  if (capex > 10_000_000) return { key: 'BOARD', label: 'Board approval', reason: 'Capex > PKR 1 Cr' };
  if (capex > 0 && opex === 0 && total <= 250_000) {
    return { key: 'FAST_TRACK', label: 'HOD + Procurement only', reason: 'Capex ≤ PKR 2.5 L (within HOD delegation)' };
  }
  if (capex === 0 && total <= 100_000) {
    return { key: 'FAST_TRACK', label: 'HOD only', reason: 'Opex ≤ PKR 1 L (petty)' };
  }
  return { key: 'STANDARD', label: 'HOD → MC → CFO', reason: 'Standard 5-stage routing' };
}

/** Capex / Opex header pill. Port of the prototype's splitPill(). */
export function splitPill(expenseType: string | null | undefined): 'CAPEX' | 'OPEX' | 'MIXED' {
  if (expenseType === 'CAPEX') return 'CAPEX';
  if (expenseType === 'OPEX') return 'OPEX';
  return 'MIXED';
}

export const SPLIT_PILL_LABEL: Record<string, string> = {
  CAPEX: 'Capex only',
  OPEX: 'Opex only',
  MIXED: 'Mixed: Capex + Opex',
};
