// CORS allow-list ↔ web client header contract.
//
// WHY THIS TEST EXISTS
// -------------------
// The Receive Quotation upload failed on every attempt with a bare
// "Failed to fetch". The cause was a two-word omission in `main.ts`:
// `allowedHeaders` listed content-type and authorization but NOT `x-file-name`
// (nor `x-file-kind`). Every JSON call in this app sends only the two listed
// headers, so the allow-list was exactly right for all of them — and the one
// call that carries a filename header was blocked by the BROWSER at the
// preflight, before the request left the machine.
//
// That failure mode is unusually well camouflaged, which is why it survived:
//
//   * Node's `fetch` does not enforce CORS. Every e2e script in this repo
//     uploads with `x-file-name` from Node and passed — including
//     `e2e_quote_receive.mjs`, which exercises the genuine upload path.
//   * The API never sees the request, so nothing appears in its logs.
//   * The browser's only word is `TypeError: Failed to fetch`.
//
// So the allow-list has to be checked against what the client ACTUALLY sends,
// by reading the client. Not by restating today's header list in a test, which
// would pass forever while the client moved on.
//
// Run with: node --test dist/__tests__/cors.headers.test.js (after build)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// Compiled layout: apps/api/dist/__tests__/ — up three is apps/, so the web
// client sits at ../../../web/lib/api.ts.
const API_SRC = join(__dirname, '..', '..', 'src', 'main.ts');
const WEB_SRC = join(__dirname, '..', '..', '..', 'web', 'lib', 'api.ts');

const read = (p: string) => readFileSync(p, 'utf8');

/** Every controller's source, concatenated for the @Headers() sweep. */
function readControllers(): string {
  const root = join(__dirname, '..', '..', 'src');
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      // `*.controller.ts` only. Sweeping every .ts under src also swept THIS
      // file, whose own doc comment quotes `@Headers('…')` — so the guard
      // reported a non-existent header named "…" that it had introduced itself.
      else if (entry.name.endsWith('.controller.ts')) out.push(read(full));
    }
  };
  walk(root);
  assert.ok(out.length > 0, `no controllers found under ${root}`);
  return out.join('\n');
}

/**
 * Standard HTTP headers whose names are valid JS identifiers, so the client can
 * write them as an UNQUOTED object key: `return { Authorization: … }`.
 *
 * Curated on purpose. Matching every unquoted `word:` would sweep in `status:`,
 * `data:` and every other property in the file; the only thing that separates a
 * header from an ordinary property here is that its name is a real header.
 */
const IDENTIFIER_HEADERS = new Set([
  'accept', 'authorization', 'origin', 'referer', 'user-agent',
]);

/**
 * Header names the web client puts on the wire.
 *
 * THREE syntaxes appear in the client and all three must be matched. This file's
 * own self-check caught the other two, one at a time:
 *
 *   1. quoted object key   `{ 'x-file-name': … }`
 *   2. computed assignment  `headers['x-file-kind'] = …`  (conditional)
 *   3. unquoted key         `{ Authorization: … }`         (valid identifier)
 *
 * A matcher that understands only the first two is blind to a header the client
 * genuinely sends — which is precisely how this bug's guard would have gone on
 * passing while the client changed shape underneath it.
 */
function clientHeaders(src: string): Set<string> {
  const out = new Set<string>();
  const forms = [
    /['"]([A-Za-z][A-Za-z0-9-]*)['"]\s*:/g,        // 1
    /\[['"]([A-Za-z][A-Za-z0-9-]*)['"]\]\s*=/g,    // 2
  ];
  for (const re of forms) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      const name = m[1];
      if (name.includes('-') || name.toLowerCase() === 'authorization') out.add(name.toLowerCase());
    }
  }
  const unquoted = /[{,]\s*([A-Za-z][A-Za-z0-9]*)\s*:/g;   // 3
  let m2: RegExpExecArray | null;
  while ((m2 = unquoted.exec(src))) {
    const name = m2[1].toLowerCase();
    if (IDENTIFIER_HEADERS.has(name)) out.add(name);
  }
  return out;
}

/**
 * Header names the API itself declares it reads, via `@Headers('…')`.
 *
 * The mirror image of the rule above: a header the API consumes is useless to a
 * browser unless CORS lets it through, and the browser is what supplies it.
 * This side is derived from the server, so it still catches the drift even if
 * the client is refactored into a form this file can no longer read.
 */
function serverReadHeaders(src: string): Set<string> {
  const out = new Set<string>();
  const re = /@Headers\(\s*['"]([^'"]+)['"]\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) out.add(m[1].trim().toLowerCase());
  return out;
}

/**
 * Headers the BROWSER controls, which are deliberately not in the CORS
 * negotiation.
 *
 * These are "forbidden header names" in the Fetch standard: script cannot set
 * them, the user agent supplies them itself, and they are never listed in
 * Access-Control-Request-Headers — so no allow-list entry is needed or wanted.
 * `ack.controller.ts` reads `user-agent` for the acknowledge audit trail, and
 * requiring that to be allow-listed would be wrong, not merely noisy.
 */
const BROWSER_CONTROLLED = new Set([
  'user-agent', 'origin', 'referer', 'host', 'content-length',
  'accept-encoding', 'connection', 'cookie', 'set-cookie', 'cache-control',
]);

/** Header names the API's CORS layer will accept, from `allowedHeaders`. */
function allowedHeaders(src: string): Set<string> {
  const block = /allowedHeaders:\s*\[([^\]]*)\]/.exec(src);
  assert.ok(block, 'main.ts no longer has an allowedHeaders array — find the CORS config');
  const out = new Set<string>();
  const re = /['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block![1]))) out.add(m[1].trim().toLowerCase());
  return out;
}

test('C1 the client header extractor actually finds the upload headers', () => {
  // The guard is worthless if it silently extracts nothing, which is the
  // default failure mode of a source-scraping matcher. Prove it can see the
  // exact headers this bug was about.
  const found = clientHeaders(read(WEB_SRC));
  assert.ok(found.has('x-file-name'), 'extractor lost x-file-name');
  assert.ok(found.has('x-file-kind'), 'extractor lost x-file-kind');
  assert.ok(found.has('content-type'), 'extractor lost content-type');
  assert.ok(found.has('authorization'), 'extractor lost authorization');
});

test('C2 every header the web client sends is allowed by the API CORS layer', () => {
  const sent = clientHeaders(read(WEB_SRC));
  const allowed = allowedHeaders(read(API_SRC));

  assert.ok(sent.size > 0, 'no client headers parsed — the extractor regressed');

  // The browser blocks the preflight when the server omits ANY header the
  // request carries, so this is an all-or-nothing set, not a majority.
  const blocked = [...sent].filter((h) => !allowed.has(h)).sort();

  assert.deepEqual(
    blocked, [],
    `CORS would BLOCK these headers at the browser preflight, so the calls that `
    + `send them fail with "Failed to fetch" and never reach the API: ${blocked.join(', ')}. `
    + `Add them to allowedHeaders in apps/api/src/main.ts.`,
  );
});

test('C3 the quotation upload contract headers are explicitly allowed', () => {
  // Pinned regardless of what the client does today: these two ARE the upload
  // contract. Both endpoints read them — POST /pr/:id/attachments and the
  // supplier portal's own quotation upload.
  const allowed = allowedHeaders(read(API_SRC));
  assert.ok(allowed.has('x-file-name'), 'x-file-name missing from allowedHeaders');
  assert.ok(allowed.has('x-file-kind'), 'x-file-kind missing from allowedHeaders');
});

test('C4 every header the API reads with @Headers() is allowed by CORS', () => {
  // The server-side half of the same invariant, so it still holds if the web
  // client is rewritten in a form this file can no longer read.
  const allowed = allowedHeaders(read(API_SRC));
  const read_ = serverReadHeaders(readControllers());
  assert.ok(read_.size > 0, 'no @Headers() found — the sweep regressed');

  // Browser-controlled headers are excluded: the user agent sets those itself
  // and never negotiates them at the preflight.
  const unreachable = [...read_]
    .filter((h) => !BROWSER_CONTROLLED.has(h))
    .filter((h) => !allowed.has(h))
    .sort();
  assert.deepEqual(
    unreachable, [],
    `the API reads these headers but CORS blocks them, so a browser can never `
    + `supply them: ${unreachable.join(', ')}. Add them to allowedHeaders.`,
  );
});