import type { TableColumn, TableColumnSummary, TableRecord, TableValue } from "./api";

export type TableCalculation = "none" | "rows" | keyof TableColumnSummary;
export type TableFilterOperator = "contains" | "not_contains" | "is" | "is_not" | "gt" | "gte" | "lt" | "lte" | "empty" | "not_empty";
export type TableFilter = { columnId: string; operator: TableFilterOperator; value?: string | number | boolean };
export type TableQuery = { filters: TableFilter[]; sort: { columnId: string; direction: "asc" | "desc" } | null };
export const tableNumberSeparators = [
  { value: "plain", label: "1234.56", group: "", decimal: "." },
  { value: "comma-dot", label: "1,234.56", group: ",", decimal: "." },
  { value: "dot-comma", label: "1.234,56", group: ".", decimal: "," },
  { value: "space-dot", label: "1 234.56", group: " ", decimal: "." },
  { value: "space-comma", label: "1 234,56", group: " ", decimal: "," },
  { value: "decimal-comma", label: "1234,56", group: "", decimal: "," },
] as const;
export type TableNumberFormat = { decimals: number | null; separators: typeof tableNumberSeparators[number]["value"] };
export const defaultTableNumberFormat: TableNumberFormat = { decimals: null, separators: "plain" };

export function readTableNumberFormats(raw: string | null): Record<string, TableNumberFormat> {
  if (!raw || raw.length > 65536) return {};
  try {
    const values: unknown = JSON.parse(raw);
    if (!values || typeof values !== "object" || Array.isArray(values)) return {};
    return Object.fromEntries(Object.entries(values).slice(0, 100).filter(([, value]) => value && typeof value === "object"
      && (value.decimals === null || Number.isInteger(value.decimals) && value.decimals >= 0 && value.decimals <= 10)
      && tableNumberSeparators.some(option => option.value === value.separators)));
  } catch { return {}; }
}

// Format the decimal text itself: SQL decimal/bigint values can exceed JS number
// precision. Rounding is display-only, including carry and negative values.
export function formatTableNumber(value: number | string, format: TableNumberFormat = defaultTableNumberFormat): string {
  const raw = String(value);
  const match = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:e([+-]?\d+))?$/i.exec(raw);
  if (!match || raw.length > 10000) return raw;
  const whole = match[2] ?? "0", fraction = match[3] ?? match[4] ?? "";
  const point = whole.length + Number(match[5] ?? 0);
  if (!Number.isSafeInteger(point) || Math.abs(point) > 10000) return raw;
  const digits = whole + fraction;
  let integer = (point <= 0 ? "0" : digits.slice(0, point).padEnd(point, "0")).replace(/^0+(?=\d)/, "");
  let decimal = point < 0 ? "0".repeat(-point) + digits : digits.slice(point);
  if (format.decimals !== null) {
    const places = Math.max(0, Math.min(10, Math.trunc(format.decimals)));
    const rounded = (BigInt(integer + decimal.slice(0, places).padEnd(places, "0"))
      + (Number(decimal[places] ?? 0) >= 5 ? 1n : 0n)).toString().padStart(places + 1, "0");
    integer = places ? rounded.slice(0, -places) : rounded;
    decimal = places ? rounded.slice(-places) : "";
  }
  const negative = match[1] === "-" && /[1-9]/.test(integer + decimal);
  const separators = tableNumberSeparators.find(option => option.value === format.separators) ?? tableNumberSeparators[0];
  if (separators.group) {
    const groups: string[] = [];
    for (let end = integer.length; end > 0; end -= 3) groups.push(integer.slice(Math.max(0, end - 3), end));
    integer = groups.reverse().join(separators.group);
  }
  return `${negative ? "-" : ""}${integer}${decimal ? separators.decimal + decimal : ""}`;
}

export function tableFilterOperators(column: TableColumn): { value: TableFilterOperator; label: string }[] {
  const date = column.type === "date" || column.type === "datetime";
  return [
    ...(column.type === "text" ? [{ value: "contains", label: "contains" }, { value: "not_contains", label: "does not contain" }] as const : []),
    { value: "is", label: date ? "is on" : "is" }, { value: "is_not", label: date ? "is not on" : "is not" },
    ...(date || column.type === "number" ? [
      { value: "gt", label: date ? "is after" : "is greater than" }, { value: "gte", label: date ? "is on or after" : "is at least" },
      { value: "lt", label: date ? "is before" : "is less than" }, { value: "lte", label: date ? "is on or before" : "is at most" },
    ] as const : []),
    { value: "empty", label: "is empty" }, { value: "not_empty", label: "is not empty" },
  ];
}

export function tableFilterFromDraft(column: TableColumn, operator: TableFilterOperator, draft: string): TableFilter {
  if (operator === "empty" || operator === "not_empty") return { columnId: column.id, operator };
  if (!draft.trim()) throw new Error(`Choose a filter value for ${column.name}.`);
  if (column.type === "checkbox" && draft !== "true" && draft !== "false") throw new Error("Choose Checked or Unchecked.");
  const value = tableValueFromDraft(column, draft, draft === "true");
  if (value === null) throw new Error(`Choose a filter value for ${column.name}.`);
  return { columnId: column.id, operator, value };
}
export const tableCalculationLabels: Record<TableCalculation, string> = {
  none: "None", rows: "Count all", count: "Count", empty: "Empty", sum: "Sum", average: "Average", min: "Min", max: "Max",
  earliest: "Earliest", latest: "Latest", checked: "Checked", unchecked: "Unchecked",
};
export function tableCalculationsFor(column: TableColumn): TableCalculation[] {
  const common: TableCalculation[] = ["none", "count", "rows", "empty"];
  return [...common, ...(column.type === "number" ? ["sum", "average", "min", "max"] as const
    : column.type === "date" || column.type === "datetime" ? ["earliest", "latest"] as const
      : column.type === "checkbox" ? ["checked", "unchecked"] as const : [])];
}

export function columnLetter(index: number): string {
  let value = index + 1, result = "";
  while (value > 0) { result = String.fromCharCode(65 + (value - 1) % 26) + result; value = Math.floor((value - 1) / 26); }
  return result;
}

export function nextTableCell(row: number, column: number, rows: number, columns: number, key: string, shift = false): { row: number; column: number } | null {
  if (!rows || !columns) return null;
  if (key === "Tab") {
    const index = row * columns + column + (shift ? -1 : 1);
    if (index < 0 || index >= rows * columns) return null;
    return { row: Math.floor(index / columns), column: index % columns };
  }
  return { row: Math.max(0, Math.min(rows - 1, row + (key === "ArrowDown" || key === "Enter" ? shift ? -1 : 1 : key === "ArrowUp" ? -1 : 0))),
    column: key === "Home" ? 0 : key === "End" ? columns - 1 : Math.max(0, Math.min(columns - 1, column + (key === "ArrowRight" ? 1 : key === "ArrowLeft" ? -1 : 0))) };
}

export function tableCellDraft(column: TableColumn, value: TableValue | undefined): string {
  if (value === null || value === undefined) return "";
  if (column.type === "datetime" && typeof value === "string") {
    const date = new Date(value);
    if (!Number.isNaN(date.valueOf())) {
      const local = new Date(date.valueOf() - date.getTimezoneOffset() * 60_000);
      return local.toISOString().slice(0, -1);
    }
  }
  return String(value);
}

export function tableValueFromDraft(column: TableColumn, draft: string, checked: boolean | null = false): TableValue {
  if (column.type === "checkbox") return checked;
  if (draft === "") return null;
  if (column.type === "number") {
    const value = Number(draft);
    if (!Number.isFinite(value)) throw new Error("Enter a valid number.");
    return value;
  }
  if (column.type === "datetime") {
    const value = new Date(draft);
    if (Number.isNaN(value.valueOf())) throw new Error("Enter a valid date and time.");
    return value.toISOString();
  }
  if (column.type === "select" && !column.options.includes(draft))
    throw new Error("Choose one of the available options.");
  return draft;
}

export function tableRecordValues(record: TableRecord, columnId: string, value: TableValue): Record<string, TableValue> {
  return { ...record.values, [columnId]: value };
}

export function tableValuesEqual(column: TableColumn, left: TableValue | undefined, right: TableValue): boolean {
  if (left == null && right === null) return true;
  if (column.type !== "datetime" || typeof left !== "string" || typeof right !== "string") return left === right;
  return Date.parse(left) === Date.parse(right);
}
