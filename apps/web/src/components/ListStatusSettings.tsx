import { useEffect, useRef, useState } from "react";
import { api, ApiError, message, workspacePath, type Detail, type ListStatusConfiguration, type ProjectStatus } from "../lib/api";
import { projectStatuses } from "../lib/project-statuses";
import { projectForNode } from "../lib/project-fields";
import { ErrorNotice } from "./Shared";
import { StatusEditor } from "./ProjectSettings";

export default function ListStatusSettings({ detail, listId, onUpdated, localConfiguration }: {
  detail: Detail;
  listId: string;
  onUpdated: (detail: Detail) => void;
  localConfiguration?: ListStatusConfiguration;
}) {
  const project = projectForNode(detail.nodes, listId);
  const standalone = !project;
  const inherited = projectStatuses(detail, project?.id);
  const [baseline, setBaseline] = useState<ListStatusConfiguration>();
  const [override, setOverride] = useState(false);
  const [statuses, setStatuses] = useState<ProjectStatus[]>([]);
  const [busy, setBusy] = useState(true);
  const [blocked, setBlocked] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [reload, setReload] = useState(0);
  const context = useRef<AbortController | null>(null);
  const overrideMode = useRef(override);
  overrideMode.current = override;
  const base = workspacePath(detail.workspace.id);
  const path = `${base}/lists/${encodeURIComponent(listId)}/statuses`;

  useEffect(() => {
    if (!localConfiguration) return;
    setBaseline(current => current && (!overrideMode.current ||
      current.statuses !== undefined && JSON.stringify(current.statuses) === JSON.stringify(localConfiguration.statuses))
      ? localConfiguration : current);
    if (!overrideMode.current && !standalone) setStatuses(structuredClone(inherited));
  }, [localConfiguration, inherited, standalone]);
  useEffect(() => {
    const controller = new AbortController(); context.current = controller; setBusy(true);
    api<ListStatusConfiguration>(path, "GET", undefined, controller.signal).then(config => {
      controller.signal.throwIfAborted();
      if (config.listId !== listId) throw new Error("Unexpected list status configuration.");
      setBaseline(config); setOverride(standalone || config.statuses !== undefined); setStatuses(structuredClone(config.statuses ?? inherited)); setBlocked(false); setError("");
    }).catch(value => { if (!controller.signal.aborted) { setError(message(value)); setBlocked(true); } })
      .finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [path, listId, reload, standalone]);

  return <section className="stack list-status-settings"><h3>List statuses</h3>
    <ErrorNotice error={error} />{notice && <p role="status">{notice}</p>}
    {blocked && <button type="button" disabled={busy} onClick={() => {
      if (window.confirm("Discard the list status draft and reload?")) setReload(value => value + 1);
    }}>Reload list statuses</button>}
    <form className="stack" onSubmit={async event => {
      event.preventDefault(); if (busy || blocked || !baseline) return;
      const signal = context.current!.signal; setBusy(true); setError(""); setNotice(""); let saved = false;
      try {
        await api(path, "PATCH", {
          statuses: standalone || override ? statuses : null,
          expectedUpdatedAt: baseline.updatedAt,
          ...(!standalone && override && baseline.statuses === undefined ? { expectedProjectUpdatedAt: baseline.inheritedProjectUpdatedAt } : {}),
        }, signal); saved = true;
        const fresh = await api<Detail>(base, "GET", undefined, signal); signal.throwIfAborted();
        const config = fresh.listStatusConfigs?.find(value => value.listId === listId);
        if (fresh.workspace.id !== detail.workspace.id || !config) throw new Error("Could not verify list statuses.");
        setBaseline(config); setOverride(standalone || config.statuses !== undefined); setStatuses(structuredClone(config.statuses ?? projectStatuses(fresh, listId))); onUpdated(fresh); setNotice("List statuses saved.");
      } catch (value) {
        if (!signal.aborted) {
          const conflict = value instanceof ApiError && value.status === 409;
          const uncertain = saved || !(value instanceof ApiError);
          setBlocked(conflict || uncertain);
          setError(conflict ? "List statuses changed elsewhere. Your draft is kept. Reload before saving again." : uncertain ? "The update may have saved but could not be verified. Your draft is kept. Reload before retrying." : message(value));
        }
      } finally { if (!signal.aborted) setBusy(false); }
    }}>
      <fieldset className="stack bare-fieldset list-status-fieldset" disabled={busy || blocked || !baseline}>
        <legend>{standalone ? "Standalone list workflow" : "Status source"}</legend>
        {standalone
          ? <p className="muted">This list is at the workspace root and defines its own statuses.</p>
          : <div className="list-status-source-options">
            <label>
              <input type="radio" name="list-status-source" aria-label="Use project statuses" checked={!override} onChange={() => setOverride(false)} />
              <span><strong>Use project statuses</strong><small>Stay synchronized with the project's workflow.</small></span>
            </label>
            <label>
              <input type="radio" name="list-status-source" aria-label="Override statuses for this list" checked={override} onChange={() => { setOverride(true); if (!statuses.length) setStatuses(structuredClone(inherited)); }} />
              <span><strong>Override for this list</strong><small>Customize statuses only for this list.</small></span>
            </label>
          </div>}
        {(standalone || override) && <StatusEditor statuses={statuses} onChange={setStatuses} />}
        <button type="submit">Save list statuses</button>
      </fieldset>
    </form>
  </section>;
}
