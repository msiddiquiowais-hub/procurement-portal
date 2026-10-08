// Minimal axios-free HTTP client — avoids pulling axios into a tiny scaffold.
// Surfaces server error messages cleanly; never throws on non-JSON bodies.

const BASE = process.env.NEXT_PUBLIC_API_BASE || 'http://localhost:33001';

function authHeader(): Record<string, string> {
  if (typeof window === 'undefined') return {};
  const raw = localStorage.getItem('pk_session');
  if (!raw) return {};
  try {
    const s = JSON.parse(raw);
    return s.token ? { Authorization: `Bearer ${s.token}` } : {};
  } catch {
    return {};
  }
}

async function request(method: string, path: string, body?: any) {
  let res: Response;

  // A request that never settles is indistinguishable from a slow one, and the
  // screen that made it just spins forever. Every call is therefore bounded, so
  // "the API is unreachable" surfaces as a readable error instead of a spinner
  // with no way out. Generous enough that a legitimately slow report still
  // succeeds, short enough that a hung socket is not a mystery.
  const TIMEOUT_MS = Number(process.env.NEXT_PUBLIC_API_TIMEOUT_MS || 20000);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...authHeader() },
      body: body ? JSON.stringify(body) : undefined,
      signal: ac.signal,
    });
  } catch (e: any) {
    clearTimeout(timer);
    if (e?.name === 'AbortError') {
      throw new Error(
        `The API did not respond within ${Math.round(TIMEOUT_MS / 1000)}s `
        + `(${method} ${path}). It may be restarting or unreachable at ${BASE}.`,
      );
    }
    throw new Error(`Network error — cannot reach API at ${BASE}: ${e?.message || e}`);
  }
  clearTimeout(timer);
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
    const err = new Error(`HTTP ${res.status}: ${msg}`) as ApiError;
    err.status = res.status;
    err.data = data;
    // Server-side validation returns per-field detail in `errors` (and softer
    // `warnings`). A form must show WHY a save was refused, not just that it
    // was — so these are carried on the error rather than collapsed into the
    // one-line message.
    err.errors = Array.isArray(data?.errors) ? data.errors : [];
    err.warnings = Array.isArray(data?.warnings) ? data.warnings : [];
    throw err;
  }
  return { data, status: res.status };
}

/** An HTTP failure that still carries the server's structured detail. */
export type ApiError = Error & {
  status: number;
  data: any;
  errors: string[];
  warnings: string[];
};

export const api = {
  get:  <T = any>(p: string) => request('GET', p) as Promise<{ data: T; status: number }>,
  post: <T = any>(p: string, b?: any) => request('POST', p, b) as Promise<{ data: T; status: number }>,
  put:  <T = any>(p: string, b?: any) => request('PUT', p, b) as Promise<{ data: T; status: number }>,
  /**
   * Partial update. Used by the Wave 5 settings screen, whose save is a subset of
   * the catalog rather than a whole collection — replacing the whole table would
   * mean reading every row to change one.
   */
  patch: <T = any>(p: string, b?: any) => request('PATCH', p, b) as Promise<{ data: T; status: number }>,
  /**
   * Delete. `b` travels as a body because some deletes here are audited ACTIONS,
   * not anonymous removals — unlinking a vendor from a line category is refused
   * without a reason, so the reason has to reach the server with the request.
   */
  del:  <T = any>(p: string, b?: any) => request('DELETE', p, b) as Promise<{ data: T; status: number }>,
};