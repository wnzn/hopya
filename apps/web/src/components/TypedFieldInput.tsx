import type { Field, Item } from "../lib/api";
import { localDateTime } from "../lib/field-values";
import ChecklistDropdown from "./ChecklistDropdown";
import Select from "./Select";
import type { FocusEventHandler, KeyboardEventHandler } from "react";

export default function TypedFieldInput({ field, value, disabled, onChange, compact = false, onBlur, onKeyDown, onDismiss, formulaValue, id, ariaInvalid, ariaDescribedBy }: {
  field: Field; value: Item["customFields"][string]; disabled?: boolean;
  onChange: (value: Item["customFields"][string]) => void;
  compact?: boolean;
  onBlur?: FocusEventHandler<HTMLInputElement>;
  onKeyDown?: KeyboardEventHandler<HTMLInputElement>;
  onDismiss?: () => void;
  formulaValue?: string;
  id?: string;
  ariaInvalid?: boolean;
  ariaDescribedBy?: string;
}) {
  if (field.type === "checklist") {
    return <ChecklistDropdown field={field} value={value} disabled={disabled} onChange={onChange} compact={compact}
      id={id} ariaInvalid={ariaInvalid} ariaDescribedBy={ariaDescribedBy} />;
  }
  const labelClass = compact ? "sr-only" : undefined;
  const controlProps = {
    id,
    "aria-label": field.name,
    "aria-invalid": ariaInvalid || undefined,
    "aria-describedby": ariaDescribedBy,
  };
  if (field.type === "select") return <label><span className={labelClass}>{field.name}</span><Select {...controlProps} autoFocus={compact} openOnMount={compact} disabled={disabled} value={String(value ?? "")} onDismiss={onDismiss}
    onChange={event => onChange(event.target.value || null)}>
    <option value="">Not set</option>
    {field.options?.map(option => <option key={option}>{option}</option>)}
  </Select></label>;
  if (field.type === "checkbox") return <label><span className={labelClass}>{field.name}</span><input {...controlProps} autoFocus={compact} type="checkbox" disabled={disabled}
    checked={value === true} onChange={event => onChange(event.target.checked)} /></label>;
  if (field.type === "rating") return <label><span className={labelClass}>{field.name}</span><input {...controlProps} autoFocus={compact} type="number" min={1} max={field.settings?.maxRating ?? 5} step={1} disabled={disabled}
    value={value == null ? "" : String(value)} onChange={event => onChange(event.target.value === "" ? null : Number(event.target.value))} />
    {!compact && <small>1 to {field.settings?.maxRating ?? 5}; leave blank for not set.</small>}</label>;
  if (field.type === "datetime") return <label><span className={labelClass}>{field.name}</span><input {...controlProps} autoFocus={compact} type="datetime-local" step="any" disabled={disabled} value={typeof value === "string" ? localDateTime(value) : ""}
    onFocus={event => { if (compact) { try { event.currentTarget.showPicker(); } catch {} } }}
    onBlur={onBlur}
    onKeyDown={onKeyDown}
    onChange={event => { const date = new Date(event.target.value); if (!event.target.value) onChange(null); else if (Number.isFinite(date.getTime())) onChange(date.toISOString()); }} />
    {!compact && <small>Local time ({Intl.DateTimeFormat().resolvedOptions().timeZone})</small>}</label>;
  if (field.type === "formula" && field.settings?.formula !== undefined)
    return <label><span className={labelClass}>{field.name}</span><output aria-label={`${field.name} calculated value`}>{formulaValue || "Not set"}</output></label>;
  if (field.type === "formula") return <label><span className={labelClass}>{field.name}</span><input {...controlProps} autoFocus={compact} type="text" maxLength={200} readOnly={disabled}
    value={disabled ? formulaValue ?? "" : String(value ?? "")} onBlur={onBlur} onKeyDown={onKeyDown}
    onChange={event => onChange(event.target.value || null)} />
    {!disabled && typeof value === "string" && value.length > 0 && <small aria-live="polite">Preview: {formulaValue}</small>}</label>;
  return <label><span className={labelClass}>{field.name}</span><input {...controlProps} autoFocus={compact} disabled={disabled}
    type={field.type === "number" ? "number" : field.type === "date" ? "date" : "text"}
    step={field.type === "number" ? "any" : undefined} maxLength={field.type === "text" ? 10000 : undefined}
    value={value == null ? "" : String(value)}
    onFocus={event => { if (compact && field.type === "date") { try { event.currentTarget.showPicker(); } catch {} } }}
    onBlur={onBlur} onKeyDown={onKeyDown}
    onChange={event => onChange(event.target.value === "" ? null : field.type === "number" ? Number(event.target.value) : event.target.value)} /></label>;
}
