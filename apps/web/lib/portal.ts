// The one shared helper behind the two Wave 5 Track F pages
// (`/vendor-portal/[token]` and `/buyer/award-matrix`). It exists for two
// reasons, both of them about being honest about what the API did and did not
// return:
//
//   1. FORMATTERS. An absent figure is an em-dash — never a zero, a blank cell or
//      a prototype literal. Nothing here hard-codes a currency: the vendor
//      portal renders `rfq.currency` off the RFQ, and only the matrix endpoint
//      happens to return a fixed 'PKR', so a hard-coded code would be a literal
//      the API did not send. `lib/ui.tsx`'s `pkr()` is therefore NOT reused here.
//
//   2. portalRequest — the vendor portal's ONLY transport. `lib/api.ts` is
//      deliberately not used on that page: it attaches the stored session's
//      Bearer token to every call, and the entire point of
//      `/vendor-portal/:token` is that the emailed link needs no account, no
//      password and no portal login. Sending a login's credentials on a link
//      that was minted to work without one is the bug, not the fix — and it
//      would also make the page depend on a session it must not require.
//      The error extraction below is deliberately identical to `lib/api.ts` so
//      both surfaces put the SERVER's own refusal on screen verbatim.

/**
 * Mirrors the private `BASE` in `lib/api.ts`, which cannot be edited in this
 * change. Both read the same variable and the same default, so the two agree
 * until that default is changed — at which point this one must be changed with
 * it. It is exported because the vendor portal needs a PLAIN URL for the
 * template download: that link has to be a bare <a href>, with no JavaScript
 * and no auth header, which is the feature.
 */
export const API_BASE = process.env.NEXT_PUBLIC_API_BASE || 'http://localhost:33001';

export type PortalError = Error & { status: number; errors: string[] };

/**
 * GET/POST with NO Authorization header and NO cookies. The token in the path
 * is the whole authorisation decision for these routes (see
 * vendor-portal.controller.ts), so nothing else is offered.
 */
export async function portalRequest<T = any>(
  method: 'GET' | 'POST',
  path: string,
  body?: any,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      credentials: 'omit',
      headers: { 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e: any) {
    throw new Error(`Network error — cannot reach API at ${API_BASE}: ${e?.message || e}`);
  }

  const text = await res.text();
  let data: any = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
  }

  if (!res.ok) {
    const rawMsg = data?.message;
    let msg: string;
    if (Array.isArray(rawMsg)) msg = rawMsg.join(', ');
    else if (typeof rawMsg === 'string') msg = rawMsg;
    else msg = `HTTP ${res.status} ${res.statusText}`;
    const err = new Error(`HTTP ${res.status}: ${msg}`) as PortalError;
    err.status = res.status;
    // Per-field detail, so a refused form says WHY rather than only that it was.
    err.errors = Array.isArray(data?.errors) ? data.errors : [];
    throw err;
  }
  return data as T;
}

/** An em-dash for a value the API did not supply. Never a zero, never a blank. */
export const dash = (v: unknown): string =>
  v === null || v === undefined || v === '' ? '—' : String(v);

/**
 * Money in the currency the API sent. The code is a prefix rather than a symbol
 * because the code is the data; a missing amount is a dash, never 0.
 */
export function money(
  amount: number | string | null | undefined,
  currency?: string | null,
): string {
  if (amount === null || amount === undefined || amount === '') return '—';
  const n = Number(amount);
  if (!Number.isFinite(n)) return '—';
  const body = n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return currency ? `${currency} ${body}` : body;
}

/** A real date, or a dash. Never the raw ISO string in a date cell. */
export function dateOnly(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? '—' : d.toISOString().slice(0, 10);
}

/** A real timestamp, or a dash. */
export function dateTime(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? '—' : d.toISOString().slice(0, 19).replace('T', ' ');
}
