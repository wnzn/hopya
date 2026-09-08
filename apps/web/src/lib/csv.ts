const MAX_ROWS = 2000;
const MAX_CHARS = 1024 * 1024;

export function parseCsv(text: string): string[][] {
  const input = text.startsWith("\uFEFF") ? text.slice(1) : text;
  if (input.length > MAX_CHARS) {
    throw new Error("CSV input exceeds the 1MB size limit.");
  }
  if (input === "") return [];
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;

  function endRow() {
    row.push(field);
    field = "";
    rows.push(row);
    row = [];
    if (rows.length > MAX_ROWS) {
      throw new Error("CSV input exceeds the 2000 row limit.");
    }
  }

  while (i < input.length) {
    const char = input[i];
    if (inQuotes) {
      if (char === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 2;
        } else {
          inQuotes = false;
          i += 1;
        }
      } else {
        field += char;
        i += 1;
      }
    } else if (char === '"') {
      inQuotes = true;
      i += 1;
    } else if (char === ",") {
      row.push(field);
      field = "";
      i += 1;
    } else if (char === "\r" && input[i + 1] === "\n") {
      endRow();
      i += 2;
    } else if (char === "\n" || char === "\r") {
      endRow();
      i += 1;
    } else {
      field += char;
      i += 1;
    }
  }
  if (inQuotes) {
    // Lenient: accept an unterminated quoted field as-is.
    inQuotes = false;
  }
  // A trailing newline already closed the final row; otherwise flush it.
  const trailingNewline = input.endsWith("\n") || input.endsWith("\r");
  if (trailingNewline && row.length === 0 && field === "") {
    return rows;
  }
  row.push(field);
  rows.push(row);
  if (rows.length > MAX_ROWS) {
    throw new Error("CSV input exceeds the 2000 row limit.");
  }
  return rows;
}

export function toCsv(rows: string[][]): string {
  return rows
    .map((row) =>
      row
        .map((field) =>
          /[",\n\r]/.test(field)
            ? `"${field.replaceAll('"', '""')}"`
            : field,
        )
        .join(","),
    )
    .join("\n");
}
