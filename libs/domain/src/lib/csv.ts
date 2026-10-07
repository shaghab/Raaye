import Papa from 'papaparse';

export interface CsvParseResult {
  rows: string[][];
  errors: { row: number; message: string }[];
}

/** Parse CSV text supporting a BOM, quoted values, and CRLF/LF/CR newlines. */
export function parseCsv(text: string): CsvParseResult {
  const withoutBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const result = Papa.parse<string[]>(withoutBom, {
    skipEmptyLines: 'greedy',
    header: false,
    dynamicTyping: false,
  });
  return {
    rows: result.data.map((row) => row.map((cell) => (cell ?? '').toString())),
    errors: result.errors.map((error) => ({ row: (error.row ?? 0) + 1, message: error.message })),
  };
}
