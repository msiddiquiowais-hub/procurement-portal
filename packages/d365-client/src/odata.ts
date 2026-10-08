// ═══════════════════════════════════════════════════════════════════════════
// OData v4 transport for D365 F&O.
//
// A thin, honest client: it does what OData requires and nothing else. The two
// things it is careful about are the two that bite in practice.
//
// PAGING. F&O caps a page (commonly at 1000 records). A client that reads the
// first page and stops has silently truncated a vendor or dimension list — and
// truncation that looks like "these are all the operating units" is far worse
// than an error. `readAll` follows @odata.nextLink to exhaustion and reports
// how many pages it walked.
//
// ONE forced re-auth on 401. A token that expires mid-sync should cost one
// retry, not a support ticket. The retry is bounded to ONE: a 401 after a
// freshly minted token is a real permission problem, and retrying it twice
// would turn an authorization failure into a timeout.
//
// Note on $select and $expand: they are passed through verbatim, so the CALLER
// owns field selection. A client that helpfully added fields would break on
// any F&O version whose entity set differs.
// ═══════════════════════════════════════════════════════════════════════════

import type { AccessToken, EntraTokenProvider } from './oauth';

export type ODataPage<T> = {
  value: T[];
  nextLink: string | null;
  /** The raw body, kept so a caller can read @odata.count etc. */
  raw: any;
};

export class D365ODataError extends Error {
  constructor(
    public readonly status: number,
    public readonly entitySet: string,
    /** Truncated, and never assumed to be secret-free by accident. */
    public readonly bodySnippet: string,
  ) {
    super(`D365 OData request failed (HTTP ${status}) on ${entitySet}: ${bodySnippet}`);
    this.name = 'D365ODataError';
  }
}

export class ODataClient {
  constructor(
    private readonly opts: {
      baseUrl: string;
      company?: string;
      tokens: EntraTokenProvider;
      fetch?: typeof fetch;
    },
  ) {}

  private get doFetch() { return this.opts.fetch ?? fetch; }

  private root(): string {
    return this.opts.baseUrl.replace(/\/+$/, '');
  }

  private async authHeaders(): Promise<Record<string, string>> {
    const t: AccessToken = await this.opts.tokens.getToken();
    return {
      authorization: `${t.tokenType} ${t.accessToken}`,
      accept: 'application/json',
      // OData.maxpagesize is a hint; the server may return fewer. readAll does
      // not rely on it being honoured.
      'prefer': 'odata.maxpagesize=1000,odata.include-annotations="*"',
    };
  }

  private async request(url: string, method: string, body?: unknown): Promise<{ status: number; json: any }> {
    const res = await this.doFetch(url, {
      method,
      headers: {
        ...(await this.authHeaders()),
        ...(body !== undefined ? { 'content-type': 'application/json', 'odata-version': '4.0' } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
    return { status: res.status, json };
  }

  /** GET one entity set page. `query` is the raw OData query string. */
  async get<T = any>(entitySet: string, query = ''): Promise<ODataPage<T>> {
    const url = `${this.root()}/data/${entitySet}${query ? `?${query}` : ''}`;
    let { status, json } = await this.request(url, 'GET');

    // Exactly ONE forced re-auth. The token is dropped and re-minted; if the
    // second call also 401s, it is an authorization problem and retrying again
    // would only convert a clear failure into a hang.
    if (status === 401) {
      this.opts.tokens.invalidate();
      ({ status, json } = await this.request(url, 'GET'));
    }

    if (status >= 400) {
      throw new D365ODataError(status, entitySet, JSON.stringify(json).slice(0, 500));
    }
    return {
      value: Array.isArray(json?.value) ? json.value : [],
      nextLink: json?.['@odata.nextLink'] ?? null,
      raw: json,
    };
  }

  /**
   * Walk an entity set to exhaustion.
   *
   * Returns the concatenated rows AND the page count, so a caller can record
   * that a sync really did read 3 pages rather than assuming the first page was
   * the whole answer.
   */
  async readAll<T = any>(
    entitySet: string,
    query = '',
    opts: { maxPages?: number } = {},
  ): Promise<{ rows: T[]; pages: number; truncated: boolean }> {
    const maxPages = opts.maxPages ?? 100;
    let page = await this.get<T>(entitySet, query);
    const rows: T[] = [...page.value];
    let pages = 1;
    while (page.nextLink && pages < maxPages) {
      const res = await this.request(page.nextLink, 'GET');
      if (res.status === 401) {
        this.opts.tokens.invalidate();
        const retry = await this.request(page.nextLink, 'GET');
        if (retry.status >= 400) throw new D365ODataError(retry.status, entitySet, JSON.stringify(retry.json).slice(0, 500));
        page = { value: retry.json?.value ?? [], nextLink: retry.json?.['@odata.nextLink'] ?? null, raw: retry.json };
      } else if (res.status >= 400) {
        throw new D365ODataError(res.status, entitySet, JSON.stringify(res.json).slice(0, 500));
      } else {
        page = { value: res.json?.value ?? [], nextLink: res.json?.['@odata.nextLink'] ?? null, raw: res.json };
      }
      rows.push(...page.value);
      pages++;
    }
    return { rows, pages, truncated: !!page.nextLink };
  }

  /** POST into an entity set. Returns the created row, including its keys. */
  async post<T = any>(entitySet: string, payload: unknown): Promise<T> {
    const url = `${this.root()}/data/${entitySet}`;
    let { status, json } = await this.request(url, 'POST', payload);
    if (status === 401) {
      this.opts.tokens.invalidate();
      ({ status, json } = await this.request(url, 'POST', payload));
    }
    if (status >= 400) {
      throw new D365ODataError(status, entitySet, JSON.stringify(json).slice(0, 500));
    }
    return json as T;
  }

  /**
   * PATCH a single row by its OData key predicate.
   *
   * `keyPredicate` is the raw predicate only, e.g. `VendorAccount='V-00081'`,
   * NOT the surrounding `EntitySet(...)`. F&O addresses a single row as
   * `data/VendorsV2(VendorAccount='V-00081')`, and building the entity-set
   * name here keeps the two halves from drifting apart.
   *
   * PATCH is what makes create-or-update possible without a read-modify-write
   * race: POST when the row is absent, PATCH only the fields this system owns
   * when it is present.
   */
  async patchByKey<T = any>(
    entitySet: string,
    keyPredicate: string,
    payload: unknown,
  ): Promise<T> {
    const url = `${this.root()}/data/${entitySet}(${keyPredicate})`;
    let { status, json } = await this.request(url, 'PATCH', payload);
    if (status === 401) {
      this.opts.tokens.invalidate();
      ({ status, json } = await this.request(url, 'PATCH', payload));
    }
    if (status >= 400) {
      throw new D365ODataError(status, entitySet, JSON.stringify(json).slice(0, 500));
    }
    return json as T;
  }

  /**
   * Count rows matching a filter, via $count with $top=0.
   *
   * Used by the reconciliation step. D365 rejects $count with $skip, so the
   * combination is deliberate.
   */
  async count(entitySet: string, filter?: string): Promise<number> {
    const q = `$count=true&$top=0${filter ? `&$filter=${encodeURIComponent(filter)}` : ''}`;
    const page = await this.get(entitySet, q);
    const n = page.raw?.['@odata.count'];
    return Number.isFinite(Number(n)) ? Number(n) : 0;
  }
}

// ── the entity sets W5-H syncs ─────────────────────────────────────────────
//
// Named in ONE place so a typo is a compile error rather than a 404 from F&O at
// 3am. The F&O paths are exact and case-sensitive.
//
//   OMOperatingUnits      -> legal entities / operating units
//   HcmWorkers            -> employees (the Worker financial dimension's source)
//   FinancialDimensionValues -> the actual dimension VALUES a PR line must supply
//   VendorsV2             -> vendor master, keyed by VendorAccount
//
export const D365_ENTITY_SETS = {
  operatingUnits: 'OMOperatingUnits',
  workers: 'HcmWorkers',
  dimensionValues: 'FinancialDimensionValues',
  purchaseOrders: 'PurchPurchaseOrderHeadersV2',
  /**
   * F&O's vendor master. Keyed by VendorAccount, which is what this
   * application's `vendor_code` maps to — the join key for every vendor push.
   */
  vendors: 'VendorsV2',
} as const;

/**
 * VendorsV2 property names — ONE definition, shared by the API and the harness.
 *
 * VERIFICATION REQUIRED against a live environment. No D365 tenant was
 * available for W5-H, so while these are the standard F&O vendor-master
 * property names, none has been confirmed against a real tenant. They live
 * here, beside the entity sets, so a correction is one edit in one place
 * rather than a sweep through a service and a test that could disagree.
 *
 * The failure mode is loud by design: F&O rejects an unknown property with a
 * 400 naming the field, so a wrong name surfaces as a failed push rather than
 * as a field that silently never syncs.
 */
export const D365_VENDOR_FIELDS = {
  account: 'VendorAccount',
  name: 'Name',
  legalName: 'VendorLegalName',
  ntn: 'TaxRegistrationNumber',
  strn: 'Strn',
  currency: 'CurrencyCode',
  paymentTerms: 'PaymentTerms',
  /**
   * F&O needs BOTH for a hold to actually stop commitments: `IsOnHold` records
   * the state and `BlockOnHold` enforces it. Setting only the first leaves a
   * vendor that reads as held but can still receive a PO.
   */
  isOnHold: 'IsOnHold',
  blockOnHold: 'BlockOnHold',
  /**
   * F&O's vendor entity has no array field for procurement categories, so the
   * mapping travels as a delimited string in the annotation field. That is a
   * constraint of the target schema, not a preference, and it means F&O cannot
   * query categories off it.
   */
  categoryNote: 'Notes',
} as const;

/** $select + $filter strings kept beside their entity sets for the same reason. */
export const D365_QUERIES = {
  operatingUnits: "$select=OMOperatingUnitId,OperatingUnitType,Name,Description&$filter=IsLegalEntity eq true",
  workers: "$select=HcmWorkerId,WorkerNumber,Name,Email,DepartmentId,EmploymentStatus&$filter=EmploymentStatus eq 'Active'",
  dimensionValues: "$select=FinancialDimensionType,FinancialDimensionValue,Name,Active",
} as const;
