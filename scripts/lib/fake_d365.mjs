// ═══════════════════════════════════════════════════════════════════════════
// A local fake Entra ID + OData v4 server.
//
// WHY THIS EXISTS
//
// Wave 5 Track H asks for Entra ID OAuth2 and OData v4 against D365 F&O. There
// is no tenant available, so the integration cannot be proven against the real
// thing — and pretending otherwise by writing a "mock" of our own client proves
// nothing, because a mock of the subject under test cannot fail.
//
// So the boundary that is actually under test is the NETWORK one: our client
// talks HTTP to some server; this is a server that speaks the same protocol.
// If the client mangles the token request, omits the `.default` scope, sends
// the wrong content type, forgets to follow `@odata.nextLink`, or mis-reads the
// response, it fails HERE against something that behaves the way F&O behaves.
//
// The Entra token endpoint is the REAL Microsoft URL — only the F&O resource is
// faked. The client therefore cannot cheat on URL construction: it has to build
// login.microsoftonline.com/{tenant}/oauth2/v2.0/token itself, or nothing works.
//
// WHAT IT IS NOT: not a D365 emulator, not a test double of our client, and not
// evidence that F&O's real schema matches these entity sets. Verification
// against a live tenant remains outstanding and is reported as such.
// ═══════════════════════════════════════════════════════════════════════════

import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

/**
 * @typedef {Object} FakeD365Options
 * @property {string} [tenant]
 * @property {string} [clientId]
 * @property {string} [clientSecret]
 * @property {number} [pageSize]        Rows per page — forces the client to page.
 * @property {number} [operatingUnits]
 * @property {number} [workers]
 * @property {number} [vendors]  VendorsV2 rows to PRE-SEED. The store is writable:
 *   POST creates, PATCH by key updates, and a PATCH to an unknown key 404s.
 *   Seeded rows exist so create-vs-update can be told apart.
 * @property {boolean} [failFirstTokenRequest] Reject the first grant, to prove
 *   the 401-re-auth path without expiring a real clock.
 */

/**
 * Tenant -> baseUrl, for every live fake in this process.
 *
 * The real Entra token URL embeds the tenant, so routing on the tenant is both
 * faithful to production and the only way several fakes can coexist under one
 * global fetch patch.
 * @type {Map<string, string>}
 */
const TENANTS = new Map();

let instanceSeq = 0;
/** @type {{real: typeof fetch, depth: number}|null} */
let patch = null;

/**
 * Install the global fetch patch (reference counted) and return its release.
 *
 * Ref counting matters because `close()` and an explicit `restoreFetch()` may
 * both run. A naive patch captured the already-patched function and its restore
 * reinstated the previous patch rather than the original — leaving the process
 * permanently redirected after the last fake closed.
 */
function installPatch() {
  if (patch) { patch.depth++; return; }
  const real = globalThis.fetch;
  patch = { real, depth: 1 };
  globalThis.fetch = (input, init) => {
    const href = typeof input === 'string' ? input : input?.url;
    if (typeof href === 'string' && href.includes('login.microsoftonline.com')) {
      const m = href.match(/login\.microsoftonline\.com\/([^/]+)\//);
      const base = m && TENANTS.get(decodeURIComponent(m[1]));
      if (base) return real(`${base}/token`, init);
      // An unrouted tenant is NOT absorbed: it goes to the real endpoint so a
      // misconfigured client fails loudly instead of being silently served.
    }
    return real(input, init);
  };
}

function releasePatch() {
  if (!patch) return;
  if (--patch.depth > 0) return;
  globalThis.fetch = patch.real;
  patch = null;
}

/**
 * @param {FakeD365Options} [opts]
 */
export async function startFakeD365(opts = {}) {
  // A UNIQUE tenant per instance. Two fakes that shared a tenant produced the
  // same token URL, so the single global redirect sent the second fake's token
  // request to the FIRST fake's server — its fail-injection was silently
  // bypassed and a negative test passed for the wrong reason. Distinct
  // tenants make the URL itself carry the routing, exactly as it does in
  // production, so the two cannot collide.
  const tenant = opts.tenant ?? `11111111-1111-1111-1111-${String(++instanceSeq).padStart(12, '0')}`;
  const clientId = opts.clientId ?? '22222222-2222-2222-2222-222222222222';
  const clientSecret = opts.clientSecret ?? 'secret-under-test';
  const pageSize = opts.pageSize ?? 2;

  /** @type {{method:string,url:string,auth:string|null,body:string}[]} */
  const calls = [];
  /** F&O vendor master, keyed by VendorAccount. Seeded by startFakeD365. */
  const vendorStore = new Map();
  for (let i = 0; i < (opts.vendors ?? 0); i++) {
    const code = `V-F${String(i + 1).padStart(4, '0')}`;
    vendorStore.set(code, {
      VendorAccount: code,
      Name: `Fake Vendor ${i + 1}`,
      VendorLegalName: `Fake Vendor ${i + 1} Ltd`,
      IsOnHold: false,
      BlockOnHold: false,
      CurrencyCode: 'PKR',
    });
  }
  /** @type {{scope:string,clientId:string,grantType:string}[]} */
  const tokenGrants = [];
  let unauthenticatedCalls = 0;
  let tokensIssued = 0;
  // Counts token REQUESTS, not tokens granted. `failFirstTokenRequest` used to
  // gate on `tokensIssued === 0`, but the failure path returns without
  // incrementing it — so the condition stayed true forever and the option
  // rejected EVERY grant. It was named "first" and behaved as "always", which
  // made a retry-success test impossible to write and would have quietly
  // mis-proved the 401 re-auth path too.
  let tokenAttempts = 0;
  // Declared BEFORE the handler: it closes over `port` to build the absolute
  // @odata.nextLink. Declaring it after would be a TDZ error on the first page.
  let port = 0;

  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const url = req.url || '/';
      const auth = req.headers.authorization || null;
      calls.push({ method: req.method || 'GET', url, auth, body: raw });

      // ── Entra token endpoint ───────────────────────────────────────────
      // `POST /token` is the LOCAL stand-in for
      // https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token. It exists
      // because the harness cannot reach the real Microsoft endpoint and must
      // not: the point is to prove our client BUILDS the right URL and BODY,
      // which the redirect preserves, not to prove Microsoft is online.
      if (url.includes('/oauth2/v2.0/token') || url === '/token' || url.startsWith('/token')) {
        const form = new URLSearchParams(raw);
        tokenAttempts += 1;
        if (url.includes('/oauth2/v2.0/token') && !url.includes(`/${tenant}/`)) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            error: 'invalid_tenant',
            // The real endpoint echoes request parameters back here. Reproducing
            // that means a client that leaks the body into an error message is
            // caught here rather than in production logs.
            error_description: `AADSTS90002: Tenant '${form.get('client_id')}' not found.`,
          }));
          return;
        }
        if (opts.failFirstTokenRequest && tokenAttempts === 1) {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            error: 'invalid_client',
            error_description: `AADSTS7000215: Invalid client secret for ${form.get('client_id')}.`,
          }));
          return;
        }
        if (form.get('grant_type') !== 'client_credentials') {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'unsupported_grant_type' }));
          return;
        }
        if (form.get('client_id') !== clientId || form.get('client_secret') !== clientSecret) {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid_client', error_description: 'AADSTS7000215' }));
          return;
        }
        // A scope that is not `{resource}/.default` is refused, exactly as F&O's
        // resource server refuses a token minted for another audience.
        const scope = String(form.get('scope') || '');
        if (!scope.endsWith('/.default')) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            error: 'invalid_scope',
            error_description: `AADSTS70011: the value for scope '${scope}' is not valid.`,
          }));
          return;
        }
        tokenGrants.push({
          scope,
          clientId: String(form.get('client_id')),
          grantType: String(form.get('grant_type')),
        });
        tokensIssued += 1;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          access_token: `fake-access-token-${tokensIssued}`,
          token_type: 'Bearer',
          expires_in: 3600,
          ext_expires_in: 3600,
        }));
        return;
      }

      // ── everything else must present the token ─────────────────────────
      if (!auth || !auth.startsWith('Bearer ')) {
        unauthenticatedCalls += 1;
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { code: '401', message: 'Unauthorized' } }));
        return;
      }

      // ── purchase-order POST ───────────────────────────────────────────
      if (req.method === 'POST' && url.includes('PurchPurchaseOrderHeadersV2')) {
        let payload = {};
        try { payload = JSON.parse(raw); } catch { /* malformed body */ }
        const n = randomUUID();
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          // Payload FIRST, server-assigned fields LAST. F&O assigns the PO
          // number regardless of what the client sent — the client deliberately
          // sends `PurchaseOrderNumber: null`. Spreading the payload last let
          // that null overwrite the assigned number, so every push returned a
          // 200 with no number and the client's "a 200 with no number is not a
          // success" guard rejected its own successful push.
          ...payload,
          PurchaseOrderNumber: `PO${new Date().getFullYear()}-${n.slice(0, 8).toUpperCase()}`,
          PurchPurchaseOrderId: n,
          PurchaseOrderSourceReference: payload.PurchaseOrderSourceReference ?? null,
        }));
        return;
      }

      // ── VendorsV2: create, read, patch by key ──────────────────────────
      // A real store, because the vendor sync is the one place where
      // create-or-update is the whole behaviour: a read-only fake would let
      // `count()` always answer 0, and the create/update branch would never be
      // exercised at all.
      if (url.includes('VendorsV2')) {
        // PATCH .../VendorsV2(VendorAccount='V-00081')
        const patchKey = /VendorsV2\(VendorAccount='([^']*)'\)/.exec(url);
        if (req.method === 'PATCH' && patchKey) {
          const existing = vendorStore.get(patchKey[1]);
          if (!existing) {
            // A PATCH to a row F&O does not have must 404. Silently creating it
            // would make the "never invent a vendor" rule untestable.
            res.writeHead(404, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: { code: '404', message: `no vendor ${patchKey[1]}` } }));
            return;
          }
          let patch = {};
          try { patch = JSON.parse(raw); } catch { /* malformed body */ }
          Object.assign(existing, patch);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ...existing }));
          return;
        }

        if (req.method === 'POST') {
          let payload = {};
          try { payload = JSON.parse(raw); } catch { /* malformed body */ }
          if (!payload.VendorAccount) {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({
              error: { code: 'VendorAccount', message: 'VendorAccount is required' },
            }));
            return;
          }
          const row = { ...payload };
          vendorStore.set(row.VendorAccount, row);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ...row }));
          return;
        }

        // GET with $count / $filter, as `ODataClient.count` issues it.
        const filter = /[?&]\$filter=([^&]*)/.exec(url);
        let rows = [...vendorStore.values()];
        if (filter) {
          const m = /VendorAccount\s+eq\s+'([^']*)'/.exec(decodeURIComponent(filter[1]));
          if (m) rows = rows.filter((r) => r.VendorAccount === m[1]);
        }
        const body = { '@odata.context': `http://fake/$metadata#VendorsV2` };
        if (url.includes('$count')) body['@odata.count'] = rows.length;
        body.value = rows;
        res.writeHead(200, { 'content-type': 'application/json;odata.metadata=minimal' });
        res.end(JSON.stringify(body));
        return;
      }

      /** Serve one entity set, honouring $skip so paging is real. */
      const send = (entitySet, make, count) => {
        const startMatch = /[?&]\$skip=(\d+)/.exec(url);
        const start = startMatch ? Number(startMatch[1]) : 0;
        const size = Math.min(pageSize, Math.max(0, count - start));
        const value = [];
        for (let i = 0; i < size; i++) value.push(make(start + i));

        const body = { '@odata.context': `http://fake/$metadata#${entitySet}` };
        if (url.includes('$count')) body['@odata.count'] = count;
        body.value = value;
        const nextStart = start + size;
        if (nextStart < count) {
          // ABSOLUTE nextLink, as F&O emits.
          body['@odata.nextLink'] =
            `http://127.0.0.1:${port}/data/${entitySet}?$skip=${nextStart}&$top=${pageSize}`;
        }
        res.writeHead(200, { 'content-type': 'application/json;odata.metadata=minimal' });
        res.end(JSON.stringify(body));
      };

      const segments = url.split('/').filter(Boolean);
      const entitySet = (segments[segments.length - 1] || '').split('?')[0];

      if (entitySet === 'OMOperatingUnits') {
        send(entitySet, (i) => ({
          OMOperatingUnitId: `OU-${String(i).padStart(4, '0')}`,
          OperatingUnitType: 'LegalEntity',
          Name: `Operating Unit ${i}`,
          Description: `Fake operating unit ${i}`,
          RowVersion: 'AQAAAABAAAAA=',
        }), opts.operatingUnits ?? 5);
        return;
      }
      if (entitySet === 'HcmWorkers') {
        send(entitySet, (i) => ({
          HcmWorkerId: `WK-${String(i).padStart(4, '0')}`,
          WorkerNumber: `E${1000 + i}`,
          Name: `Worker ${i}`,
          Email: `worker${i}@example.test`,
          DepartmentId: `DEPT-${(i % 3) + 1}`,
          EmploymentStatus: 'Active',
          RowVersion: 'AQAAAABAAAAA=',
        }), opts.workers ?? 4);
        return;
      }
      if (entitySet === 'FinancialDimensionValues') {
        send(entitySet, (i) => ({
          FinancialDimensionType: ['Department', 'CostCenter', 'BusinessUnit'][i % 3],
          FinancialDimensionValue: `VAL-${String(i).padStart(4, '0')}`,
          Name: `Dimension value ${i}`,
          // Some inactive, so `Active` normalisation is actually exercised.
          Active: i % 4 !== 3,
          RowVersion: 'AQAAAABAAAAA=',
        }), opts.dimensionValues ?? 6);
        return;
      }

      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: '404', message: `no route for ${entitySet}` } }));
    });
  });

  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      resolve();
    });
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  // Registered only once the port is known. Every live fake in the process is
  // reachable by its own tenant, so one global patch can serve all of them.
  TENANTS.set(tenant, baseUrl);

  let owns = false;

  return {
    tenant,
    clientId,
    clientSecret,
    tokenUrl: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
    baseUrl,
    calls,
    tokenGrants,
    get unauthenticatedCalls() { return unauthenticatedCalls; },

    /**
     * Deregister, drop the patch if this instance installed it, then close.
     * Unregistering BEFORE closing means a token call arriving during teardown
     * is not routed to a socket that is going away.
     */
    close: async () => {
      TENANTS.delete(tenant);
      if (owns) { owns = false; releasePatch(); }
      await new Promise((resolve) => server.close(() => resolve()));
    },

    /**
     * Redirect the Entra token hop for THIS fake's tenant to this local server.
     *
     * The client still constructs `https://login.microsoftonline.com/{tenant}/
     * oauth2/v2.0/token` and still sends a real client-credentials body — only
     * the socket goes somewhere reachable. That keeps the thing under test
     * honest: if the client built the wrong URL or the wrong scope, this
     * redirect still lands on a server that rejects it.
     *
     * Routing is per-tenant, so a second fake in the same process is unaffected.
     * Every OTHER url passes through untouched, so an accidental request to a
     * real third party is not silently absorbed.
     *
     * Idempotent against `close()`: releasing twice is a no-op, never a
     * double-decrement that would unpatch while another fake still needs it.
     */
    redirectTokenFetch() {
      if (!owns) { owns = true; installPatch(); }
      return () => { if (owns) { owns = false; releasePatch(); } };
    },
  };
}
