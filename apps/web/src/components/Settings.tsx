import { useEffect, useState, type SubmitEvent } from "react";
import {
  api,
  message,
  workspacePath,
  type Detail,
  type Workspace,
} from "../lib/api";
import { ErrorNotice, Loading, Shell, ThemeToggle, useSession } from "./Shared";
import WorkspaceSettings from "./WorkspaceSettings";
import ProfileForm from "./ProfileForm";

type Token = {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt?: string | null;
  expiresAt?: string | null;
};
export default function Settings() {
  const { user, setUser, error: authError } = useSession();
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [busy, setBusy] = useState(false);
  const [tokens, setTokens] = useState<Token[]>([]);
  const [rawToken, setRawToken] = useState("");
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [wid, setWid] = useState("");
  const [detail, setDetail] = useState<Detail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [revisions, setRevisions] = useState<Record<string, number>>({});
  const revision = revisions[wid] || 0;
  useEffect(() => {
    if (!user) return;
    const controller = new AbortController();
    Promise.all([
      api<Token[]>("/auth/tokens", "GET", undefined, controller.signal),
      api<Workspace[]>("/workspaces", "GET", undefined, controller.signal),
    ])
      .then(([t, w]) => {
        let preferredWorkspace: string | null = null;
        try { preferredWorkspace = localStorage.getItem("hopya.workspace"); } catch {}
        setTokens(t);
        setWorkspaces(w);
        setWid(
          (current) =>
            current ||
            w.find((v) => v.id === preferredWorkspace)
              ?.id ||
            w[0]?.id ||
            "",
        );
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(message(e));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [user?.id]);
  useEffect(() => {
    if (!wid) return;
    const controller = new AbortController();
    setDetail(null);
    setDetailLoading(true);
    api<Detail>(workspacePath(wid), "GET", undefined, controller.signal)
      .then((nextDetail) => {
        if (controller.signal.aborted) return;
        setDetail(nextDetail);
        setWorkspaces((current) =>
          current.map((workspace) =>
            workspace.id === nextDetail.workspace.id
              ? nextDetail.workspace
              : workspace,
          ),
        );
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(message(e));
      })
      .finally(() => {
        if (!controller.signal.aborted) setDetailLoading(false);
      });
    return () => controller.abort();
  }, [wid, revision]);
  async function createToken(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const name = new FormData(form).get("name");
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      const result = await api<{ token: string }>("/auth/tokens", "POST", {
        name,
      });
      setRawToken(result.token);
      form.reset();
      setTokens(await api<Token[]>("/auth/tokens"));
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  async function revoke(token: Token) {
    if (
      !window.confirm(
        `Revoke "${token.name}"? Apps using it will lose access immediately.`,
      )
    )
      return;
    setBusy(true);
    setError("");
    try {
      await api(`/auth/tokens/${token.id}`, "DELETE");
      setTokens((current) => current.filter((t) => t.id !== token.id));
      setSuccess("Token revoked.");
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  function chooseWorkspace(id: string) {
    if (!workspaces.some((workspace) => workspace.id === id)) return;
    setWid(id);
    setDetail(null);
    setDetailLoading(true);
    setError("");
    try { localStorage.setItem("hopya.workspace", id); } catch {}
  }
  function workspaceDeleted(id: string) {
    const remaining = workspaces.filter((workspace) => workspace.id !== id);
    const next = remaining[0]?.id || "";
    setWorkspaces(remaining);
    setWid(next);
    setDetail(null);
    setDetailLoading(Boolean(next));
    setSuccess("Workspace deleted permanently.");
    try {
      if (next) localStorage.setItem("hopya.workspace", next);
      else localStorage.removeItem("hopya.workspace");
    } catch {}
  }
  return (
    <Shell user={user} active="settings" currentPage="Settings" navigation={{
      workspaces,
      workspaceId: wid,
      detail,
      onWorkspaceChange: chooseWorkspace,
    }}>
      <div className="settings-body">
        <h1>Settings</h1>
        <p className="muted">
          Appearance, your profile, tokens, and workspace administration tools.
        </p>
        <section className="settings-section" aria-labelledby="appearance-heading">
          <div className="section-intro">
            <h2 id="appearance-heading">Appearance</h2>
            <p>Choose light or dark mode, or follow your device settings.</p>
          </div>
          <ThemeToggle />
        </section>
        <ErrorNotice error={authError || error} />
        {(authError || error) && (
          <button onClick={() => window.location.reload()}>
            Reload settings
          </button>
        )}
        {success && (
          <p className="notice success" role="status">
            {success}
          </p>
        )}
        {authError ? null : !user || loading ? (
          <Loading />
        ) : (
          <>
            <ProfileForm user={user} setUser={setUser} onCredentialsChanged={() => {
              setRawToken("");
              setTokens([]);
            }} />
            <section className="settings-section">
              <div className="section-intro">
                <h2>Personal access tokens</h2>
                <p>
                  Connect scripts and MCP clients. Tokens act as you and respect
                  your workspace permissions.
                </p>
              </div>
              <div className="stack">
                {rawToken && (
                  <div className="notice token-reveal">
                    <strong>
                      Copy this token now. It will not be shown again.
                    </strong>
                    <label>
                      New access token
                      <input
                        readOnly
                        type="text"
                        value={rawToken}
                        onFocus={(e) => e.target.select()}
                        autoComplete="off"
                        spellCheck={false}
                      />
                    </label>
                    <button onClick={() => setRawToken("")}>
                      I saved it. Hide token.
                    </button>
                  </div>
                )}
                <form className="inline-form" onSubmit={createToken}>
                  <label>
                    Token name
                    <input
                      name="name"
                      required
                      maxLength={120}
                      placeholder="e.g. Local MCP client"
                    />
                  </label>
                  <button disabled={busy || !!rawToken}>Create token</button>
                </form>
                {tokens.length === 0 ? (
                  <p className="muted">
                    No active tokens. Only create one when you need programmatic
                    access.
                  </p>
                ) : (
                  <ul className="record-list">
                    {tokens.map((t) => (
                      <li key={t.id}>
                        <div>
                          <strong>{t.name}</strong>
                          <small>
                            Created {new Date(t.createdAt).toLocaleDateString()}
                            {t.lastUsedAt &&
                              ` · Last used ${new Date(t.lastUsedAt).toLocaleDateString()}`}
                            {t.expiresAt &&
                              ` · Expires ${new Date(t.expiresAt).toLocaleDateString()}`}
                          </small>
                        </div>
                        <button
                          className="danger"
                          disabled={busy}
                          onClick={() => void revoke(t)}
                        >
                          Revoke
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </section>
            <section className="settings-section">
              <div className="section-intro">
                <h2>Workspace</h2>
                <p>
                  Manage the workspace selected in the sidebar. Permission
                  changes are enforced by the server.
                </p>
              </div>
              <div className="stack">
                {!workspaces.length && (
                  <a href="/app">Create a workspace to get started.</a>
                )}
                {detailLoading && <Loading />}
                {detail && (
                  <>
                    <div>
                      <strong>{detail.workspace.name}</strong>
                      <p className="muted">Your role: {detail.role.name}</p>
                    </div>
                    {detail.permissions.includes("items:read") && (
                      <div>
                        <a
                          href={`/api/v1${workspacePath(detail.workspace.id)}/export`}
                          download={`hopya-${detail.workspace.id}.json`}
                        >
                          Download workspace JSON
                        </a>
                      </div>
                    )}
                  </>
                )}
              </div>
            </section>
            {detail && (
              <WorkspaceSettings
                key={detail.workspace.id}
                detail={detail}
                onSaved={(workspaceId, workspace) => {
                  if (workspace)
                    setWorkspaces((current) =>
                      current.map((w) =>
                        w.id === workspace.id ? workspace : w,
                      ),
                    );
                  setRevisions((current) => ({
                    ...current,
                    [workspaceId]: (current[workspaceId] || 0) + 1,
                  }));
                }}
                onDeleted={workspaceDeleted}
              />
            )}
          </>
        )}
      </div>
    </Shell>
  );
}
