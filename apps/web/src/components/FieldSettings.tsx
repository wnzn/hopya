import { useState } from "react";
import { api, message, type Field, type DateFormat } from "../lib/api";
import { dateFormats } from "../lib/field-values";
import { ErrorNotice, Modal } from "./Shared";

export function FieldSettings({ type, settings, onChange, formulaFallback = "=0" }: { type: Field["type"]; settings: NonNullable<Field["settings"]>; onChange: (settings: NonNullable<Field["settings"]>) => void; formulaFallback?: string }) {
  if (type === "date" || type === "datetime") return <label>Date display format<select value={settings.dateFormat ?? ""} onChange={event => onChange(event.target.value ? { dateFormat: event.target.value as DateFormat } : {})}>
    <option value="">Use project format</option>{dateFormats.map(format => <option key={format}>{format}</option>)}
  </select></label>;
  if (type === "rating") return <label>Maximum rating<input type="number" min={1} max={10} step={1} required value={settings.maxRating ?? 5} onChange={event => onChange({ maxRating: Number(event.target.value) })} /></label>;
  if (type === "formula") return <label>Formula expression<input type="text" required={formulaFallback !== ""} maxLength={200} value={settings.formula ?? formulaFallback}
    onChange={event => onChange({ formula: event.target.value })} placeholder="={{Estimate (hours)}} * 2" />
    <small>Reference another custom field by name, for example {"{{Estimate (hours)}} * 2"}.</small></label>;
  return null;
}
export function fieldSettings(type: Field["type"], settings: NonNullable<Field["settings"]>, formulaFallback = "=0") {
  return type === "date" || type === "datetime" ? (settings.dateFormat ? { dateFormat: settings.dateFormat } : {})
    : type === "rating" ? { maxRating: settings.maxRating ?? 5 }
      : type === "formula" ? (settings.formula !== undefined ? { formula: settings.formula } : formulaFallback ? { formula: formulaFallback } : {}) : {};
}
export function FieldEditor({ field, base, onClose, onSaved }: { field: Field; base: string; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(field.name);
  const [options, setOptions] = useState(field.options?.join("\n") ?? "");
  const [settings, setSettings] = useState(field.settings ?? {});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return <Modal title={`Edit field ${field.name}`} onClose={() => { if (!busy) onClose(); }}>
    <ErrorNotice error={error} />
    <p>Changes apply to this reusable field in every project. Existing task values are retained; incompatible changes may be rejected.</p>
    <form className="stack" onSubmit={async event => {
      event.preventDefault(); if (busy) return; setBusy(true); setError("");
      try {
        await api(`${base}/fields/${encodeURIComponent(field.id)}`, "PATCH", { name: name.trim(), settings: fieldSettings(field.type, settings, ""),
          ...(["select", "checklist"].includes(field.type) ? { options: [...new Set(options.split("\n").map(value => value.trim()).filter(Boolean))] } : {}) });
        onSaved();
      } catch (error) { setError(message(error)); setBusy(false); }
    }}><fieldset className="stack bare-fieldset" disabled={busy}>
      <label>Field name<input required maxLength={120} value={name} onChange={event => setName(event.target.value)} /></label>
      {["select", "checklist"].includes(field.type) && <label>Options, one per line<textarea required maxLength={4000} rows={4} value={options} onChange={event => setOptions(event.target.value)} /></label>}
      <FieldSettings type={field.type} settings={settings} onChange={setSettings} formulaFallback="" />
      <button type="submit">Save field</button>
    </fieldset></form>
  </Modal>;
}
