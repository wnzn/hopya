import type { Field, Item } from "../lib/api";
import { localDateTime } from "../lib/field-values";
import ChecklistDropdown from "./ChecklistDropdown";

export default function TypedFieldInput({ field, value, disabled, onChange }: {
  field: Field; value: Item["customFields"][string]; disabled?: boolean;
  onChange: (value: Item["customFields"][string]) => void;
}) {
  if (field.type === "checklist") {
    return <ChecklistDropdown field={field} value={value} disabled={disabled} onChange={onChange} />;
  }
  if (field.type === "rating") return <label>{field.name}<input aria-label={field.name} type="number" min={1} max={field.settings?.maxRating ?? 5} step={1} disabled={disabled}
    value={value == null ? "" : String(value)} onChange={event => onChange(event.target.value === "" ? null : Number(event.target.value))} />
    <small>1 to {field.settings?.maxRating ?? 5}; leave blank for not set.</small></label>;
  return <label>{field.name}<input aria-label={field.name} type="datetime-local" step="any" readOnly={disabled} value={typeof value === "string" ? localDateTime(value) : ""}
    onChange={event => { const date = new Date(event.target.value); if (!event.target.value) onChange(null); else if (Number.isFinite(date.getTime())) onChange(date.toISOString()); }} />
    <small>Local time ({Intl.DateTimeFormat().resolvedOptions().timeZone})</small></label>;
}
