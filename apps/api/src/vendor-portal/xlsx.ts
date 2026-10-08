import { deflateRawSync, inflateRawSync } from 'node:zlib';

/**
 * A minimal, dependency-free .xlsx writer and reader.
 *
 * WHY THIS EXISTS RATHER THAN A LIBRARY
 * -------------------------------------
 * The requirement is that a vendor downloads a system-generated Excel template
 * and re-uploads the filled file. That needs a real OOXML package - a ZIP of XML
 * parts - in both directions, and this project has no spreadsheet dependency and
 * no reliable way to add one. A "CSV with an .xlsx name" would be a lie the
 * vendor discovers on their machine, and a text file with the right extension is
 * exactly the kind of fabricated success this codebase refuses to ship.
 *
 * So this writes and reads the real thing. The output opens in Excel, LibreOffice
 * and Google Sheets, and the reader accepts what those tools produce.
 *
 * SCOPE, STATED PLAINLY
 * --------------------
 * Deliberately minimal, and anything unsupported RAISES rather than silently
 * producing a file that looks right and is not:
 *   - one worksheet (the RFQ pack)
 *   - inline strings, numbers and formulas as their literal values
 *   - no styling, no charts, no macros, no shared strings table
 * A vendor template needs none of those, and every one of them is another way
 * for the file to be subtly wrong.
 */

// ─── CRC-32 ──────────────────────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ─── ZIP ─────────────────────────────────────────────────────────────────────
type ZipEntry = { name: string; data: Buffer };

/**
 * DEFLATE, with STORE as the fallback for anything the compressor will not
 * shrink. A stored entry is still a valid ZIP entry, so the package opens
 * everywhere; what changes is only the file size.
 */
function zip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const crc = crc32(e.data);
    let method = 8;
    let payload = deflateRawSync(e.data);
    if (payload.length >= e.data.length) { method = 0; payload = e.data; }

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);           // version needed
    local.writeUInt16LE(0, 6);            // flags
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);           // mod time - fixed, so the file is reproducible
    local.writeUInt16LE(0x21, 12);        // mod date = 1980-01-01
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(e.data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);         // extra
    central.writeUInt16LE(0, 32);         // comment
    central.writeUInt16LE(0, 34);         // disk
    central.writeUInt16LE(0, 36);         // internal attrs
    central.writeUInt32LE(0, 38);         // external attrs
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + payload.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralBuf, end]);
}

/** Read every entry of a ZIP. Raises if the file is not a ZIP at all. */
function unzip(buf: Buffer): Map<string, Buffer> {
  // Locate the End Of Central Directory record by scanning backwards, because the
  // comment field is variable-length and its size is the only thing that tells
  // you where the record starts.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 22 - 65535; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a ZIP archive — the uploaded file is not a valid .xlsx');

  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map<string, Buffer>();

  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('corrupt ZIP central directory');
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');

    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.slice(dataStart, dataStart + compSize);
    out.set(name, method === 0 ? raw : inflateRawSync(raw));

    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

// ─── XML escaping ───────────────────────────────────────────────────────────
function esc(v: unknown): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
    // Control characters are ILLEGAL in XML 1.0 and Excel refuses the file
    // outright if one survives. Dropping them is better than a corrupt package.
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
}

export type CellValue = string | number | null;
export type Sheet = { name: string; rows: CellValue[][] };

function colName(i: number): string {
  let s = '';
  let n = i + 1;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function sheetXml(rows: CellValue[][]): string {
  const body = rows.map((row, ri) => {
    if (!row.length) return `<row r="${ri + 1}"/>`;
    const cells = row.map((v, ci) => {
      const ref = `${colName(ci)}${ri + 1}`;
      if (v === null || v === undefined || v === '') return `<c r="${ref}"/>`;
      if (typeof v === 'number' && Number.isFinite(v)) return `<c r="${ref}"><v>${v}</v></c>`;
      return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
    }).join('');
    return `<row r="${ri + 1}">${cells}</row>`;
  }).join('');

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`;
}

/** Build a real .xlsx package from one worksheet. */
export function buildXlsx(sheet: Sheet): Buffer {
  const sheetName = (sheet.name || 'Sheet1').replace(/[\\/?*\[\]:]/g, '-').slice(0, 31);

  return zip([
    {
      name: '[Content_Types].xml',
      data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`, 'utf8'),
    },
    {
      name: '_rels/.rels',
      data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`, 'utf8'),
    },
    {
      name: 'xl/workbook.xml',
      data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="${esc(sheetName)}" sheetId="1" r:id="rId1"/></sheets>
</workbook>`, 'utf8'),
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`, 'utf8'),
    },
    { name: 'xl/worksheets/sheet1.xml', data: Buffer.from(sheetXml(sheet.rows), 'utf8') },
  ]);
}

/**
 * Read the first worksheet of an .xlsx back into rows.
 *
 * Handles inline strings AND a sharedStrings table, because Excel and
 * LibreOffice write the latter by default. Formulas are read as their cached
 * value, which is what a vendor's filled-in number actually is.
 */
export function readXlsx(buf: Buffer): Sheet {
  const parts = unzip(buf);

  const shared: string[] = [];
  const sst = parts.get('xl/sharedStrings.xml');
  if (sst) {
    const xml = sst.toString('utf8');
    for (const m of xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
      // A run may be split across <r><t> parts; concatenate every <t> in order.
      const parts2 = [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => unescapeXml(t[1]));
      shared.push(parts2.join(''));
    }
  }

  const sheetXmlText = parts.get('xl/worksheets/sheet1.xml');
  if (!sheetXmlText) {
    throw new Error('the uploaded workbook has no first worksheet — is this really an .xlsx file?');
  }
  const xml = sheetXmlText.toString('utf8');

  const rows: CellValue[][] = [];
  for (const rowM of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells: CellValue[] = [];
    for (const c of rowM[1].matchAll(/<c\b([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = c[1] || '';
      const body = c[2] || '';
      const refM = /r="([A-Z]+)\d+"/.exec(attrs);
      const col = refM ? colIndex(refM[1]) : cells.length;

      const type = /t="([^"]+)"/.exec(attrs)?.[1];
      let value: CellValue = null;

      if (type === 'inlineStr') {
        value = [...body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => unescapeXml(t[1])).join('');
      } else if (type === 's') {
        const idx = Number(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? NaN);
        value = shared[idx] ?? null;
      } else if (type === 'str') {
        value = unescapeXml(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '');
      } else {
        // Numeric, or a formula's cached value. `t` absent or t="n".
        const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
        if (v !== undefined && v !== '') {
          const n = Number(v);
          value = Number.isFinite(n) ? n : unescapeXml(v);
        }
      }
      while (cells.length < col) cells.push(null);
      cells[col] = value;
    }
    rows.push(cells);
  }
  return { name: 'Sheet1', rows };
}

function colIndex(letters: string): number {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}
