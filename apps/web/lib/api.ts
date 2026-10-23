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

/**
 * Upload one file as a RAW body, not base64 in a JSON envelope.
 *
 * Exported because the attachment endpoint reads the stream directly: the size
 * ceiling must be the CONFIGURED one rather than a framework default, and the
 * bytes must never be inflated ~33% by encoding just to travel in JSON. The
 * filename travels in `x-file-name` so no envelope is needed at all.
 *
 * The session token comes from the same place every other call reads it, so an
 * upload cannot silently go out unauthenticated.
 *
 * A network failure here is WRAPPED, exactly as `request()` wraps its own. This
 * used to let the browser's own `TypeError: Failed to fetch` escape untouched,
 * which is what the Receive Quotation screen showed when a CORS preflight
 * rejected the upload header: a message with no URL, no method, and no cause,
 * on the one screen where an officer is committing a vendor's price. The same
 * bounded timeout applies too — an upload that hangs must not pin the Save
 * button forever, and the ceiling is generous enough for a large package.
 */
export async function uploadFile(
  path: string,
  file: File,
  opts: { fileName?: string; contentType?: string; kind?: 'image' } = {},
): Promise<any> {
  const headers: Record<string, string> = {
    'x-file-name': opts.fileName || file.name || 'upload.bin',
    'content-type': opts.contentType || file.type || 'application/octet-stream',
    ...authHeader(),
  };
  if (opts.kind) headers['x-file-kind'] = opts.kind;

  const TIMEOUT_MS = Number(process.env.NEXT_PUBLIC_API_TIMEOUT_MS || 20000);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, { method: 'POST', headers, body: file, signal: ac.signal });
  } catch (e: any) {
    if (e?.name === 'AbortError') {
      throw new Error(
        `The upload did not complete within ${Math.round(TIMEOUT_MS / 1000)}s. `
        + `Check the API is reachable at ${BASE} and try again.`,
      );
    }
    throw new Error(
      `Upload failed — the API at ${BASE} could not be reached `
      + `(${e?.message || e}). Nothing was attached; the quotation was not saved.`,
    );
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  if (!res.ok) {
    let msg = `upload failed (${res.status})`;
    try { msg = JSON.parse(text).message || msg; } catch { /* non-JSON body */ }
    throw new Error(msg);
  }
  try { return JSON.parse(text); } catch { return text; }
}

/**
 * Fetch an authenticated binary (currently attachment downloads) and save it.
 *
 * `window.open('/attachments/<id>/download')` is NOT an option: the endpoint is
 * behind JwtAuthGuard and reads the bearer token from the Authorization header,
 * which a plain navigation cannot send. Opening it unauthenticated returns 401
 * and the buyer sees a blank tab and no explanation.
 *
 * So the bytes are fetched here — token attached, failures surfaced with the
 * server's own message — and handed to the browser as an object URL.
 *
 * The anchor is clicked and then its object URL revoked. Without the revoke,
 * every view pins the file's bytes in memory for the life of the tab, and
 * this screen is re-rendered on every refresh, which is exactly the pattern
 * that turns a long procurement session into a slow one.
 */
export async function downloadFile(attachmentId: string, fallbackName = 'attachment'): Promise<void> {
  const TIMEOUT_MS = Number(process.env.NEXT_PUBLIC_API_TIMEOUT_MS || 20000);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${BASE}/attachments/${attachmentId}/download`, {
      headers: authHeader(),
      signal: ac.signal,
    });
  } catch (e: any) {
    clearTimeout(timer);
    if (e?.name === 'AbortError') {
      throw new Error(`The download did not complete within ${Math.round(TIMEOUT_MS / 1000)}s.`);
    }
    throw new Error(`Could not reach the API at ${BASE}: ${e?.message || e}`);
  }
  clearTimeout(timer);

  if (!res.ok) {
    let msg = `download failed (${res.status})`;
    try { msg = JSON.parse(await res.text()).message || msg; } catch { /* non-JSON body */ }
    throw new Error(msg);
  }

  // Prefer the filename the server derived over ours: it is sanitised there and
  // is the name the vendor's document actually has on file.
  const disposition = res.headers.get('content-disposition') || '';
  const match = /filename\*=UTF-8''([^;]+)|filename="?([^";]+)"?/i.exec(disposition);
  const name = match ? decodeURIComponent(match[1] || match[2]) : fallbackName;

  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

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