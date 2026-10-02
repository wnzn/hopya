import { useEffect, useId, useRef, useState, type KeyboardEvent, type SubmitEvent } from "react";
import {
  api,
  ApiError,
  message,
  workspacePath,
  type Detail,
  type TableCalculations,
  type TableColumn,
  type TableColumnType,
  type TableRecord,
  type TableSummary,
  type TableValue,
} from "../lib/api";
import { columnLetter, defaultTableNumberFormat, formatTableNumber, nextTableCell, readTableNumberFormats, tableCalculationLabels, tableCalculationsFor, tableCellDraft, tableRecordValues, tableValueFromDraft, tableValuesEqual, type TableCalculation, type TableNumberFormat, type TableQuery } from "../lib/table-resource";
import { listSortLabels } from "../lib/list-view";
import { Empty, ErrorNotice } from "./Shared";
import Select from "./Select";
import SolidIcon from "./SolidIcon";
import TableTransfer from "./TableTransfer";
import { TableFilters, TableMenu, TableNumberDisplay } from "./TableControls";
import "../styles/table-resource.css";

const columnTypes: TableColumnType[] = ["text", "number", "date", "datetime", "checkbox", "select"];
type CellAddress = { recordId: string; columnId: string };
type LiveSource = { dialect: string; connectionName: string; schema: string; table: string };

function TypeBadge({ column }: { column: TableColumn }) {
  const type = column.type === "datetime" ? "Date and time" : column.type[0]!.toUpperCase() + column.type.slice(1);
  const label = `${type}${column.primaryKey ? " · Primary key" : column.readOnly ? " · Read-only" : ""}`;
  return <span className="table-type-badge" role="img" title={`${label}${column.sourceType ? ` (${column.sourceType})` : ""}`} aria-label={label}>
    {column.primaryKey ? <SolidIcon name="lock" /> : column.type === "text" ? "Aa" : column.type === "number" ? "#"
      : <SolidIcon name={column.type === "date" ? "calendar" : column.type === "datetime" ? "clock" : column.type === "checkbox" ? "check" : "chevronDown"} />}
  </span>;
}

function optionsFromInput(value: string) {
  return [...new Set(value.split(/\r?\n/).map(option => option.trim()).filter(Boolean))];
}

function displayValue(column: TableColumn, value: TableValue | undefined, format?: TableNumberFormat) {
  if (value === null || value === undefined || value === "") return "Empty";
  if (column.type === "number" && (typeof value === "number" || typeof value === "string")) return formatTableNumber(value, format);
  if (column.type === "checkbox") return value === true ? "Checked" : "Unchecked";
  if ((column.type === "date" || column.type === "datetime") && typeof value === "string") {
    const date = column.type === "date" ? new Date(`${value}T00:00:00`) : new Date(value);
    if (!Number.isNaN(date.valueOf())) return column.type === "date" ? date.toLocaleDateString() : date.toLocaleString();
  }
  return String(value);
}

function calculationValue(column: TableColumn, calculation: TableCalculation, data: TableCalculations | null, format: TableNumberFormat) {
  if (!data) return "…";
  if (!data.columns[column.id]) return "Unavailable";
  const summary = data.columns[column.id]!;
  const value = calculation === "rows" ? data.recordCount : calculation === "none" ? null : summary[calculation];
  if (value == null) return summary.count && (calculation === "sum" || calculation === "average") ? "Out of range" : "—";
  if (typeof value === "number") return column.type === "number"
    ? formatTableNumber(value, ["rows", "count", "empty"].includes(calculation) ? { ...format, decimals: 0 } : format)
    : value.toLocaleString(undefined, { maximumSignificantDigits: 12 });
  return displayValue(column, value);
}

async function loadRecordPage(workspaceId: string, tableId: string, cursor: string | null, signal?: AbortSignal, view?: TableQuery) {
  const params = new URLSearchParams({ limit: "100" });
  if (cursor) params.set("cursor", cursor);
  const path = `${workspacePath(workspaceId)}/tables/${tableId}`;
  type Page = { records: TableRecord[]; nextCursor: string | null; total?: number };
  const page = view && (view.sort || view.filters.length)
    ? await api<Page>(`${path}/query`, "POST", { ...view, limit: 100, ...(cursor ? { cursor } : {}) }, signal)
    : await api<Page>(`${path}/records?${params}`, "GET", undefined, signal);
  if (!page || !Array.isArray(page.records) || !(page.nextCursor === null || (typeof page.nextCursor === "string" && page.nextCursor.length > 0)))
    throw new Error("The server returned an invalid record page. Retry loading the table.");
  const ids = new Set<string>();
  for (const record of page.records) {
    if (!record?.id || record.tableId !== tableId || ids.has(record.id))
      throw new Error("The server returned invalid or duplicate table records. Retry loading the table.");
    ids.add(record.id);
  }
  if (cursor && page.nextCursor === cursor) throw new Error("The record cursor repeated. Retry loading the table.");
  return page;
}

type CellDraft = {
  recordId: string;
  columnId: string;
  draft: string;
  initialDraft: string;
  checked: boolean | null;
  initialChecked: boolean | null;
  busy: boolean;
  error: string;
  conflict: boolean;
};

function TableCreateOnly({ detail, table }: { detail: Detail; table: TableSummary }) {
  const tablePath = `${workspacePath(detail.workspace.id)}/tables/${table.id}`;
  const [columnType, setColumnType] = useState<TableColumnType>("text");
  const [columnOptions, setColumnOptions] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState("");

  async function addColumn(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = event.currentTarget;
    const name = String(new FormData(form).get("name") ?? "").trim();
    const options = optionsFromInput(columnOptions);
    if (!name || (columnType === "select" && !options.length)) {
      setError(columnType === "select" ? "Enter a column name and at least one select option." : "Enter a column name.");
      return;
    }
    setBusy(true); setError(""); setResult("");
    try {
      await api(`${tablePath}/columns`, "POST", { name, type: columnType, ...(columnType === "select" ? { options } : {}) });
      form.reset();
      setColumnOptions("");
      setResult("Column created.");
    } catch (cause) { setError(message(cause)); }
    finally { setBusy(false); }
  }

  async function addRecord() {
    if (busy) return;
    setBusy(true); setError(""); setResult("");
    try {
      await api(`${tablePath}/records`, "POST", { values: {} });
      setResult("Empty record created.");
    } catch (cause) { setError(message(cause)); }
    finally { setBusy(false); }
  }

  return <section className="table-resource" aria-label={`${table.name} table creation`}>
    <p className="notice">Your role can create columns and empty records. Reading or editing existing Table data requires Table read access.</p>
    <ErrorNotice error={error} />
    {result && <p role="status">{result}</p>}
    <form className="table-column-form" onSubmit={addColumn}>
      <label>Column name<input name="name" required maxLength={120} /></label>
      <label>Type<Select value={columnType} onChange={event => setColumnType(event.target.value as TableColumnType)}>
        {columnTypes.map(type => <option key={type} value={type}>{type === "datetime" ? "Date and time" : type[0]!.toUpperCase() + type.slice(1)}</option>)}
      </Select></label>
      {columnType === "select" && <label>Select options<textarea value={columnOptions} onChange={event => setColumnOptions(event.target.value)} rows={3} placeholder="One option per line" required /></label>}
      <div className="modal-actions"><button className="primary" disabled={busy}>{busy ? "Adding..." : "Add column"}</button></div>
    </form>
    <button type="button" disabled={busy} onClick={addRecord}><SolidIcon name="plus" /> Add empty record</button>
  </section>;
}

export default function TableResourceEditor({ detail, table, currentUserId }: { detail: Detail; table: TableSummary; currentUserId?: string }) {
  if (!detail.permissions.includes("tables:read")) return <TableCreateOnly detail={detail} table={table} />;
  return <TableReadableEditor detail={detail} table={table} currentUserId={currentUserId} />;
}

function TableReadableEditor({ detail, table, currentUserId }: { detail: Detail; table: TableSummary; currentUserId?: string }) {
  const writable = detail.permissions.includes("tables:write");
  const deletable = detail.permissions.includes("tables:delete");
  const tablePath = `${workspacePath(detail.workspace.id)}/tables/${table.id}`;
  const [columns, setColumns] = useState<TableColumn[]>([]);
  const [records, setRecords] = useState<TableRecord[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [addingColumn, setAddingColumn] = useState(false);
  const [columnType, setColumnType] = useState<TableColumnType>("text");
  const [columnOptions, setColumnOptions] = useState("");
  const [renamingColumn, setRenamingColumn] = useState<string | null>(null);
  const [columnName, setColumnName] = useState("");
  const [columnConflict, setColumnConflict] = useState(false);
  const [cell, setCell] = useState<CellDraft | null>(null);
  const [selection, setSelection] = useState<CellAddress | null>(null);
  const [source, setSource] = useState<LiveSource | null>(null);
  const [revision, setRevision] = useState(0);
  const [transferring, setTransferring] = useState(false);
  const [transferBusy, setTransferBusy] = useState(false);
  const [calculations, setCalculations] = useState<Record<string, TableCalculation>>({});
  const [summaryRevision, setSummaryRevision] = useState(0);
  const [summary, setSummary] = useState<{ revision: number; data: TableCalculations } | null>(null);
  const [summaryError, setSummaryError] = useState("");
  const [view, setView] = useState<TableQuery>({ filters: [], sort: null });
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [sourceOpen, setSourceOpen] = useState(false);
  const [ready, setReady] = useState(false);
  const [total, setTotal] = useState<number | undefined>();
  const [notice, setNotice] = useState("");
  const [numberFormats, setNumberFormats] = useState<Record<string, TableNumberFormat>>({});
  const [formattingColumn, setFormattingColumn] = useState<TableColumn | null>(null);
  const numberFormatKey = currentUserId ? `hopya.table.numbers.v1.${currentUserId}.${detail.workspace.id}.${table.id}` : null;
  const filterPanelId = useId();
  const viewKey = JSON.stringify(view);
  const filtersKey = JSON.stringify(view.filters);
  const queried = !!view.sort || view.filters.length > 0;
  const focusAfterLoad = useRef<CellAddress | null>(null);
  const headerAfterLoad = useRef<string | null>(null);
  const loadMoreController = useRef<AbortController | null>(null);
  const cellTrigger = useRef<string | null>(null);
  const summariesEnabled = columns.some(column => calculations[column.id] && calculations[column.id] !== "none");
  const summaryPaused = loading || !!loadError || busy || transferBusy || cell?.busy === true;

  useEffect(() => {
    try { setNumberFormats(numberFormatKey ? readTableNumberFormats(localStorage.getItem(numberFormatKey)) : {}); }
    catch { setNumberFormats({}); }
    setFormattingColumn(null);
  }, [numberFormatKey]);

  function saveNumberFormat(format: TableNumberFormat) {
    if (!formattingColumn) return;
    const next = { ...numberFormats, [formattingColumn.id]: format };
    const formats = Object.fromEntries(columns.filter(column => column.type === "number" && next[column.id]).map(column => [column.id, next[column.id]!]));
    setNumberFormats(formats);
    setNotice("");
    try {
      if (numberFormatKey) localStorage.setItem(numberFormatKey, JSON.stringify(formats));
    } catch { setNotice("Number display updated for this session. Browser preferences could not be saved."); }
    setFormattingColumn(null);
  }

  useEffect(() => {
    setSummary(null); setSummaryError("");
    if (!summariesEnabled || summaryPaused) return;
    const controller = new AbortController();
    const request = view.filters.length
      ? api<{ summary: TableCalculations }>(`${tablePath}/query`, "POST", { filters: view.filters, limit: 1, summary: true }, controller.signal).then(result => result.summary)
      : api<TableCalculations>(`${tablePath}/summary`, "GET", undefined, controller.signal);
    request.then(data => {
      if (!controller.signal.aborted) setSummary({ revision: summaryRevision, data });
    }).catch(cause => { if (!controller.signal.aborted) setSummaryError(message(cause)); });
    return () => controller.abort();
  }, [tablePath, summariesEnabled, summaryRevision, summaryPaused, filtersKey]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setLoadError("");
    setError("");
    Promise.all([
      api<TableColumn[]>(`${tablePath}/columns`, "GET", undefined, controller.signal),
      loadRecordPage(detail.workspace.id, table.id, null, controller.signal, view),
      api<LiveSource | null>(`${tablePath}/source`, "GET", undefined, controller.signal),
    ]).then(([nextColumns, page, nextSource]) => {
      if (controller.signal.aborted) return;
      if (!Array.isArray(nextColumns) || nextColumns.some(column => column.tableId !== table.id))
        throw new Error("The server returned invalid table columns. Retry loading the table.");
      setColumns([...nextColumns].sort((a, b) => a.position - b.position));
      setRecords(page.records);
      setNextCursor(page.nextCursor);
      setTotal(page.total);
      setSource(nextSource);
      setReady(true);
      setSummaryRevision(value => value + 1);
    }).catch(cause => {
      if (!controller.signal.aborted) setLoadError(message(cause));
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => { controller.abort(); loadMoreController.current?.abort(); };
  }, [detail.workspace.id, table.id, tablePath, revision, viewKey]);

  useEffect(() => {
    if (loading) return;
    if (headerAfterLoad.current) {
      document.getElementById(headerAfterLoad.current)?.focus();
      headerAfterLoad.current = null;
    }
    if (!focusAfterLoad.current) return;
    const address = focusAfterLoad.current;
    focusAfterLoad.current = null;
    const record = records.find(record => record.id === address.recordId) ?? records[0];
    if (record) selectCell({ recordId: record.id, columnId: address.columnId });
  }, [loading]);

  async function loadMoreRecords() {
    if (!nextCursor || loading || loadingMore || busy || cell) return;
    const controller = new AbortController();
    loadMoreController.current = controller;
    setLoadingMore(true); setError("");
    try {
      const page = await loadRecordPage(detail.workspace.id, table.id, nextCursor, controller.signal, view);
      if (controller.signal.aborted) return;
      setRecords(current => {
        const known = new Set(current.map(record => record.id));
        return [...current, ...page.records.filter(record => !known.has(record.id))];
      });
      setNextCursor(page.nextCursor);
      setTotal(page.total);
    } catch (cause) { if (!controller.signal.aborted) setError(message(cause)); }
    finally {
      if (loadMoreController.current === controller) {
        loadMoreController.current = null;
        setLoadingMore(false);
      }
    }
  }

  async function addColumn(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = String(new FormData(event.currentTarget).get("name") ?? "").trim();
    const options = optionsFromInput(columnOptions);
    if (!name || (columnType === "select" && !options.length)) {
      setError(columnType === "select" ? "Enter a column name and at least one select option." : "Enter a column name.");
      return;
    }
    setBusy(true); setError("");
    try {
      const created = await api<TableColumn>(`${tablePath}/columns`, "POST", {
        name, type: columnType, ...(columnType === "select" ? { options } : {}),
      });
      setColumns(current => [...current, created].sort((a, b) => a.position - b.position));
      setSummaryRevision(value => value + 1);
      setAddingColumn(false); setColumnType("text"); setColumnOptions("");
      if (queried) setRevision(value => value + 1);
      requestAnimationFrame(() => document.getElementById("table-options")?.focus());
    } catch (cause) { setError(message(cause)); }
    finally { setBusy(false); }
  }

  async function renameColumn(event: SubmitEvent<HTMLFormElement>, column: TableColumn) {
    event.preventDefault();
    const name = columnName.trim();
    if (!name) return;
    if (name === column.name) { closeColumnRename(column.id); return; }
    setBusy(true); setError(""); setColumnConflict(false);
    try {
      const updated = await api<TableColumn>(`${tablePath}/columns/${column.id}`, "PATCH", { name, expectedUpdatedAt: column.updatedAt });
      setColumns(current => current.map(candidate => candidate.id === updated.id ? updated : candidate));
      closeColumnRename(column.id);
    } catch (cause) {
      setColumnConflict(cause instanceof ApiError && cause.status === 409);
      setError(cause instanceof ApiError && cause.status === 409 ? `${message(cause)}. The column name remains available; reload before retrying.` : message(cause));
    } finally { setBusy(false); }
  }

  async function reloadConflictedColumn(columnId: string) {
    setBusy(true); setError("");
    try {
      const fresh = await api<TableColumn[]>(`${tablePath}/columns`);
      const current = fresh.find(column => column.id === columnId);
      if (!current) throw new Error("The column no longer exists.");
      setColumns(columns => columns.map(column => column.id === current.id ? current : column));
      setColumnConflict(false);
      requestAnimationFrame(() => document.getElementById(`column-${columnId}`)?.focus());
    } catch (cause) { setError(message(cause)); }
    finally { setBusy(false); }
  }

  function closeColumnRename(columnId: string) {
    setRenamingColumn(null);
    setColumnConflict(false);
    requestAnimationFrame(() => document.getElementById(`table-order-${columnId}`)?.focus());
  }

  async function deleteColumn(column: TableColumn) {
    if (loadingMore) return;
    if (!window.confirm(`Delete the "${column.name}" column and its value from every record? This cannot be undone.`)) return;
    loadMoreController.current?.abort();
    setBusy(true); setError("");
    try {
      await api(`${tablePath}/columns/${column.id}`, "DELETE");
      setColumns(current => current.filter(candidate => candidate.id !== column.id));
      setSummaryRevision(value => value + 1);
      if (cell?.columnId === column.id) setCell(null);
      setView(current => ({ filters: current.filters.filter(filter => filter.columnId !== column.id), sort: current.sort?.columnId === column.id ? null : current.sort }));
      setRevision(value => value + 1);
    } catch (cause) { setError(message(cause)); }
    finally { setBusy(false); }
  }

  async function addRecord() {
    setBusy(true); setError("");
    try {
      const created = await api<TableRecord>(`${tablePath}/records`, "POST", { values: {} });
      setRecords(current => [...current, created]
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)));
      setSummaryRevision(value => value + 1);
      if (queried) {
        setRevision(value => value + 1);
        setNotice(view.filters.length ? "Record added. Clear filters if the empty record is hidden." : "Record added in the selected order.");
      }
    } catch (cause) { setError(message(cause)); }
    finally { setBusy(false); }
  }

  async function deleteRecord(record: TableRecord) {
    if (!window.confirm("Delete this record? This cannot be undone.")) return;
    setBusy(true); setError("");
    try {
      await api(`${tablePath}/records/${record.id}`, "DELETE");
      setRecords(current => current.filter(candidate => candidate.id !== record.id));
      setSummaryRevision(value => value + 1);
      if (cell?.recordId === record.id) setCell(null);
      if (queried) setRevision(value => value + 1);
    } catch (cause) { setError(message(cause)); }
    finally { setBusy(false); }
  }

  function editCell(record: TableRecord, column: TableColumn, replacement?: string) {
    if (!writable || column.readOnly || busy || cell || transferring || addingColumn || renamingColumn) return;
    const value = record.values[column.id];
    const draft = tableCellDraft(column, value);
    cellTrigger.current = `cell-trigger-${record.id}-${column.id}`;
    const checked = typeof value === "boolean" ? value : null;
    setSelection({ recordId: record.id, columnId: column.id });
    setCell({ recordId: record.id, columnId: column.id, draft: replacement ?? draft, initialDraft: draft, checked, initialChecked: checked, busy: false, error: "", conflict: false });
  }

  function selectCell(address: CellAddress) {
    setSelection(address);
    requestAnimationFrame(() => document.getElementById(`cell-trigger-${address.recordId}-${address.columnId}`)?.focus());
  }

  function destination(record: TableRecord, column: TableColumn, key: string, shift = false): CellAddress | undefined {
    const next = nextTableCell(records.findIndex(row => row.id === record.id), columns.findIndex(field => field.id === column.id), records.length, columns.length, key, shift);
    return next ? { recordId: records[next.row]!.id, columnId: columns[next.column]!.id } : undefined;
  }

  function cellKey(event: KeyboardEvent<HTMLButtonElement>, record: TableRecord, column: TableColumn) {
    if (cell || event.nativeEvent.isComposing) return;
    if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "Tab"].includes(event.key)) {
      const next = destination(record, column, event.key, event.shiftKey);
      if (next) { event.preventDefault(); selectCell(next); }
    } else if (event.key === "Enter" || event.key === "F2") {
      event.preventDefault(); editCell(record, column);
    } else if (!event.ctrlKey && !event.metaKey && !event.altKey && event.key.length === 1 && ["text", "number"].includes(column.type)) {
      event.preventDefault(); editCell(record, column, event.key);
    } else if (event.key === "Backspace" || event.key === "Delete") {
      event.preventDefault(); editCell(record, column, "");
    }
  }

  function closeCell(next?: CellAddress) {
    setCell(null);
    if (next) selectCell(next);
    else requestAnimationFrame(() => { if (cellTrigger.current) document.getElementById(cellTrigger.current)?.focus(); });
  }

  async function saveCell(record: TableRecord, column: TableColumn, next?: CellAddress) {
    if (!cell || cell.busy || cell.conflict) return;
    if (cell.draft === cell.initialDraft && cell.checked === cell.initialChecked) { closeCell(next); return; }
    let value: TableValue;
    try { value = tableValueFromDraft(column, cell.draft, cell.checked); }
    catch (cause) { setCell(current => current ? { ...current, error: message(cause), conflict: false } : current); return; }
    if (tableValuesEqual(column, record.values[column.id], value)) { closeCell(next); return; }
    setCell(current => current ? { ...current, busy: true, error: "", conflict: false } : current);
    try {
      const updated = await api<TableRecord>(`${tablePath}/records/${record.id}`, "PATCH", {
        values: source ? { [column.id]: value } : tableRecordValues(record, column.id, value), expectedUpdatedAt: record.updatedAt,
      });
      setRecords(current => current.map(candidate => candidate.id === updated.id ? updated : candidate));
      setSummaryRevision(value => value + 1);
      closeCell(next);
      if (queried) {
        focusAfterLoad.current = next ?? { recordId: record.id, columnId: column.id };
        setRevision(value => value + 1);
      }
    } catch (cause) {
      const conflict = cause instanceof ApiError ? cause.status === 409 || (!!source && cause.status >= 500) : !!source;
      const text = conflict
        ? `${message(cause)}. Your value is retained; reload the current record before retrying.` : message(cause);
      setCell(current => current?.recordId === record.id && current.columnId === column.id
        ? { ...current, busy: false, error: text, conflict } : current);
    }
  }

  async function reloadConflictedRecord(recordId: string) {
    const active = cell;
    const column = columns.find(candidate => candidate.id === active?.columnId);
    if (!active || !column) return;
    setCell(current => current ? { ...current, busy: true } : current);
    try {
      const fresh = await api<TableRecord>(`${tablePath}/records/${recordId}`);
      const value = fresh.values[column.id];
      setRecords(current => current.map(record => record.id === fresh.id ? fresh : record));
      setSummaryRevision(value => value + 1);
      setCell(current => current?.recordId === recordId ? {
        ...current,
        initialDraft: tableCellDraft(column, value),
        initialChecked: typeof value === "boolean" ? value : null,
        busy: false,
        error: "",
        conflict: false,
      } : current);
      requestAnimationFrame(() => document.getElementById(`cell-${recordId}-${column.id}`)?.focus());
    } catch (cause) {
      setCell(current => current?.recordId === recordId ? { ...current, busy: false, error: message(cause) } : current);
    }
  }

  if (loading && !ready) return <section className="table-resource" aria-busy="true">
    <p role="status">Loading columns and records...</p>
  </section>;
  const interactionBusy = loading || busy || loadingMore || transferring;
  const hasDraft = cell !== null || addingColumn || renamingColumn !== null;
  const activeRecord = records.find(record => record.id === selection?.recordId) ?? records[0];
  const activeColumn = columns.find(column => column.id === selection?.columnId) ?? columns[0];
  const localDeletable = deletable && !source;
  const summaryData = !summaryPaused && summary?.revision === summaryRevision ? summary.data : null;
  const orderedColumn = columns.find(column => column.id === view.sort?.columnId);
  function orderBy(column: TableColumn, direction: "asc" | "desc" | null) {
    headerAfterLoad.current = `table-order-${column.id}`;
    setView(current => ({ ...current, sort: direction ? { columnId: column.id, direction } : null }));
  }

  return <section className="table-resource" aria-label={`${table.name} table`} aria-busy={loading}>
    <div className="table-resource-frame">
    <div className="table-resource-toolbar">
      <div className="table-view-controls">
        <button type="button" className="table-filter-trigger" aria-expanded={filtersOpen} aria-controls={filterPanelId} onClick={() => setFiltersOpen(value => !value)}>
          Filters{view.filters.length > 0 && <span className="count">{view.filters.length}</span>}<SolidIcon name={filtersOpen ? "chevronUp" : "chevronDown"} />
        </button>
        {orderedColumn && <span className="table-order-status" title={`Ordered by ${orderedColumn.name}, ${view.sort!.direction === "asc" ? "ascending" : "descending"}`}><SolidIcon name={view.sort!.direction === "asc" ? "arrowUp" : "arrowDown"} /><span>{orderedColumn.name}</span></span>}
      </div>
      <div className="table-record-controls">
        {writable && !source && <button type="button" className="primary" disabled={interactionBusy || hasDraft || !columns.length} onClick={addRecord}><SolidIcon name="plus" /> Add record</button>}
        <div className="table-utility-controls">
        <button type="button" className="table-toolbar-icon" aria-label="Refresh table" title="Refresh table" disabled={loading || busy || loadingMore || transferBusy || hasDraft} onClick={() => setRevision(value => value + 1)}><SolidIcon name="refresh" /></button>
        <TableMenu disabled={loading || busy || loadingMore || transferBusy || hasDraft} options={[
          ...(writable && !source ? [{ label: "Add column", icon: "plus" as const, disabled: transferring, action: () => setAddingColumn(true) }] : []),
          { label: transferring ? "Close import / export" : "Import / export", icon: "arrowDown", action: () => setTransferring(value => !value) },
          ...(view.sort ? [{ label: "Clear ordering", icon: "sort" as const, action: () => setView(current => ({ ...current, sort: null })) }] : []),
          ...(source ? [{ label: sourceOpen ? "Hide source details" : "Source details", icon: "link" as const, action: () => setSourceOpen(value => !value) }] : []),
        ]} />
        </div>
      </div>
    </div>
    {filtersOpen && <TableFilters id={filterPanelId} columns={columns} filters={view.filters} disabled={interactionBusy || hasDraft} onApply={filters => { setView(current => ({ ...current, filters })); setNotice(""); }} />}
    {source && <p className="table-source"><SolidIcon name="link" /> Live {source.dialect}{sourceOpen && <> · {source.connectionName} · {source.schema}.{source.table}</>}<span className="muted">Edits save to source.</span></p>}
    {transferring && <div className="table-transfer-panel"><TableTransfer detail={detail} table={table} live={!!source} onBusyChange={setTransferBusy} onImported={() => { setTransferBusy(false); setRevision(value => value + 1); }} /></div>}
    <ErrorNotice error={error} />
    {notice && <p className="view-help" role="status">{notice}</p>}
    {addingColumn && <form className="table-column-form" onSubmit={addColumn}>
      <label>Column name<input name="name" autoFocus required maxLength={120} /></label>
      <label>Type<Select value={columnType} onChange={event => setColumnType(event.target.value as TableColumnType)}>
        {columnTypes.map(type => <option key={type} value={type}>{type === "datetime" ? "Date and time" : type[0]!.toUpperCase() + type.slice(1)}</option>)}
      </Select></label>
      {columnType === "select" && <label>Select options<textarea value={columnOptions} onChange={event => setColumnOptions(event.target.value)} rows={3} placeholder="One option per line" required /></label>}
      <div className="modal-actions"><button type="button" disabled={busy} onClick={() => { setAddingColumn(false); requestAnimationFrame(() => document.getElementById("table-options")?.focus()); }}>Cancel</button><button className="primary" disabled={busy}>{busy ? "Adding..." : "Add column"}</button></div>
    </form>}
    {loading ? <p role="status">Loading records…</p> : loadError ? <div><ErrorNotice error={loadError} /><button type="button" onClick={() => setRevision(value => value + 1)}>Retry loading table</button>{queried && <button type="button" onClick={() => setView({ filters: [], sort: null })}>Clear filters and ordering</button>}</div> : !columns.length ? <><Empty title="Add the first column" action={writable ? <button className="primary" disabled={interactionBusy || hasDraft} onClick={() => setAddingColumn(true)}>Add column</button> : undefined}>
      {writable ? "Columns define the values each record can hold." : "This table does not have any columns yet."}
    </Empty>{records.length > 0 && <div className="table-resource-scroll" tabIndex={0} aria-label="Table records">
      <table><thead><tr><th scope="col">Record</th>{deletable && <th scope="col" className="table-record-action-heading"><span className="sr-only">Record actions</span></th>}</tr></thead>
        <tbody>{records.map((record, index) => <tr key={record.id}><td>Record {index + 1}</td>{deletable && <td className="table-record-actions"><button type="button" className="danger" aria-label={`Delete record ${index + 1}`} disabled={interactionBusy} onClick={() => deleteRecord(record)}><SolidIcon name="trash" /></button></td>}</tr>)}</tbody>
      </table>
    </div>}</> : <div className="table-resource-scroll" role="region" aria-label="Table records, scroll horizontally for more columns" tabIndex={0}>
      <table style={{ width: `calc(48px + ${columns.length} * var(--table-column-width) + ${localDeletable ? 52 : 0}px)` }}>
        <colgroup><col style={{ width: 48 }} />{columns.map(column => <col key={column.id} />)}{localDeletable && <col style={{ width: 52 }} />}</colgroup>
        <thead><tr><th scope="col" className="table-row-number"><span className="sr-only">Row number</span>#</th>{columns.map((column, columnIndex) => {
          const direction = view.sort?.columnId === column.id ? view.sort.direction : null;
          const labels = listSortLabels(column.type === "datetime" ? "date" : column.type === "select" ? "text" : column.type);
          return <th key={column.id} scope="col" data-type={column.type} aria-sort={direction === "asc" ? "ascending" : direction === "desc" ? "descending" : "none"}>
          <div className="table-column-heading">
          {renamingColumn === column.id ? <form className="table-column-rename" onSubmit={event => renameColumn(event, column)}>
            <label className="sr-only" htmlFor={`column-${column.id}`}>Rename {column.name}</label>
            <input id={`column-${column.id}`} autoFocus value={columnName} maxLength={120} required onChange={event => setColumnName(event.target.value)} onKeyDown={event => { if (event.key === "Escape") closeColumnRename(column.id); }} />
            <button aria-label={`Save ${column.name} name`} disabled={interactionBusy || columnConflict}><SolidIcon name="check" /></button>
            <button type="button" aria-label={`Cancel renaming ${column.name}`} disabled={interactionBusy} onClick={() => closeColumnRename(column.id)}><SolidIcon name="x" /></button>
            {columnConflict && <button type="button" className="table-column-reload" disabled={interactionBusy} onClick={() => reloadConflictedColumn(column.id)}>Reload current column and keep draft</button>}
          </form> : <TableMenu id={`table-order-${column.id}`} className="table-column-trigger" label={`${column.name}: ordering and column options`} heading={`Column ${columnLetter(columnIndex)} · ${column.type === "datetime" ? "Date and time" : column.type[0]!.toUpperCase() + column.type.slice(1)}${column.primaryKey ? " · Primary key" : column.readOnly ? " · Read-only" : ""}`} disabled={interactionBusy || hasDraft} options={[
            { label: labels.asc, icon: "arrowUp", checked: direction === "asc", action: () => orderBy(column, "asc") },
            { label: labels.desc, icon: "arrowDown", checked: direction === "desc", action: () => orderBy(column, "desc") },
            { label: "Clear ordering", icon: "x", disabled: !direction, action: () => orderBy(column, null) },
            ...(column.type === "number" ? [{ label: "Number display…", icon: "settings" as const, separator: true, action: () => setFormattingColumn(column) }] : []),
            ...(writable && !source ? [{ label: "Rename column", icon: "pencil" as const, separator: true, action: () => { setRenamingColumn(column.id); setColumnName(column.name); setColumnConflict(false); } },
              ...(deletable ? [{ label: "Delete column", icon: "trash" as const, danger: true, action: () => { void deleteColumn(column); } }] : [])] : []),
          ]}>
            <span className="table-column-label"><strong>{column.name}</strong><TypeBadge column={column} /></span>
            <span className="table-column-indicators">{direction && <SolidIcon name={direction === "asc" ? "arrowUp" : "arrowDown"} className="solid-icon table-sort-indicator" />}<SolidIcon name="chevronDown" className="solid-icon table-column-chevron" /></span>
          </TableMenu>}
          </div>
        </th>; })}{localDeletable && <th scope="col" className="table-record-action-heading"><span className="sr-only">Record actions</span></th>}</tr></thead>
        <tbody>{records.map((record, recordIndex) => <tr key={record.id}><th scope="row" className="table-row-number">{recordIndex + 1}</th>{columns.map(column => {
          const editing = cell?.recordId === record.id && cell.columnId === column.id;
          const selected = activeRecord?.id === record.id && activeColumn?.id === column.id;
          const displayed = displayValue(column, record.values[column.id], numberFormats[column.id]);
          return <td key={column.id} className={`${selected ? "is-selected" : ""}${editing ? " is-editing" : ""}`} data-type={column.type}>{editing && cell ? <form className="table-cell-editor" onSubmit={event => { event.preventDefault(); void saveCell(record, column, destination(record, column, "Enter")); }} onKeyDown={event => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "Escape" && !cell.busy) { event.preventDefault(); closeCell(); }
            if (event.key === "Tab" && event.target instanceof HTMLInputElement && event.target.type !== "checkbox") {
              const next = destination(record, column, "Tab", event.shiftKey);
              if (next) { event.preventDefault(); if (event.currentTarget.reportValidity()) void saveCell(record, column, next); }
            }
          }}>
            <label className="sr-only" htmlFor={`cell-${record.id}-${column.id}`}>{column.name}, record {recordIndex + 1}</label>
             {column.type === "checkbox" ? <span className="table-checkbox-input"><input id={`cell-${record.id}-${column.id}`} autoFocus type="checkbox" checked={cell.checked === true}
               ref={input => { if (input) input.indeterminate = cell.checked === null; }} disabled={cell.busy}
               onChange={event => setCell(current => current ? { ...current, checked: event.target.checked } : current)} /><span>{cell.checked === null ? "Empty" : cell.checked ? "Checked" : "Unchecked"}</span></span>
              : column.type === "select" ? <Select id={`cell-${record.id}-${column.id}`} autoFocus value={cell.draft} disabled={cell.busy} onChange={event => setCell(current => current ? { ...current, draft: event.target.value } : current)}><option value="">Empty</option>{column.options.map(option => <option key={option} value={option}>{option}</option>)}</Select>
              : <input id={`cell-${record.id}-${column.id}`} autoFocus type={column.type === "text" ? "text" : column.type === "number" ? "number" : column.type === "date" ? "date" : "datetime-local"} step={column.type === "number" || column.type === "datetime" ? "any" : undefined} value={cell.draft} disabled={cell.busy} onChange={event => setCell(current => current ? { ...current, draft: event.target.value } : current)} />}
              <span className="table-cell-actions"><button aria-label={`Save ${column.name} for record ${recordIndex + 1}`} disabled={cell.busy || cell.conflict}><SolidIcon name="check" /></button><button type="button" aria-label={`Cancel editing ${column.name} for record ${recordIndex + 1}`} disabled={cell.busy} onClick={() => closeCell()}><SolidIcon name="x" /></button></span>
             {column.type === "checkbox" && cell.checked !== null && <button type="button" className="table-cell-clear" disabled={cell.busy}
               onClick={() => setCell(current => current ? { ...current, checked: null } : current)}>Clear value</button>}
            {cell.error && <small className="field-error" role="alert">{cell.error}</small>}
            {cell.conflict && <button type="button" className="table-cell-reload" disabled={cell.busy} onClick={() => reloadConflictedRecord(record.id)}>Reload current record and keep draft</button>}
             </form> : <button id={`cell-trigger-${record.id}-${column.id}`} type="button" className={`table-cell-value${record.values[column.id] == null || record.values[column.id] === "" ? " is-empty" : ""}`}
               tabIndex={selected ? 0 : -1} disabled={cell !== null || interactionBusy} title={column.type === "number" && record.values[column.id] != null ? `${displayed} · Stored value: ${record.values[column.id]}` : displayed}
               aria-label={`${column.name}, row ${recordIndex + 1}: ${displayed}${column.readOnly ? ". Read-only" : ""}`}
               onClick={event => { if (selected && event.detail > 0) editCell(record, column); else selectCell({ recordId: record.id, columnId: column.id }); }}
               onDoubleClick={() => editCell(record, column)} onKeyDown={event => cellKey(event, record, column)}
               onCopy={event => { event.clipboardData.setData("text/plain", String(record.values[column.id] ?? "")); event.preventDefault(); }}
               onPaste={event => { if (writable && !column.readOnly && ["text", "number"].includes(column.type)) { event.preventDefault(); editCell(record, column, event.clipboardData.getData("text/plain")); } }}>
               <span>{record.values[column.id] == null || record.values[column.id] === "" ? "" : column.type === "checkbox" ? <SolidIcon name={record.values[column.id] ? "check" : "minus"} /> : displayed}</span>
             </button>}</td>;
          })}{localDeletable && <td className="table-record-actions"><button type="button" className="danger" aria-label={`Delete record ${recordIndex + 1}`} disabled={interactionBusy || cell !== null} onClick={() => deleteRecord(record)}><SolidIcon name="trash" /></button></td>}</tr>)}
        {!records.length && <tr><td colSpan={columns.length + 1 + (localDeletable ? 1 : 0)} className="table-record-empty">{view.filters.length ? "No records match these filters." : `No records yet.${writable && !source ? " Add one to start entering values." : ""}`}</td></tr>}</tbody>
        <tfoot><tr><th scope="row" className="table-row-number"><span className="sr-only">Column calculations across all records</span></th>{columns.map(column => {
          const calculation = calculations[column.id] ?? "none";
          const label = calculation === "none" ? "Calculate" : `${tableCalculationLabels[calculation]} · ${summaryError ? "Unavailable" : calculationValue(column, calculation, summaryData, numberFormats[column.id] ?? defaultTableNumberFormat)}`;
          return <td key={column.id} className="table-summary-cell">
            <Select className="table-summary-select" value={calculation} triggerLabel={label}
              aria-label={`${column.name} calculation: ${label}. Includes all ${view.filters.length ? "matching " : ""}records.`}
              onChange={event => setCalculations(current => ({ ...current, [column.id]: event.target.value as TableCalculation }))}>
              {tableCalculationsFor(column).map(option => <option key={option} value={option}>{tableCalculationLabels[option]}</option>)}
            </Select>
          </td>;
        })}{localDeletable && <td className="table-record-actions" />}</tr></tfoot>
      </table>
    </div>}
    </div>
    {summariesEnabled && !loadError && <div className="table-summary-status" role="status">
      {summaryError ? <><span>Calculations unavailable: {summaryError}</span><button type="button" disabled={summaryPaused} onClick={() => setSummaryRevision(value => value + 1)}>Retry calculations</button></>
        : summaryData ? `Calculations include all ${summaryData.recordCount.toLocaleString()} ${view.filters.length ? "matching " : ""}records.` : "Calculating all records…"}
    </div>}
    {!loading && !loadError && nextCursor && <div className="table-resource-more"><span>{records.length} records loaded; more are available.</span><button type="button" disabled={interactionBusy || hasDraft} onClick={loadMoreRecords}>{loadingMore ? "Loading..." : "Load more records"}</button></div>}
    <div className="table-resource-meta">
      <p className="table-record-count">{loading ? "Loading…" : loadError ? "Records unavailable" : <>{records.length}{total !== undefined && nextCursor ? ` of ${total.toLocaleString()}` : ""} {view.filters.length ? "matching " : ""}{records.length === 1 ? "record" : "records"}{nextCursor ? " loaded" : ""}</>}</p>
      <p className="table-keyboard-help">Click to select · Enter/F2, double-click or tap the selected cell to edit · Arrow keys to move · Tab to save and advance · Escape to cancel</p>
    </div>
    {formattingColumn && <TableNumberDisplay column={formattingColumn} value={numberFormats[formattingColumn.id] ?? defaultTableNumberFormat} onSave={saveNumberFormat} onClose={() => setFormattingColumn(null)} />}
  </section>;
}
