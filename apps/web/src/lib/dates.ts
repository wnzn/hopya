export function dateKey(date: Date): string {
  const year = date.getFullYear();
  const formattedYear =
    year < 0
      ? `-${String(-year).padStart(6, "0")}`
      : String(year).padStart(4, "0");
  return `${formattedYear}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
export function parseDate(value: string): Date {
  return new Date(`${value}T12:00:00`);
}
export function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}
export function monthStart(month: Date, offset = 0): Date {
  const first = new Date(month);
  first.setFullYear(month.getFullYear(), month.getMonth() + offset, 1);
  first.setHours(12, 0, 0, 0);
  return first;
}
export function parseMonth(value: string): Date | null {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) return null;
  return parseDate(`${value}-01`);
}
export function monthDays(month: Date): Date[] {
  const first = monthStart(month);
  const start = addDays(first, -((first.getDay() + 6) % 7));
  return Array.from({ length: 42 }, (_, index) => addDays(start, index));
}
export function dayDistance(start: Date, end: Date): number {
  const startUtc = new Date(0);
  const endUtc = new Date(0);
  startUtc.setUTCFullYear(
    start.getFullYear(),
    start.getMonth(),
    start.getDate(),
  );
  endUtc.setUTCFullYear(end.getFullYear(), end.getMonth(), end.getDate());
  return Math.round((endUtc.getTime() - startUtc.getTime()) / 86400000);
}
export function barRange(
  startDate: string | null,
  dueDate: string | null,
  rangeStart: Date,
  days: number,
) {
  if (!startDate && !dueDate) return null;
  const start = parseDate(startDate || dueDate!);
  const end = parseDate(dueDate || startDate!);
  const left = dayDistance(rangeStart, start);
  const right = dayDistance(rangeStart, end);
  if (right < 0 || left >= days || right < left) return null;
  return {
    offset: Math.max(0, left),
    span: Math.min(days - 1, right) - Math.max(0, left) + 1,
  };
}
