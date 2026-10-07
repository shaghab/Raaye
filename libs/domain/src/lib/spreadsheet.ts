import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { XMLParser } from 'fast-xml-parser';

const FORMULA_PREFIX = /^[=@\t\r\n]/;
const SIGNED_NUMERIC = /^[+-][\d\s().-]*\d[\d\s().-]*$/;

/**
 * Neutralize spreadsheet formula injection. Cells starting with =, @, tab or newline,
 * or with + / - followed by anything other than a plain numeric/phone pattern, are
 * prefixed with an apostrophe. E.164 phone numbers such as +923001234567 are kept as
 * text because a sign followed only by digits cannot execute code.
 */
export function neutralizeCell(value: string): string {
  if (!value) return value;
  if (FORMULA_PREFIX.test(value)) return `'${value}`;
  if ((value.startsWith('+') || value.startsWith('-')) && !SIGNED_NUMERIC.test(value)) return `'${value}`;
  if (/^\s+[=@+-]/.test(value)) return `'${value}`;
  return value;
}

export type CsvValue = string | number | null | undefined;

export function csvEscape(value: CsvValue): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  const text = neutralizeCell(value);
  if (/[",\r\n]/.test(text) || text !== text.trim()) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

/** RFC 4180 CSV with a UTF-8 BOM so spreadsheet applications read UTF-8 correctly. */
export function toCsv(rows: readonly CsvValue[][]): string {
  return `\uFEFF${rows.map((row) => row.map(csvEscape).join(',')).join('\r\n')}\r\n`;
}

export interface ParsedCell {
  text: string;
  isFormula: boolean;
  isNumeric: boolean;
}

export interface ParsedSheet {
  name: string;
  rows: ParsedCell[][];
}

export type XlsxReadResult =
  | { ok: true; sheets: ParsedSheet[] }
  | { ok: false; reason: 'ENCRYPTED_OR_LEGACY' | 'NOT_XLSX' | 'CORRUPT' | 'TOO_LARGE' };

const MAX_ENTRY_BYTES = 60 * 1024 * 1024;

function xmlText(node: unknown): string {
  if (node === null || node === undefined) return '';
  if (typeof node === 'string' || typeof node === 'number' || typeof node === 'boolean') return String(node);
  if (Array.isArray(node)) return node.map(xmlText).join('');
  if (typeof node === 'object') {
    const record = node as Record<string, unknown>;
    if ('#text' in record) return xmlText(record['#text']);
    // Rich text runs: <r><t>..</t></r>
    let out = '';
    for (const key of ['t', 'r']) if (key in record) out += xmlText(record[key]);
    return out;
  }
  return '';
}

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

export function columnIndexFromRef(ref: string): number {
  const letters = /^[A-Z]+/i.exec(ref)?.[0]?.toUpperCase() ?? 'A';
  let index = 0;
  for (const char of letters) index = index * 26 + (char.charCodeAt(0) - 64);
  return index - 1;
}

export function columnLetter(index: number): string {
  let n = index + 1;
  let letters = '';
  while (n > 0) {
    const remainder = (n - 1) % 26;
    letters = String.fromCharCode(65 + remainder) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

/**
 * Minimal, dependency-light XLSX reader. Formulas are never evaluated: a cell with a
 * formula is flagged so the import can reject it. Numeric cells keep their raw textual
 * representation so they are never coerced through floating-point arithmetic.
 */
export function readXlsx(bytes: Uint8Array): XlsxReadResult {
  if (bytes.length >= 8 && bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) {
    return { ok: false, reason: 'ENCRYPTED_OR_LEGACY' };
  }
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) return { ok: false, reason: 'NOT_XLSX' };
  let files: Record<string, Uint8Array>;
  try {
    let tooLarge = false;
    files = unzipSync(bytes, {
      filter: (file) => {
        if (file.originalSize > MAX_ENTRY_BYTES) tooLarge = true;
        return file.originalSize <= MAX_ENTRY_BYTES;
      },
    });
    if (tooLarge) return { ok: false, reason: 'TOO_LARGE' };
  } catch {
    return { ok: false, reason: 'CORRUPT' };
  }
  const workbookXml = files['xl/workbook.xml'];
  if (!workbookXml) return { ok: false, reason: 'NOT_XLSX' };
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    removeNSPrefix: true,
    parseTagValue: false,
    parseAttributeValue: false,
    trimValues: false,
    isArray: (name) => ['sheet', 'Relationship', 'row', 'c', 'si', 'r'].includes(name),
  });
  try {
    const workbook = parser.parse(strFromU8(workbookXml)) as Record<string, unknown>;
    const rels = parser.parse(strFromU8(files['xl/_rels/workbook.xml.rels'] ?? strToU8('<Relationships/>'))) as Record<string, unknown>;
    const relMap = new Map<string, string>();
    const relationships = (rels['Relationships'] as Record<string, unknown> | undefined)?.['Relationship'];
    for (const rel of asArray(relationships as Record<string, string>[] | undefined)) {
      const target = rel['@_Target'] ?? '';
      relMap.set(rel['@_Id'] ?? '', target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`);
    }
    const sharedStrings: string[] = [];
    if (files['xl/sharedStrings.xml']) {
      const sst = parser.parse(strFromU8(files['xl/sharedStrings.xml'])) as Record<string, unknown>;
      const items = (sst['sst'] as Record<string, unknown> | undefined)?.['si'];
      for (const item of asArray(items as unknown[])) sharedStrings.push(xmlText(item));
    }
    const sheetsNode = (workbook['workbook'] as Record<string, unknown> | undefined)?.['sheets'] as Record<string, unknown> | undefined;
    const sheets: ParsedSheet[] = [];
    for (const sheet of asArray(sheetsNode?.['sheet'] as Record<string, string>[] | undefined)) {
      const name = sheet['@_name'] ?? `Sheet${sheets.length + 1}`;
      const path = relMap.get(sheet['@_id'] ?? '') ?? '';
      const sheetXml = files[path];
      if (!sheetXml) continue;
      const parsed = parser.parse(strFromU8(sheetXml)) as Record<string, unknown>;
      const sheetData = (parsed['worksheet'] as Record<string, unknown> | undefined)?.['sheetData'] as Record<string, unknown> | undefined;
      const rows: ParsedCell[][] = [];
      for (const row of asArray(sheetData?.['row'] as Record<string, unknown>[] | undefined)) {
        const rowIndex = Number(row['@_r'] ?? rows.length + 1) - 1;
        const cells: ParsedCell[] = [];
        let fallbackColumn = 0;
        for (const cell of asArray(row['c'] as Record<string, unknown>[] | undefined)) {
          const ref = typeof cell['@_r'] === 'string' ? cell['@_r'] : '';
          const column = ref ? columnIndexFromRef(ref) : fallbackColumn;
          fallbackColumn = column + 1;
          const type = typeof cell['@_t'] === 'string' ? cell['@_t'] : 'n';
          const isFormula = cell['f'] !== undefined;
          let text = '';
          let isNumeric = false;
          if (type === 's') {
            const index = Number(xmlText(cell['v']));
            text = sharedStrings[index] ?? '';
          } else if (type === 'inlineStr') {
            text = xmlText(cell['is']);
          } else if (type === 'str' || type === 'e') {
            text = xmlText(cell['v']);
          } else if (type === 'b') {
            text = xmlText(cell['v']) === '1' ? 'TRUE' : 'FALSE';
          } else {
            text = xmlText(cell['v']);
            isNumeric = text !== '';
          }
          cells[column] = { text, isFormula, isNumeric };
        }
        for (let i = 0; i < cells.length; i += 1) if (!cells[i]) cells[i] = { text: '', isFormula: false, isNumeric: false };
        rows[rowIndex] = cells;
      }
      for (let i = 0; i < rows.length; i += 1) if (!rows[i]) rows[i] = [];
      sheets.push({ name, rows });
    }
    return { ok: true, sheets };
  } catch {
    return { ok: false, reason: 'CORRUPT' };
  }
}

export type XlsxCell = string | number | null | undefined;

export interface XlsxSheet {
  name: string;
  rows: readonly XlsxCell[][];
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    // Strip control characters that are invalid in XML 1.0.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
}

function sheetXml(sheet: XlsxSheet): string {
  const rows = sheet.rows
    .map((row, rowIndex) => {
      const cells = row
        .map((value, columnIndex) => {
          if (value === null || value === undefined) return '';
          const ref = `${columnLetter(columnIndex)}${rowIndex + 1}`;
          if (typeof value === 'number') {
            return Number.isFinite(value) ? `<c r="${ref}"><v>${value}</v></c>` : '';
          }
          const text = neutralizeCell(String(value));
          return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(text)}</t></is></c>`;
        })
        .join('');
      return `<row r="${rowIndex + 1}">${cells}</row>`;
    })
    .join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`;
}

/** Build an .xlsx workbook. Strings are written as inline string cells; never as formulas. */
export function buildXlsx(sheets: readonly XlsxSheet[]): Uint8Array {
  const safeSheets = sheets.map((sheet, index) => ({
    ...sheet,
    name: (sheet.name || `Sheet${index + 1}`).replace(/[\\/*?:[\]]/g, ' ').slice(0, 31),
  }));
  const files: Record<string, Uint8Array> = {};
  files['[Content_Types].xml'] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${safeSheets
      .map((_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`)
      .join('')}</Types>`,
  );
  files['_rels/.rels'] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
  );
  files['xl/workbook.xml'] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${safeSheets
      .map((sheet, index) => `<sheet name="${xmlEscape(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`)
      .join('')}</sheets></workbook>`,
  );
  files['xl/_rels/workbook.xml.rels'] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${safeSheets
      .map((_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`)
      .join('')}<Relationship Id="rId${safeSheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
  );
  files['xl/styles.xml'] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs></styleSheet>`,
  );
  safeSheets.forEach((sheet, index) => {
    files[`xl/worksheets/sheet${index + 1}.xml`] = strToU8(sheetXml(sheet));
  });
  return zipSync(files, { level: 6 });
}
