import type { DateFormat } from "./api";

export const dateFormats: DateFormat[] = ["yyyy-MM-dd", "MMM d, yyyy", "MMMM d, yyyy", "dd/MM/yyyy"];
export function formatFieldDate(value: string, format: DateFormat = "yyyy-MM-dd", datetime = false): string {
  const date = new Date(datetime ? value : `${value}T00:00:00`);
  if (!Number.isFinite(date.getTime())) return value;
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const result = format === "yyyy-MM-dd" ? `${year}-${month}-${day}`
    : format === "dd/MM/yyyy" ? `${day}/${month}/${year}`
    : `${date.toLocaleString("en-US", { month: format === "MMM d, yyyy" ? "short" : "long" })} ${date.getDate()}, ${year}`;
  return datetime ? `${result} ${date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : result;
}
export function localDateTime(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return `${String(date.getFullYear()).padStart(4, "0")}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}T${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}:${String(date.getSeconds()).padStart(2, "0")}.${String(date.getMilliseconds()).padStart(3, "0")}`;
}
