import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import {
  api,
  ApiError,
  message,
  workspacePath,
  type Detail,
  type TreeNode,
  type User,
  type Workspace,
} from "../lib/api";
import "../styles/shared-navigation.css";
import { safeAncestorPath } from "../lib/shared-navigation";
import NodeGlyph from "./NodeGlyph";
export { safeAncestorPath } from "../lib/shared-navigation";

export type NavigationState = {
  workspaces: Workspace[];
  workspaceId: string;
  detail: Detail | null;
  selectedNodeId?: string;
  itemCount?: number;
  loading?: boolean;
  onWorkspaceChange?: (id: string) => void;
  onNodeSelect?: (id: string) => void;
  onCreateWorkspace?: () => void;
  onCreateNode?: () => void;
  onEditNode?: (node: TreeNode) => void;
};

function appHref(workspaceId: string, nodeId = "") {
  const query = new URLSearchParams({ workspace: workspaceId });
  if (nodeId) query.set("node", nodeId);
  return `/app?${query}`;
}

function NavigationTree({ state, collapsed, onToggle, parentId = null, depth = 0, ancestors = new Set<string>() }: {
  state: NavigationState;
  collapsed: Set<string>;
  onToggle: (id: string) => void;
  parentId?: string | null;
  depth?: number;
  ancestors?: Set<string>;
}) {
  if (depth >= 32 || !state.detail) return null;
  const children = state.detail.nodes.filter((node) => node.parentId === parentId && !ancestors.has(node.id));
  if (!children.length) return null;
  return (
    <ul className="tree">
      {children.map((node) => {
        const nextAncestors = new Set(ancestors).add(node.id);
        const hasChildren = state.detail!.nodes.some(candidate => candidate.parentId === node.id && !nextAncestors.has(candidate.id));
        const containsSelection = state.selectedNodeId ? safeAncestorPath(state.detail!.nodes, state.selectedNodeId).some(candidate => candidate.id === node.id) : false;
        const isCollapsed = hasChildren && collapsed.has(node.id) && !containsSelection;
        return (
          <li key={node.id}>
            <div className="tree-row">
              {hasChildren ? <button type="button" className="tree-toggle" aria-label={`${isCollapsed ? "Expand" : "Collapse"} ${node.name}`} aria-expanded={!isCollapsed} onClick={() => onToggle(node.id)}>
                <svg className={isCollapsed ? "" : "tree-toggle-expanded"} aria-hidden="true" viewBox="0 0 20 20">
                  <path d="m7.5 4.5 5.5 5.5-5.5 5.5" />
                </svg>
              </button> : <span className="tree-toggle-spacer" aria-hidden="true" />}
              <a
                className={state.selectedNodeId === node.id ? "selected" : ""}
                href={appHref(state.workspaceId, node.id)}
                title={`${node.kind}: ${node.name}`}
                onClick={state.onNodeSelect ? (event) => {
                  event.preventDefault();
                  state.onNodeSelect?.(node.id);
                } : undefined}
              >
                <NodeGlyph node={node} />
                <span>{node.name}</span>
              </a>
              {state.onEditNode && (
                <button type="button" className="tree-edit" aria-label={`Manage ${node.name}`} onClick={() => state.onEditNode?.(node)}>···</button>
              )}
            </div>
            {!isCollapsed && <NavigationTree state={state} collapsed={collapsed} onToggle={onToggle} parentId={node.id} depth={depth + 1} ancestors={nextAncestors} />}
          </li>
        );
      })}
    </ul>
  );
}

function WorkspaceNavigation({ state, inboxActive = false }: { state: NavigationState; inboxActive?: boolean }) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [unread, setUnread] = useState(0);
  useEffect(() => {
    try {
      const value = JSON.parse(localStorage.getItem(`hopya.navigation.collapsed.${state.workspaceId}`) || "[]");
      setCollapsed(new Set(Array.isArray(value) ? value.filter(id => typeof id === "string") : []));
    } catch { setCollapsed(new Set()); }
  }, [state.workspaceId]);
  useEffect(() => {
    if (!state.workspaceId) { setUnread(0); return; }
    const controller = new AbortController();
    const load = () => api<{ unread: number }>(`${workspacePath(state.workspaceId)}/notifications/unread-count`, "GET", undefined, controller.signal)
      .then(result => { if (!controller.signal.aborted) setUnread(result.unread); })
      .catch(() => { if (!controller.signal.aborted) setUnread(0); });
    void load();
    const refresh = () => void load();
    window.addEventListener("hopya-notifications-changed", refresh);
    return () => { controller.abort(); window.removeEventListener("hopya-notifications-changed", refresh); };
  }, [state.workspaceId]);
  function toggleNode(id: string) {
    setCollapsed(current => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      try { localStorage.setItem(`hopya.navigation.collapsed.${state.workspaceId}`, JSON.stringify([...next])); } catch { /* Storage is optional. */ }
      return next;
    });
  }
  const canSeeTree = state.detail && (state.detail.permissions.includes("items:read") || state.detail.permissions.includes("structure:write"));
  return (
    <div className="shared-navigation">
      <div className="workspace-picker">
        <label htmlFor="workspace-select">WORKSPACE</label>
        <select id="workspace-select" value={state.workspaceId} onChange={(event) => state.onWorkspaceChange?.(event.target.value)} disabled={!state.onWorkspaceChange}>
          {!state.workspaces.length && <option value="">No workspaces</option>}
          {state.workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}
        </select>
        {state.onCreateWorkspace && <button type="button" onClick={state.onCreateWorkspace}>+ New workspace</button>}
      </div>
      {state.workspaceId && <a className="inbox-link" aria-current={inboxActive ? "page" : undefined}
        aria-label={unread ? `Inbox, ${unread} unread` : "Inbox"}
        href={`/inbox?workspace=${encodeURIComponent(state.workspaceId)}`}>
        <span>Inbox</span>{unread > 0 && <strong>{unread > 99 ? "99+" : unread}</strong>}
      </a>}
      {canSeeTree && (
        <nav className="sidebar-structure" aria-label="Workspace hierarchy">
          <div className="sidebar-section-title">
            STRUCTURE
            {state.onCreateNode && <button type="button" aria-label="Add project, folder, or list" onClick={state.onCreateNode}>+</button>}
          </div>
          <a
            className={`all-tasks ${state.onNodeSelect && !state.selectedNodeId ? "selected" : ""}`}
            href={appHref(state.workspaceId)}
            onClick={state.onNodeSelect ? (event) => {
              event.preventDefault();
              state.onNodeSelect?.("");
            } : undefined}
          >
            All tasks {state.itemCount !== undefined && <span>{state.loading ? "..." : state.itemCount}</span>}
          </a>
          <NavigationTree state={state} collapsed={collapsed} onToggle={toggleNode} />
          {state.detail && !state.detail.nodes.length && state.onCreateNode && <p className="sidebar-hint">Start with a project.</p>}
        </nav>
      )}
    </div>
  );
}

export function Breadcrumbs({ detail, nodeId, currentPage }: { detail: Detail | null; nodeId?: string; currentPage?: string }) {
  const path = detail && nodeId ? safeAncestorPath(detail.nodes, nodeId) : [];
  const workspace = detail?.workspace;
  const crumbs: { label: string; href?: string }[] = workspace
    ? [{ label: workspace.name, href: appHref(workspace.id) }]
    : [{ label: "Workspace", href: "/app" }];
  for (const node of path) crumbs.push({ label: node.name, href: appHref(workspace!.id, node.id) });
  if (currentPage) crumbs.push({ label: currentPage });
  else delete crumbs[crumbs.length - 1].href;
  return (
    <nav className="breadcrumb" aria-label="Breadcrumb">
      <ol>
        {crumbs.map((crumb, index) => (
          <li key={`${crumb.label}:${index}`}>
            {crumb.href ? <a href={crumb.href}>{crumb.label}</a> : <span aria-current="page">{crumb.label}</span>}
          </li>
        ))}
      </ol>
    </nav>
  );
}

export function ThemeToggle() {
  const [dark, setDark] = useState(false);
  const [system, setSystem] = useState(true);
  useEffect(() => {
    const sync = () => {
      setDark(document.documentElement.style.colorScheme === "dark");
      setSystem(!document.documentElement.dataset.theme);
    };
    sync();
    window.addEventListener("hopya-theme-change", sync);
    return () => window.removeEventListener("hopya-theme-change", sync);
  }, []);
  function choose(value: "light" | "dark" | null) {
    window.dispatchEvent(
      new CustomEvent("hopya-theme-preference", { detail: value }),
    );
  }
  return (
    <div className="stack">
      <div className="theme-controls">
        <button
          type="button"
          className="theme-toggle"
          aria-pressed={dark}
          aria-label="Toggle dark mode"
          onClick={() => choose(dark ? "light" : "dark")}
        >
          {dark ? "Light mode" : "Dark mode"}
        </button>
        <button type="button" aria-pressed={system} onClick={() => choose(null)}>
          Use system theme
        </button>
      </div>
      <p className="muted" role="status">
        {system ? "Following your device appearance." : "Using your chosen appearance on this browser."}
      </p>
    </div>
  );
}

export function ErrorNotice({ error }: { error: string }) {
  return error ? (
    <p className="notice error" role="alert">
      {error}
    </p>
  ) : null;
}
export function Loading() {
  return (
    <div className="loading" role="status">
      <span className="spinner" /> Loading your space...
    </div>
  );
}
export function Empty({
  title,
  children,
  action,
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-mark" aria-hidden="true">
        +
      </div>
      <h2>{title}</h2>
      <p>{children}</p>
      {action}
    </div>
  );
}
export function useDialog(
  ref: RefObject<HTMLElement | null>,
  modal = true,
  focusFirstField = true,
) {
  useEffect(() => {
    if (!ref.current) return;
    const dialog = ref.current;
    const previous = document.activeElement as HTMLElement | null;
    if (modal && dialog instanceof HTMLDialogElement) dialog.showModal();
    // React autofocus runs while the dialog is hidden. Without a real input,
    // focus the dialog itself so nothing deep inside scrolls it away from
    // its heading on open.
    const first = focusFirstField
      ? dialog.querySelector<HTMLElement>(
          "input:not(:disabled), select:not(:disabled), textarea:not(:disabled)",
        )
      : null;
    if (first) first.focus();
    else if (dialog instanceof HTMLDialogElement) {
      dialog.tabIndex = -1;
      dialog.scrollTop = 0;
      dialog.focus({ preventScroll: true });
    }
    return () => {
      if (dialog instanceof HTMLDialogElement) dialog.close();
      if (previous?.isConnected) previous.focus();
    };
  }, [ref, modal, focusFirstField]);
}
export function Modal({
  title,
  heading,
  headerActions,
  children,
  onClose,
  focusFirstField = true,
  className,
}: {
  title: string;
  heading?: ReactNode;
  headerActions?: ReactNode;
  children: ReactNode;
  onClose: () => void;
  focusFirstField?: boolean;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useDialog(ref, true, focusFirstField);
  return (
    <dialog
      ref={ref}
      className={`modal${className ? ` ${className}` : ""}`}
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target !== e.currentTarget) return;
        const bounds = e.currentTarget.getBoundingClientRect();
        if (
          e.clientX < bounds.left ||
          e.clientX > bounds.right ||
          e.clientY < bounds.top ||
          e.clientY > bounds.bottom
        )
          onClose();
      }}
    >
      <div className="modal-head">
        <div className="modal-heading">{heading ?? <h2>{title}</h2>}</div>
        <div className="modal-head-actions">
          {headerActions}
          <button
            type="button"
            className="icon-button"
            onClick={onClose}
            aria-label="Close dialog"
          >
            ×
          </button>
        </div>
      </div>
      {children}
    </dialog>
  );
}
export function useSession() {
  const [user, setUser] = useState<User | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    api<User>("/auth/me", "GET", undefined, controller.signal)
      .then(setUser)
      .catch((e) => {
        if (controller.signal.aborted) return;
        if (e instanceof ApiError && e.status === 401)
          window.location.assign("/login");
        else setError(message(e));
      });
    return () => controller.abort();
  }, []);
  return { user, setUser, error };
}
export function Brand({ className }: { className?: string }) {
  const [logo, setLogo] = useState<string | null>(() => {
    try {
      return sessionStorage.getItem("hopya-logo");
    } catch {
      return null;
    }
  });
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/v1/config", { signal: controller.signal })
      .then((response) => (response.ok ? response.json() : null))
      .then((config: { logo?: string } | null) => {
        const url = config?.logo ?? null;
        if (url) sessionStorage.setItem("hopya-logo", url);
        else sessionStorage.removeItem("hopya-logo");
        setLogo(url);
      })
      .catch(() => {});
    return () => controller.abort();
  }, []);
  if (!logo)
    return (
      <a className={className} href="/app">
        hopya<span>.</span>
      </a>
    );
  return (
    <a className={`${className} brand-logo`} href="/app">
      <img src={logo} alt="Go to your workspace" />
    </a>
  );
}

export function Shell({
  user,
  active,
  children,
  sidebar,
  navigation,
  currentPage,
}: {
  user: User | null;
  active: "app" | "account" | "settings" | "admin";
  children: ReactNode;
  sidebar?: ReactNode;
  navigation?: NavigationState;
  currentPage?: string;
}) {
  const [open, setOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const accountMenu = useRef<HTMLDetailsElement>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [fallbackWorkspaces, setFallbackWorkspaces] = useState<Workspace[]>([]);
  const [fallbackWorkspaceId, setFallbackWorkspaceId] = useState("");
  const [fallbackDetail, setFallbackDetail] = useState<Detail | null>(null);
  useEffect(() => {
    if (!user || navigation) return;
    const controller = new AbortController();
    api<Workspace[]>("/workspaces", "GET", undefined, controller.signal)
      .then((rows) => {
        if (controller.signal.aborted) return;
        let stored: string | null = null;
        try { stored = localStorage.getItem("hopya.workspace"); } catch {}
        setFallbackWorkspaces(rows);
        setFallbackWorkspaceId(rows.find((row) => row.id === stored)?.id ?? rows[0]?.id ?? "");
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(message(cause));
      });
    return () => controller.abort();
  }, [user, navigation]);
  useEffect(() => {
    if (navigation || !fallbackWorkspaceId) {
      if (!fallbackWorkspaceId) setFallbackDetail(null);
      return;
    }
    const controller = new AbortController();
    setFallbackDetail(null);
    api<Detail>(workspacePath(fallbackWorkspaceId), "GET", undefined, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted && value.workspace.id === fallbackWorkspaceId) setFallbackDetail(value);
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(message(cause));
      });
    return () => controller.abort();
  }, [fallbackWorkspaceId, navigation]);
  const fallbackNavigation: NavigationState = {
    workspaces: fallbackWorkspaces,
    workspaceId: fallbackWorkspaceId,
    detail: fallbackDetail,
    onWorkspaceChange: (id) => {
      if (!fallbackWorkspaces.some((workspace) => workspace.id === id)) return;
      setFallbackWorkspaceId(id);
      try { localStorage.setItem("hopya.workspace", id); } catch {}
    },
  };
  const sharedNavigation = navigation ?? fallbackNavigation;
  const pageLabel = currentPage ?? (active === "admin" ? "Administration" : undefined);
  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      if (accountMenu.current && !accountMenu.current.contains(event.target as Node))
        accountMenu.current.open = false;
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, []);
  async function logout() {
    setBusy(true);
    try {
      await api("/auth/logout", "POST");
      window.location.assign("/login");
    } catch (e) {
      setError(message(e));
      setBusy(false);
    }
  }
  return (
    <div className={`shell${pageLabel ? " shell-has-shared-breadcrumbs" : ""}`}>
      <header className="mobile-bar">
        <Brand className="brand" />
        <button
          ref={menuButton}
          disabled={!user}
          aria-expanded={open}
          aria-controls="sidebar"
          onClick={() => setOpen(!open)}
        >
          Menu
        </button>
      </header>
      <aside
        id="sidebar"
        className={`sidebar ${open ? "is-open" : ""}`}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            setOpen(false);
            menuButton.current?.focus();
          }
        }}
        onClick={(event) => {
          if (
            (event.target as HTMLElement).closest(".inbox-link, .all-tasks, .tree-row > a")
          )
            setOpen(false);
        }}
      >
        <Brand className="brand" />
        <WorkspaceNavigation state={sharedNavigation} inboxActive={currentPage === "Inbox"} />
        {sidebar}
        <div className="sidebar-bottom">
          <details ref={accountMenu} className="account-menu" onKeyDown={(event) => {
            if (event.key === "Escape" && event.currentTarget.open) {
              event.stopPropagation();
              event.currentTarget.open = false;
              event.currentTarget.querySelector("summary")?.focus();
            }
          }}>
          <summary className="identity" aria-label="Account menu">
            <span className="avatar">
              {user?.name.slice(0, 1).toUpperCase() || "?"}
            </span>
            <span className="identity-text">
              <strong>{user?.name || "Your account"}</strong>
              <small>{user?.email}</small>
            </span>
          </summary>
          <nav className="account-links" aria-label="Account">
            <a href="/account" aria-current={active === "account" ? "page" : undefined}>Account settings</a>
            <a href="/fields" aria-current={currentPage === "Field Management" ? "page" : undefined}>Field management</a>
            <a href="/import" aria-current={currentPage === "Import & export" ? "page" : undefined}>Import &amp; export</a>
            <a href="/integrations" aria-current={currentPage === "Integrations" ? "page" : undefined}>Webhooks &amp; automations</a>
            <a href="/docs" aria-current={currentPage === "API docs" ? "page" : undefined}>API docs</a>
            <a href="/help" aria-current={currentPage === "Help" ? "page" : undefined}>Help</a>
            <a href="/settings" aria-current={active === "settings" ? "page" : undefined}>Settings</a>
            {user?.isAdmin && <a href="/admin" aria-current={active === "admin" ? "page" : undefined}>Administration</a>}
          <button
            className="sidebar-signout"
            disabled={busy || !user}
            onClick={logout}
          >
            {busy ? "Signing out..." : "Sign out"}
          </button>
          </nav>
          </details>
          <ErrorNotice error={error} />
          <p className="sidebar-attribution">
            <a href="https://wnzn.dev" rel="noopener noreferrer" aria-label="By WNZN">
              <span className="sidebar-attribution-label">BY</span>
              <svg viewBox="0 0 272 64" aria-hidden="true">
                <path d="M0 8h14v34h9V27h10v15h9V8h14v48H0V8Z" />
                <path d="M72 8h56v48h-14V22H86v34H72V8Z" />
                <path d="M144 8h56v14h-56zm0 34h56v14h-56z" />
                <path d="M216 8h56v48h-14V22h-28v34h-14V8Z" />
                <path className="sidebar-attribution-signal" d="M174 22h26l-30 20h-26l30-20Z" />
              </svg>
              <span className="sidebar-attribution-arrow" aria-hidden="true">↗</span>
            </a>
          </p>
        </div>
      </aside>
      <main id="main" className="main-content" tabIndex={-1}>
        {pageLabel && (
          <header className="page-top shared-page-top">
            <Breadcrumbs detail={sharedNavigation.detail} currentPage={pageLabel} />
            <a href={sharedNavigation.workspaceId ? appHref(sharedNavigation.workspaceId) : "/app"} className="quiet-link">
              Back to work ↗
            </a>
          </header>
        )}
        {children}
      </main>
    </div>
  );
}
