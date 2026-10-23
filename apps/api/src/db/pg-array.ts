// Reading a Postgres ARRAY out of this API's database driver.
//
// WHY THIS IS A SHARED MODULE
// ---------------------------
// `DbService` does not speak the pg protocol. It shells out to `psql --csv`,
// which returns EVERY column as text (booleans aside — those arrive as 't'/'f'
// and are coerced). An `array_agg(...)` therefore arrives as the Postgres
// literal `'{1,2}'`: a STRING.
//
// So `(row.line_nos ?? []).map(...)` throws `map is not a function` at runtime,
// and the `?? []` does not save it — a non-empty string is truthy, so the
// default never fires. This codebase has written that parser four times
// (auth, rfq, quotation, and the award-shape builder that 500'd on the CS
// confirm) and each copy was a slightly different shape. One owner, so the
// fifth call site cannot be the one that gets it wrong.
//
// It cannot be fixed at the bridge: `psql --csv` does not report column types,
// so `parsePsqlOutput` has no way to know a text cell held an array.
//
// THE PARSE
// ---------
// Postgres array literals are `{a,b,c}`, with a double-quoted element when it
// contains a comma, a brace or a quote, and `""` for a literal quote inside one.
// A naive `split(',')` corrupts such an element, so quotes are honoured here.
// `NULL` elements are kept as the text 'NULL' by `pgArray` and discarded by
// `pgIntArray`, because a NULL line number is not line number zero.

/**
 * A Postgres array literal as string[], whichever shape the driver hands back.
 *
 * Accepts a real array (a pg driver that DID parse it), the `'{a,b}'` literal
 * the CSV bridge produces, or anything else — which yields `[]` rather than a
 * throw. `{}` is an empty array, not an array containing one empty element.
 */
export function pgArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((x) => (x === null || x === undefined ? '' : String(x)));
  }
  if (typeof value !== 'string') return [];

  const text = value.trim();
  if (text.length < 2 || text[0] !== '{' || text[text.length - 1] !== '}') return [];
  const inner = text.slice(1, -1);
  if (inner.trim() === '') return [];

  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (quoted) {
      if (ch === '"') {
        if (inner[i + 1] === '"') { cur += '"'; i++; } else { quoted = false; }
      } else {
        cur += ch;
      }
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === ',') { out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur.trim());
  return out;
}

/**
 * A Postgres integer array as number[].
 *
 * Empty elements and `NULL` are dropped rather than coerced: `Number('')`
 * is 0, and a phantom line 0 is worse than a short list — it is a line number
 * nothing was ever awarded on.
 */
export function pgIntArray(value: unknown): number[] {
  return pgArray(value)
    .filter((s) => s !== '' && s.toUpperCase() !== 'NULL')
    .map(Number)
    .filter((n) => Number.isFinite(n));
}