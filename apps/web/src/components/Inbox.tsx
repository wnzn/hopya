import { useEffect, useState } from "react";
import { api, message, workspacePath, type Detail, type Notification, type Workspace } from "../lib/api";
import { ErrorNotice, Loading, Shell, useSession, type NavigationState } from "./Shared";

export default function Inbox() {
  const { user, error: authError } = useSession();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState("");
  const [detail, setDetail] = useState<Detail | null>(null);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  useEffect(() => {
    if (!user) return;
    const controller = new AbortController();
    api<Workspace[]>("/workspaces", "GET", undefined, controller.signal).then(rows => {
      if (controller.signal.aborted) return;
      const requested = new URLSearchParams(location.search).get("workspace");
      let stored: string | null = null;
      try { stored = localStorage.getItem("hopya.workspace"); } catch {}
      const selected = rows.find(row => row.id === requested)?.id ?? rows.find(row => row.id === stored)?.id ?? rows[0]?.id ?? "";
      setWorkspaces(rows); setWorkspaceId(selected);
    }).catch(cause => { if (!controller.signal.aborted) { setError(message(cause)); setLoading(false); } });
    return () => controller.abort();
  }, [user]);
  useEffect(() => {
    if (!workspaceId) { setDetail(null); setNotifications([]); setLoading(false); return; }
    const controller = new AbortController();
    setLoading(true); setError("");
    Promise.all([
      api<Detail>(workspacePath(workspaceId), "GET", undefined, controller.signal),
      api<Notification[]>(`${workspacePath(workspaceId)}/notifications`, "GET", undefined, controller.signal),
    ]).then(([nextDetail, rows]) => {
      if (controller.signal.aborted || nextDetail.workspace.id !== workspaceId) return;
      setDetail(nextDetail); setNotifications(rows); setLoading(false);
    }).catch(cause => { if (!controller.signal.aborted) { setError(message(cause)); setLoading(false); } });
    return () => controller.abort();
  }, [workspaceId]);
  function selectWorkspace(id: string) {
    if (!workspaces.some(workspace => workspace.id === id)) return;
    setWorkspaceId(id); setDetail(null); setNotifications([]);
    try { localStorage.setItem("hopya.workspace", id); } catch {}
    history.replaceState(null, "", `/inbox?workspace=${encodeURIComponent(id)}`);
  }
  async function toggle(row: Notification) {
    setBusy(row.id); setError("");
    try {
      const result = await api<{ id: string; readAt: string | null }>(`${workspacePath(workspaceId)}/notifications/${row.id}`, "PATCH", { read: !row.readAt });
      setNotifications(current => current.map(entry => entry.id === row.id ? { ...entry, readAt: result.readAt } : entry));
      window.dispatchEvent(new Event("hopya-notifications-changed"));
    } catch (cause) { setError(message(cause)); }
    finally { setBusy(""); }
  }
  async function remove(row: Notification) {
    setBusy(row.id); setError("");
    try {
      await api(`${workspacePath(workspaceId)}/notifications/${row.id}`, "DELETE");
      setNotifications(current => current.filter(entry => entry.id !== row.id));
      window.dispatchEvent(new Event("hopya-notifications-changed"));
    } catch (cause) { setError(message(cause)); }
    finally { setBusy(""); }
  }
  const navigation: NavigationState = { workspaces, workspaceId, detail, onWorkspaceChange: selectWorkspace };
  return <Shell user={user} active="app" currentPage="Inbox" navigation={navigation}>
    <div className="settings-body inbox-body">
      <h1>Inbox</h1>
      <p className="muted">Task assignments and mentions in this workspace.</p>
      <ErrorNotice error={authError || error} />
      {!user || loading ? <Loading /> : notifications.length === 0 ? <div className="empty"><h2>You&apos;re all caught up</h2><p>No notifications in this workspace.</p></div> : (
        <ol className="inbox-list" aria-label="Notifications">
          {notifications.map(row => <li key={row.id} className={row.readAt ? "" : "unread"}>
            <a href={`/app?workspace=${encodeURIComponent(workspaceId)}&task=${encodeURIComponent(row.itemId)}${row.commentId ? `&comment=${encodeURIComponent(row.commentId)}` : ""}`}>
              <span className="inbox-kind">{row.type === "assignment" ? "ASSIGNED" : "MENTIONED"}</span>
              <strong>{row.type === "assignment" ? `${row.actorName} assigned you` : `${row.actorName} mentioned you`}</strong>
              <span>{row.itemTitle}</span>
              <time dateTime={row.createdAt}>{new Date(row.createdAt).toLocaleString()}</time>
            </a>
            <div className="button-group">
              <button type="button" disabled={busy === row.id} onClick={() => void toggle(row)}>{row.readAt ? "Mark unread" : "Mark read"}</button>
              <button type="button" disabled={busy === row.id} onClick={() => void remove(row)}>Delete</button>
            </div>
          </li>)}
        </ol>
      )}
    </div>
  </Shell>;
}
