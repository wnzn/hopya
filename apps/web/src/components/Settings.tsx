import { useEffect, useState } from "react";
import {
  api,
  message,
  workspacePath,
  type Detail,
  type Workspace,
} from "../lib/api";
import { ErrorNotice, Loading, Shell, useSession } from "./Shared";
import WorkspaceSettings from "./WorkspaceSettings";

export default function Settings() {
  const { user, error: authError } = useSession();
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
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
    api<Workspace[]>("/workspaces", "GET", undefined, controller.signal)
      .then((w) => {
        if (controller.signal.aborted) return;
        let preferredWorkspace: string | null = null;
        try { preferredWorkspace = localStorage.getItem("hopya.workspace"); } catch {}
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
  function chooseWorkspace(id: string) {
    if (id === wid || !workspaces.some((workspace) => workspace.id === id)) return;
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
    <Shell user={user} active="settings" currentPage="Workspace settings" navigation={{
      workspaces,
      workspaceId: wid,
      detail,
      onWorkspaceChange: chooseWorkspace,
    }}>
      <div className="settings-body">
        <h1>Workspace settings</h1>
        <p className="muted">
          Manage the selected workspace, its members, roles and custom fields.
        </p>
        <ErrorNotice error={authError || error} />
        {(authError || error) && (
          <button onClick={() => window.location.reload()}>
            Reload workspace settings
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
