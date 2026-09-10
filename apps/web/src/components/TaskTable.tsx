import { useEffect, useRef, useState, type CSSProperties, type DragEvent } from "react";
import { createPortal } from "react-dom";
import { api, ApiError, label, message, priorities, workspacePath, type BuiltInField, type Detail, type Field, type Item } from "../lib/api";
import { projectStatuses, projectDateFormat, statusLabel, statusStyle, tagStyle } from "../lib/project-statuses";
import { formatFieldDate } from "../lib/field-values";
import TypedFieldInput from "./TypedFieldInput";
import Select from "./Select";
import SolidIcon from "./SolidIcon";
import { evaluateFormula } from "../lib/formula";
import { fieldOwnerForNode, optionalBuiltIns, projectBuiltIns, projectCustomFields } from "../lib/project-fields";
import { plainText } from "../lib/rich-text";
import { listSortLabels, type ListSort, type ListSortType } from "../lib/list-view";
import "../styles/task-table.css";

type CoreKey = "title" | "status" | "assigneeId" | "dueDate" | BuiltInField;
type Column = { key: string; name: string; width: number } & (
  | { core: CoreKey; field?: never }
  | { field: Field; core?: never }
);
type Draft = string | null | string[];
type Editing = { key: string; column: Column; baseline: Item; draft: Draft; tag: string; error: string; conflict: boolean };
type Props = {
  items: Item[]; detail: Detail; view: "list" | "table"; projectId?: string | null;
  writable: boolean; onOpen: (item: Item) => void;
  onSaved?: () => void; onItemUpdated?: (item: Item) => void;
  onCreate?: () => void;
  // List order is controlled by TaskViews. Table order remains historical
  // local state, including its header drag and keyboard controls.
  columnOrder?: string[];
  onColumnOrder?: (order: string[]) => void;
  hiddenColumns?: string[];
  sort?: ListSort | null;
  onSort?: (sort: ListSort | null) => void;
  selectedIds?: Set<string>;
  onSelectionChange?: (ids: string[], selected: boolean) => void;
};
// Task-level hierarchy/checklist fields may be absent on older payloads;
// read them defensively so both shapes keep working.
type TaskExtensions = {
  parentId?: string | null;
  checklist?: { id: string; text: string; done: boolean }[] | null;
};
function parentOf(item: Item): string | null {
  const value = (item as Item & TaskExtensions).parentId;
  return typeof value === "string" && value ? value : null;
}
function checklistOf(item: Item): { id: string; text: string; done: boolean }[] {
  const value = (item as Item & TaskExtensions).checklist;
  return Array.isArray(value) ? value : [];
}
function checklistCount(item: Item): { done: number; total: number } | null {
  const entries = checklistOf(item);
  if (!entries.length) return null;
  return { done: entries.filter(entry => entry && entry.done).length, total: entries.length };
}
// Depth cap for subtask indentation; chains can never be deeper than this
// visually even if the payload disagrees.
const MAX_SUBTASK_DEPTH = 8;
function subtaskDepth(item: Item, byId: Map<string, Item>): number {
  let depth = 0;
  const seen = new Set([item.id]);
  let next = parentOf(item);
  while (next && depth < MAX_SUBTASK_DEPTH) {
    if (seen.has(next)) break;
    const parent = byId.get(next);
    if (!parent) break;
    seen.add(next);
    depth += 1;
    next = parentOf(parent);
  }
  return depth;
}
type Row = { item: Item; depth: number; parentTitle: string | null };
function orderRows(source: Item[], hierarchize: boolean): Row[] {
  if (!hierarchize) return source.map(item => ({ item, depth: 0, parentTitle: null }));
  const byId = new Map(source.map(item => [item.id, item]));
  const depths = new Map(source.map(item => [item.id, subtaskDepth(item, byId)]));
  // Stable grouping: each parent's children follow it directly, preserving
  // the incoming relative order. Orphans (missing parents) stay roots.
  const children = new Map<string, Item[]>();
  const roots: Item[] = [];
  for (const item of source) {
    const pid = parentOf(item);
    if (pid && pid !== item.id && byId.has(pid)) {
      const siblings = children.get(pid) ?? [];
      siblings.push(item);
      children.set(pid, siblings);
    } else {
      roots.push(item);
    }
  }
  const rows: Row[] = [];
  const emitted = new Set<string>();
  function emit(item: Item) {
    if (emitted.has(item.id)) return;
    emitted.add(item.id);
    const pid = parentOf(item);
    rows.push({
      item,
      depth: Math.min(depths.get(item.id) ?? 0, MAX_SUBTASK_DEPTH),
      parentTitle: pid ? byId.get(pid)?.title ?? null : null,
    });
    for (const child of children.get(item.id) ?? []) emit(child);
  }
  for (const root of roots) emit(root);
  // Cycle leftovers have no root; append them in incoming order.
  for (const item of source) emit(item);
  return rows;
}

const clamp = (width: number) => Math.min(600, Math.max(80, Math.round(width)));
function rawValue(item: Item, column: Column) {
  return column.field ? item.customFields[column.field.id] ?? null : item[column.core!];
}
function draftValue(item: Item, column: Column): Draft {
  const raw = rawValue(item, column);
  return Array.isArray(raw) ? [...raw] : raw === null ? null : String(raw);
}

export default function TaskTable({ items, detail, view, projectId, writable, onOpen, onSaved, onItemUpdated, onCreate, columnOrder, onColumnOrder, hiddenColumns = [], sort = null, onSort, selectedIds, onSelectionChange }: Props) {
  const controlled = columnOrder !== undefined;
  const columns: Column[] = [
    { key: "title", core: "title", name: "Task", width: 280 },
    { key: "status", core: "status", name: "Status", width: 160 },
    { key: "assigneeId", core: "assigneeId", name: "Assignee", width: 180 },
    { key: "dueDate", core: "dueDate", name: "Due date", width: 180 },
    ...projectBuiltIns(detail, projectId).map(core => ({ key: core, core, name: optionalBuiltIns.find(field => field.id === core)!.label, width: 180 })),
    ...projectCustomFields(detail, projectId).map(field => ({ key: `custom:${field.id}`, field, name: field.name, width: 180 })),
  ];
  const [editing, setEditing] = useState<Editing | null>(null);
  const [selectedCell, setSelectedCell] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const request = useRef<AbortController | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const focusKey = useRef<string | null>(null);
  const [widths, setWidths] = useState<Record<string, number>>({});
  const storageKey = `hopya.task-columns:${JSON.stringify([detail.workspace.id, projectId || null, view])}`;
  const drag = useRef<{ element: HTMLElement; pointer: number; key: string; x: number; width: number } | null>(null);
  const sourceOrder = columns.map(column => column.key).join("\u0000");
  const [order, setOrder] = useState<string[]>(() => columns.map(column => column.key));
  const [draggingKey, setDraggingKey] = useState<string | null>(null);
  const [dropTargetKey, setDropTargetKey] = useState<string | null>(null);
  const [sortColumnKey, setSortColumnKey] = useState<string | null>(null);
  const [sortPosition, setSortPosition] = useState<{ top: number; left: number } | null>(null);
  const sortMenu = useRef<HTMLDivElement>(null);
  const sourceOrderRef = useRef(sourceOrder);
  const orderRef = useRef(order);
  orderRef.current = order;
  useEffect(() => {
    if (sourceOrderRef.current !== sourceOrder) {
      sourceOrderRef.current = sourceOrder;
      setOrder(columns.map(column => column.key));
    }
  });
  // Controlled (list) mode reads the caller's order and never writes local
  // state; uncontrolled (table) mode keeps the historical local behavior.
  const activeOrder = controlled ? columnOrder! : order;
  const allOrderedColumns = activeOrder
    .map(key => columns.find(column => column.key === key))
    .filter((column): column is Column => column !== undefined);
  if (allOrderedColumns.length !== columns.length) {
    allOrderedColumns.push(...columns.filter(column => !activeOrder.includes(column.key)));
  }
  const orderedColumns = view === "list"
    ? allOrderedColumns.filter(column => column.key === "title" || !hiddenColumns.includes(column.key))
    : allOrderedColumns;
  function reorder(fromKey: string, toIndex: number) {
    if (controlled) {
      if (!onColumnOrder) return;
      // Reorder the displayed columns (which include any appended fallback)
      // and hand the full order back to the caller.
      const base = allOrderedColumns.map(column => column.key);
      const from = base.indexOf(fromKey);
      if (from < 0 || toIndex < 0 || toIndex >= base.length || from === toIndex) return;
      const next = base.filter(key => key !== fromKey);
      next.splice(toIndex, 0, fromKey);
      onColumnOrder(next);
      return;
    }
    setOrder(current => {
      const from = current.indexOf(fromKey);
      if (from < 0 || toIndex < 0 || toIndex >= current.length || from === toIndex) return current;
      const next = current.filter(key => key !== fromKey);
      next.splice(toIndex, 0, fromKey);
      return next;
    });
  }
  function onHeaderDrop(event: DragEvent<HTMLTableCellElement>, toKey: string) {
    event.preventDefault();
    const fromKey = event.dataTransfer.getData("text/plain");
    const target = orderedColumns.find(column => column.key === toKey);
    if (fromKey && target) reorder(fromKey, orderedColumns.indexOf(target));
  }
  function onHeaderDragOver(event: DragEvent<HTMLTableCellElement>, key: string) {
    if (!draggingKey) return;
    event.preventDefault();
    if (event.dataTransfer.dropEffect === "none") event.dataTransfer.dropEffect = "move";
    setDropTargetKey(current => current === key ? current : key);
  }

  useEffect(() => {
    if (!editing || busy) return;
    const control = root.current?.querySelector<HTMLElement>(".task-cell-editor input, .task-cell-editor select, .task-cell-editor textarea");
    control?.focus();
    if (control instanceof HTMLInputElement && (control.type === "date" || control.type === "datetime-local")) {
      try { control.showPicker(); } catch { /* The native picker remains available from its indicator. */ }
    }
  }, [editing?.key, busy]);
  useEffect(() => {
    try {
      const stored: unknown = JSON.parse(localStorage.getItem(storageKey) || "{}");
      if (stored && typeof stored === "object" && !Array.isArray(stored))
        setWidths(Object.fromEntries(Object.entries(stored).filter(([, value]) => typeof value === "number" && Number.isFinite(value)).map(([key, value]) => [key, clamp(value as number)])));
    } catch { /* Unavailable or malformed storage does not prevent editing. */ }
    return () => {
      request.current?.abort();
      const current = drag.current;
      if (current?.element.hasPointerCapture(current.pointer)) current.element.releasePointerCapture(current.pointer);
      drag.current = null;
    };
  }, [storageKey]);
  useEffect(() => {
    if (!sortColumnKey) return;
    const activeKey = sortColumnKey;
    function closeOnPointer(event: PointerEvent) {
      const target = event.target;
      if (sortMenu.current?.contains(target as Node)) return;
      if (target instanceof Element && target.closest(`[data-sort-column="${CSS.escape(activeKey)}"]`)) return;
      setSortColumnKey(null);
      setSortPosition(null);
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setSortColumnKey(null);
      setSortPosition(null);
      root.current?.querySelector<HTMLButtonElement>(`[data-sort-column="${CSS.escape(activeKey)}"]`)?.focus();
    }
    function closeOnViewportChange() {
      setSortColumnKey(null);
      setSortPosition(null);
    }
    document.addEventListener("pointerdown", closeOnPointer);
    document.addEventListener("keydown", closeOnEscape);
    document.addEventListener("scroll", closeOnViewportChange, true);
    window.addEventListener("resize", closeOnViewportChange);
    return () => {
      document.removeEventListener("pointerdown", closeOnPointer);
      document.removeEventListener("keydown", closeOnEscape);
      document.removeEventListener("scroll", closeOnViewportChange, true);
      window.removeEventListener("resize", closeOnViewportChange);
    };
  }, [sortColumnKey]);
  useEffect(() => {
    if (!editing && focusKey.current) {
      const button = root.current?.querySelector<HTMLButtonElement>(`[data-cell-key="${CSS.escape(focusKey.current)}"]`);
      (button || root.current)?.focus();
      setSelectedCell(focusKey.current);
      focusKey.current = null;
    }
  });
  useEffect(() => {
    if (editing && !items.some(item => item.id === editing.baseline.id)) {
      request.current?.abort();
      busyRef.current = false;
      setBusy(false);
      setEditing(null);
    }
  }, [items, editing]);

  function assigned(item: Item, column: Column) {
    if (column.core && ["title", "status", "assigneeId", "dueDate"].includes(column.core)) return true;
    const fieldOwner = fieldOwnerForNode(detail.nodes, item.nodeId);
    if (!fieldOwner && detail.projectFields !== undefined) return false;
    return column.field
      ? projectCustomFields(detail, fieldOwner?.id).some(field => field.id === column.field!.id)
      : projectBuiltIns(detail, fieldOwner?.id).includes(column.core as BuiltInField);
  }
  function listPath(id: string) {
    const parts: string[] = [];
    const visited = new Set<string>();
    let node = detail.nodes.find(node => node.id === id);
    while (node && !visited.has(node.id) && parts.length <= 32) {
      visited.add(node.id);
      parts.unshift(node.name);
      node = detail.nodes.find(parent => parent.id === node!.parentId);
    }
    return parts.join(" / ");
  }
  const paths = detail.nodes.filter(node => node.kind === "list").map(node => ({ value: node.id, name: listPath(node.id) }));
  const lists = paths.map(option => ({ ...option, name: paths.some(other => other !== option && other.name === option.name) ? `${option.name} (${option.value})` : option.name }));
  function formula(item: Item, expression: string) {
    return evaluateFormula(expression, Object.fromEntries(detail.fields.map(field => [field.name, Array.isArray(item.customFields[field.id]) ? null : item.customFields[field.id] ?? null])) as Record<string, string | number | boolean | null>);
  }
  function display(item: Item, column: Column) {
    const raw = rawValue(item, column);
    if (column.field?.type === "formula") {
      const expression = column.field.settings?.formula ?? raw;
      if (typeof expression === "string") return formula(item, expression);
    }
    // Descriptions are markdown; cells show a plain-text excerpt so neither
    // raw HTML nor markdown syntax ever renders here.
    if (column.core === "description" && typeof raw === "string") {
      const excerpt = plainText(raw);
      if (excerpt === "") return "-";
      const preview = excerpt.length > 180 ? `${excerpt.slice(0, 177).trimEnd()}...` : excerpt;
      return <span className="task-description-preview">{preview}</span>;
    }
    if (column.core === "assigneeId") return detail.members.find(member => member.userId === raw)?.name || "Unassigned";
    if (column.core === "nodeId") return listPath(String(raw));
    if (column.core === "status") return <span className="status status-badge" style={statusStyle(projectStatuses(detail, item.nodeId).find(status => status.id === raw)?.color ?? "#64748b")}><i aria-hidden="true" />{statusLabel(detail, item.nodeId, String(raw))}</span>;
    if (column.core === "tags" && Array.isArray(raw)) return raw.length
      ? <span className="tag-list">{raw.map(tag => <span className="tag-badge" style={tagStyle(detail, item.nodeId, tag)} key={tag}>{tag}</span>)}</span>
      : "-";
    if (column.core === "priority") return <span className={`priority priority-${raw}`}>{label(String(raw))}</span>;
    if (typeof raw === "string" && raw && (column.core === "createdAt" || column.core === "updatedAt")) return new Date(raw).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
    if (typeof raw === "string" && raw && (column.core === "dueDate" || column.core === "startDate" || column.field?.type === "date" || column.field?.type === "datetime")) return formatFieldDate(raw, column.field?.settings?.dateFormat ?? projectDateFormat(detail, item.nodeId), column.field?.type === "datetime");
    if (column.field?.type === "rating" && raw !== null) return `${raw} / ${column.field.settings?.maxRating ?? 5}`;
    if (typeof raw === "boolean") return raw ? "Yes" : "No";
    if (Array.isArray(raw)) return raw.join(" · ") || "-";
    return raw === null || raw === "" ? "-" : String(raw);
  }
  function close(nextFocusKey: string | null = editing?.key ?? null) {
    if (busyRef.current) return;
    focusKey.current = nextFocusKey;
    setSelectedCell(nextFocusKey);
    setEditing(null);
  }
  function updateDraft(draft: Draft) {
    setEditing(current => current && ({ ...current, draft }));
  }
  function addTag() {
    if (busyRef.current || !writable) return;
    setEditing(current => {
      if (!current || !Array.isArray(current.draft)) return current;
      const tag = current.tag.trim();
      const error = !tag ? "Enter a non-empty tag."
        : current.draft.includes(tag) ? "This tag already exists."
        : current.draft.length >= 30 ? "A task can have at most 30 tags. Remove a tag before adding another."
        : "";
      return { ...current, error, ...(error ? {} : { draft: [...current.draft, tag], tag: "" }) };
    });
  }
  async function submit(reload = false, nextFocusKey: string | null = editing?.key ?? null, draftOverride?: Draft) {
    if (!editing || busyRef.current) return;
    if (!reload && editing.conflict) return;
    if (!reload && !root.current?.querySelector("form")?.reportValidity()) return;
    if (reload && !window.confirm("Discard your draft and reload the current task?")) return;
    const { baseline, column } = editing;
    let draft = draftOverride === undefined ? editing.draft : draftOverride;
    if (!reload && column.core === "tags" && editing.tag.trim()) {
      if (!Array.isArray(draft)) return;
      const pending = editing.tag.trim();
      const error = draft.includes(pending) ? "This tag already exists."
        : draft.length >= 30 ? "A task can have at most 30 tags. Remove a tag before adding another."
        : "";
      if (error) {
        setEditing(current => current && ({ ...current, error }));
        return;
      }
      draft = [...draft, pending];
    }
    const currentColumn = columns.find(candidate => candidate.key === column.key);
    const currentItem = items.find(item => item.id === baseline.id);
    if (!reload && (!writable || !currentColumn || !currentItem || !assigned(currentItem, currentColumn))) {
      setEditing(current => current && ({ ...current, error: "This field is no longer editable. Reload current task or cancel." }));
      return;
    }
    let value: string | number | boolean | null | string[] = draft;
    if (!reload && (column.field?.type === "number" || column.field?.type === "rating")) {
      value = draft === null || draft === "" ? null : Number(draft);
      if (value !== null && !Number.isFinite(value)) {
        setEditing(current => current && ({ ...current, error: "Enter a finite number or clear the value." }));
        return;
      }
    } else if (column.field?.type === "checkbox") value = draft === null ? null : draft === "true";
    else if (column.field?.type === "date" || column.core === "startDate" || column.core === "dueDate") value = draft || null;
    else if (column.core === "title" || column.core === "description") value = draft ?? "";
    else if (column.field && draft === "") value = null;
    const original = rawValue(baseline, column);
    if (!reload && JSON.stringify(value) === JSON.stringify(original)) { close(nextFocusKey); return; }
    const body = { expectedUpdatedAt: baseline.updatedAt, ...(column.field
      ? { customFields: { ...baseline.customFields, [column.field.id]: value } }
      : { [column.core!]: value }) };
    const controller = new AbortController();
    request.current = controller;
    busyRef.current = true;
    setBusy(true);
    try {
      const saved = await api<Item>(`${workspacePath(detail.workspace.id)}/items/${encodeURIComponent(baseline.id)}`, reload ? "GET" : "PATCH", reload ? undefined : body, controller.signal);
      if (controller.signal.aborted || request.current !== controller) return;
      if (saved.id !== baseline.id || saved.workspaceId !== detail.workspace.id) throw new Error("The server returned an unexpected task.");
      if (reload) {
        setEditing({ ...editing, baseline: saved, draft: draftValue(saved, column), tag: "", error: "", conflict: false });
      } else {
        focusKey.current = nextFocusKey;
        setSelectedCell(nextFocusKey);
        setEditing(null);
      }
      if (onItemUpdated) onItemUpdated(saved);
      else onSaved?.();
    } catch (error) {
      if (!controller.signal.aborted && request.current === controller)
        setEditing(current => current && ({ ...current, error: message(error), conflict: current.conflict || error instanceof ApiError && error.status === 409 }));
    } finally {
      if (!controller.signal.aborted && request.current === controller) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  }
  function resize(key: string, width: number) {
    setWidths(current => {
      const next = { ...current, [key]: clamp(width) };
      try { localStorage.setItem(storageKey, JSON.stringify(next)); } catch { /* Storage is optional. */ }
      return next;
    });
  }
  const width = (column: Column) => widths[column.key] ?? column.width;
  // Subtask hierarchy applies to the list view only; the table view keeps
  // the incoming order untouched.
  const rows = orderRows(items, view === "list");
  const selectable = view === "list" && selectedIds !== undefined && onSelectionChange !== undefined;
  const selectedCount = selectable ? rows.filter(row => selectedIds.has(row.item.id)).length : 0;
  const showsDescription = orderedColumns.some(column => column.core === "description");
  function sortType(column: Column): ListSortType {
    if (column.core === "status") return "status";
    if (column.core === "dueDate" || column.core === "startDate" || column.core === "createdAt" || column.core === "updatedAt" || column.field?.type === "date" || column.field?.type === "datetime") return "date";
    if (column.field?.type === "number" || column.field?.type === "rating") return "number";
    if (column.field?.type === "checkbox") return "checkbox";
    return "text";
  }
  function applySort(column: Column, next: ListSort | null) {
    onSort?.(next);
    setSortColumnKey(null);
    setSortPosition(null);
    requestAnimationFrame(() => root.current?.querySelector<HTMLButtonElement>(`[data-sort-column="${CSS.escape(column.key)}"]`)?.focus());
  }
  function toggleSortMenu(column: Column, trigger: HTMLButtonElement) {
    if (sortColumnKey === column.key) {
      setSortColumnKey(null);
      setSortPosition(null);
      return;
    }
    const bounds = trigger.getBoundingClientRect();
    const menuWidth = 180;
    const menuHeight = 124;
    setSortPosition({
      left: Math.max(8, Math.min(bounds.left, window.innerWidth - menuWidth - 8)),
      top: bounds.bottom + menuHeight + 8 <= window.innerHeight ? bounds.bottom + 4 : Math.max(8, bounds.top - menuHeight - 4),
    });
    setSortColumnKey(column.key);
  }
  function beginEditing(key: string, column: Column, item: Item) {
    if (busyRef.current || editing) return;
    setSelectedCell(key);
    setEditing({ key, column, baseline: structuredClone(item), draft: draftValue(item, column), tag: "", error: "", conflict: false });
  }
  function adjacentCell(key: string, offset: number): string | null {
    const cells = [...(root.current?.querySelectorAll<HTMLButtonElement>("[data-cell-key]:not(:disabled)") ?? [])];
    const index = cells.findIndex(cell => cell.dataset.cellKey === key);
    return cells[index + offset]?.dataset.cellKey ?? null;
  }
  function moveCell(event: React.KeyboardEvent<HTMLButtonElement>, key: string, row: number, column: number) {
    let target: HTMLButtonElement | null = null;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      const direction = event.key === "ArrowRight" ? 1 : -1;
      for (let at = column + direction; at >= 0 && at < orderedColumns.length; at += direction) {
        target = root.current?.querySelector<HTMLButtonElement>(`[data-row-index="${row}"][data-column-index="${at}"]:not(:disabled)`) ?? null;
        if (target) break;
      }
    } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      const direction = event.key === "ArrowDown" ? 1 : -1;
      for (let at = row + direction; at >= 0 && at < rows.length; at += direction) {
        target = root.current?.querySelector<HTMLButtonElement>(`[data-row-index="${at}"][data-column-index="${column}"]:not(:disabled)`) ?? null;
        if (target) break;
      }
    }
    if (!target) return;
    event.preventDefault();
    target.focus();
    target.scrollIntoView({ block: "nearest", inline: "nearest" });
    setSelectedCell(target.dataset.cellKey ?? key);
  }

  function editor() {
    if (!editing) return null;
    const { column, draft, baseline } = editing;
    const type = column.field?.type;
    const name = column.core === "title" ? "Title" : column.name;
    let options: { value: string | null; name: string }[] | undefined;
    if (column.core === "status") options = projectStatuses(detail, baseline.nodeId).map(status => ({ value: status.id, name: status.name }));
    else if (column.core === "priority") options = priorities.map(value => ({ value, name: label(value) }));
    else if (column.core === "assigneeId") options = [{ value: null, name: "Unassigned" }, ...detail.members.filter(member => !member.disabled).map(member => ({ value: member.userId, name: `${member.name} (${member.email})` }))];
    else if (column.core === "nodeId") options = lists;
    else if (type === "checkbox") options = [{ value: null, name: "Not set" }, { value: "true", name: "Yes" }, { value: "false", name: "No" }];
    else if (type === "select") options = [{ value: null, name: "Not set" }, ...(column.field?.options || []).map(value => ({ value, name: value }))];
    const disabled = busy || !writable;
    const inputProps = { id: "task-cell-input", "aria-label": name, "aria-invalid": !!editing.error, "aria-describedby": editing.error ? "task-cell-error" : undefined, disabled };
    return <form className="task-cell-editor" aria-label={`Edit ${name}`} onSubmit={event => { event.preventDefault(); void submit(); }}
      onBlurCapture={event => {
        const form = event.currentTarget;
        queueMicrotask(() => { if (!form.contains(document.activeElement) && !busyRef.current) void submit(false, null); });
      }} onKeyDown={event => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
      if (event.key === "Tab" && !(event.target instanceof HTMLButtonElement)) {
        const next = adjacentCell(editing.key, event.shiftKey ? -1 : 1);
        if (next) { event.preventDefault(); void submit(false, next); }
      }
      if (event.key === "Enter" && !(event.target instanceof HTMLButtonElement) && !event.nativeEvent.isComposing) {
        event.preventDefault();
        if (column.core === "tags" && editing.tag) {
          addTag();
        } else void submit();
      }
    }}>
      <label className="sr-only" htmlFor="task-cell-input">{name}</label>
      {column.field && ["datetime", "checklist", "rating"].includes(type!) ? <TypedFieldInput field={column.field} value={draft} disabled={disabled} compact onChange={value => {
        const next = typeof value === "number" || typeof value === "boolean" ? String(value) : value;
        updateDraft(next);
        if (type === "datetime") void submit(false, editing.key, next);
      }} /> : options ? <Select {...inputProps} autoFocus openOnMount value={JSON.stringify(draft)} onChange={event => {
        const next = JSON.parse(event.target.value) as Draft;
        updateDraft(next);
        void submit(false, editing.key, next);
      }}>
        {!options.some(option => option.value === draft) && <option value={JSON.stringify(draft)} disabled>Unavailable value</option>}
        {options.map(option => <option key={JSON.stringify(option.value)} value={JSON.stringify(option.value)}>{option.name}</option>)}
      </Select> : column.core === "tags" ? <>
        <ul className="task-tag-editor-list">{(draft as string[]).map((tag, index) => <li key={tag}><span>{tag}</span><button type="button" disabled={disabled} aria-label={`Remove tag ${tag}`}
          onMouseDown={event => event.preventDefault()}
          onClick={() => {
            setEditing(current => current && ({ ...current, error: "", draft: (current.draft as string[]).filter((_, at) => at !== index) }));
            root.current?.querySelector<HTMLInputElement>("#task-cell-input")?.focus();
          }}>Remove</button></li>)}</ul>
        <div className="task-tag-add">
          <input {...inputProps} aria-label="New tag" maxLength={60} value={editing.tag} onChange={event => setEditing(current => current && ({ ...current, tag: event.target.value, error: "" }))} placeholder="Add a tag" />
          <button type="button" disabled={disabled || !editing.tag.trim()} onClick={addTag}>Add</button>
        </div>
      </> : column.core === "description" ? <textarea {...inputProps} value={String(draft ?? "")} maxLength={50000} onChange={event => updateDraft(event.target.value)} />
        : <input {...inputProps} type={type === "number" ? "number" : type === "date" || column.core === "dueDate" || column.core === "startDate" ? "date" : "text"} step="any" required={column.core === "title"} maxLength={type === "formula" ? 200 : column.core === "title" ? 300 : 10000} value={String(draft ?? "")} onChange={event => {
          const next = event.target.value;
          updateDraft(next);
          if (event.target.type === "date") void submit(false, editing.key, next);
        }} />}
      {type === "formula" && <output aria-label="Formula preview">{formula(baseline, String(draft ?? ""))}</output>}
      {editing.error && <p id="task-cell-error" role="alert">{editing.error}</p>}
      {editing.error && <div className="task-cell-actions">
        <button type="button" disabled={busy} onClick={() => close()}>Cancel</button>
        {editing.conflict && <button type="button" disabled={busy} onClick={() => void submit(true)}>Reload current task</button>}
      </div>}
    </form>;
  }

  return <div ref={root} className={`task-table task-table-scroll${view === "table" ? " task-table--grid" : ""}`} tabIndex={0} role="region" aria-label={`${view === "table" ? "Table" : "List"} tasks`}
    onBlurCapture={event => {
      const table = event.currentTarget;
      queueMicrotask(() => { if (!table.contains(document.activeElement) && !editing && !busyRef.current) setSelectedCell(null); });
    }}>
    {editing && !columns.some(column => column.key === editing.column.key) && <div className="notice">
      <p>This field was removed from the view. Your draft is retained below. Cancel it or add the field back to continue.</p>
      {editor()}
    </div>}
    <table style={{ tableLayout: "fixed", width: orderedColumns.reduce((sum, column) => sum + width(column), selectable ? 44 : 0) }}>
      <colgroup>{selectable && <col style={{ width: 44 }} />}{orderedColumns.map(column => <col key={column.key} style={{ width: width(column) }} />)}</colgroup>
      <thead><tr>{selectable && <th className="task-select-column" scope="col">
        <input type="checkbox" aria-label="Select all tasks in this section" checked={rows.length > 0 && selectedCount === rows.length}
          ref={input => { if (input) input.indeterminate = selectedCount > 0 && selectedCount < rows.length; }}
          onChange={event => onSelectionChange(rows.map(row => row.item.id), event.currentTarget.checked)} />
      </th>}{orderedColumns.map((column, position) => {
        const canMove = view === "table" && orderedColumns.length > 1;
        const activeSort = sort?.column === column.key ? sort : null;
        const labels = listSortLabels(sortType(column));
        return <th scope="col" key={column.key}
          aria-sort={view === "list" ? activeSort?.direction === "asc" ? "ascending" : activeSort?.direction === "desc" ? "descending" : "none" : undefined}
          draggable={canMove}
          onDragStart={event => { if (!canMove) return; event.dataTransfer.setData("text/plain", column.key); event.dataTransfer.effectAllowed = "move"; setDraggingKey(column.key); setDropTargetKey(column.key); }}
          onDragEnd={() => { setDraggingKey(null); setDropTargetKey(null); }}
          onDragOver={event => onHeaderDragOver(event, column.key)}
          onDragLeave={() => setDropTargetKey(current => current === column.key ? null : current)}
          onDrop={event => onHeaderDrop(event, column.key)}
          aria-description={canMove ? "Column can be dragged to reorder; use the Move left and Move right buttons as a keyboard alternative" : undefined}
          className={draggingKey === column.key ? "task-column-dragging" : dropTargetKey === column.key ? "task-column-drop" : undefined}>
          <span className="task-column-head">
            {view === "list" ? <span className="task-sort">
              <button type="button" className="task-sort-trigger" data-sort-column={column.key} aria-haspopup="menu"
                aria-expanded={sortColumnKey === column.key} onClick={event => toggleSortMenu(column, event.currentTarget)}>
                <span className="task-column-name">{column.name}</span>
                <span aria-hidden="true">{activeSort?.direction === "asc" ? " ↑" : activeSort?.direction === "desc" ? " ↓" : " ↕"}</span>
              </button>
              {sortColumnKey === column.key && sortPosition && createPortal(<div ref={sortMenu} className="task-sort-menu" style={sortPosition} role="menu" aria-label={`Sort ${column.name}`}>
                <button type="button" role="menuitemradio" aria-checked={activeSort?.direction === "asc"} onClick={() => applySort(column, { column: column.key, direction: "asc" })}>{labels.asc}</button>
                <button type="button" role="menuitemradio" aria-checked={activeSort?.direction === "desc"} onClick={() => applySort(column, { column: column.key, direction: "desc" })}>{labels.desc}</button>
                <button type="button" role="menuitem" disabled={!activeSort} onClick={() => applySort(column, null)}>Clear sort</button>
              </div>, document.body)}
            </span> : <span className="task-column-name">{column.name}</span>}
            {canMove && <span className="task-column-move">
              <button type="button" disabled={position === 0} aria-label={`Move ${column.name} left`} onClick={() => reorder(column.key, position - 1)}><SolidIcon name="arrowLeft" width="12" height="12" /></button>
              <button type="button" disabled={position === orderedColumns.length - 1} aria-label={`Move ${column.name} right`} onClick={() => reorder(column.key, position + 1)}><SolidIcon name="arrowRight" width="12" height="12" /></button>
            </span>}
          </span>
        {view === "table" && <span className="task-column-resize" role="separator" tabIndex={0} aria-orientation="vertical" aria-label={`Resize ${column.name}`} aria-valuemin={80} aria-valuemax={600} aria-valuenow={width(column)} onKeyDown={event => {
          if (!["ArrowLeft", "ArrowRight", "Home"].includes(event.key)) return;
          event.preventDefault();
          resize(column.key, event.key === "Home" ? column.width : width(column) + (event.key === "ArrowRight" ? 16 : -16));
        }} onPointerDown={event => {
          if (event.button !== 0 || drag.current) return;
          event.preventDefault();
          event.currentTarget.focus();
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { element: event.currentTarget, pointer: event.pointerId, key: column.key, x: event.clientX, width: width(column) };
        }} onPointerMove={event => {
          const current = drag.current;
          if (current?.pointer === event.pointerId) resize(current.key, current.width + event.clientX - current.x);
        }} onPointerUp={event => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
          drag.current = null;
        }} onPointerCancel={() => {
          const current = drag.current;
          if (current?.element.hasPointerCapture(current.pointer)) current.element.releasePointerCapture(current.pointer);
          drag.current = null;
        }} onLostPointerCapture={() => { drag.current = null; }} />}
        </th>;
      })}</tr></thead>
      <tbody>{rows.map(({ item, depth, parentTitle }, rowIndex) => {
        const count = checklistCount(item);
        return <tr key={item.id} className={selectedIds?.has(item.id) ? "task-row-selected" : undefined}>{selectable && <td className="task-select-cell">
          <input type="checkbox" aria-label={`Select ${item.title}`} checked={selectedIds.has(item.id)}
            onChange={event => onSelectionChange([item.id], event.currentTarget.checked)} />
        </td>}{orderedColumns.map((column, columnIndex) => {
        const key = `${item.id}:${column.key}`;
        const available = assigned(item, column);
        const editable = writable && available && column.core !== "createdAt" && column.core !== "updatedAt"
          && !(column.field?.type === "formula" && column.field.settings?.formula !== undefined);
        // Checklist progress sits next to the description where that column
        // is shown, otherwise in the title cell; absent checklists render
        // nothing so the existing empty display is unchanged.
        const showCount = count && (column.core === "description" || (column.core === "title" && !showsDescription));
        const subtask = column.core === "title" && depth > 0;
        return <td key={column.key} data-column={column.key} className={selectedCell === key ? "task-cell-selected" : undefined}
          {...(subtask ? { "data-subtask-depth": depth, style: { "--subtask-depth": depth } as CSSProperties } : {})}>
          {editing?.key === key ? editor() : <>
            <div className={`task-cell-content${column.core === "title" ? " task-name-cell" : ""}`}>
              {subtask && parentTitle && <span className="sr-only">Subtask of {parentTitle}</span>}
              {view === "list" && column.core === "title" && parentOf(item) && <>
                <SolidIcon name="subtask" className="task-subtask-icon solid-icon" width="16" height="16" />
                {!parentTitle && <span className="sr-only">Subtask</span>}
              </>}
              {column.core === "title" && <button className="task-title" data-task-id={item.id} onClick={() => onOpen(item)} disabled={busy}>{item.title}</button>}
              {editable ? <button className={`task-cell-edit${column.core === "title" ? " task-title-edit" : ""}`} data-cell-key={key}
                data-row-index={rowIndex} data-column-index={columnIndex}
                aria-label={`Edit ${item.title} ${column.core === "title" ? "Title" : column.name}`} disabled={busy}
                onFocus={() => setSelectedCell(key)}
                onPointerDown={event => { if (editing && editing.key !== key) { event.preventDefault(); void submit(false, key); } }}
                onDoubleClick={() => beginEditing(key, column, item)}
                onKeyDown={event => {
                  if (event.key === "Enter" || event.key === "F2") { event.preventDefault(); beginEditing(key, column, item); }
                  else moveCell(event, key, rowIndex, columnIndex);
                }}
                onClick={() => {
                  if (editing) return;
                  if (column.core === "title") {
                    beginEditing(key, column, item);
                    return;
                  }
                  const textLike = column.core === "description" || column.field?.type === "text" || column.field?.type === "number" || column.field?.type === "formula";
                  if (textLike) setSelectedCell(key);
                  else beginEditing(key, column, item);
                }}>
                {column.core === "title" ? <SolidIcon name="pencil" width="16" height="16" /> : display(item, column)}
              </button> : column.core !== "title" && (available ? display(item, column) : "-")}
              {showCount && <span className="count" title={`${count.done} of ${count.total} checklist items complete`}>{count.done}/{count.total}</span>}
            </div>
          </>}
        </td>;
      })}</tr>;
      })
      }</tbody>
      {onCreate && writable && <tfoot><tr className="task-add-row"><td colSpan={orderedColumns.length + (selectable ? 1 : 0)} className="task-add-cell">
        <button type="button" className="task-add-task" onClick={onCreate}><span aria-hidden="true">+</span> Add task</button>
      </td></tr></tfoot>}
    </table>
  </div>;
}
