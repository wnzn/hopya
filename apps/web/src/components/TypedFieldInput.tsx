import type { Field, Item } from "../lib/api";
import { localDateTime } from "../lib/field-values";
import ChecklistDropdown from "./ChecklistDropdown";
import type { FocusEventHandler, KeyboardEventHandler } from "react";

export default function TypedFieldInput({ field, value, disabled, onChange, compact = false, onBlur, onKeyDown }: {
  field: Field; value: Item["customFields"][string]; disabled?: boolean;
  onChange: (value: Item["customFields"][string]) => void;
  compact?: boolean;
  onBlur?: FocusEventHandler<HTMLInputElement>;
  onKeyDown?: KeyboardEventHandler<HTMLInputElement>;
}) {
  if (field.type === "checklist") {
    return <ChecklistDropdown field={field} value={value} disabled={disabled} onChange={onChange} compact={compact} />;
  }
  if (field.type === "rating") return <label><span className={compact ? "sr-only" : undefined}>{field.name}</span><input autoFocus={compact} aria-label={field.name} type="number" min={1} max={field.settings?.maxRating ?? 5} step={1} disabled={disabled}
    value={value == null ? "" : String(value)} onChange={event => onChange(event.target.value === "" ? null : Number(event.target.value))} />
    {!compact && <small>1 to {field.settings?.maxRating ?? 5}; leave blank for not set.</small>}</label>;
  return <label><span className={compact ? "sr-only" : undefined}>{field.name}</span><input autoFocus={compact} aria-label={field.name} type="datetime-local" step="any" readOnly={disabled} value={typeof value === "string" ? localDateTime(value) : ""}
    onFocus={event => { if (compact) { try { event.currentTarget.showPicker(); } catch {} } }}
    onBlur={onBlur}
    onKeyDown={onKeyDown}
    onChange={event => { const date = new Date(event.target.value); if (!event.target.value) onChange(null); else if (Number.isFinite(date.getTime())) onChange(date.toISOString()); }} />
    {!compact && <small>Local time ({Intl.DateTimeFormat().resolvedOptions().timeZone})</small>}</label>;
}
