import { strToU8, zipSync } from 'fflate';
import { parseCsv } from '../csv';
import { buildXlsx, columnLetter, neutralizeCell, readXlsx, toCsv } from '../spreadsheet';

describe('spreadsheet safety (R12, R50)', () => {
  it('neutralizes formula control characters but keeps phone numbers as text', () => {
    expect(neutralizeCell('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(neutralizeCell('@cmd')).toBe("'@cmd");
    expect(neutralizeCell('+cmd|/c calc')).toBe("'+cmd|/c calc");
    expect(neutralizeCell('-2+3')).toBe("'-2+3");
    expect(neutralizeCell('-15')).toBe('-15');
    expect(neutralizeCell('-cmd')).toBe("'-cmd");
    expect(neutralizeCell('\tfoo')).toBe("'\tfoo");
    expect(neutralizeCell('  =x')).toBe("'  =x");
    expect(neutralizeCell('+923001234567')).toBe('+923001234567');
    expect(neutralizeCell('Plain name')).toBe('Plain name');
  });

  it('produces RFC 4180 CSV with BOM and proper quoting', () => {
    const csv = toCsv([
      ['name', 'phone'],
      ['Doe, "Jane"', '+923001234567'],
      ['=HYPERLINK("x")', 'line\nbreak'],
    ]);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    const parsed = parseCsv(csv);
    expect(parsed.rows).toEqual([
      ['name', 'phone'],
      ['Doe, "Jane"', '+923001234567'],
      ["'=HYPERLINK(\"x\")", 'line\nbreak'],
    ]);
  });

  it('round-trips an xlsx workbook with strings and numbers', () => {
    const bytes = buildXlsx([
      { name: 'Contacts', rows: [['name', 'phone', 'count'], ['Ayesha', '+923001234567', 3], ['=evil', '03001234567', null]] },
      { name: 'Second/Sheet?', rows: [['x']] },
    ]);
    const result = readXlsx(bytes);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sheets.map((sheet) => sheet.name)).toEqual(['Contacts', 'Second Sheet ']);
    const rows = result.sheets[0].rows;
    expect(rows[1].map((cell) => cell.text)).toEqual(['Ayesha', '+923001234567', '3']);
    expect(rows[1][2].isNumeric).toBe(true);
    expect(rows[1][1].isNumeric).toBe(false);
    expect(rows[2][0].text).toBe("'=evil");
    expect(rows[2][1].text).toBe('03001234567');
  });

  it('flags formula cells, reads shared strings, and rejects encrypted or non-xlsx files', () => {
    const files = {
      '[Content_Types].xml': strToU8('<Types/>'),
      'xl/workbook.xml': strToU8(
        '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>',
      ),
      'xl/_rels/workbook.xml.rels': strToU8(
        '<Relationships><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
      ),
      'xl/sharedStrings.xml': strToU8('<sst><si><t>name</t></si><si><r><t>Rich </t></r><r><t>Text</t></r></si></sst>'),
      'xl/worksheets/sheet1.xml': strToU8(
        '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2"><f>SUM(1,2)</f><v>3</v></c><c r="C2"><v>3.001234567E9</v></c></row></sheetData></worksheet>',
      ),
    };
    const bytes = zipSync(files);
    const result = readXlsx(bytes);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const rows = result.sheets[0].rows;
    expect(rows[0].map((cell) => cell.text)).toEqual(['name', 'Rich Text']);
    expect(rows[1][0]).toMatchObject({ text: '3', isFormula: true, isNumeric: true });
    expect(rows[1][1]).toMatchObject({ text: '', isFormula: false });
    expect(rows[1][2]).toMatchObject({ text: '3.001234567E9', isNumeric: true });

    const encrypted = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]);
    expect(readXlsx(encrypted)).toEqual({ ok: false, reason: 'ENCRYPTED_OR_LEGACY' });
    expect(readXlsx(strToU8('not a workbook'))).toEqual({ ok: false, reason: 'NOT_XLSX' });
    expect(columnLetter(27)).toBe('AB');
  });
});
