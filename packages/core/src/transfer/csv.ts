/** RFC 4180 CSV + the documented, reversible spreadsheet formula escape (docs/IMPORT-EXPORT.md "CSV v1"). */

export const CSV_COLUMNS = [
  'owned_card_id', 'catalog_card_id', 'custom_card_id', 'name', 'set_id', 'set_name', 'local_id', 'language', 'rarity', 'image_url', 'variant', 'variant_detail',
  'condition', 'acquisition_id', 'purchase_date', 'purchase_source', 'acquisition_notes', 'purchase_price_cents', 'purchase_currency', 'storage_location_id',
  'storage_location_name', 'storage_location_description', 'group_ids', 'group_names', 'group_descriptions', 'is_graded', 'grade_id', 'grading_company',
  'grading_company_label', 'grade', 'cert_number', 'grade_notes', 'manual_price_cents', 'manual_price_currency', 'notes', 'custom_card_notes',
  'custom_card_created_at', 'custom_card_updated_at', 'scan_session_id', 'scan_session_status', 'scan_session_started_at', 'scan_session_ended_at',
  'scan_session_notes', 'created_at', 'updated_at'
] as const;
export type CsvColumn = (typeof CSV_COLUMNS)[number];

/** Columns whose cells are structured (integers, booleans, timestamps, JSON arrays): never formula-escaped. */
const NON_TEXT = new Set<CsvColumn>([
  'purchase_price_cents', 'manual_price_cents', 'is_graded', 'group_ids', 'group_names', 'group_descriptions', 'custom_card_created_at',
  'custom_card_updated_at', 'scan_session_started_at', 'scan_session_ended_at', 'created_at', 'updated_at', 'purchase_date'
]);
export const isTextColumn = (column: CsvColumn): boolean => !NON_TEXT.has(column);

const TRIGGERS = new Set(['=', '+', '-', '@', '\t', '\r', '\n', "'"]);

/** Export: prefix one apostrophe when the raw text starts with a trigger character. */
export const escapeFormula = (text: string): string => (text.length > 0 && TRIGGERS.has(text[0] as string) ? `'${text}` : text);
/** Import: remove exactly one leading apostrophe, only when the next character is itself a trigger. */
export const unescapeFormula = (text: string): string => (text.length > 1 && text[0] === "'" && TRIGGERS.has(text[1] as string) ? text.slice(1) : text);

const needsQuotes = (cell: string): boolean => /[",\r\n]/.test(cell);
const quote = (cell: string): string => (needsQuotes(cell) ? `"${cell.replace(/"/g, '""')}"` : cell);

export function serializeCsv(rows: ReadonlyArray<ReadonlyArray<string>>): string {
  return `\uFEFF${rows.map((row) => row.map(quote).join(',')).join('\r\n')}\r\n`;
}

export class CsvSyntaxError extends Error {}

/** Strict RFC 4180 parser: BOM tolerated, quoted newlines supported, CRLF or LF row ends, ragged rows rejected. */
export function parseCsv(input: string): string[][] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  let cellStarted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] as string;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i += 1; } else inQuotes = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"') {
      if (cell !== '' || cellStarted) throw new CsvSyntaxError('Unexpected quote inside an unquoted cell');
      inQuotes = true;
      cellStarted = true;
    } else if (ch === ',') {
      row.push(cell); cell = ''; cellStarted = false;
    } else if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(cell); cell = ''; cellStarted = false;
      rows.push(row); row = [];
    } else {
      cell += ch;
      cellStarted = true;
    }
  }
  if (inQuotes) throw new CsvSyntaxError('Unterminated quoted cell');
  if (cell !== '' || cellStarted || row.length > 0) { row.push(cell); rows.push(row); }
  const width = rows[0]?.length ?? 0;
  rows.forEach((r, index) => {
    if (r.length !== width) throw new CsvSyntaxError(`Row ${index + 1} has ${r.length} cells, expected ${width}`);
  });
  return rows.filter((r) => !(r.length === 1 && r[0] === '')); // ignore blank lines
}
