import { useEffect, useState, type SubmitEvent } from "react";
import {
  api,
  message,
  webhookEvents,
  workspacePath,
  type Detail,
  type Webhook,
  type WebhookEvent,
  type Workspace,
} from "../lib/api";
import AutomationWorkspace, { CredentialManager } from "./AutomationWorkspace";
import { Empty, ErrorNotice, Loading, Modal, Shell, useSession } from "./Shared";

const eventLabel = (id: string) => webhookEvents.find((event) => event.id === id)?.label ?? id;

function Webhooks({ wid, revision }: { wid: string; revision: number }) {
  const [hooks, setHooks] = useState<Webhook[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Webhook | null>(null);
  const [oneTimeSecret, setOneTimeSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [readRevision, setReadRevision] = useState(0);
  const base = `${workspacePath(wid)}/webhooks`;
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError("");
    api<Webhook[]>(base, "GET", undefined, controller.signal)
      .then(rows => { if (!controller.signal.aborted) setHooks(rows); })
      .catch((cause) => { if (!controller.signal.aborted) setError(message(cause)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [base, revision, readRevision]);
  async function mutate(operation: () => Promise<unknown>, rejectOnError = false) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await operation();
      if (result && typeof result === "object" && "secret" in result) setOneTimeSecret(String(result.secret));
      setCreating(false);
      setEditing(null);
      try { setHooks(await api<Webhook[]>(base, "GET")); }
      catch (cause) { setError(`The change was saved, but the webhook list could not refresh. ${message(cause)}`); }
    } catch (cause) {
      setError(message(cause));
      if (rejectOnError) throw cause;
    } finally {
      setBusy(false);
    }
  }
  return <section className="settings-section" aria-labelledby="webhooks-heading">
    <div className="section-intro"><h2 id="webhooks-heading">Webhooks</h2><p>New and rotated webhooks sign JSON events with HMAC-SHA256 in <code>x-hopya-signature</code>. Signing secrets are shown only once.</p></div>
    <div className="stack"><ErrorNotice error={error} />{error && <div><button type="button" disabled={busy || loading} onClick={() => setReadRevision(value => value + 1)}>Reload webhooks</button></div>}{loading ? <Loading /> : <ul className="record-list">{hooks.map((hook) => <li key={hook.id}>
      <div><strong>{hook.name}</strong><small className="muted hook-url">{hook.url}</small><small className="muted">{hook.events.map(eventLabel).join(", ")}</small>{hook.signingVersion === 1 && <small className="warning-text">Legacy signature format · rotate the secret to upgrade to HMAC-SHA256</small>}</div>
      <div className="button-group"><span className={hook.enabled ? "count ok" : "count"}>{hook.enabled ? "Enabled" : "Paused"}</span><button disabled={busy} onClick={() => void mutate(() => api(`${base}/${hook.id}`, "PATCH", { enabled: !hook.enabled }))}>{hook.enabled ? "Pause" : "Resume"}</button><button disabled={busy} onClick={() => setEditing(hook)}>Edit</button><button disabled={busy} onClick={() => { if (window.confirm(`Rotate the signing secret for "${hook.name}"? The old secret will stop working immediately.`)) void mutate(() => api(`${base}/${hook.id}/rotate`, "POST")); }}>Rotate secret</button><button className="danger" disabled={busy} onClick={() => { if (window.confirm(`Delete webhook "${hook.name}"?`)) void mutate(() => api(`${base}/${hook.id}`, "DELETE")); }}>Delete</button></div>
    </li>)}</ul>}{!loading && !error && !hooks.length && <p className="muted">No webhooks yet. Add one to push workspace events to an external endpoint.</p>}<div><button type="button" disabled={loading || busy} onClick={() => setCreating(true)}>Add webhook</button></div></div>
    {creating && <WebhookDialog title="Add webhook" busy={busy} onClose={() => { if (!busy) setCreating(false); }} onSave={(payload) => mutate(() => api(base, "POST", payload), true)} />}
    {editing && <WebhookDialog title="Edit webhook" webhook={editing} busy={busy} onClose={() => { if (!busy) setEditing(null); }} onSave={(payload) => mutate(() => api(`${base}/${editing.id}`, "PATCH", payload), true)} />}
    {oneTimeSecret && <Modal title="Save webhook signing secret" onClose={() => setOneTimeSecret("")}><div className="stack"><p className="notice">This secret is shown once. Store it in your receiver's secret manager before closing.</p><label>Signing secret<input readOnly value={oneTimeSecret} onFocus={(event) => event.currentTarget.select()} /></label><div className="modal-actions"><button type="button" className="primary" onClick={() => setOneTimeSecret("")}>I stored the secret</button></div></div></Modal>}
  </section>;
}

function WebhookDialog({ title, webhook, busy, onClose, onSave }: { title: string; webhook?: Webhook; busy: boolean; onClose: () => void; onSave: (payload: unknown) => Promise<unknown> }) {
  const [name, setName] = useState(webhook?.name ?? "");
  const [url, setUrl] = useState(webhook?.url ?? "");
  const [events, setEvents] = useState<WebhookEvent[]>(webhook?.events ?? ["item.updated"]);
  const [enabled, setEnabled] = useState(webhook?.enabled ?? true);
  const [error, setError] = useState("");
  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!busy && name.trim() && url.trim() && events.length) {
      setError("");
      void onSave({ name: name.trim(), url: url.trim(), events, enabled }).catch((cause) => setError(message(cause)));
    }
  };
  return <Modal title={title} onClose={onClose}><form onSubmit={submit} className="stack">
    <ErrorNotice error={error} />
    <label>Name<input required disabled={busy} maxLength={120} value={name} onChange={(event) => setName(event.target.value)} /></label>
    <label>Endpoint URL<input required disabled={busy} type="url" maxLength={2000} placeholder="https://example.com/hook" value={url} onChange={(event) => setUrl(event.target.value)} /></label>
    <fieldset className="bare-fieldset" disabled={busy}><legend>Events</legend><div className="project-field-options">{webhookEvents.map((option) => <label key={option.id}><input type="checkbox" checked={events.includes(option.id)} onChange={(event) => setEvents((current) => event.target.checked ? [...current, option.id] : current.filter((value) => value !== option.id))} /><span>{option.label}</span></label>)}</div></fieldset>
    <label className="inline-check"><input type="checkbox" disabled={busy} checked={enabled} onChange={(event) => setEnabled(event.target.checked)} /><span>Enabled</span></label>
    <div className="modal-actions"><button type="button" disabled={busy} onClick={onClose}>Cancel</button><button className="primary" disabled={busy || !events.length}>{busy ? "Saving…" : webhook ? "Save webhook" : "Create webhook"}</button></div>
  </form></Modal>;
}

export default function Integrations() {
  const { user, error: authError } = useSession();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState("");
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [loadingWorkspaces, setLoadingWorkspaces] = useState(true);
  useEffect(() => {
    if (!user) return;
    const controller = new AbortController();
    setLoadingWorkspaces(true); setError("");
    api<Workspace[]>("/workspaces", "GET", undefined, controller.signal).then((rows) => {
      if (controller.signal.aborted) return;
      let stored: string | null = null;
      try { stored = localStorage.getItem("hopya.workspace"); } catch {}
      setWorkspaces(rows);
      setWorkspaceId((current) => rows.some((row) => row.id === current) ? current : rows.find((row) => row.id === stored)?.id ?? rows[0]?.id ?? "");
    }).catch((cause) => { if (!controller.signal.aborted) setError(message(cause)); })
      .finally(() => { if (!controller.signal.aborted) setLoadingWorkspaces(false); });
    return () => controller.abort();
  }, [user?.id, revision]);
  useEffect(() => {
    if (!workspaceId) { setDetail(null); return; }
    const controller = new AbortController();
    setDetail(null);
    api<Detail>(workspacePath(workspaceId), "GET", undefined, controller.signal)
      .then((loaded) => { if (!controller.signal.aborted && loaded.workspace.id === workspaceId) setDetail(loaded); })
      .catch((cause) => { if (!controller.signal.aborted) setError(message(cause)); });
    return () => controller.abort();
  }, [workspaceId, revision]);
  function chooseWorkspace(id: string) {
    if (id === workspaceId || !workspaces.some((workspace) => workspace.id === id)) return;
    setWorkspaceId(id);
    setDetail(null);
    setError("");
    try { localStorage.setItem("hopya.workspace", id); } catch {}
  }
  const canManageWebhooks = detail?.permissions.includes("workspace:manage");
  const canManageAutomations = detail?.permissions.includes("automations:manage") && detail.permissions.includes("items:read");
  const canManageCredentials = detail?.permissions.includes("credentials:manage");
  return <Shell user={user} active="app" currentPage="Integrations" navigation={{ workspaces, workspaceId, detail, onWorkspaceChange: chooseWorkspace }}><div className="settings-body integrations-body">
    <header className="integrations-header"><h1>Integrations</h1><p className="muted">Webhooks and automations for {detail?.workspace.name || "your workspace"}.</p></header><ErrorNotice error={authError || error} />{(authError || error) && <button onClick={() => authError ? window.location.reload() : setRevision((value) => value + 1)}>Retry loading</button>}
    <div className="integrations-content">{authError || error ? null : !user || loadingWorkspaces ? <Loading /> : !workspaceId ? <Empty title="Choose a workspace" action={<a className="button" href="/app">Open workspace</a>}>Create or join a workspace to manage its integrations.</Empty> : !detail ? <Loading /> : !canManageWebhooks && !canManageAutomations && !canManageCredentials ? <section className="notice"><h2>Management permission required</h2><p>Webhooks, automations, or credential management permission is required.</p></section> : <>{canManageWebhooks && <Webhooks key={detail.workspace.id} wid={detail.workspace.id} revision={revision} />}{canManageAutomations && <AutomationWorkspace key={detail.workspace.id} detail={detail} revision={revision} />}{!canManageAutomations && canManageCredentials && <CredentialManager key={detail.workspace.id} wid={detail.workspace.id} />}</>}</div>
  </div></Shell>;
}
