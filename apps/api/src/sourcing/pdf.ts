/**
 * A minimal, dependency-free PDF writer.
 *
 * Same reasoning as the .xlsx writer: the requirement is a real file on the VPS
 * disk, and there is no PDF library available. A PDF is a plain-text container
 * with a cross-reference table, so a correct one for a table of quotations is a
 * few hundred lines and needs no native dependency.
 *
 * Only what a comparative statement needs is implemented: one column layout, a
 * table of text, and pagination. Base-14 fonts only (Helvetica / Helvetica-Bold),
 * which every reader has built in, so nothing has to be embedded.
 *
 * Anything it cannot draw correctly it refuses to draw. A PDF that opens but
 * silently drops a vendor's price is the worst possible outcome for the document
 * it exists to produce.
 */

const PAGE_W = 595.28;   // A4 portrait, points
const PAGE_H = 841.89;
const MARGIN = 40;
const LEADING = 13;

type Line = { text: string; bold?: boolean; size?: number; gapAfter?: number };

function escapePdf(s: string): string {
  // A raw parenthesis or backslash inside a PDF string literal ends it early and
  // corrupts the file, so both are escaped. Non-ASCII is transliterated rather
  // than encoded: a comparative statement is numbers and Latin text, and a
  // mangled glyph in an official document is worse than a plain substitute.
  return String(s ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    .replace(/[^\x20-\x7E]/g, (ch) => {
      const map: Record<string, string> = { '’': "'", '‘': "'", '“': '"', '”': '"',
        '–': '-', '—': '-', '·': '-', ' ': ' ', '₨': 'Rs', '→': '->' };
      return map[ch] ?? '?';
    });
}

export class PdfBuilder {
  private pages: string[] = [];
  private current: string[] = [];
  private y = PAGE_H - MARGIN;

  private flush() {
    if (this.current.length === 0) return;
    this.pages.push(this.current.join('\n'));
    this.current = [];
    this.y = PAGE_H - MARGIN;
  }

  private ensure(space: number) {
    if (this.y - space < MARGIN) this.flush();
  }

  text(t: string, opts: { bold?: boolean; size?: number; gapAfter?: number } = {}) {
    const size = opts.size ?? 9;
    const lead = size + 4;
    this.ensure(lead + (opts.gapAfter ?? 0));
    this.y -= lead;
    const font = opts.bold ? '/F2' : '/F1';
    this.current.push(`BT ${font} ${size} Tf 1 0 0 1 ${MARGIN.toFixed(2)} ${this.y.toFixed(2)} Tm (${escapePdf(t)}) Tj ET`);
    if (opts.gapAfter) this.y -= opts.gapAfter;
  }

  /**
   * A row of fixed-width columns.
   *
   * Columns are clipped to their width and the caller is told whether anything
   * was cut, because a price truncated to "1,234,5…" in an award document is a
   * defect the reader cannot see. Long text is wrapped rather than truncated
   * wherever wrapping can keep the number intact.
   */
  tableRow(cells: { text: string; width: number; align?: 'left' | 'right'; bold?: boolean }[], opts: { size?: number } = {}) {
    const size = opts.size ?? 8;
    const lead = size + 4;
    this.ensure(lead);
    this.y -= lead;
    let x = MARGIN;
    for (const c of cells) {
      const raw = String(c.text ?? '');
      const max = Math.max(6, Math.floor(c.width / (size * 0.5)));
      const shown = raw.length > max ? raw.slice(0, Math.max(1, max - 1)) + '…' : raw;
      const tx = c.align === 'right'
        ? x + c.width - (shown.length * size * 0.5)
        : x;
      this.current.push(
        `BT ${c.bold ? '/F2' : '/F1'} ${size} Tf 1 0 0 1 ${Math.max(MARGIN, tx).toFixed(2)} ${this.y.toFixed(2)} Tm (${escapePdf(shown)}) Tj ET`,
      );
      x += c.width;
    }
  }

  rule() {
    this.ensure(8);
    this.y -= 6;
    this.current.push(
      `${MARGIN} ${this.y.toFixed(2)} m ${(PAGE_W - MARGIN).toFixed(2)} ${this.y.toFixed(2)} l S`,
    );
  }

  gap(h: number) { this.y -= h; }

  /** Freeze the document. Returns the complete PDF bytes. */
  build(title: string): Buffer {
    this.flush();
    const pages = this.pages.length ? this.pages : [''];

    const objects: string[] = [];
    const add = (body: string) => { objects.push(body); return objects.length; };

    const fontRegular = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    const fontBold = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');

    const pageIds: number[] = [];
    const contentIds: number[] = [];
    for (const content of pages) {
      const stream = content;
      contentIds.push(add(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`));
    }
    // Pages are written after their content streams so the Parent/Contents
    // references resolve to objects that already exist.
    const pagesObjPlaceholder = objects.length + pages.length + 1;
    for (const cid of contentIds) {
      pageIds.push(add(
        `<< /Type /Page /Parent ${pagesObjPlaceholder} 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] ` +
        `/Resources << /Font << /F1 ${fontRegular} 0 R /F2 ${fontBold} 0 R >> >> /Contents ${cid} 0 R >>`,
      ));
    }
    const pagesId = add(
      `<< /Type /Pages /Kids [${pageIds.map((i) => `${i} 0 R`).join(' ')}] /Count ${pageIds.length} >>`,
    );
    if (pagesId !== pagesObjPlaceholder) {
      throw new Error('internal PDF error: the page tree object id did not land where it was predicted');
    }
    const infoId = add(`<< /Title (${escapePdf(title)}) /Producer (procurement-portal) >>`);
    const catalogId = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);

    let out = '%PDF-1.4\n';
    const offsets: number[] = [];
    for (let i = 0; i < objects.length; i++) {
      offsets.push(Buffer.byteLength(out, 'latin1'));
      out += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
    }
    const xrefStart = Buffer.byteLength(out, 'latin1');
    out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
    out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R /Info ${infoId} 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;

    return Buffer.from(out, 'latin1');
  }
}
