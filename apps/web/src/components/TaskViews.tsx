import { useEffect, useId, useRef, useState } from "react";
import TaskTable from "./TaskTable";
import {
  api,
  evaluateFormula,
  label,
  message,
  workspacePath,
  type Detail,
  type Item,
  type ListViewSettings,
  type TreeNode,
} from "../lib/api";
import { projectStatuses, statusLabel, statusStyle, tagStyle } from "../lib/project-statuses";
import { plainText } from "../lib/rich-text";
import { hierarchyLabels, optionalBuiltIns, projectBuiltIns, projectCustomFields } from "../lib/project-fields";
import { matchesListFilter, normalizeListViewSettings, sortListItems, type ListFilter, type ListFilterOperator, type ListSortType } from "../lib/list-view";
import {
  addDays,
  barRange,
  dateKey,
  monthDays,
  monthStart,
  parseDate,
  parseMonth,
} from "../lib/dates";
import "../styles/list-controls.css";

export type View = "list" | "board" | "calendar" | "gallery" | "gantt";
type Props = {
  items: Item[];
  detail: Detail;
  view: View;
  month: Date;
  setMonth: (month: Date) => void;
  onOpen: (item: Item) => void;
  onMove: (item: Item, status: Item["status"]) => Promise<void>;
  writable: boolean;
  limit: number;
  onShowMore: () => void;
  onSaved?: () => void;
  projectId?: string | null;
  filtered?: boolean;
  scopedLists?: TreeNode[];
  groupedNodes?: TreeNode[];
  onItemUpdated?: (item: Item) => void;
  onCreateTask?: (nodeId?: string) => void;
  deletable?: boolean;
};

export function Status({ status, name, color }: { status: Item["status"]; name?: string; color?: string }) {
  return (
    <span className={`status status-badge status-${status}`} style={color ? statusStyle(color) : undefined}>
      <i aria-hidden="true" style={color ? { background: "currentColor" } : undefined} />
      {name || label(status)}
    </span>
  );
}
function TaskCard({ item, onOpen, detail, variant = "board" }: { item: Item; onOpen: Props["onOpen"]; detail?: Detail; variant?: "board" | "gallery" }) {
  const configuredStatus = detail && projectStatuses(detail, item.nodeId).find(status => status.id === item.status);
  const assignee = detail?.members.find(member => member.userId === item.assigneeId)?.name ?? "Unassigned";
  const taskDate = item.dueDate ?? item.startDate;
  const meta = <div className="task-meta">
    <span className="task-meta-main">
      {variant === "gallery" && <Status status={item.status} name={configuredStatus?.name} color={configuredStatus?.color} />}
      <span className={`priority priority-${item.priority}`}>{label(item.priority)}</span>
    </span>
    {taskDate && <time dateTime={taskDate}>{item.dueDate ? "Due " : "Starts "}{parseDate(taskDate).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</time>}
  </div>;
  const tags = item.tags.length > 0 && <div className="tags tag-list">
    {item.tags.map((tag) => <span className="tag-badge" style={tagStyle(detail, item.nodeId, tag)} key={tag}>{tag}</span>)}
  </div>;
  if (variant === "gallery") return (
    <button className="task-card task-card--gallery" data-task-id={item.id} onClick={() => onOpen(item)}>
      <span className="task-card-media" aria-hidden="true" />
      <span className="task-card-footer">
        <strong>{item.title}</strong>
        {meta}
        {tags}
      </span>
    </button>
  );
  return (
    <button className="task-card task-card--board" data-task-id={item.id} onClick={() => onOpen(item)}>
      <span className="task-card-board-header"><strong>{item.title}</strong></span>
      <span className="task-card-board-body">{item.description ? plainText(item.description).slice(0, 280) : "\u00a0"}</span>
      <span className="task-card-board-footer">
        <span className="task-card-footer-row"><strong className="task-card-footer-label">Priority</strong><span className={`priority priority-${item.priority}`}>{label(item.priority)}</span></span>
        <span className="task-card-footer-row"><strong className="task-card-footer-label">Assignee</strong><span className="task-card-footer-value task-card-assignee">{assignee}</span></span>
        <span className="task-card-footer-row"><strong className="task-card-footer-label">Due date</strong>{item.dueDate
          ? <time className="task-card-footer-value" dateTime={item.dueDate}>{parseDate(item.dueDate).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</time>
          : <span className="task-card-footer-value task-card-no-date">Not set</span>}</span>
      </span>
    </button>
  );
}
type ListViewColumn = { key: string; name: string; kind: "core" | "builtIn" | "custom" } & (
  | { core: string; field?: never }
  | { field: NonNullable<Detail["fields"]>[number]; core?: never }
);
function listColumns(detail: Detail, projectId?: string | null): ListViewColumn[] {
  return [
    { key: "title", core: "title", name: "Task", kind: "core" },
    { key: "status", core: "status", name: "Status", kind: "core" },
    { key: "assigneeId", core: "assigneeId", name: "Assignee", kind: "core" },
    { key: "dueDate", core: "dueDate", name: "Due date", kind: "core" },
    ...projectBuiltIns(detail, projectId).map(core => ({ key: core, core, name: optionalBuiltIns.find(field => field.id === core)!.label, kind: "builtIn" as const })),
    ...projectCustomFields(detail, projectId).map(field => ({ key: `custom:${field.id}`, field, name: field.name, kind: "custom" as const })),
  ];
}
function defaultColumnKeys(detail: Detail, projectId?: string | null) {
  return listColumns(detail, projectId).map(column => column.key);
}
function moveIn(values: string[], key: string, offset: number): string[] {
  const from = values.indexOf(key);
  const to = from + offset;
  if (from === -1 || to < 0 || to >= values.length) return values;
  const next = [...values];
  next.splice(from, 1);
  next.splice(to, 0, key);
  return next;
}
function ColumnControls({ columns, settings, onChange, saving, error }: {
  columns: ListViewColumn[];
  settings: ListViewSettings;
  onChange: (settings: ListViewSettings) => void;
  saving: boolean;
  error: string;
}) {
  const controlsId = useId();
  const [expanded, setExpanded] = useState(false);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  const name = (key: string) => columns.find(column => column.key === key)?.name || key;
  function move(key: string, offset: number) {
    onChange({ ...settings, columnOrder: moveIn(settings.columnOrder, key, offset) });
  }
  function drop(index: number) {
    const from = dragIndex;
    setDragIndex(null);
    setOverIndex(null);
    if (from === null || from === index) return;
    const next = [...settings.columnOrder];
    const [key] = next.splice(from, 1);
    next.splice(index, 0, key);
    onChange({ ...settings, columnOrder: next });
  }
  function toggle(key: string) {
    if (key === "title") return;
    const hiding = !settings.hiddenColumns.includes(key);
    const hiddenColumns = settings.hiddenColumns.includes(key)
      ? settings.hiddenColumns.filter(candidate => candidate !== key)
      : [...settings.hiddenColumns, key];
    onChange({ ...settings, hiddenColumns, sort: hiding && settings.sort?.column === key ? null : settings.sort });
  }
  const visibleCount = settings.columnOrder.length - settings.hiddenColumns.length;
  return <section className="list-controls" aria-label="List columns">
    <button className="list-controls-disclosure" type="button" aria-expanded={expanded} aria-controls={`${controlsId}-panel`} onClick={() => setExpanded(value => !value)}>
      <span>Columns</span>
      <span className="count">{visibleCount}/{settings.columnOrder.length}</span>
      <svg aria-hidden="true" viewBox="0 0 24 24"><path d={expanded ? "m6 15 6-6 6 6" : "m6 9 6 6 6-6"} /></svg>
    </button>
    {expanded && <div id={`${controlsId}-panel`} className="column-order" role="toolbar" aria-label="List column controls">
    <ol className="column-order-list">
      {settings.columnOrder.map((key, index) => (
        <li
          key={key}
          className={`column-order-item${settings.hiddenColumns.includes(key) ? " column-hidden" : ""}${overIndex === index && dragIndex !== null && dragIndex !== index ? " selected" : ""}`}
          draggable={!saving}
          onDragStart={(event) => { setDragIndex(index); event.dataTransfer.setData("text/plain", key); }}
          onDragEnd={() => { setDragIndex(null); setOverIndex(null); }}
          onDragOver={(event) => { if (dragIndex !== null) { event.preventDefault(); setOverIndex(index); } }}
          onDrop={(event) => { event.preventDefault(); drop(index); }}
        >
          <span>{name(key)}</span>
          <button type="button" disabled={saving || index === 0} aria-label={`Move ${name(key)} column left`} onClick={() => move(key, -1)}>←</button>
          <button type="button" disabled={saving || index === settings.columnOrder.length - 1} aria-label={`Move ${name(key)} column right`} onClick={() => move(key, 1)}>→</button>
          <button type="button" disabled={saving || key === "title"} aria-pressed={!settings.hiddenColumns.includes(key)}
            aria-label={`${settings.hiddenColumns.includes(key) ? "Show" : "Hide"} ${name(key)} column`} onClick={() => toggle(key)}>
            {settings.hiddenColumns.includes(key)
              ? <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M3 3l18 18M10.6 10.7a2 2 0 0 0 2.7 2.7M9.9 4.2A10.7 10.7 0 0 1 12 4c5.5 0 9 6 9 6a15 15 0 0 1-2.1 2.7M6.6 6.7C4.3 8.2 3 10 3 10s3.5 6 9 6c.8 0 1.5-.1 2.2-.3" /></svg>
              : <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M3 12s3.5-6 9-6 9 6 9 6-3.5 6-9 6-9-6-9-6z"/><circle cx="12" cy="12" r="2.5"/></svg>}
          </button>
        </li>
      ))}
    </ol>
    {saving && <p className="view-help" role="status">Saving list preferences...</p>}
    {error && <p className="notice" role="alert">{error}</p>}
    {!saving && !error && <p className="view-help">Order, visibility, and sorting save for this view.</p>}
    </div>}
  </section>;
}
function FilterControls({ fields, filters, groupBy, onFilters, onGroupBy, typeOf, optionsFor }: {
  fields: ListViewColumn[];
  filters: ListFilter[];
  groupBy: string;
  onFilters: (filters: ListFilter[]) => void;
  onGroupBy: (field: string) => void;
  typeOf: (field: ListViewColumn) => ListSortType;
  optionsFor: (field: ListViewColumn) => { value: string; label: string }[] | undefined;
}) {
  const panelId = useId();
  const sequence = useRef(0);
  const [expanded, setExpanded] = useState(false);
  const field = (key: string) => fields.find(candidate => candidate.key === key) ?? fields[0];
  const operators = (candidate: ListViewColumn): { value: ListFilterOperator; label: string }[] => {
    const type = typeOf(candidate);
    if (type === "number") return [
      { value: "is", label: "is" }, { value: "is_not", label: "is not" }, { value: "gt", label: "is greater than" },
      { value: "gte", label: "is at least" }, { value: "lt", label: "is less than" }, { value: "lte", label: "is at most" },
      { value: "empty", label: "is empty" }, { value: "not_empty", label: "is not empty" },
    ];
    if (type === "date") return [
      { value: "is", label: "is on" }, { value: "is_not", label: "is not on" }, { value: "gt", label: "is after" },
      { value: "gte", label: "is on or after" }, { value: "lt", label: "is before" }, { value: "lte", label: "is on or before" },
      { value: "empty", label: "is empty" }, { value: "not_empty", label: "is not empty" },
    ];
    return [
      { value: "contains", label: "contains" }, { value: "not_contains", label: "does not contain" },
      { value: "is", label: "is" }, { value: "is_not", label: "is not" },
      { value: "empty", label: "is empty" }, { value: "not_empty", label: "is not empty" },
    ];
  };
  function add() {
    const first = fields[0];
    if (!first) return;
    onFilters([...filters, { id: `filter-${Date.now()}-${sequence.current++}`, field: first.key, operator: "contains", value: "" }]);
  }
  return <section className="list-controls list-filter-controls" aria-label="List filters and grouping">
    <button className="list-controls-disclosure" type="button" aria-expanded={expanded} aria-controls={panelId} onClick={() => setExpanded(value => !value)}>
      <span>Filter & group</span>
      {(filters.length > 0 || groupBy) && <span className="count">{filters.length + (groupBy ? 1 : 0)}</span>}
      <svg aria-hidden="true" viewBox="0 0 24 24"><path d={expanded ? "m6 15 6-6 6 6" : "m6 9 6 6 6-6"} /></svg>
    </button>
    {expanded && <div id={panelId} className="list-filter-panel">
      <div className="list-filter-heading"><strong>Match all filters</strong><button type="button" onClick={add}>+ Add filter</button></div>
      {filters.map((filter, index) => {
        const selectedField = field(filter.field);
        const choices = optionsFor(selectedField);
        const needsValue = filter.operator !== "empty" && filter.operator !== "not_empty";
        return <div className="list-filter-row" key={filter.id}>
          <span className="list-filter-join">{index ? "AND" : "WHERE"}</span>
          <select aria-label={`Filter ${index + 1} field`} value={selectedField.key} onChange={event => {
            const nextField = field(event.target.value);
            const operator = typeOf(nextField) === "number" || typeOf(nextField) === "date" ? "is" : "contains";
            onFilters(filters.map(candidate => candidate.id === filter.id ? { ...candidate, field: nextField.key, operator, value: "" } : candidate));
          }}>{fields.map(candidate => <option value={candidate.key} key={candidate.key}>{candidate.name}</option>)}</select>
          <select aria-label={`Filter ${index + 1} formula`} value={filter.operator} onChange={event => onFilters(filters.map(candidate => candidate.id === filter.id ? { ...candidate, operator: event.target.value as ListFilterOperator } : candidate))}>
            {operators(selectedField).map(operator => <option value={operator.value} key={operator.value}>{operator.label}</option>)}
          </select>
          {needsValue && (choices ? <select aria-label={`Filter ${index + 1} value`} value={filter.value} onChange={event => onFilters(filters.map(candidate => candidate.id === filter.id ? { ...candidate, value: event.target.value } : candidate))}>
            <option value="">Choose a value</option>{choices.map(choice => <option value={choice.value} key={choice.value}>{choice.label}</option>)}
          </select> : <input aria-label={`Filter ${index + 1} value`} type={typeOf(selectedField) === "number" ? "number" : typeOf(selectedField) === "date" ? "date" : "text"}
            value={filter.value} onChange={event => onFilters(filters.map(candidate => candidate.id === filter.id ? { ...candidate, value: event.target.value } : candidate))} />)}
          <button type="button" aria-label={`Remove filter ${index + 1}`} onClick={() => onFilters(filters.filter(candidate => candidate.id !== filter.id))}>Remove</button>
        </div>;
      })}
      {!filters.length && <p className="view-help">No filters. Add more than one to narrow tasks with AND formulas.</p>}
      <label className="list-group-control">Group tasks by
        <select value={groupBy} onChange={event => onGroupBy(event.target.value)}><option value="">No grouping</option>{fields.map(candidate => <option value={candidate.key} key={candidate.key}>{candidate.name}</option>)}</select>
      </label>
    </div>}
  </section>;
}
function BulkActions({ tasks, selectedIds, writable, deletable, busy, error, onAction, onClear }: {
  tasks: Item[]; selectedIds: Set<string>; writable: boolean; deletable: boolean; busy: boolean; error: string;
  onAction: (action: "archive" | "delete", tasks: Item[]) => void; onClear: (ids: string[]) => void;
}) {
  const selected = tasks.filter(item => selectedIds.has(item.id));
  if (!selected.length) return null;
  return <div className="bulk-actions" role="toolbar" aria-label="Bulk task actions">
    <strong>{selected.length} selected</strong>
    {writable && <button type="button" disabled={busy} onClick={() => onAction("archive", selected)}>Archive</button>}
    {deletable && <button className="danger" type="button" disabled={busy} onClick={() => onAction("delete", selected)}>Delete</button>}
    <button type="button" disabled={busy} onClick={() => onClear(selected.map(item => item.id))}>Clear</button>
    {busy && <span role="status">Applying bulk action...</span>}
    {error && <span role="alert">{error}</span>}
  </div>;
}
export default function TaskViews({
  items,
  detail,
  view,
  month,
  setMonth,
  onOpen,
  onMove,
  writable,
  limit,
  onShowMore,
  onSaved,
  projectId,
  filtered,
  scopedLists,
  groupedNodes,
  onItemUpdated,
  onCreateTask,
  deletable = false,
}: Props) {
  const [moving, setMoving] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const settingsScope = JSON.stringify([detail.workspace.id, projectId ?? null]);
  const defaults = defaultColumnKeys(detail, projectId);
  const [storedSettings, setStoredSettings] = useState<{ scope: string; value: ListViewSettings } | null>(null);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [settingsError, setSettingsError] = useState("");
  const settingsRequest = useRef<AbortController | null>(null);
  const galleryStorageKey = `hopya.gallery-columns:${detail.workspace.id}`;
  const [galleryColumns, setGalleryColumns] = useState<"auto" | "2" | "3" | "4" | "5">("auto");
  const [filters, setFilters] = useState<ListFilter[]>([]);
  const [groupBy, setGroupBy] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [bulkState, setBulkState] = useState<{ listId: string; busy: boolean; error: string }>({ listId: "", busy: false, error: "" });
  const listSettings = normalizeListViewSettings(
    storedSettings?.scope === settingsScope ? storedSettings.value : null,
    defaults,
    projectId ?? null,
  );
  async function move(item: Item, status: Item["status"]) {
    if (!projectStatuses(detail, item.nodeId).some(s => s.id === status)) return;
    setMoving(item.id);
    try {
      await onMove(item, status);
    } finally {
      setMoving(null);
    }
  }
  useEffect(() => {
    if (view !== "list") return;
    const controller = new AbortController();
    settingsRequest.current?.abort();
    settingsRequest.current = controller;
    setStoredSettings(null);
    setSettingsBusy(true);
    setSettingsError("");
    const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
    void api<unknown>(`${workspacePath(detail.workspace.id)}/views/list/settings${query}`, "GET", undefined, controller.signal)
      .then(value => {
        if (!controller.signal.aborted) setStoredSettings({ scope: settingsScope, value: normalizeListViewSettings(value, defaults, projectId ?? null) });
      })
      .catch(error => { if (!controller.signal.aborted) setSettingsError(message(error)); })
      .finally(() => { if (!controller.signal.aborted) setSettingsBusy(false); });
    return () => controller.abort();
  }, [settingsScope, view]);
  useEffect(() => {
    if (view !== "gallery") return;
    try {
      const stored = localStorage.getItem(galleryStorageKey);
      setGalleryColumns(stored === "2" || stored === "3" || stored === "4" || stored === "5" ? stored : "auto");
    } catch {
      setGalleryColumns("auto");
    }
  }, [galleryStorageKey, view]);
  function configureGallery(columns: typeof galleryColumns) {
    setGalleryColumns(columns);
    try { localStorage.setItem(galleryStorageKey, columns); } catch { /* Browser storage is optional. */ }
  }
  async function saveListSettings(next: ListViewSettings) {
    if (settingsBusy) return;
    const previous = listSettings;
    const normalized = normalizeListViewSettings(next, defaults, projectId ?? null);
    setStoredSettings({ scope: settingsScope, value: normalized });
    setSettingsBusy(true);
    setSettingsError("");
    const controller = new AbortController();
    settingsRequest.current?.abort();
    settingsRequest.current = controller;
    try {
      const saved = await api<unknown>(`${workspacePath(detail.workspace.id)}/views/list/settings`, "PATCH", {
        projectId: projectId ?? null,
        columnOrder: normalized.columnOrder,
        hiddenColumns: normalized.hiddenColumns,
        sort: normalized.sort,
        expectedUpdatedAt: normalized.updatedAt,
      }, controller.signal);
      if (!controller.signal.aborted)
        setStoredSettings({ scope: settingsScope, value: normalizeListViewSettings(saved, defaults, projectId ?? null) });
    } catch (error) {
      if (!controller.signal.aborted) {
        setStoredSettings({ scope: settingsScope, value: previous });
        setSettingsError(message(error));
        const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
        try {
          const fresh = await api<unknown>(`${workspacePath(detail.workspace.id)}/views/list/settings${query}`, "GET", undefined, controller.signal);
          if (!controller.signal.aborted)
            setStoredSettings({ scope: settingsScope, value: normalizeListViewSettings(fresh, defaults, projectId ?? null) });
        } catch {
          // Keep the last confirmed state and the original save error visible.
        }
      }
    } finally {
      if (!controller.signal.aborted) setSettingsBusy(false);
    }
  }
  function columnType(column: ListViewColumn): ListSortType {
    if (column.core === "status") return "status";
    if (column.core === "dueDate" || column.core === "startDate" || column.core === "createdAt" || column.core === "updatedAt" || column.field?.type === "date" || column.field?.type === "datetime") return "date";
    if (column.field?.type === "number" || column.field?.type === "rating") return "number";
    if (column.field?.type === "checkbox") return "checkbox";
    return "text";
  }
  function filterColumns(): ListViewColumn[] {
    const core: ListViewColumn[] = [
      { key: "title", core: "title", name: "Task", kind: "core" },
      { key: "description", core: "description", name: "Body", kind: "builtIn" },
      { key: "status", core: "status", name: "Status", kind: "core" },
      { key: "priority", core: "priority", name: "Priority", kind: "builtIn" },
      { key: "assigneeId", core: "assigneeId", name: "Assignee", kind: "core" },
      { key: "nodeId", core: "nodeId", name: "List", kind: "builtIn" },
      { key: "startDate", core: "startDate", name: "Start date", kind: "builtIn" },
      { key: "dueDate", core: "dueDate", name: "Due date", kind: "core" },
      { key: "tags", core: "tags", name: "Tags", kind: "builtIn" },
      { key: "createdAt", core: "createdAt", name: "Created", kind: "builtIn" },
      { key: "updatedAt", core: "updatedAt", name: "Updated", kind: "builtIn" },
    ];
    return [...core, ...detail.fields.map(field => ({ key: `custom:${field.id}`, field, name: field.name, kind: "custom" as const }))];
  }
  const advancedFields = filterColumns();
  function filterType(column: ListViewColumn): ListSortType {
    return column.core === "status" ? "text" : columnType(column);
  }
  function displayValue(item: Item, column: ListViewColumn): unknown {
    if (column.core === "status") return statusLabel(detail, item.nodeId, item.status);
    if (column.core === "priority") return label(item.priority);
    return sortValue(item, column);
  }
  function filterOptions(column: ListViewColumn): { value: string; label: string }[] | undefined {
    if (column.core === "status") return [...new Set((scopedLists ?? []).flatMap(list => projectStatuses(detail, list.id).map(status => status.name)))].map(value => ({ value, label: value }));
    if (column.core === "priority") return ["none", "low", "medium", "high", "urgent"].map(value => ({ value: label(value), label: label(value) }));
    if (column.core === "assigneeId") return [{ value: "Unassigned", label: "Unassigned" }, ...detail.members.filter(member => !member.disabled).map(member => ({ value: member.name, label: member.name }))];
    if (column.core === "nodeId") return (scopedLists ?? []).map(list => ({ value: list.name, label: list.name }));
    if (column.field?.type === "checkbox") return [{ value: "true", label: "Yes" }, { value: "false", label: "No" }];
    if (column.field?.type === "select" || column.field?.type === "checklist") return column.field.options?.map(value => ({ value, label: value }));
    return undefined;
  }
  const filteredItems = view === "list" ? items.filter(item => filters.every(filter => {
    const column = advancedFields.find(candidate => candidate.key === filter.field);
    return column ? matchesListFilter(displayValue(item, column), filter, filterType(column)) : true;
  })) : items;
  useEffect(() => {
    if (view !== "list") return;
    const available = new Set(filteredItems.map(item => item.id));
    setSelectedIds(current => {
      const next = new Set([...current].filter(id => available.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [view, items, filters]);
  function changeSelection(ids: string[], selected: boolean) {
    setSelectedIds(current => {
      const next = new Set(current);
      ids.forEach(id => selected ? next.add(id) : next.delete(id));
      return next;
    });
  }
  async function bulkAction(listId: string, action: "archive" | "delete", tasks: Item[]) {
    if (!tasks.length || tasks.length > 100 || bulkState.busy) return;
    if (!window.confirm(`${action === "delete" ? "Permanently delete" : "Archive"} ${tasks.length} selected ${tasks.length === 1 ? "task" : "tasks"}?`)) return;
    setBulkState({ listId, busy: true, error: "" });
    try {
      await api(`${workspacePath(detail.workspace.id)}/items/bulk`, "POST", { action, items: tasks.map(item => ({ id: item.id, expectedUpdatedAt: item.updatedAt })) });
      changeSelection(tasks.map(item => item.id), false);
      onSaved?.();
    } catch (error) {
      setBulkState({ listId, busy: false, error: message(error) });
    }
  }
  function groupTasks(source: Item[]): { key: string; label: string; tasks: Item[] }[] {
    const column = advancedFields.find(candidate => candidate.key === groupBy);
    if (!column) return [{ key: "", label: "", tasks: source }];
    const groups = new Map<string, { label: string; tasks: Item[] }>();
    for (const item of source) {
      const raw = displayValue(item, column);
      const label = Array.isArray(raw) ? raw.join(" / ") || "No value" : raw === null || raw === undefined || raw === "" ? "No value" : String(raw);
      const group = groups.get(label) ?? { label, tasks: [] };
      group.tasks.push(item);
      groups.set(label, group);
    }
    return [...groups].sort(([left], [right]) => left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" })).map(([key, value]) => ({ key, ...value }));
  }
  const listControls = <div className="list-controls-row">
    <ColumnControls columns={listColumns(detail, projectId)} settings={listSettings} onChange={settings => void saveListSettings(settings)} saving={settingsBusy} error={settingsError} />
    <FilterControls fields={advancedFields} filters={filters} groupBy={groupBy} onFilters={setFilters} onGroupBy={setGroupBy} typeOf={filterType} optionsFor={filterOptions} />
  </div>;
  function sortValue(item: Item, column: ListViewColumn): unknown {
    if (column.field) {
      if (column.field.type === "formula" && column.field.settings?.formula !== undefined)
        return evaluateFormula(column.field.settings.formula, Object.fromEntries(detail.fields.map(field => [field.name, Array.isArray(item.customFields[field.id]) ? null : item.customFields[field.id] ?? null])) as Record<string, string | number | boolean | null>);
      return item.customFields[column.field.id] ?? null;
    }
    if (column.core === "assigneeId") return detail.members.find(member => member.userId === item.assigneeId)?.name ?? null;
    if (column.core === "status") {
      const rank = projectStatuses(detail, item.nodeId).findIndex(status => status.id === item.status);
      return rank < 0 ? null : rank;
    }
    if (column.core === "nodeId") return detail.nodes.find(node => node.id === item.nodeId)?.name ?? null;
    const value = item[column.core as keyof Item];
    return Array.isArray(value) ? value.join(" ") : value;
  }
  function sorted(source: Item[]) {
    const sort = listSettings.sort;
    const column = sort && listColumns(detail, projectId).find(candidate => candidate.key === sort.column);
    return sort && column ? sortListItems([...source], sort, columnType(column), item => sortValue(item, column)) : source;
  }
  if (view === "gallery") {
    const shown = items.slice(0, limit);
    return <section className="gallery-view" aria-labelledby="gallery-heading">
      <div className="gallery-toolbar">
        <div>
          <h2 id="gallery-heading">Gallery</h2>
          <p className="view-help" role="status">Showing {shown.length} of {items.length} tasks</p>
        </div>
        <label className="gallery-columns">
          Grid columns
          <select aria-label="Grid columns" value={galleryColumns} onChange={event => configureGallery(event.target.value as typeof galleryColumns)}>
            <option value="auto">Auto-fit</option>
            <option value="2">2 columns</option>
            <option value="3">3 columns</option>
            <option value="4">4 columns</option>
            <option value="5">5 columns</option>
          </select>
        </label>
      </div>
      <div className={`gallery-grid${galleryColumns === "auto" ? " gallery-grid--auto" : ""}`}
        style={galleryColumns === "auto" ? undefined : { gridTemplateColumns: `repeat(${galleryColumns}, minmax(0, 1fr))` }}>
        {shown.map(item => <TaskCard key={item.id} item={item} onOpen={onOpen} detail={detail} variant="gallery" />)}
      </div>
      {shown.length < items.length && <div className="section-heading gallery-more"><button onClick={onShowMore}>Show more tasks</button></div>}
    </section>;
  }
  if (view === "board") {
    const definitions = new Map<string, { status: ReturnType<typeof projectStatuses>[number]; listIds: Set<string> }>();
    const statusKey = (s: ReturnType<typeof projectStatuses>[number]) => JSON.stringify([s.id, s.name, s.color, s.completed]);
    const lists = scopedLists ?? detail.nodes.filter(n => n.kind === "list");
    const listLabels = hierarchyLabels(detail.nodes, lists);
    for (const list of lists) for (const status of projectStatuses(detail, list.id)) {
      const key = statusKey(status);
      const definition = definitions.get(key) ?? { status, listIds: new Set<string>() };
      definition.listIds.add(list.id);
      definitions.set(key, definition);
    }
    const columns = [...definitions].map(([key, definition]) => ({ key, ...definition, tasks: [] as Item[] }));
    const nameCounts = new Map<string, number>();
    for (const column of columns) nameCounts.set(column.status.name, (nameCounts.get(column.status.name) || 0) + 1);
    const columnLabel = (column: typeof columns[number]) => nameCounts.get(column.status.name)! > 1
      ? `${column.status.name} (${[...column.listIds].map(id => listLabels.get(id)).join(", ")})`
      : column.status.name;
    const byKey = new Map(columns.map(column => [column.key, column]));
    for (const item of items) {
      const s = projectStatuses(detail, item.nodeId).find(s => s.id === item.status);
      if (s) byKey.get(statusKey(s))?.tasks.push(item);
    }
    const shown = columns.reduce(
      (total, column) => total + Math.min(limit, column.tasks.length),
      0,
    );
    return (
      <>
        <div className="section-heading">
          <p className="view-help" role="status">
            Showing {shown} of {items.length} tasks across all columns.
          </p>
          {shown < items.length && (
            <button onClick={onShowMore}>Show 100 more per column</button>
          )}
        </div>
        <div className="board" tabIndex={0} role="region" aria-label="Task board">
          {columns.map((column) => {
            const { key, status, tasks, listIds } = column;
            const draggedItem = items.find(item => item.id === dragging);
            const unavailable = !!draggedItem && !listIds.has(draggedItem.nodeId);
            return (
            <section
              className={`board-column${unavailable ? " unavailable" : ""}`}
              key={key}
              aria-label={columnLabel(column)}
              aria-disabled={unavailable || undefined}
              onDragOver={(e) => {
                const item = items.find(value => value.id === dragging);
                if (writable && item && listIds.has(item.nodeId)) e.preventDefault();
              }}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(null);
                const item = items.find(
                  (i) => i.id === e.dataTransfer.getData("text/plain"),
                );
                if (item && writable && !moving && projectStatuses(detail, item.nodeId).some(s => statusKey(s) === key))
                  void move(item, status.id);
              }}
            >
              <h2>
                <Status status={status.id} name={status.name} color={status.color} />
                <span className="count">{tasks.length}</span>
              </h2>
              {nameCounts.get(status.name)! > 1 && <p className="view-help">Available in {[...listIds].map(id => listLabels.get(id)).join(", ")}</p>}
              <p className="view-help">
                Showing {Math.min(limit, tasks.length)} of {tasks.length} tasks
              </p>
              <div className="board-stack">
                {tasks.slice(0, limit).map((item) => (
                  <div
                    className="board-task"
                    key={item.id}
                    draggable={writable && !moving}
                    onDragStart={(e) => { setDragging(item.id); e.dataTransfer.setData("text/plain", item.id); }}
                    onDragEnd={() => setDragging(null)}
                  >
                    <TaskCard item={item} onOpen={onOpen} detail={detail} />
                    {writable && (
                      <label className="move-label">
                        Move to
                        <select
                          aria-label={`Move ${item.title} to status`}
                          value={item.status}
                          disabled={moving !== null}
                          onChange={(e) =>
                            void move(item, e.target.value as Item["status"])
                          }
                        >
                          {projectStatuses(detail, item.nodeId).map((s) => (
                            <option key={s.id} value={s.id}>
                              {s.name}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                  </div>
                ))}
                {!tasks.length && (
                  <p className="column-empty">Nothing here yet</p>
                )}
              </div>
            </section>
          );})}
        </div>
      </>
    );
  }
  if (view === "calendar" || view === "gantt") {
    const days = monthDays(month);
    const first = monthStart(month);
    const total = addDays(monthStart(month, 1), -1).getDate();
    const firstKey = dateKey(first);
    const lastKey = dateKey(addDays(first, total - 1));
    const monthValue = `${String(month.getFullYear()).padStart(4, "0")}-${String(month.getMonth() + 1).padStart(2, "0")}`;
    const buckets = new Map(days.map((day) => [dateKey(day), [] as Item[]]));
    const scheduled: {
      item: Item;
      bar: NonNullable<ReturnType<typeof barRange>>;
    }[] = [];
    const unscheduled: Item[] = [];
    const outside: Item[] = [];
    let monthCount = 0;
    for (const item of items) {
      if (view === "calendar") {
        const date = item.dueDate || item.startDate;
        if (!date) unscheduled.push(item);
        else {
          const bucket = buckets.get(date);
          if (bucket) {
            bucket.push(item);
            if (date >= firstKey && date <= lastKey) monthCount++;
          } else outside.push(item);
        }
      } else {
        const bar = barRange(item.startDate, item.dueDate, first, total);
        if (bar) scheduled.push({ item, bar });
        else unscheduled.push(item);
      }
    }
    const gridCount = [...buckets.values()].reduce(
      (count, tasks) => count + tasks.length,
      0,
    );
    const gridShown = [...buckets.values()].reduce(
      (count, tasks) => count + Math.min(limit, tasks.length),
      0,
    );
    const shown =
      (view === "calendar" ? gridShown : Math.min(limit, scheduled.length)) +
      Math.min(limit, unscheduled.length) +
      Math.min(limit, outside.length);
    const sections = [
      {
        id: "unscheduled",
        title:
          view === "calendar"
            ? "Without a date"
            : "Outside this month or unscheduled",
        tasks: unscheduled,
      },
      {
        id: "outside-calendar",
        title: "Outside this calendar grid",
        tasks: outside,
      },
    ];
    return (
      <section>
        <div className="date-toolbar" style={{ flexWrap: "wrap" }}>
          <h2>
            {month.toLocaleDateString(undefined, {
              month: "long",
              year: "numeric",
            })}
          </h2>
          <div className="button-group">
            <button
              aria-label="Previous month"
              disabled={monthValue === "0000-01"}
              onClick={() => setMonth(monthStart(month, -1))}
            >
              ←
            </button>
            <button onClick={() => setMonth(new Date())}>Today</button>
            <button
              aria-label="Next month"
              disabled={monthValue === "9999-12"}
              onClick={() => setMonth(monthStart(month, 1))}
            >
              →
            </button>
          </div>
        </div>
        <form
          key={monthValue}
          className="section-heading"
          onSubmit={(event) => {
            event.preventDefault();
            const input = event.currentTarget.elements.namedItem(
              "month",
            ) as HTMLInputElement;
            const selected = parseMonth(input.value);
            input.setCustomValidity(
              selected ? "" : "Enter a month as YYYY-MM (0000-01 to 9999-12).",
            );
            if (selected) setMonth(selected);
            else input.reportValidity();
          }}
        >
          <label>
            Jump to month (YYYY-MM)
            <input
              name="month"
              type={month.getFullYear() === 0 ? "text" : "month"}
              defaultValue={monthValue}
              min="0001-01"
              max="9999-12"
              pattern="[0-9]{4}-(0[1-9]|1[0-2])"
              placeholder="YYYY-MM"
              required
              onInput={(event) => event.currentTarget.setCustomValidity("")}
            />
          </label>
          <button type="submit">Go to month</button>
        </form>
        <div className="section-heading">
          <p className="view-help" role="status">
            Showing {shown} of {items.length} tasks across all date sections.{" "}
            {view === "calendar"
              ? `${monthCount} in selected month; showing ${gridShown} of ${gridCount} in the 42-day grid.`
              : `Showing ${Math.min(limit, scheduled.length)} of ${scheduled.length} scheduled in selected month.`}
          </p>
          {shown < items.length && (
            <button onClick={onShowMore}>
              {view === "calendar"
                ? "Show 100 more per day and per date list"
                : "Show 100 more scheduled and 100 more outside/unscheduled"}
            </button>
          )}
        </div>
        {view === "calendar" ? (
          <div className="calendar-scroll" tabIndex={0} role="region" aria-label="Task calendar">
            <div className="calendar-grid">
              {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((day) => (
                <div className="weekday" key={day}>
                  {day}
                </div>
              ))}
              {days.map((day) => {
                const key = dateKey(day);
                const tasks = buckets.get(key)!;
                return (
                  <div
                    className={`calendar-day ${day.getMonth() !== month.getMonth() ? "outside" : ""} ${dateKey(day) === dateKey(new Date()) ? "today" : ""}`}
                    key={dateKey(day)}
                  >
                    <time dateTime={dateKey(day)}>{day.getDate()}</time>
                    {tasks.length > 0 && (
                      <p
                        className="view-help"
                        aria-label={`${key}: showing ${Math.min(limit, tasks.length)} of ${tasks.length} tasks`}
                      >
                        Showing {Math.min(limit, tasks.length)} of{" "}
                        {tasks.length} tasks
                      </p>
                    )}
                    {tasks.slice(0, limit).map((item) => (
                      <button
                         className={`calendar-task status-${item.status}`}
                         style={statusStyle(projectStatuses(detail, item.nodeId).find(s => s.id === item.status)?.color || "")}
                        data-task-id={item.id}
                        key={item.id}
                        onClick={() => onOpen(item)}
                        title={`${item.title}, ${item.dueDate ? "due" : "starts"} ${dateKey(day)}`}
                      >
                        {item.title}
                      </button>
                    ))}
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="gantt-scroll" tabIndex={0} role="region" aria-label="Task timeline">
            <div
              className="gantt"
              style={{ minWidth: Math.max(850, total * 32 + 220) }}
            >
              <div className="gantt-row">
                <div className="gantt-label muted">TASK / SCHEDULE</div>
                <div
                  className="gantt-track gantt-days"
                  style={{ gridTemplateColumns: `repeat(${total}, 1fr)` }}
                >
                  {Array.from({ length: total }, (_, i) => (
                    <span key={i}>{addDays(first, i).getDate()}</span>
                  ))}
                </div>
              </div>
              {scheduled.slice(0, limit).map(({ item, bar }) => {
                return (
                  <div className="gantt-row" key={item.id}>
                    <button
                      className="gantt-label"
                      data-task-id={item.id}
                      onClick={() => onOpen(item)}
                    >
                      {item.title}
                    </button>
                    <div
                      className="gantt-track"
                      style={{
                        gridTemplateColumns: `repeat(${total}, 1fr)`,
                        backgroundSize: `calc(100% / ${total}) 100%`,
                      }}
                    >
                      <button
                        className={`gantt-bar status-${item.status}`}
                        data-task-id={item.id}
                        style={{
                          ...statusStyle(projectStatuses(detail, item.nodeId).find(s => s.id === item.status)?.color || ""),
                          gridColumn: `${bar.offset + 1} / span ${bar.span}`,
                        }}
                        onClick={() => onOpen(item)}
                        aria-label={`${item.title}: ${item.startDate || item.dueDate} to ${item.dueDate || item.startDate}, ${statusLabel(detail, item.nodeId, item.status)}`}
                        title={`${item.title}: ${item.startDate || item.dueDate} – ${item.dueDate || item.startDate}`}
                      >
                        <span>{item.title}</span>
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
        {sections.map(
          ({ id, title, tasks }) =>
            tasks.length > 0 && (
              <section
                className="unscheduled"
                key={id}
                aria-labelledby={`${id}-heading`}
              >
                <h3 id={`${id}-heading`}>
                  {title} <span className="count">{tasks.length}</span>
                </h3>
                <p className="view-help">
                  Showing {Math.min(limit, tasks.length)} of {tasks.length}{" "}
                  tasks
                  {id === "outside-calendar" &&
                    ". Jump to a month, search all tasks, or open a task here."}
                </p>
                {tasks.slice(0, limit).map((i) => (
                  <button key={i.id} data-task-id={i.id} onClick={() => onOpen(i)}>
                    {i.title}
                    <span>{i.dueDate || i.startDate || "Add dates"} →</span>
                  </button>
                ))}
              </section>
            ),
        )}
      </section>
    );
  }
  if (view === "list" && groupedNodes) {
    const nodes = new Map(detail.nodes.map(node => [node.id, node]));
    // List sections are always real task destinations. This keeps the add row
    // unambiguous even when the selected project contains nested folders.
    const listGroups = scopedLists ?? groupedNodes.filter(node => node.kind === "list");
    const buckets = new Map(listGroups.map(node => [node.id, [] as Item[]]));
    for (const item of filteredItems) {
      buckets.get(item.nodeId)?.push(item);
    }
    let remaining = limit;
    return <div className="grouped-lists">
      {listControls}
      <div className="section-heading">
        <p className="view-help" role="status">Showing {Math.min(limit, filteredItems.length)} of {filteredItems.length} tasks{listGroups.length > 1 ? ` across ${listGroups.length} lists` : ""}</p>
        {limit < filteredItems.length && <button onClick={onShowMore}>Show more tasks</button>}
      </div>
      {listGroups.map(group => {
        const tasks = buckets.get(group.id)!;
        const shown = sorted(tasks).slice(0, remaining);
        remaining -= shown.length;
        const path: string[] = [];
        const seen = new Set<string>();
        let node: TreeNode | undefined = group;
        while (node && !seen.has(node.id) && path.length <= 32) {
          seen.add(node.id);
          path.unshift(node.name);
          node = node.parentId ? nodes.get(node.parentId) : undefined;
        }
        return <section className="list-section" key={group.id} aria-labelledby={`list-heading-${group.id}`}>
          <header>
            <h2 id={`list-heading-${group.id}`}>{group.name} <span className="node-kind">list</span> <span className="count">{tasks.length}</span></h2>
            <p className="list-path">{path.join(" / ")}</p>
            <p className="view-help">Showing {shown.length} of {tasks.length} tasks</p>
          </header>
          <BulkActions tasks={shown} selectedIds={selectedIds} writable={writable} deletable={deletable}
            busy={bulkState.busy && bulkState.listId === group.id} error={bulkState.listId === group.id ? bulkState.error : ""}
            onAction={(action, selected) => void bulkAction(group.id, action, selected)} onClear={ids => changeSelection(ids, false)} />
          {groupTasks(shown).map((taskGroup, index) => <div className="task-value-group" key={taskGroup.key || "all"}>
            {groupBy && <h3>{taskGroup.label} <span className="count">{taskGroup.tasks.length}</span></h3>}
            <TaskTable items={taskGroup.tasks} detail={detail} view="list"
              projectId={projectId} writable={writable} onOpen={onOpen}
              onSaved={onSaved} onItemUpdated={onItemUpdated}
              onCreate={index === groupTasks(shown).length - 1 && onCreateTask ? () => onCreateTask(group.id) : undefined}
              columnOrder={listSettings.columnOrder} hiddenColumns={listSettings.hiddenColumns}
              selectedIds={writable || deletable ? selectedIds : undefined} onSelectionChange={writable || deletable ? changeSelection : undefined}
              sort={listSettings.sort} onSort={sort => void saveListSettings({ ...listSettings, sort })} />
          </div>)}
          {!shown.length && (filtered || filters.length > 0) && <p className="muted">No tasks in this list match the current view.</p>}
        </section>;
      })}
    </div>;
  }
  const displayedItems = sorted(filteredItems).slice(0, limit);
  const singleListId = scopedLists?.[0]?.id ?? "scope";
  return (
    <>
      {view === "list" && listControls}
      <BulkActions tasks={displayedItems} selectedIds={selectedIds} writable={writable} deletable={deletable}
        busy={bulkState.busy && bulkState.listId === singleListId} error={bulkState.listId === singleListId ? bulkState.error : ""}
        onAction={(action, selected) => void bulkAction(singleListId, action, selected)} onClear={ids => changeSelection(ids, false)} />
      {groupTasks(displayedItems).map((taskGroup, index, groups) => <div className="task-value-group" key={taskGroup.key || "all"}>
        {groupBy && <h2>{taskGroup.label} <span className="count">{taskGroup.tasks.length}</span></h2>}
        <TaskTable
          key={JSON.stringify([detail.workspace.id, projectId, view, taskGroup.key])}
          items={taskGroup.tasks} detail={detail} view="list"
          projectId={projectId} writable={writable} onOpen={onOpen}
          onSaved={onSaved} onItemUpdated={onItemUpdated}
          onCreate={index === groups.length - 1 && onCreateTask && scopedLists?.[0] ? () => onCreateTask(scopedLists[0].id) : undefined}
          columnOrder={listSettings.columnOrder}
          hiddenColumns={listSettings.hiddenColumns}
          selectedIds={writable || deletable ? selectedIds : undefined} onSelectionChange={writable || deletable ? changeSelection : undefined}
          sort={listSettings.sort}
          onSort={(sort: ListViewSettings["sort"]) => void saveListSettings({ ...listSettings, sort })}
        />
      </div>)}
      <div className="section-heading">
        <p className="view-help" role="status">
          Showing {Math.min(limit, filteredItems.length)} of {filteredItems.length} tasks
        </p>
        {limit < filteredItems.length && (
          <button onClick={onShowMore}>Show more tasks</button>
        )}
      </div>
    </>
  );
}
