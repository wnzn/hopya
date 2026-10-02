import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { message, type TableColumn } from "../lib/api";
import { defaultTableNumberFormat, formatTableNumber, tableNumberSeparators, tableCellDraft, tableFilterFromDraft, tableFilterOperators, type TableFilter, type TableFilterOperator, type TableNumberFormat } from "../lib/table-resource";
import { ErrorNotice, Modal } from "./Shared";
import Select from "./Select";
import SolidIcon, { type SolidIconName } from "./SolidIcon";
import "../styles/list-controls.css";

type FilterDraft = { id: number; columnId: string; operator: TableFilterOperator; value: string };

export function TableNumberDisplay({ column, value, onSave, onClose }: {
  column: TableColumn; value: TableNumberFormat; onSave: (value: TableNumberFormat) => void; onClose: () => void;
}) {
  const [draft, setDraft] = useState(value);
  return <Modal title={`Number display · ${column.name}`} className="table-number-dialog" onClose={onClose}>
    <form className="stack" onSubmit={event => { event.preventDefault(); onSave(draft); }}>
      <label>Decimal places<Select autoFocus value={draft.decimals === null ? "auto" : String(draft.decimals)} onChange={event => setDraft(current => ({ ...current, decimals: event.target.value === "auto" ? null : Number(event.target.value) }))}>
        <option value="auto">Automatic · full precision</option>
        {Array.from({ length: 11 }, (_, places) => <option key={places} value={places}>{places} {places === 1 ? "decimal place" : "decimal places"}</option>)}
      </Select></label>
      <label>Separators<Select value={draft.separators} onChange={event => setDraft(current => ({ ...current, separators: event.target.value as TableNumberFormat["separators"] }))}>
        {tableNumberSeparators.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
      </Select></label>
      <div className="table-number-preview"><span>Preview</span><output aria-live="polite">{formatTableNumber("12345.6789", draft)}</output></div>
      <p className="view-help">Applies to this column and its calculations. Stored values, editing, copy and exports keep their original precision. Remembered for your account in this browser.</p>
      <div className="modal-actions"><button type="button" onClick={() => setDraft(defaultTableNumberFormat)}>Reset</button><button type="button" onClick={onClose}>Cancel</button><button className="primary">Apply</button></div>
    </form>
  </Modal>;
}

export function TableFilters({ id, columns, filters, disabled, onApply }: {
  id: string; columns: TableColumn[]; filters: TableFilter[]; disabled: boolean; onApply: (filters: TableFilter[]) => void;
}) {
  const sequence = useRef(0);
  const [drafts, setDrafts] = useState<FilterDraft[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    setDrafts(filters.map(filter => {
      const column = columns.find(column => column.id === filter.columnId);
      return { ...filter, id: sequence.current++, value: column ? tableCellDraft(column, filter.value) : "" };
    }));
    setError("");
  }, [filters]);
  const update = (id: number, patch: Partial<FilterDraft>) => setDrafts(current => current.map(filter => filter.id === id ? { ...filter, ...patch } : filter));
  return <form id={id} className="list-filter-panel table-filter-panel" aria-label="Table filters" onSubmit={event => {
    event.preventDefault();
    if (disabled) return;
    try {
      const next = drafts.map(filter => {
        const column = columns.find(column => column.id === filter.columnId);
        if (!column) throw new Error("A filter column no longer exists. Remove that filter.");
        return tableFilterFromDraft(column, filter.operator, filter.value);
      });
      setError(""); onApply(next);
    } catch (cause) { setError(message(cause)); }
  }}>
    <div className="list-filter-heading"><strong>Match all filters</strong><button type="button" disabled={disabled || !columns.length || drafts.length >= 20} onClick={() => {
      const column = columns[0];
      if (column) setDrafts(current => [...current, { id: sequence.current++, columnId: column.id, operator: tableFilterOperators(column)[0]!.value, value: "" }]);
    }}><SolidIcon name="plus" /> Add filter</button></div>
    {drafts.map((filter, index) => {
      const column = columns.find(column => column.id === filter.columnId);
      if (!column) return <div className="list-filter-row" key={filter.id}><span>Column no longer exists</span><button type="button" disabled={disabled} onClick={() => setDrafts(current => current.filter(candidate => candidate.id !== filter.id))}>Remove filter {index + 1}</button></div>;
      const needsValue = filter.operator !== "empty" && filter.operator !== "not_empty";
      return <div className="list-filter-row" key={filter.id}>
        <span className="list-filter-join">{index ? "AND" : "WHERE"}</span>
        <Select aria-label={`Filter ${index + 1} column`} value={column.id} disabled={disabled} onChange={event => {
          const next = columns.find(column => column.id === event.target.value)!;
          update(filter.id, { columnId: next.id, operator: tableFilterOperators(next)[0]!.value, value: "" });
        }}>{columns.map(column => <option key={column.id} value={column.id}>{column.name}</option>)}</Select>
        <Select aria-label={`Filter ${index + 1} formula`} value={filter.operator} disabled={disabled} onChange={event => update(filter.id, { operator: event.target.value as TableFilterOperator })}>
          {tableFilterOperators(column).map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
        </Select>
        {needsValue && (column.type === "checkbox" || column.type === "select" ? <Select aria-label={`Filter ${index + 1} value`} required value={filter.value} disabled={disabled} onChange={event => update(filter.id, { value: event.target.value })}>
          <option value="">Choose a value</option>{column.type === "checkbox" ? [<option key="true" value="true">Checked</option>, <option key="false" value="false">Unchecked</option>] : column.options.map(option => <option key={option} value={option}>{option}</option>)}
        </Select> : <input aria-label={`Filter ${index + 1} value`} required disabled={disabled} maxLength={10000}
          type={column.type === "number" ? "number" : column.type === "date" ? "date" : column.type === "datetime" ? "datetime-local" : "text"}
          step={column.type === "number" || column.type === "datetime" ? "any" : undefined} value={filter.value} onChange={event => update(filter.id, { value: event.target.value })} />)}
        <button type="button" aria-label={`Remove filter ${index + 1}`} disabled={disabled} onClick={() => setDrafts(current => current.filter(candidate => candidate.id !== filter.id))}><SolidIcon name="x" /></button>
      </div>;
    })}
    {!drafts.length && <p className="view-help">No filters. Add conditions to narrow records across the entire Table.</p>}
    <ErrorNotice error={error} />
    <div className="table-filter-actions"><button type="button" disabled={disabled || !drafts.length && !filters.length} onClick={() => { setDrafts([]); setError(""); onApply([]); }}>Clear filters</button><button className="primary" disabled={disabled}>Apply filters</button></div>
  </form>;
}

type Option = { label: string; icon: SolidIconName; disabled?: boolean; checked?: boolean; danger?: boolean; separator?: boolean; action: () => void };
export function TableMenu({ options, disabled, id = "table-options", label = "Table options", heading, className = "table-toolbar-icon", children }: {
  options: Option[]; disabled: boolean; id?: string; label?: string; heading?: string; className?: string; children?: ReactNode;
}) {
  const trigger = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const focusLast = useRef(false);
  const menuId = useId();
  function close(focus = false) { setPosition(null); if (focus) trigger.current?.focus({ preventScroll: true }); }
  function open(last = false) {
    if (disabled) return;
    focusLast.current = last;
    const rect = trigger.current!.getBoundingClientRect();
    setPosition({ top: Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - options.length * 44 - (heading ? 44 : 0) - 16)), left: Math.max(8, Math.min(children ? rect.left : rect.right - 232, window.innerWidth - 240)) });
  }
  useEffect(() => {
    if (!position) return;
    const buttons = menu.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)");
    buttons?.[focusLast.current ? buttons.length - 1 : 0]?.focus();
    const outside = (event: PointerEvent) => { if (!menu.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) close(); };
    const viewport = (event: Event) => { if (!menu.current?.contains(event.target as Node)) close(); };
    document.addEventListener("pointerdown", outside);
    window.addEventListener("resize", viewport);
    window.addEventListener("scroll", viewport, true);
    return () => { document.removeEventListener("pointerdown", outside); window.removeEventListener("resize", viewport); window.removeEventListener("scroll", viewport, true); };
  }, [position]);
  useEffect(() => { if (disabled) setPosition(null); }, [disabled]);
  return <>
    <button ref={trigger} id={id} type="button" className={className} aria-label={label} title={label} disabled={disabled} aria-haspopup="menu" aria-expanded={!!position} aria-controls={position ? menuId : undefined}
      onClick={() => position ? close() : open()}
      onKeyDown={event => { if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); open(event.key === "ArrowUp"); } }}>{children ?? <SolidIcon name="more" />}</button>
    {position && createPortal(<div ref={menu} id={menuId} className="table-options-menu" role="menu" aria-label={label} style={position}
      onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node) && event.relatedTarget !== trigger.current) close(); }}
      onKeyDown={event => {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(true); }
        if (event.key === "Tab") close(true);
        const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        if (event.key.length === 1 && event.key.trim() && !event.ctrlKey && !event.metaKey && !event.altKey) {
          const match = [...buttons.slice(index + 1), ...buttons.slice(0, index + 1)]
            .find(button => button.textContent?.trim().toLocaleLowerCase().startsWith(event.key.toLocaleLowerCase()));
          if (match) { event.preventDefault(); match.focus(); }
        }
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        buttons[event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length]?.focus();
      }}>
      {heading && <div className="table-menu-heading" role="presentation">{heading}</div>}
      {options.map(option => <div key={option.label} role="none">
        {option.separator && <div className="table-menu-separator" role="separator" />}
        <button type="button" tabIndex={-1} role={option.checked === undefined ? "menuitem" : "menuitemradio"} aria-checked={option.checked} className={option.danger ? "danger" : undefined} disabled={option.disabled}
          onClick={() => { close(true); option.action(); }}><SolidIcon name={option.icon} /><span>{option.label}</span>{option.checked && <SolidIcon name="check" className="solid-icon table-menu-check" />}</button>
      </div>)}
    </div>, document.body)}
  </>;
}
