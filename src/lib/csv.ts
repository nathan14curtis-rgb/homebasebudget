/** Minimal RFC 4180 CSV parser: quoted fields, escaped "" quotes, commas
 * and newlines inside quotes. No external dependency for something this
 * self-contained. Returns rows of raw string cells — callers own type
 * conversion (dates, amounts). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  // Normalize line endings so \r\n and \r don't produce phantom empty rows.
  const input = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  for (let i = 0; i < input.length; i++) {
    const char = input[i];

    if (inQuotes) {
      if (char === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }

  // Flush a trailing field/row that wasn't newline-terminated.
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}

/** Rows keyed by header, skipping the header row itself. */
export function parseCsvWithHeader(text: string): Array<Record<string, string>> {
  const rows = parseCsv(text);
  const [header, ...dataRows] = rows;
  if (!header) return [];
  return dataRows.map((row) => {
    const record: Record<string, string> = {};
    header.forEach((key, i) => {
      record[key.trim()] = (row[i] ?? "").trim();
    });
    return record;
  });
}

/** Quote a cell only when RFC 4180 says it needs it: a comma, a quote, or
 * a line break inside. Everything else is written bare so the file stays
 * readable in a text editor as well as a spreadsheet. */
export function csvCell(value: string | number | null | undefined): string {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Header row plus data rows, CRLF-terminated the way spreadsheets expect. */
export function formatCsv(header: string[], rows: Array<Array<string | number | null | undefined>>): string {
  return [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
