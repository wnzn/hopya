import { useEffect, useState, type SubmitEvent } from "react";
import {
  api,
  message,
  webhookEvents,
  workspacePath,
  type Automation,
  type AutomationAction,
  type AutomationProvider,
  type AutomationRun,
  type Detail,
  type Workspace,
  type Webhook,
  type WebhookEvent,
} from "../lib/api";
import { ErrorNotice, Loading, Modal, Shell, useSession } from "./Shared";

const eventLabel = (id: string) =>
  webhookEvents.find((event) => event.id === id)?.label ?? id;

function Webhooks({ wid, revision }: { wid: string; revision: number }) {
  const [hooks, setHooks] = useState<Webhook[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Webhook | null>(null);
  const [busy, setBusy] = useState(false);
  const base = `${workspacePath(wid)}/webhooks`;
  useEffect(() => {
    if (!wid) return;
    const controller = new AbortController();
    setLoading(true);
    api<Webhook[]>(base, "GET", undefined, controller.signal)
      .then(setHooks)
      .catch((e) => setError(message(e)))
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [wid, revision, base]);
  async function mutate(operation: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await operation();
      setHooks(await api<Webhook[]>(base, "GET"));
      setCreating(false);
      setEditing(null);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="settings-section" aria-labelledby="webhooks-heading">
      <div className="section-intro">
        <h2 id="webhooks-heading">Webhooks</h2>
        <p>
          HTTP endpoints that receive JSON events with an HMAC-SHA256 signature
          header (x-hopya-signature: sha256=&lt;hexdigest&gt; over
          &lt;secret&gt;.&lt;body&gt;).
        </p>
      </div>
      <div className="stack">
        <ErrorNotice error={error} />
        {loading ? (
          <Loading />
        ) : (
          <ul className="record-list">
            {hooks.map((hook) => (
              <li key={hook.id}>
                <div>
                  <strong>{hook.name}</strong>
                  <small className="muted hook-url">{hook.url}</small>
                  <small className="muted">
                    {hook.events.map(eventLabel).join(", ")}
                  </small>
                </div>
                <div className="button-group">
                  <span className={hook.enabled ? "count ok" : "count"}>
                    {hook.enabled ? "Enabled" : "Paused"}
                  </span>
                  <button
                    disabled={busy}
                    onClick={() =>
                      void mutate(() =>
                        api(`${base}/${hook.id}`, "PATCH", {
                          enabled: !hook.enabled,
                        }),
                      )
                    }
                  >
                    {hook.enabled ? "Pause" : "Resume"}
                  </button>
                  <button disabled={busy} onClick={() => setEditing(hook)}>
                    Edit
                  </button>
                  <button
                    className="danger"
                    disabled={busy}
                    onClick={() => {
                      if (
                        window.confirm(`Delete webhook "${hook.name}"?`)
                      )
                        void mutate(() => api(`${base}/${hook.id}`, "DELETE"));
                    }}
                  >
                    Delete
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
        {!loading && !hooks.length && (
          <p className="muted">
            No webhooks yet. Add one to push workspace events to an external
            endpoint.
          </p>
        )}
        <button type="button" onClick={() => setCreating(true)}>
          Add webhook
        </button>
      </div>
      {creating && (
        <WebhookDialog
          title="Add webhook"
          busy={busy}
          onClose={() => setCreating(false)}
          onSave={(payload) =>
            mutate(() => api(base, "POST", payload) as Promise<unknown>)
          }
        />
      )}
      {editing && (
        <WebhookDialog
          title="Edit webhook"
          webhook={editing}
          busy={busy}
          onClose={() => setEditing(null)}
          onSave={(payload) =>
            mutate(() =>
              api(`${base}/${editing.id}`, "PATCH", payload) as Promise<unknown>,
            )
          }
        />
      )}
    </section>
  );
}

function WebhookDialog({
  title,
  webhook,
  busy,
  onClose,
  onSave,
}: {
  title: string;
  webhook?: Webhook;
  busy: boolean;
  onClose: () => void;
  onSave: (payload: unknown) => Promise<unknown>;
}) {
  const [name, setName] = useState(webhook?.name ?? "");
  const [url, setUrl] = useState(webhook?.url ?? "");
  const [events, setEvents] = useState<WebhookEvent[]>(
    webhook?.events ?? ["item.updated"],
  );
  const [enabled, setEnabled] = useState(webhook?.enabled ?? true);
  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!name.trim() || !url.trim() || !events.length) return;
    void onSave({ name: name.trim(), url: url.trim(), events, enabled });
  };
  return (
    <Modal title={title} onClose={onClose}>
      <form onSubmit={submit} className="stack">
        <ErrorNotice error={busy ? "" : ""} />
        <label>
          Name
          <input
            required
            maxLength={120}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label>
          Endpoint URL
          <input
            required
            type="url"
            maxLength={2000}
            placeholder="https://example.com/hook"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
        </label>
        <fieldset className="bare-fieldset">
          <legend>Events</legend>
          <div className="project-field-options">
            {webhookEvents.map((event) => (
              <label key={event.id}>
                <input
                  type="checkbox"
                  checked={events.includes(event.id)}
                  onChange={(e) =>
                    setEvents((current) =>
                      e.target.checked
                        ? [...current, event.id]
                        : current.filter((value) => value !== event.id),
                    )
                  }
                />
                <span>{event.label}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <label className="inline-check">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          <span>Enabled</span>
        </label>
        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" disabled={busy || !events.length}>
            {webhook ? "Save webhook" : "Create webhook"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

const actionTypes: { id: AutomationProvider; label: string }[] = [
  { id: "webhook", label: "Webhook request" },
  { id: "email", label: "Email notification" },
  { id: "http", label: "HTTP request" },
  { id: "log", label: "Run log" },
];

type StepDraft = {
  key: number;
  type: string;
  url: string;
  method: string;
  headers: string;
  body: string;
  to: string;
  subject: string;
  logMessage: string;
};

let nextStepKey = 0;
const stringConfig = (config: Record<string, unknown>, key: string) =>
  typeof config[key] === "string" ? config[key] : "";
const stepDraft = (action?: AutomationAction): StepDraft => {
  const config = action?.config ?? {};
  const headerValue = config.headers;
  return {
    key: ++nextStepKey,
    type: action?.type ?? "http",
    url: stringConfig(config, "url"),
    method: stringConfig(config, "method") || "POST",
    headers:
      headerValue && typeof headerValue === "object" && !Array.isArray(headerValue)
        ? Object.entries(headerValue)
            .filter((entry): entry is [string, string] => typeof entry[1] === "string")
            .map(([key, value]) => `${key}: ${value}`)
            .join("\n")
        : "",
    body: stringConfig(config, "body"),
    to: Array.isArray(config.to)
      ? config.to.filter((value): value is string => typeof value === "string").join(", ")
      : "",
    subject: stringConfig(config, "subject"),
    logMessage: stringConfig(config, "message"),
  };
};

const providerLabel = (type: string) =>
  actionTypes.find((provider) => provider.id === type)?.label ?? `Unavailable provider (${type})`;

function Automations({ detail, revision }: { detail: Detail; revision: number }) {
  const [rows, setRows] = useState<Automation[]>([]);
  const [runs, setRuns] = useState<AutomationRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<Automation | null>(null);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [runsLoading, setRunsLoading] = useState(true);
  const base = `${workspacePath(detail.workspace.id)}/automations`;
  async function refreshRuns(signal?: AbortSignal) {
    setRunsLoading(true);
    try {
      setRuns(await api<AutomationRun[]>(`${base}/runs?limit=20`, "GET", undefined, signal));
    } finally {
      setRunsLoading(false);
    }
  }
  useEffect(() => {
    if (!detail.workspace.id) return;
    const controller = new AbortController();
    setLoading(true);
    setRunsLoading(true);
    setRows([]);
    setRuns([]);
    setError("");
    Promise.all([
      api<Automation[]>(base, "GET", undefined, controller.signal),
      api<AutomationRun[]>(`${base}/runs?limit=20`, "GET", undefined, controller.signal),
    ])
      .then(([automations, recentRuns]) => {
        setRows(automations);
        setRuns(recentRuns);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(message(e));
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setLoading(false);
          setRunsLoading(false);
        }
      });
    return () => controller.abort();
  }, [detail.workspace.id, revision, base]);
  async function mutate(operation: () => Promise<unknown>, rejectOnError = false) {
    setBusy(true);
    setError("");
    try {
      await operation();
      const [automations, recentRuns] = await Promise.all([
        api<Automation[]>(base, "GET"),
        api<AutomationRun[]>(`${base}/runs?limit=20`, "GET"),
      ]);
      setRows(automations);
      setRuns(recentRuns);
      setCreating(false);
      setEditing(null);
    } catch (e) {
      setError(message(e));
      if (rejectOnError) throw e;
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="settings-section" aria-labelledby="automations-heading">
      <div className="section-intro">
        <h2 id="automations-heading">Automations</h2>
        <p>
          Run up to 20 ordered webhook, email, HTTP or log steps when a chosen
          workspace event occurs. Email requires operator SMTP.
        </p>
      </div>
      <div className="stack">
        <ErrorNotice error={error} />
        {loading ? (
          <Loading />
        ) : (
          <ul className="record-list">
            {rows.map((automation) => (
              <li key={automation.id}>
                <div>
                  <strong>{automation.name}</strong>
                  <small className="muted">
                    On {eventLabel(automation.event)} · {automation.steps.length} ordered
                    {automation.steps.length === 1 ? " step" : " steps"}
                  </small>
                </div>
                <div className="button-group">
                  <span className={automation.enabled ? "count ok" : "count"}>
                    {automation.enabled ? "Enabled" : "Paused"}
                  </span>
                  <button
                    disabled={busy}
                    onClick={() =>
                      void mutate(() =>
                        api(`${base}/${automation.id}`, "PATCH", {
                          enabled: !automation.enabled,
                        }),
                      )
                    }
                  >
                    {automation.enabled ? "Pause" : "Resume"}
                  </button>
                  <button disabled={busy} onClick={() => setEditing(automation)}>
                    Edit
                  </button>
                  <button
                    disabled={busy}
                    onClick={() => void mutate(() => api(`${base}/${automation.id}/test`, "POST"))}
                  >
                    Test run
                  </button>
                  <button
                    className="danger"
                    disabled={busy}
                    onClick={() => {
                      if (window.confirm(`Delete automation "${automation.name}"?`))
                        void mutate(() => api(`${base}/${automation.id}`, "DELETE"));
                    }}
                  >
                    Delete
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
        {!loading && !rows.length && (
          <p className="muted">
            No automations yet. Create one to react to workspace events.
          </p>
        )}
        <button type="button" onClick={() => setCreating(true)}>
          Add automation
        </button>
        <section aria-labelledby="job-monitor-heading" className="stack">
          <div className="section-intro">
            <h3 id="job-monitor-heading">Job monitor</h3>
            <p>
              Latest 20 workspace automation and webhook runs. Logs and outputs are
              bounded and sanitized by the server; the original event and secrets are not shown.
            </p>
          </div>
          <button
            type="button"
            disabled={runsLoading}
            onClick={() => {
              setError("");
              void refreshRuns().catch((cause) => setError(message(cause)));
            }}
          >
            {runsLoading ? "Refreshing…" : "Refresh jobs"}
          </button>
          {!runsLoading && !runs.length ? (
            <p className="muted">No recent jobs in this workspace.</p>
          ) : (
            <ul className="record-list compact">
              {runs.map((run) => (
                <li key={run.id}>
                  <details className="run-log">
                    <summary>
                      <strong className={run.status}>{run.status}</strong>{" "}
                      {run.targetType === "automation"
                        ? rows.find((row) => row.id === run.targetId)?.name ?? "Unavailable automation"
                        : `Webhook delivery ${run.targetId}`}{" "}
                      <span className="muted">· {new Date(run.createdAt).toLocaleString()}</span>
                    </summary>
                    <div className="stack">
                      <p>{run.detail || "No run detail recorded yet."}</p>
                      <small className="muted">
                        {run.startedAt ? `Started ${new Date(run.startedAt).toLocaleString()}` : "Waiting to start"}
                        {run.completedAt ? ` · Completed ${new Date(run.completedAt).toLocaleString()}` : ""}
                      </small>
                      {run.steps.length > 0 && (
                        <ol>
                          {run.steps.map((step) => (
                            <li key={step.id}>
                              <strong>Step {step.position}: {providerLabel(step.type)}</strong>{" "}
                              <span className={step.status}>{step.status}</span>
                              {step.log && <p><strong>Log:</strong> {step.log}</p>}
                              {step.output && <p><strong>Output:</strong> {step.output}</p>}
                            </li>
                          ))}
                        </ol>
                      )}
                    </div>
                  </details>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
      {(creating || editing) && (
        <AutomationDialog
          title={editing ? "Edit automation" : "Add automation"}
          automation={editing ?? undefined}
          busy={busy}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSave={(payload) =>
            editing
              ? mutate(() => api(`${base}/${editing.id}`, "PATCH", payload), true)
              : mutate(() => api(base, "POST", payload), true)
          }
        />
      )}
    </section>
  );
}

function AutomationDialog({
  title,
  automation,
  busy,
  onClose,
  onSave,
}: {
  title: string;
  automation?: Automation;
  busy: boolean;
  onClose: () => void;
  onSave: (payload: unknown) => Promise<unknown>;
}) {
  const [name, setName] = useState(automation?.name ?? "");
  const [event, setEvent] = useState<WebhookEvent>(automation?.event ?? "item.updated");
  const [steps, setSteps] = useState<StepDraft[]>(() => {
    const saved = automation?.steps?.length ? automation.steps : automation?.action ? [automation.action] : [];
    return saved.length ? saved.map(stepDraft) : [stepDraft()];
  });
  const [error, setError] = useState("");
  const updateStep = (key: number, patch: Partial<StepDraft>) =>
    setSteps((current) => current.map((step) => (step.key === key ? { ...step, ...patch } : step)));
  const moveStep = (index: number, offset: number) => {
    setSteps((current) => {
      const target = index + offset;
      if (target < 0 || target >= current.length) return current;
      const next = [...current];
      [next[index], next[target]] = [next[target]!, next[index]!];
      return next;
    });
  };
  function submit(formEvent: SubmitEvent<HTMLFormElement>) {
    formEvent.preventDefault();
    if (!name.trim()) return;
    const actions: AutomationAction[] = [];
    for (const [index, step] of steps.entries()) {
      let config: Record<string, unknown>;
      if (step.type === "http") {
        const headerMap: Record<string, string> = {};
        for (const line of step.headers.split("\n")) {
          const colon = line.indexOf(":");
          if (!line.trim()) continue;
          if (colon < 1) { setError(`Step ${index + 1}: headers must use 'Name: value' format.`); return; }
          headerMap[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
        }
        if (Object.keys(headerMap).length > 20) { setError(`Step ${index + 1}: use at most 20 headers.`); return; }
        if (!step.url.trim()) { setError(`Step ${index + 1}: an endpoint URL is required.`); return; }
        config = { url: step.url.trim(), method: step.method, headers: headerMap, ...(step.body ? { body: step.body } : {}) };
      } else if (step.type === "webhook") {
        if (!step.url.trim()) { setError(`Step ${index + 1}: a webhook URL is required.`); return; }
        config = { url: step.url.trim(), method: step.method };
      } else if (step.type === "email") {
        const recipients = step.to.split(",").map((value) => value.trim()).filter(Boolean);
        if (!recipients.length || !step.subject.trim()) { setError(`Step ${index + 1}: at least one recipient and a subject are required.`); return; }
        if (recipients.length > 10) { setError(`Step ${index + 1}: use at most 10 recipients.`); return; }
        config = { to: recipients, subject: step.subject.trim() };
      } else if (step.type === "log") {
        config = { message: step.logMessage };
      } else {
        setError(`Step ${index + 1} uses unavailable provider "${step.type}". Choose a supported provider or remove the step.`);
        return;
      }
      for (const match of JSON.stringify(config).matchAll(/\{\{steps\.(\d+)\.output\}\}/g)) {
        const referenced = Number(match[1]);
        if (referenced < 1 || referenced > index) {
          setError(`Step ${index + 1} may reference only prior step outputs.`);
          return;
        }
      }
      actions.push({ type: step.type, config });
    }
    setError("");
    void onSave({ name: name.trim(), event, enabled: automation?.enabled ?? true, steps: actions })
      .catch((cause) => setError(message(cause)));
  }
  return (
    <Modal title={title} onClose={onClose}>
      <form onSubmit={submit} className="stack">
        <ErrorNotice error={error} />
        <label>
          Name
          <input aria-label="Automation name" required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          Trigger event
          <select value={event} onChange={(e) => setEvent(e.target.value as WebhookEvent)}>
            {webhookEvents.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <div className="notice">
          <strong>Using earlier results</strong>
          <p>
            In step 2 or later, insert <code>{'{{steps.1.output}}'}</code> in a supported
            text setting. Replace <code>1</code> with the prior step number. For example,
            an HTTP body can be <code>{'{"previous":"{{steps.1.output}}"}'}</code>.
            References to the current or a later step are rejected. HTTP bodies may
            also use <code>{'{{event}}'}</code> for the triggering event JSON.
          </p>
        </div>
        <ol className="stack" aria-label="Automation steps">
          {steps.map((step, index) => {
            const supported = actionTypes.some((provider) => provider.id === step.type);
            return (
              <li key={step.key}>
                <fieldset className="bare-fieldset stack">
                  <legend>Step {index + 1}</legend>
                  <div className="button-group">
                    <button type="button" disabled={index === 0} onClick={() => moveStep(index, -1)} aria-label={`Move step ${index + 1} up`}>Move up</button>
                    <button type="button" disabled={index === steps.length - 1} onClick={() => moveStep(index, 1)} aria-label={`Move step ${index + 1} down`}>Move down</button>
                    <button type="button" className="danger" disabled={steps.length === 1} onClick={() => setSteps((current) => current.filter((item) => item.key !== step.key))} aria-label={`Remove step ${index + 1}`}>Remove</button>
                  </div>
                  <label>
                    Provider
                    <select value={step.type} onChange={(e) => updateStep(step.key, { type: e.target.value, method: "POST" })}>
                      {!supported && <option value={step.type}>{providerLabel(step.type)}</option>}
                      {actionTypes.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
                    </select>
                  </label>
                  {!supported ? (
                    <p className="notice">This saved provider is unavailable. Its draft is retained; select a supported provider or remove this step before saving.</p>
                  ) : step.type === "email" ? (
                    <>
                      <p className="muted">Email requires SMTP configured by the operator. A missing or stale provider is reported as a failed job without discarding this automation draft.</p>
                       <label>Recipients, comma separated<input aria-label={`Step ${index + 1} recipients`} required maxLength={2549} value={step.to} onChange={(e) => updateStep(step.key, { to: e.target.value })} /></label>
                       <label>Subject<input aria-label={`Step ${index + 1} email subject`} required maxLength={200} value={step.subject} onChange={(e) => updateStep(step.key, { subject: e.target.value })} /></label>
                    </>
                  ) : step.type === "log" ? (
                    <label>Log message<textarea aria-label={`Step ${index + 1} log message`} required rows={3} maxLength={2000} placeholder={'Received {{steps.1.output}}'} value={step.logMessage} onChange={(e) => updateStep(step.key, { logMessage: e.target.value })} /></label>
                  ) : (
                    <>
                      <label>
                        {step.type === "webhook" ? "Webhook URL" : "Request URL"}
                        <input aria-label={`Step ${index + 1} ${step.type === "webhook" ? "webhook" : "request"} URL`} required type="url" maxLength={2000} placeholder="https://example.com/automation" value={step.url} onChange={(e) => updateStep(step.key, { url: e.target.value })} />
                      </label>
                      <label>
                        Method
                        <select value={step.method} onChange={(e) => updateStep(step.key, { method: e.target.value })}>
                          {(step.type === "webhook" ? ["POST", "PUT", "PATCH"] : ["GET", "POST", "PUT", "PATCH", "DELETE"]).map((option) => <option key={option} value={option}>{option}</option>)}
                        </select>
                      </label>
                      {step.type === "http" && (
                        <>
                          <label>Headers, one per line<textarea aria-label={`Step ${index + 1} HTTP headers`} rows={3} maxLength={4000} placeholder="X-Source: hopya" value={step.headers} onChange={(e) => updateStep(step.key, { headers: e.target.value })} /></label>
                          <label>Body template<textarea aria-label={`Step ${index + 1} HTTP body template`} rows={4} maxLength={20000} placeholder={'{"event": "{{event}}", "previous": "{{steps.1.output}}"}'} value={step.body} onChange={(e) => updateStep(step.key, { body: e.target.value })} /></label>
                        </>
                      )}
                    </>
                  )}
                </fieldset>
              </li>
            );
          })}
        </ol>
        <button type="button" disabled={steps.length >= 20} onClick={() => setSteps((current) => [...current, stepDraft()])}>Add step</button>
        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" disabled={busy}>
            {automation ? "Save automation" : "Create automation"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export default function Integrations() {
  const { user, error: authError } = useSession();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState("");
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!user) return;
    const controller = new AbortController();
    api<Workspace[]>("/workspaces", "GET", undefined, controller.signal)
      .then((rows) => {
        if (controller.signal.aborted) return;
        let stored: string | null = null;
        try { stored = localStorage.getItem("hopya.workspace"); } catch {}
        setWorkspaces(rows);
        setWorkspaceId((current) => rows.some((row) => row.id === current)
          ? current
          : rows.find((row) => row.id === stored)?.id ?? rows[0]?.id ?? "");
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(message(e));
      });
    return () => controller.abort();
  }, [user, revision]);
  useEffect(() => {
    if (!workspaceId) {
      setDetail(null);
      return;
    }
    const controller = new AbortController();
    setDetail(null);
    api<Detail>(workspacePath(workspaceId), "GET", undefined, controller.signal)
      .then((loaded) => {
        if (!controller.signal.aborted && loaded.workspace.id === workspaceId) setDetail(loaded);
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(message(cause));
      });
    return () => controller.abort();
  }, [workspaceId, revision]);
  function chooseWorkspace(id: string) {
    if (!workspaces.some((workspace) => workspace.id === id)) return;
    setWorkspaceId(id);
    setError("");
    try { localStorage.setItem("hopya.workspace", id); } catch {}
  }
  const canManage = detail?.permissions.includes("workspace:manage");
  return (
    <Shell user={user} active="app" currentPage="Integrations" navigation={{
      workspaces,
      workspaceId,
      detail,
      onWorkspaceChange: chooseWorkspace,
    }}>
      <div className="settings-body">
        <h1>Integrations</h1>
        <p className="muted">
          Webhooks and automations for {detail?.workspace.name || "your workspace"}.
        </p>
        <ErrorNotice error={authError || error} />
        {(authError || error) && (
          <button onClick={() => setRevision((value) => value + 1)}>
            Retry loading
          </button>
        )}
        {!user || (!detail && !error) ? (
          <Loading />
        ) : !detail ? null : !canManage ? (
          <section className="notice">
            <h2>Management permission required</h2>
            <p>
              Webhooks and automations are managed by members with workspace
              management permission.
            </p>
          </section>
        ) : (
          <>
            <Webhooks wid={detail.workspace.id} revision={revision} />
            <Automations detail={detail} revision={revision} />
          </>
        )}
      </div>
    </Shell>
  );
}
