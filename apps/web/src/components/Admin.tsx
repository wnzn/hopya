import { useEffect, useState, type SubmitEvent } from "react";
import { api, message, type User } from "../lib/api";
import { Empty, ErrorNotice, Loading, Shell, useSession } from "./Shared";
import OidcIdentities from "./OidcIdentities";
import SiteSettingsSection from "./SiteSettings";
import "../styles/admin.css";

type Audit = {
  id: string;
  actorId: string | null;
  workspaceId: string | null;
  action: string;
  resourceId: string | null;
  createdAt: string;
  details?: Record<string, unknown>;
};
export default function Admin() {
  const { user, error: authError } = useSession();
  const [users, setUsers] = useState<User[]>([]);
  const [auditResult, setAuditResult] = useState<{
    key: string;
    rows: Audit[];
    error: string;
  } | null>(null);
  const [status, setStatus] = useState<Record<string, unknown> | null>(null);
  const [offset, setOffset] = useState(0);
  const [workspaceFilter, setWorkspaceFilter] = useState("");
  const [filterInput, setFilterInput] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [loading, setLoading] = useState(true);
  const [auditRevision, setAuditRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const limit = 25;
  const auditQuery = new URLSearchParams({
    limit: String(limit),
    offset: String(offset),
    ...(workspaceFilter ? { workspaceId: workspaceFilter } : {}),
  }).toString();
  const auditKey = JSON.stringify([
    user?.id,
    auditQuery,
    revision,
    auditRevision,
  ]);
  const currentAudit = auditResult?.key === auditKey ? auditResult : null;
  const auditLoading = !currentAudit;
  const audit = currentAudit?.rows || [];
  const auditError = currentAudit?.error || "";
  useEffect(() => {
    if (!user?.isAdmin) return;
    const controller = new AbortController();
    setLoading(true);
    setError("");
    Promise.all([
      api<User[]>("/admin/users", "GET", undefined, controller.signal),
      api<Record<string, unknown>>(
        "/admin/status",
        "GET",
        undefined,
        controller.signal,
      ),
    ])
      .then(([u, s]) => {
        setUsers(u);
        setStatus(s);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(message(e));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [user?.id, revision]);
  useEffect(() => {
    if (!user?.isAdmin) return;
    const controller = new AbortController();
    setAuditResult(null);
    api<Audit[]>(
      `/admin/audit?${auditQuery}`,
      "GET",
      undefined,
      controller.signal,
    )
      .then((rows) => {
        if (!controller.signal.aborted)
          setAuditResult({ key: auditKey, rows, error: "" });
      })
      .catch((e) => {
        if (!controller.signal.aborted)
          setAuditResult({ key: auditKey, rows: [], error: message(e) });
      });
    return () => controller.abort();
  }, [user?.isAdmin, auditQuery, auditKey]);
  async function create(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      await api("/admin/users", "POST", {
        name: data.get("name"),
        email: data.get("email"),
        password: data.get("password"),
        isAdmin: data.get("isAdmin") === "on",
      });
      form.reset();
      setSuccess(
        "Account created. Share the initial password through a secure channel and ask the user to change it.",
      );
      setRevision((r) => r + 1);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  async function update(
    target: User,
    body: { isAdmin?: boolean; disabled?: boolean },
  ) {
    const action =
      body.disabled !== undefined
        ? body.disabled
          ? "Disable"
          : "Enable"
        : body.isAdmin
          ? "Grant administrator access to"
          : "Remove administrator access from";
    if (!window.confirm(`${action} ${target.name}?`)) return;
    setBusy(true);
    setError("");
    try {
      await api(`/admin/users/${target.id}`, "PATCH", body);
      setRevision((r) => r + 1);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Shell user={user} active="admin">
      <header className="page-top">
        <div className="breadcrumb">
          Instance <span>/</span> Administration
        </div>
        <a href="/app" className="quiet-link">
          Back to workspace ↗
        </a>
      </header>
      <div className="settings-body admin-body">
        <h1>Administration</h1>
        <p className="muted">
          Look after your instance, not your team's private work.
        </p>
        <ErrorNotice error={authError || error} />
        {success && (
          <p className="notice success" role="status">
            {success}
          </p>
        )}
        {authError ? (
          <button onClick={() => window.location.reload()}>
            Retry sign-in check
          </button>
        ) : !user ? (
          <Loading />
        ) : !user.isAdmin ? (
          <Empty title="Administrator access required">
            This page is only available to site administrators. Your workspace
            access has not changed.
          </Empty>
        ) : (
          <>
            {loading ? (
              <Loading />
            ) : (
              <>
                <section className="admin-status">
                  <div className="section-heading">
                    <h2>Instance status</h2>
                    <button
                      disabled={busy}
                      onClick={() => setRevision((r) => r + 1)}
                    >
                      Refresh
                    </button>
                  </div>
                  {status && (
                    <dl className="status-grid">
                      {Object.entries(status).map(([key, value]) => {
                        const label = key.replace(/([A-Z])/g, " $1");
                        const hasDetails =
                          typeof value === "object" && value !== null;
                        return (
                          <div
                            key={key}
                            className={
                              hasDetails ? "status-detail-card" : undefined
                            }
                          >
                            <dt>{label}</dt>
                            <dd>
                              {hasDetails ? (
                                <pre
                                  className="admin-status-details"
                                  role="region"
                                  aria-label={`${label} details`}
                                  tabIndex={0}
                                >
                                  <code>{JSON.stringify(value, null, 2)}</code>
                                </pre>
                              ) : typeof value === "boolean" ? (
                                value ? (
                                  "Enabled"
                                ) : (
                                  "Disabled"
                                )
                              ) : (
                                String(value ?? "Not configured")
                              )}
                            </dd>
                          </div>
                        );
                      })}
                    </dl>
                  )}
                </section>
                <SiteSettingsSection />
                <section className="settings-section">
                  <div className="section-intro">
                    <h2>Create an account</h2>
                    <p>
                      No default accounts or public passwords. Send credentials
                      privately.
                    </p>
                  </div>
                  <form className="stack" onSubmit={create}>
                    <div className="form-grid">
                      <label>
                        Name
                        <input
                          name="name"
                          required
                          maxLength={120}
                          autoComplete="off"
                        />
                      </label>
                      <label>
                        Email
                        <input
                          name="email"
                          type="email"
                          required
                          maxLength={254}
                          autoComplete="off"
                        />
                      </label>
                    </div>
                    <label>
                      Initial password
                      <input
                        name="password"
                        type="password"
                        minLength={12}
                        maxLength={256}
                        required
                        autoComplete="new-password"
                      />
                    </label>
                    <label className="checkbox-label">
                      <input name="isAdmin" type="checkbox" />
                      Site administrator
                    </label>
                    <div>
                      <button className="primary" disabled={busy}>
                        {busy ? "Creating..." : "Create account"}
                      </button>
                    </div>
                  </form>
                </section>
                <section>
                  <h2>
                    Accounts <span className="count">{users.length}</span>
                  </h2>
                  <div
                    className="table-scroll"
                    role="region"
                    aria-label="Accounts table"
                    tabIndex={0}
                  >
                    <table>
                      <thead>
                        <tr>
                          <th>Name</th>
                          <th>Email</th>
                          <th>Access</th>
                          <th>Status</th>
                          <th>Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {users.map((account) => (
                          <tr key={account.id}>
                            <th scope="row">
                              {account.name}
                              {account.id === user.id && <small> (you)</small>}
                            </th>
                            <td>{account.email}</td>
                            <td>
                              {account.isAdmin ? "Site administrator" : "User"}
                            </td>
                            <td>{account.disabled ? "Disabled" : "Active"}</td>
                            <td>
                              <div className="button-group">
                                <button
                                  disabled={busy || account.id === user.id}
                                  onClick={() =>
                                    void update(account, {
                                      isAdmin: !account.isAdmin,
                                    })
                                  }
                                >
                                  {account.isAdmin
                                    ? "Remove admin"
                                    : "Make admin"}
                                </button>
                                <button
                                  className={account.disabled ? "" : "danger"}
                                  disabled={busy || account.id === user.id}
                                  onClick={() =>
                                    void update(account, {
                                      disabled: !account.disabled,
                                    })
                                  }
                                >
                                  {account.disabled ? "Enable" : "Disable"}
                                </button>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              </>
            )}
            {!loading && (
              <OidcIdentities users={users} currentUserId={user.id} />
            )}
            <section className="audit-section">
              <div className="section-heading">
                <div>
                  <h2>Audit trail</h2>
                  <p className="muted">
                    A record of changes, without secrets or full AI prompts.
                  </p>
                </div>
                <form
                  className="inline-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    setOffset(0);
                    setWorkspaceFilter(filterInput.trim());
                  }}
                >
                  <label>
                    Workspace ID (optional)
                    <input
                      value={filterInput}
                      onChange={(e) => setFilterInput(e.target.value)}
                      maxLength={100}
                      placeholder="All workspaces"
                    />
                  </label>
                  <button>Filter</button>
                </form>
              </div>
              {auditLoading ? (
                <Loading />
              ) : auditError ? (
                <>
                  <ErrorNotice error={auditError} />
                  <button onClick={() => setAuditRevision((r) => r + 1)}>
                    Retry audit
                  </button>
                </>
              ) : audit.length === 0 ? (
                <p className="notice">No audit entries on this page.</p>
              ) : (
                <div
                  className="table-scroll"
                  role="region"
                  aria-label="Audit trail table"
                  tabIndex={0}
                >
                  <table>
                    <thead>
                      <tr>
                        <th>Time</th>
                        <th>Action</th>
                        <th>Actor</th>
                        <th>Workspace</th>
                        <th>Resource</th>
                        <th>Details</th>
                      </tr>
                    </thead>
                    <tbody>
                      {audit.map((entry) => (
                        <tr key={entry.id}>
                          <td>
                            <time dateTime={entry.createdAt}>
                              {new Date(entry.createdAt).toLocaleString()}
                            </time>
                          </td>
                          <th scope="row">{entry.action}</th>
                          <td>
                            {users.find((u) => u.id === entry.actorId)?.email ||
                              entry.actorId ||
                              "System"}
                          </td>
                          <td>
                            <code>{entry.workspaceId || "Instance"}</code>
                          </td>
                          <td>
                            <code>{entry.resourceId || "—"}</code>
                          </td>
                          <td>
                            {entry.details &&
                            Object.keys(entry.details).length ? (
                              <details>
                                <summary>View details</summary>
                                <pre>
                                  {JSON.stringify(entry.details, null, 2)}
                                </pre>
                              </details>
                            ) : (
                              "—"
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <div className="pagination">
                <span>Page {Math.floor(offset / limit) + 1}</span>
                <button
                  disabled={auditLoading || offset === 0}
                  onClick={() => setOffset((o) => Math.max(0, o - limit))}
                >
                  Previous
                </button>
                <button
                  disabled={auditLoading || audit.length < limit}
                  onClick={() => setOffset((o) => o + limit)}
                >
                  Next
                </button>
              </div>
            </section>
          </>
        )}
      </div>
    </Shell>
  );
}
