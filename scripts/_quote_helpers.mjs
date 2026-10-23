// Shared helper for every e2e suite that records a quotation through the
// procurement Receive Quotation path.
//
// WHY THIS FILE EXISTS
// --------------------
// That path enforces a FORM CONTRACT: lead time, a validity date, payment terms
// and the vendor's own uploaded document are all mandatory. Six suites record
// quotations and none of them shared this knowledge, so tightening the contract
// broke all six at the same moment, each needing its own hand-edit of three or
// four fields.
//
// The contract is deliberately re-implemented HERE rather than imported from the
// API, because these suites run over HTTP against a built server. If the server's
// required set ever drifts from this one, the suites fail loudly with a message
// naming the missing field — which is the behaviour you want from a test that
// exists to detect drift.
//
// WHAT IT GIVES YOU
//   attachQuoteDoc(prId, token, name?) -> attachment id
//   quoteBody(vendorId, lines, extra?) -> a body that satisfies the contract
//
// Usage:
//   const q = await api(`/rfq/${rfqId}/quotations`, {
//     method: 'POST', token: proc,
//     body: quoteBody(vendorId, [{ rfqLineNo: 1, unitPrice: 12500 }]),
//   });

const API = process.env.API_BASE || 'http://127.0.0.1:33001';

/**
 * The procurement form's required terms. Keep in step with
 * QuotationService.REQUIRED_FORM_FIELDS.
 */
export const REQUIRED_TERMS = {
  leadTimeDays: 7,
  validUntil: '2026-12-31',
  paymentTerms: '30 Days Net',
};

/**
 * Upload a minimal but REAL PDF and return the attachment id the API returns.
 *
 * Uploaded as a raw body with the filename in `x-file-name` — the same contract
 * the browser uses — so this exercises the genuine upload path, size ceiling and
 * sha256 write rather than a shortcut no real caller takes.
 *
 * The content is a tiny valid-enough PDF: the endpoint hashes and stores bytes,
 * it does not parse them, but a real `%PDF-` header keeps the stored artefact
 * recognisable if anyone opens it.
 */
export async function attachQuoteDoc(prId, token, name = 'e2e-quotation.pdf') {
  const bytes = Buffer.from(
    `%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n` +
    `% e2e quotation document ${new Date().toISOString()}\n%%EOF\n`,
    'utf8',
  );
  const r = await fetch(`${API}/pr/${prId}/attachments`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'x-file-name': name,
      'content-type': 'application/pdf',
    },
    body: bytes,
  });
  const text = await r.text();
  if (!r.ok) {
    throw new Error(`quote-document upload failed (${r.status}): ${text.slice(0, 200)}`);
  }
  const j = JSON.parse(text);
  return j.attachment_id || j.file_id || j.id;
}

/**
 * A body that satisfies the Receive Quotation contract.
 *
 * `prId` is required because a quotation without a document is now refused —
 * pass it so the helper can upload one. `extra` lets a suite override any
 * single field (e.g. to drop payment terms and assert the refusal).
 */
export async function quoteBody(prId, token, vendorId, lines, extra = {}) {
  const needsDoc = !('attachmentId' in extra);
  const attachmentId = needsDoc ? await attachQuoteDoc(prId, token) : extra.attachmentId;
  return {
    vendorId,
    quoteMode: 'per_line',
    ...REQUIRED_TERMS,
    lines,
    ...(attachmentId ? { attachmentId } : {}),
    ...extra,
  };
}