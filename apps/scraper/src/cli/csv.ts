/** One CSV line (RFC 4180): a cell with a comma, quote or line break is quoted, quotes doubled. */
export function csvLine(cells: readonly string[]): string {
  return cells.map((c) => (/[",\r\n]/.test(c) ? `"${c.replaceAll('"', '""')}"` : c)).join(',');
}

/**
 * A small RFC 4180 reader: comma separated, double quotes for fields that hold
 * commas, quotes or line breaks ("" is a quote), CRLF or LF line ends.
 * Returns the rows with the line each started on; blank lines are skipped.
 */
export function parseCsv(text: string): Array<{ line: number; cells: string[] }> {
  const rows: Array<{ line: number; cells: string[] }> = [];
  let cells: string[] = [];
  let field = '';
  let quoted = false;
  let started = false;
  let line = 1;
  let rowLine = 1;
  const endField = () => {
    cells.push(field);
    field = '';
  };
  const endRow = () => {
    endField();
    if (cells.length > 1 || (cells[0] ?? '').trim() !== '') rows.push({ line: rowLine, cells });
    cells = [];
    started = false;
  };
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i]!;
    if (!started) {
      started = true;
      rowLine = line;
    }
    if (quoted) {
      if (ch === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else {
        if (ch === '\n') line += 1;
        field += ch;
      }
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === ',') endField();
    else if (ch === '\n') {
      endRow();
      line += 1;
    } else if (ch !== '\r') field += ch;
  }
  if (started) endRow();
  if (quoted) throw new Error(`line ${rowLine}: a quoted field is never closed`);
  return rows;
}
