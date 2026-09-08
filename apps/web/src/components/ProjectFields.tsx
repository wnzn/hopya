import { useEffect, useRef, useState } from "react";
import { api, ApiError, label, message, workspacePath, type Detail, type Field, type ListStatusConfiguration, type ProjectFieldConfiguration } from "../lib/api";
import { fieldOwnerForNode, hierarchyLabels, optionalBuiltIns } from "../lib/project-fields";
import { ErrorNotice, Modal } from "./Shared";
import { FieldEditor, FieldSettings, fieldSettings } from "./FieldSettings";
import ProjectSettings from "./ProjectSettings";
import ListStatusSettings from "./ListStatusSettings";
import "../styles/project-fields.css";

type Props = {
  detail: Detail;
  targetId?: string | null;
  onClose: () => void;
  onUpdated: (detail: Detail) => void;
};

function mergeSelection<T extends string>(original: T[], selected: T[], latest: T[]): T[] {
  const removed = new Set(original.filter(id => !selected.includes(id)));
  return [...new Set([...latest.filter(id => !removed.has(id)), ...selected.filter(id => !original.includes(id))])];
}

export default function ProjectFields({ detail, targetId, onClose, onUpdated }: Props) {
  const [selection, setSelection] = useState({ workspaceId: detail.workspace.id, id: "" });
  const selected = selection.workspaceId === detail.workspace.id ? selection.id : "";
  const id = targetId || selected;
  const targets = detail.nodes.filter(node => node.kind === "project" || node.kind === "list");
  const targetLabels = hierarchyLabels(detail.nodes, targets);
  const target = targets.find(node => node.id === id);
  const fieldOwner = target ? fieldOwnerForNode(detail.nodes, target.id) : undefined;
  return <Modal title={target ? `Fields for ${target.name}` : "Project fields"} onClose={onClose}>
    <div className="project-fields stack">
      {!targetId && <label>Project or list
        <select value={selected} onChange={event => setSelection({ workspaceId: detail.workspace.id, id: event.target.value })}>
          <option value="">Choose a project or list</option>
          <optgroup label="Projects">{detail.nodes.filter(node => node.kind === "project").map(node =>
            <option key={node.id} value={node.id}>{targetLabels.get(node.id)}</option>)}</optgroup>
          <optgroup label="Lists">{detail.nodes.filter(node => node.kind === "list").map(node =>
            <option key={node.id} value={node.id}>{targetLabels.get(node.id)}</option>)}</optgroup>
        </select>
      </label>}
      {targetId && <p>{target ? `${target.kind === "list" ? "List" : "Project"}: ${target.name}` : "Project or list unavailable"}</p>}
      {!detail.permissions.includes("structure:write")
        ? <p className="notice">You need permission to manage project fields.</p>
        : fieldOwner && target ? <ProjectConfiguration key={`${detail.workspace.id}:${target.id}`} detail={detail}
          projectId={fieldOwner.id} listId={target.kind === "list" ? target.id : undefined} onUpdated={onUpdated} /> : null}
    </div>
  </Modal>;
}

export type ConfigurationProps = Omit<Props, "onClose" | "targetId"> & { projectId: string; listId?: string; localConfiguration?: ProjectFieldConfiguration; localListConfiguration?: ListStatusConfiguration };

export function ProjectConfiguration({ detail, projectId, listId, onUpdated }: ConfigurationProps) {
  const [localConfiguration, setLocalConfiguration] = useState<ProjectFieldConfiguration>();
  const [localListConfiguration, setLocalListConfiguration] = useState<ListStatusConfiguration>();
  function updated(fresh: Detail) {
    setLocalConfiguration(fresh.projectFields?.find(config => config.projectId === projectId));
    if (listId) setLocalListConfiguration(fresh.listStatusConfigs?.find(config => config.listId === listId));
    onUpdated(fresh);
  }
  const standalone = listId === projectId;
  return <div className="stack project-configuration"><FieldConfiguration detail={detail} projectId={projectId} listId={listId} onUpdated={updated} localConfiguration={localConfiguration} />
    {listId
      ? <>{standalone && <ProjectSettings detail={detail} projectId={projectId} onUpdated={updated} localConfiguration={localConfiguration} dateOnly />}
        <ListStatusSettings detail={detail} listId={listId} onUpdated={updated} localConfiguration={localListConfiguration} /></>
      : <ProjectSettings detail={detail} projectId={projectId} onUpdated={updated} localConfiguration={localConfiguration} />}</div>;
}

function FieldConfiguration({ detail, projectId, onUpdated, localConfiguration }: ConfigurationProps) {
  const [catalog, setCatalog] = useState(detail.fields);
  const [configuration, setConfiguration] = useState<ProjectFieldConfiguration>();
  const [fieldIds, setFieldIds] = useState<string[]>([]);
  const [builtIns, setBuiltIns] = useState<ProjectFieldConfiguration["builtInFields"]>([]);
  const [name, setName] = useState("");
  const [type, setType] = useState<Field["type"]>("text");
  const [options, setOptions] = useState("");
  const [settings, setSettings] = useState<NonNullable<Field["settings"]>>({});
  const [editing, setEditing] = useState<Field>();
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [blocked, setBlocked] = useState(false);
  const [status, setStatus] = useState("");
  const [reload, setReload] = useState(0);
  const context = useRef<AbortController | null>(null);
  const base = workspacePath(detail.workspace.id);
  const path = `${base}/projects/${encodeURIComponent(projectId)}/fields`;
  const scopeName = detail.nodes.find(node => node.id === projectId)?.kind === "list" ? "list" : "project";
  const scopeLabel = scopeName === "list" ? "List" : "Project";
  useEffect(() => {
    // Advance only past unrelated sibling writes, never past changed assignments.
    if (localConfiguration) setConfiguration(current => current &&
      JSON.stringify([current.fieldIds, current.builtInFields]) === JSON.stringify([localConfiguration.fieldIds, localConfiguration.builtInFields])
      ? localConfiguration : current);
  }, [localConfiguration]);
  useEffect(() => {
    const controller = new AbortController();
    context.current = controller;
    setBusy(true);
    Promise.all([
      api<ProjectFieldConfiguration>(path, "GET", undefined, controller.signal),
      api<Detail>(base, "GET", undefined, controller.signal),
    ]).then(([config, fresh]) => {
      controller.signal.throwIfAborted();
      if (config.projectId !== projectId || fresh.workspace.id !== detail.workspace.id) throw new Error("The server returned a different project or workspace.");
      setCatalog(fresh.fields);
      setConfiguration(config);
      setFieldIds(config.fieldIds);
      setBuiltIns(config.builtInFields);
      setError("");
      setBlocked(false);
    }).catch(e => {
      if (!controller.signal.aborted) { setError(message(e)); setBlocked(true); }
    }).finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [base, path, projectId, reload]);

  async function save(create: boolean) {
    if (busy || blocked || !configuration) return;
    const signal = context.current!.signal;
    setBusy(true);
    setError("");
    setStatus("");
    let mutationCompleted = false;
    try {
      let created: Field | undefined;
      if (create) {
        created = await api<Field>(`${base}/fields`, "POST", {
          name: name.trim(), type, projectId,
          ...(["date", "datetime", "rating", "formula"].includes(type) ? { settings: fieldSettings(type, settings) } : {}),
          ...(["select", "checklist"].includes(type) ? { options: [...new Set(options.split("\n").map(value => value.trim()).filter(Boolean))] } : {}),
        }, signal);
      } else {
        await api(path, "PATCH", { fieldIds, builtInFields: builtIns, expectedUpdatedAt: configuration.updatedAt }, signal);
      }
      mutationCompleted = true;
      const fresh = await api<Detail>(base, "GET", undefined, signal);
      signal.throwIfAborted();
      const config = fresh.projectFields?.find(value => value.projectId === projectId);
      if (fresh.workspace.id !== detail.workspace.id || !config) throw new Error("Could not verify the updated project fields.");
      setCatalog(fresh.fields);
      setConfiguration(config);
      if (created) {
        setFieldIds(mergeSelection(configuration.fieldIds, fieldIds, config.fieldIds));
        setBuiltIns(mergeSelection(configuration.builtInFields, builtIns, config.builtInFields));
        setName("");
        setOptions("");
        setSettings({});
      } else { setFieldIds(config.fieldIds); setBuiltIns(config.builtInFields); }
      setStatus(created ? "Field created and added. Other checkbox changes still need Apply fields." : `${scopeLabel} fields updated.`);
      onUpdated(fresh);
    } catch (e) {
      if (!signal.aborted) {
        const conflict = e instanceof ApiError && e.status === 409;
        // A failed refresh or transport may follow a committed write. Do not invite a duplicate POST.
        const uncertain = mutationCompleted || !(e instanceof ApiError);
        setBlocked(conflict || uncertain);
        setError(conflict ? `${scopeLabel} fields changed elsewhere. Your choices are kept. Reload and discard your choices before trying again.`
          : uncertain ? "The update could not be verified and may have saved. Your draft is kept. Reload and discard your choices before trying again."
          : message(e));
      }
    } finally { if (!signal.aborted) setBusy(false); }
  }

  return <>
    <ErrorNotice error={error} />
    {blocked && <button type="button" disabled={busy} onClick={() => {
      if (window.confirm(`Reload ${scopeName} fields and discard your checkbox choices? The create-field draft will be kept.`)) setReload(value => value + 1);
    }}>Reload {scopeName} fields</button>}
    {status && <p role="status">{status}</p>}
    {busy && <p role="status">Loading or updating {scopeName} fields...</p>}
    <fieldset className="stack bare-fieldset project-field-picker" disabled={busy || blocked || !configuration}>
      <legend>Fields in this {scopeName}</legend>
      <p className="project-fields-copy">Choose what appears on tasks in this {scopeName}. Unchecking a field hides it without deleting saved task values.</p>
      <div className="project-field-group">
        <h3>Built-in fields</h3>
        <div className="project-field-options">
          {optionalBuiltIns.map(field => <label key={field.id}>
            <input type="checkbox" aria-label={`${field.label} Built-in`} checked={builtIns.includes(field.id)} onChange={event => setBuiltIns(ids => event.target.checked ? [...ids, field.id] : ids.filter(id => id !== field.id))} />
            <span>{field.label} <small>Built-in</small></span>
          </label>)}
        </div>
      </div>
      <div className="project-field-group">
        <h3>Workspace field catalog</h3>
        <div className="project-field-options">
          {catalog.map(field => <label key={field.id}>
            <input type="checkbox" aria-label={`${field.name} ${label(field.type)}`} checked={fieldIds.includes(field.id)} onChange={event => setFieldIds(ids => event.target.checked ? [...ids, field.id] : ids.filter(id => id !== field.id))} />
            <span>{field.name} <small>{label(field.type)}</small></span>
          </label>)}
        </div>
        {!catalog.length && <p className="muted">No workspace fields yet. Create one below to add {scopeName}-specific information.</p>}
      </div>
      {catalog.length > 0 && <label>Edit a field definition<select value="" onChange={event => setEditing(catalog.find(field => field.id === event.target.value))}><option value="">Choose a field to edit</option>{catalog.map(field => <option key={field.id} value={field.id}>{field.name}</option>)}</select></label>}
      <button className="primary project-fields-apply" type="button" onClick={() => void save(false)}>Apply fields</button>
    </fieldset>
    <form className="stack project-field-create" onSubmit={event => { event.preventDefault(); void save(true); }}>
      <h3>Create a field</h3>
      <fieldset className="stack bare-fieldset" disabled={busy || blocked || !configuration}>
        <legend>New field</legend>
        <div className="project-field-templates" aria-label="Field templates">
          {[{ name: "Estimate (hours)", type: "number" }, { name: "Effort (points)", type: "number" }, { name: "Progress (%)", type: "number" }, { name: "Reference", type: "text" }].map(template =>
            <button type="button" key={template.name} onClick={() => {
              const existing = catalog.find(field => field.name.toLowerCase() === template.name.toLowerCase() && field.type === template.type);
              if (existing) {
                setFieldIds(ids => [...new Set([...ids, existing.id])]);
                setStatus(`Selected existing ${existing.name}. Choose Apply fields to add it.`);
              } else { setName(template.name); setType(template.type as Field["type"]); }
            }}>{template.name}</button>)}
        </div>
        <label>Field name<input aria-label="Field name" required maxLength={120} value={name} onChange={event => setName(event.target.value)} /></label>
        <label>Type<select aria-label="Type" value={type} onChange={event => setType(event.target.value as Field["type"])}>
          {(["text", "number", "date", "datetime", "checkbox", "select", "checklist", "rating", "formula"] as const).map(value => <option key={value} value={value}>{label(value)}</option>)}
        </select></label>
        {["select", "checklist"].includes(type) && <label>Options, one per line<textarea aria-label="Options, one per line" required rows={4} maxLength={4000} value={options} onChange={event => setOptions(event.target.value)} /></label>}
        <FieldSettings type={type} settings={settings} onChange={setSettings} />
        <button type="submit" disabled={!name.trim()}>Create field and add</button>
      </fieldset>
    </form>
    {editing && <FieldEditor key={editing.id} field={editing} base={base} onClose={() => setEditing(undefined)} onSaved={() => {
      setEditing(undefined);
      const signal = context.current!.signal;
      api<Detail>(base, "GET", undefined, signal).then(fresh => { if (!signal.aborted && fresh.workspace.id === detail.workspace.id) { setCatalog(fresh.fields); onUpdated(fresh); } }).catch(error => { if (!signal.aborted) setError(message(error)); });
    }} />}
  </>;
}
