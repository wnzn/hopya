import type { Item, ListViewSettings } from "./api";

export type ListSort = NonNullable<ListViewSettings["sort"]>;
export type ListSortType = "text" | "number" | "date" | "checkbox" | "status";
export type ListFilterOperator = "contains" | "not_contains" | "is" | "is_not" | "gt" | "gte" | "lt" | "lte" | "empty" | "not_empty";
export type ListFilter = { id: string; field: string; operator: ListFilterOperator; value: string };

export function normalizeListViewSettings(
  input: unknown,
  defaults: string[],
  projectId: string | null,
): ListViewSettings {
  const value = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const known = new Set(defaults);
  const storedOrder = Array.isArray(value.columnOrder)
    ? value.columnOrder.filter((key): key is string => typeof key === "string" && known.has(key))
    : [];
  const columnOrder = [...new Set([...storedOrder, ...defaults])];
  const hiddenColumns = Array.isArray(value.hiddenColumns)
    ? [...new Set(value.hiddenColumns.filter((key): key is string => typeof key === "string" && key !== "title" && known.has(key)))]
    : [];
  const candidate = value.sort && typeof value.sort === "object" ? value.sort as Record<string, unknown> : null;
  const sort = candidate && typeof candidate.column === "string" && known.has(candidate.column)
    && !hiddenColumns.includes(candidate.column)
    && (candidate.direction === "asc" || candidate.direction === "desc")
    ? { column: candidate.column, direction: candidate.direction } as ListSort
    : null;
  return {
    view: "list",
    projectId,
    columnOrder,
    hiddenColumns,
    sort,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : null,
  };
}

function parentOf(item: Item): string | null {
  return typeof item.parentId === "string" && item.parentId ? item.parentId : null;
}

function compareValues(left: unknown, right: unknown, type: ListSortType): number {
  const leftMissing = left === null || left === undefined || left === "";
  const rightMissing = right === null || right === undefined || right === "";
  if (leftMissing || rightMissing) return leftMissing === rightMissing ? 0 : leftMissing ? 1 : -1;
  if (type === "number" || type === "status") return Number(left) - Number(right);
  if (type === "date") return Date.parse(String(left)) - Date.parse(String(right));
  if (type === "checkbox") return Number(Boolean(left)) - Number(Boolean(right));
  return String(left).localeCompare(String(right), undefined, { numeric: true, sensitivity: "base" });
}

export function sortListItems(
  source: Item[],
  sort: ListSort | null,
  type: ListSortType,
  value: (item: Item) => unknown,
): Item[] {
  if (!sort) return source;
  const positions = new Map(source.map((item, index) => [item.id, index]));
  const compare = (left: Item, right: Item) => {
    const leftValue = value(left);
    const rightValue = value(right);
    const leftMissing = leftValue === null || leftValue === undefined || leftValue === "";
    const rightMissing = rightValue === null || rightValue === undefined || rightValue === "";
    if (leftMissing || rightMissing)
      return (leftMissing === rightMissing ? 0 : leftMissing ? 1 : -1) || positions.get(left.id)! - positions.get(right.id)!;
    const result = compareValues(leftValue, rightValue, type);
    return (sort.direction === "asc" ? result : -result) || positions.get(left.id)! - positions.get(right.id)!;
  };
  const byId = new Map(source.map(item => [item.id, item]));
  const children = new Map<string, Item[]>();
  const roots: Item[] = [];
  for (const item of source) {
    const parentId = parentOf(item);
    if (parentId && parentId !== item.id && byId.has(parentId)) {
      const siblings = children.get(parentId) ?? [];
      siblings.push(item);
      children.set(parentId, siblings);
    } else roots.push(item);
  }
  const result: Item[] = [];
  const emitted = new Set<string>();
  function emit(item: Item) {
    if (emitted.has(item.id)) return;
    emitted.add(item.id);
    result.push(item);
    for (const child of (children.get(item.id) ?? []).sort(compare)) emit(child);
  }
  for (const root of roots.sort(compare)) emit(root);
  // Malformed cycles have no root; retain every item without looping.
  for (const item of [...source].sort(compare)) emit(item);
  return result;
}

export function listSortLabels(type: ListSortType): { asc: string; desc: string } {
  if (type === "number") return { asc: "Low to high", desc: "High to low" };
  if (type === "date") return { asc: "Oldest to newest", desc: "Newest to oldest" };
  if (type === "checkbox") return { asc: "Unchecked first", desc: "Checked first" };
  if (type === "status") return { asc: "Workflow forward", desc: "Workflow reverse" };
  return { asc: "A to Z", desc: "Z to A" };
}

export function matchesListFilter(value: unknown, filter: ListFilter, type: ListSortType): boolean {
  const values = Array.isArray(value) ? value : [value];
  const missing = values.length === 0 || values.every(entry => entry === null || entry === undefined || entry === "");
  if (filter.operator === "empty") return missing;
  if (filter.operator === "not_empty") return !missing;
  if (missing) return false;
  const expected = filter.value.trim();
  if (type === "number") {
    const left = Number(values[0]);
    const right = Number(expected);
    if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
    if (filter.operator === "gt") return left > right;
    if (filter.operator === "gte") return left >= right;
    if (filter.operator === "lt") return left < right;
    if (filter.operator === "lte") return left <= right;
    return filter.operator === "is" ? left === right : filter.operator === "is_not" ? left !== right : false;
  }
  if (type === "date") {
    const left = Date.parse(String(values[0]));
    const right = Date.parse(expected);
    if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
    if (filter.operator === "gt") return left > right;
    if (filter.operator === "gte") return left >= right;
    if (filter.operator === "lt") return left < right;
    if (filter.operator === "lte") return left <= right;
    return filter.operator === "is" ? left === right : filter.operator === "is_not" ? left !== right : false;
  }
  const candidates = values.map(entry => String(entry).toLocaleLowerCase());
  const target = expected.toLocaleLowerCase();
  if (filter.operator === "contains") return candidates.some(entry => entry.includes(target));
  if (filter.operator === "not_contains") return candidates.every(entry => !entry.includes(target));
  if (filter.operator === "is") return candidates.some(entry => entry === target);
  if (filter.operator === "is_not") return candidates.every(entry => entry !== target);
  return false;
}
