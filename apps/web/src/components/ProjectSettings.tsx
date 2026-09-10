import { useEffect, useRef, useState } from "react";
import { api, ApiError, message, workspacePath, type DateFormat, type Detail, type ProjectFieldConfiguration, type ProjectStatus } from "../lib/api";
import { defaultStatuses, statusStyle } from "../lib/project-statuses";
import { dateFormats } from "../lib/field-values";
import { ErrorNotice } from "./Shared";
import Select from "./Select";

export function StatusEditor({ statuses, onChange }: { statuses: ProjectStatus[]; onChange: (statuses: ProjectStatus[]) => void }) {
  function change(id: string, patch: Partial<ProjectStatus>) { onChange(statuses.map(value => value.id === id ? { ...value, ...patch } : value)); }
  function move(index: number, offset: number) {
    const next = [...statuses];
    [next[index], next[index + offset]] = [next[index + offset], next[index]];
    onChange(next);
  }
  return <>
    {statuses.map((status, index) => <fieldset key={status.id} className="stack"><legend>Status {index + 1}</legend>
      <span className="status status-badge" style={statusStyle(status.color)}><i aria-hidden="true" />{status.name || "Unnamed status"}{status.completed ? " (completed)" : ""}</span>
      <label>Status name<input required maxLength={120} value={status.name} onChange={event => change(status.id, { name: event.target.value })} /></label>
      <label>Status color<input type="color" value={status.color} onChange={event => change(status.id, { color: event.target.value })} /></label>
      <label><input type="checkbox" checked={status.completed} onChange={event => change(status.id, { completed: event.target.checked })} />Completed</label>
      <button type="button" aria-label={`Move ${status.name || `status ${index + 1}`} up`} disabled={index === 0} onClick={() => move(index, -1)}>Move up</button>
      <button type="button" aria-label={`Move ${status.name || `status ${index + 1}`} down`} disabled={index === statuses.length - 1} onClick={() => move(index, 1)}>Move down</button>
      <button type="button" disabled={statuses.length <= 1} onClick={() => onChange(statuses.filter(value => value.id !== status.id))}>Remove status {status.name}</button>
    </fieldset>)}
    <button type="button" disabled={statuses.length >= 50} onClick={() => onChange([...statuses, { id: `status_${crypto.randomUUID().replaceAll("-", "")}`, name: "New status", color: "#64748b", completed: false }])}>Add status</button>
  </>;
}

export default function ProjectSettings({ detail, projectId, onUpdated, localConfiguration, dateOnly = false }: { detail: Detail; projectId: string; onUpdated: (detail: Detail) => void; localConfiguration?: ProjectFieldConfiguration; dateOnly?: boolean }) {
  const [baseline, setBaseline] = useState<ProjectFieldConfiguration>();
  const [statuses, setStatuses] = useState<ProjectStatus[]>([]);
  const [dateFormat, setDateFormat] = useState<DateFormat | "">("");
  const [busy, setBusy] = useState(true);
  const [blocked, setBlocked] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [reload, setReload] = useState(0);
  const context = useRef<AbortController | null>(null);
  const base = workspacePath(detail.workspace.id);
  const path = `${base}/projects/${encodeURIComponent(projectId)}/fields`;
  useEffect(() => {
    // Keep status/date drafts; a refresh containing overlapping external changes stays stale.
    if (localConfiguration) setBaseline(current => current &&
      JSON.stringify([current.statuses ?? defaultStatuses, current.dateFormat ?? "yyyy-MM-dd"]) === JSON.stringify([localConfiguration.statuses ?? defaultStatuses, localConfiguration.dateFormat ?? "yyyy-MM-dd"])
      ? localConfiguration : current);
  }, [localConfiguration]);
  useEffect(() => {
    const controller = new AbortController(); context.current = controller; setBusy(true);
    api<ProjectFieldConfiguration>(path, "GET", undefined, controller.signal).then(config => {
      controller.signal.throwIfAborted();
      if (config.projectId !== projectId) throw new Error("Unexpected project configuration.");
      setBaseline(config); setStatuses(structuredClone(config.statuses ?? defaultStatuses)); setDateFormat(config.dateFormat ?? ""); setBlocked(false); setError("");
    }).catch(error => { if (!controller.signal.aborted) { setError(message(error)); setBlocked(true); } })
      .finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [path, projectId, reload]);
  const scope = dateOnly ? "List" : "Project";
  return <section className="stack"><h3>{dateOnly ? "List date display" : "Project settings"}</h3>
    <ErrorNotice error={error} />{notice && <p role="status">{notice}</p>}
    {blocked && <button type="button" disabled={busy} onClick={() => { if (window.confirm(`Discard ${scope.toLowerCase()} settings drafts and reload?`)) setReload(value => value + 1); }}>Reload {scope.toLowerCase()} settings</button>}
    <form className="stack" onSubmit={async event => {
      event.preventDefault(); if (busy || blocked || !baseline || !detail.permissions.includes("structure:write")) return;
      const signal = context.current!.signal; setBusy(true); setError(""); setNotice(""); let saved = false;
      try {
        await api(path, "PATCH", { ...(!dateOnly ? { statuses } : {}), dateFormat: dateFormat || null, expectedUpdatedAt: baseline.updatedAt }, signal); saved = true;
        const fresh = await api<Detail>(base, "GET", undefined, signal); signal.throwIfAborted();
        const config = fresh.projectFields?.find(config => config.projectId === projectId);
        if (fresh.workspace.id !== detail.workspace.id || !config) throw new Error(`Could not verify ${scope.toLowerCase()} settings.`);
        setBaseline(config); setStatuses(structuredClone(config.statuses ?? defaultStatuses)); setDateFormat(config.dateFormat ?? ""); onUpdated(fresh); setNotice(`${scope} settings saved.`);
      } catch (error) {
        if (!signal.aborted) {
          const conflict = error instanceof ApiError && error.status === 409;
          const uncertain = saved || !(error instanceof ApiError);
          setBlocked(conflict || uncertain);
          setError(conflict ? `${scope} settings changed elsewhere. Your draft is kept. Reload before saving again.` : uncertain ? "The update may have saved but could not be verified. Your draft is kept. Reload before retrying." : message(error));
        }
      } finally { if (!signal.aborted) setBusy(false); }
    }}><fieldset disabled={busy || blocked || !baseline} className="stack bare-fieldset">
      <legend>{dateOnly ? "Date display" : "Status and date display"}</legend>
      <label>{scope} date format<Select value={dateFormat} onChange={event => setDateFormat(event.target.value as DateFormat | "")}><option value="">Default (yyyy-MM-dd)</option>{dateFormats.map(format => <option key={format}>{format}</option>)}</Select></label>
      {!dateOnly && <StatusEditor statuses={statuses} onChange={setStatuses} />}
      <button type="submit">Save {scope.toLowerCase()} settings</button>
    </fieldset></form>
  </section>;
}
