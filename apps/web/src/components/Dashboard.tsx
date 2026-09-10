import {
  useDeferredValue,
  useEffect,
  useRef,
  useState,
  type SubmitEvent,
} from "react";
import {
  api,
  label,
  loadWorkspaceItems,
  message,
  workspacePath,
  type Config,
  type Detail,
  type Item,
  type Proposal,
  type TreeNode,
  type Workspace,
} from "../lib/api";
import {
  Empty,
  ErrorNotice,
  Loading,
  Modal,
  Breadcrumbs,
  Shell,
  safeAncestorPath,
  useSession,
} from "./Shared";
import NodeGlyph from "./NodeGlyph";
import TaskViews, { type View } from "./TaskViews";
import TaskEditor from "./TaskEditor";
import ProjectFields from "./ProjectFields";
import Select from "./Select";
import { fieldOwnerForNode } from "../lib/project-fields";
import { projectStatuses } from "../lib/project-statuses";
import StructureEditor from "./StructureEditor";
import Agent from "./Agent";
import DocumentEditor from "./DocumentEditor";

function documentNode(document: NonNullable<Detail["documents"]>[number]): TreeNode {
  return { id: document.id, name: document.title, kind: "document", parentId: document.parentId, updatedAt: document.updatedAt };
}

export default function Dashboard() {
  const { user, error: authError } = useSession();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState("");
  const [detail, setDetail] = useState<Detail | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadedCount, setLoadedCount] = useState(0);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [nodeId, setNodeId] = useState("");
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  const [status, setStatus] = useState("");
  const [view, setView] = useState<View>("list");
  const [month, setMonth] = useState(() => new Date());
  const displayContext = JSON.stringify([
    workspaceId,
    nodeId,
    status,
    search,
    view,
    view === "calendar" || view === "gantt"
      ? `${month.getFullYear()}-${month.getMonth()}`
      : null,
  ]);
  const [display, setDisplay] = useState({
    context: displayContext,
    limit: 100,
  });
  // Reset before rendering a different context, not when tasks or metadata refresh.
  if (display.context !== displayContext)
    setDisplay({ context: displayContext, limit: 100 });
  const [editor, setEditor] = useState<{
    item?: Item;
    proposal?: Proposal;
    defaultNode?: string;
  } | null>(null);
  const [structure, setStructure] = useState<{
    node?: TreeNode;
    initialKind?: TreeNode["kind"];
    initialParentId?: string;
    mode?: "rename" | "details";
  } | null>(null);
  const [creatingWorkspace, setCreatingWorkspace] = useState(false);
  const [workspaceError, setWorkspaceError] = useState("");
  const [busy, setBusy] = useState(false);
  const [config, setConfig] = useState<Config | null>(null);
  const [agentOpen, setAgentOpen] = useState(false);
  const [fieldTarget, setFieldTarget] = useState<string | null>(null);
  const [editingNodeName, setEditingNodeName] = useState(false);
  const [nodeName, setNodeName] = useState("");
  const [nodeNameBusy, setNodeNameBusy] = useState(false);
  const [nodeNameError, setNodeNameError] = useState("");
  const activeWorkspace = useRef(workspaceId);
  activeWorkspace.current = workspaceId;
  const requestId = useRef(0);
  const savedTaskFocus = useRef<{
    workspaceId: string;
    taskId?: string;
  } | null>(null);
  const taskView = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const fieldsRequested = useRef(false);
  useEffect(() => {
    if (fieldsRequested.current || !user) return;
    if (!new URLSearchParams(window.location.search).get("fields")) return;
    fieldsRequested.current = true;
    const query = new URLSearchParams(window.location.search);
    query.delete("fields");
    history.replaceState(null, "", `${window.location.pathname}${query.size ? `?${query}` : ""}`);
    setFieldTarget("");
  }, [user]);
  useEffect(() => {
    api<Config>("/config")
      .then(setConfig)
      .catch(() => {});
  }, []);
  useEffect(() => {
    if (!user) return;
    const controller = new AbortController();
    api<Workspace[]>("/workspaces", "GET", undefined, controller.signal)
      .then((list) => {
        setWorkspaces(list);
        const requested = new URLSearchParams(window.location.search).get("workspace");
        let stored: string | null = null;
        try { stored = localStorage.getItem("hopya.workspace"); } catch {}
        const selected = list.find((w) => w.id === requested)?.id ||
          list.find((w) => w.id === stored)?.id ||
          list[0]?.id || "";
        setWorkspaceId(selected);
        if (selected) {
          try { localStorage.setItem("hopya.workspace", selected); } catch {}
          const query = new URLSearchParams(window.location.search);
          query.set("workspace", selected);
          history.replaceState(null, "", `${window.location.pathname}?${query}`);
        }
        if (!list.length) setLoading(false);
      })
      .catch((e) => {
        if (!controller.signal.aborted) {
          setError(message(e));
          setLoading(false);
        }
      });
    return () => controller.abort();
  }, [user]);
  useEffect(() => {
    if (!workspaceId) return;
    const controller = new AbortController();
    const id = ++requestId.current;
    setLoading(true);
    setLoadedCount(0);
    setError("");
    api<Detail>(workspacePath(workspaceId), "GET", undefined, controller.signal)
      .then(async (nextDetail) => {
        if (controller.signal.aborted || id !== requestId.current) return;
        const nextItems = nextDetail.permissions.includes("items:read")
          ? await loadWorkspaceItems(
              workspaceId,
              controller.signal,
              (count) => {
                if (!controller.signal.aborted && id === requestId.current)
                  setLoadedCount(count);
              },
            )
          : [];
        if (!controller.signal.aborted && id === requestId.current) {
          setDetail(nextDetail);
          setItems(nextItems);
          const query = new URLSearchParams(window.location.search);
          const requested = query.get("workspace") === workspaceId ? query.get("node") ?? "" : "";
           const hierarchyEntries: TreeNode[] = [...nextDetail.nodes, ...(nextDetail.documents ?? []).map(documentNode)];
           const requestedIsValid = Boolean(requested && safeAncestorPath(hierarchyEntries, requested).length);
          if (requested && !requestedIsValid) updateContextUrl(workspaceId);
          setNodeId((current) => {
            if (requestedIsValid) return requested;
             return safeAncestorPath(hierarchyEntries, current).length ? current : "";
          });
          const requestedTask = query.get("workspace") === workspaceId ? query.get("task") : null;
          if (requestedTask) {
            const task = nextItems.find(candidate => candidate.id === requestedTask);
            if (task) setEditor({ item: task });
            else {
              query.delete("task");
              query.delete("comment");
              history.replaceState(null, "", `${window.location.pathname}?${query}`);
            }
          }
        }
      })
      .catch((e) => {
        if (!controller.signal.aborted && id === requestId.current) {
          setDetail(null);
          setItems([]);
          setError(message(e));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted && id === requestId.current)
          setLoading(false);
      });
    return () => controller.abort();
  }, [workspaceId, revision]);
  useEffect(() => {
    const saved = savedTaskFocus.current;
    if (loading || !saved) return;
    savedTaskFocus.current = null;
    if (saved.workspaceId !== workspaceId) return;
    const opener = saved.taskId
      ? taskView.current?.querySelector<HTMLButtonElement>(
          `button[data-task-id="${CSS.escape(saved.taskId)}"]`,
        )
      : null;
    (opener || taskView.current || heading.current)?.focus();
  }, [loading, items, workspaceId]);
  function updateContextUrl(id: string, selected = "") {
    const query = new URLSearchParams(window.location.search);
    query.set("workspace", id);
    if (selected) query.set("node", selected);
    else query.delete("node");
    history.replaceState(null, "", `${window.location.pathname}?${query}`);
  }
  function activateWorkspace(id: string) {
    savedTaskFocus.current = null;
    ++requestId.current;
    setLoading(true);
    setLoadedCount(0);
    setWorkspaceId(id);
    try { localStorage.setItem("hopya.workspace", id); } catch {}
    updateContextUrl(id);
    setDetail(null);
    setItems([]);
    setNodeId("");
    setEditor(null);
    setStructure(null);
    setAgentOpen(false);
    setFieldTarget(null);
    setSearch("");
    setStatus("");
  }
  function selectWorkspace(id: string) {
    if (!workspaces.some((workspace) => workspace.id === id)) return;
    activateWorkspace(id);
  }
  function selectNode(id: string) {
    const entries: TreeNode[] = detail ? [...detail.nodes, ...(detail.documents ?? []).map(documentNode)] : [];
    if (id && (!detail || !safeAncestorPath(entries, id).length)) return;
    setNodeId(id);
    if (workspaceId) updateContextUrl(workspaceId, id);
  }
  function openTask(item: Item) {
    const query = new URLSearchParams(window.location.search);
    query.set("workspace", workspaceId);
    query.set("task", item.id);
    history.replaceState(null, "", `${window.location.pathname}?${query}`);
    setEditor({ item });
  }
  function closeTaskEditor() {
    const query = new URLSearchParams(window.location.search);
    query.delete("task");
    query.delete("comment");
    history.replaceState(null, "", `${window.location.pathname}${query.size ? `?${query}` : ""}`);
    setEditor(null);
  }
  function refresh() {
    setEditor(null);
    setStructure(null);
    setRevision((r) => r + 1);
  }
  async function deleteHierarchyNode(node: TreeNode) {
    if (!detail) return;
    setError("");
    try {
      await api(`${workspacePath(detail.workspace.id)}/${node.kind === "document" ? "documents" : "nodes"}/${node.id}`, "DELETE");
      refresh();
    } catch (cause) { setError(message(cause)); }
  }
  function updateMetadata(fresh: Detail) {
    if (fresh.workspace.id !== activeWorkspace.current) return;
    setDetail(fresh);
  }
  function updateItem(fresh: Item) {
    if (fresh.workspaceId !== activeWorkspace.current) return;
    setItems(current => current.map(item => item.id === fresh.id ? fresh : item));
  }
  async function createWorkspace(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = String(new FormData(event.currentTarget).get("name"));
    setBusy(true);
    setWorkspaceError("");
    try {
      const workspace = await api<Workspace>("/workspaces", "POST", { name });
      setWorkspaces((w) => [...w, workspace]);
      if (workspaces.length === 0) activateWorkspace(workspace.id);
      setCreatingWorkspace(false);
    } catch (e) {
      setWorkspaceError(message(e));
    } finally {
      setBusy(false);
    }
  }
  async function move(item: Item, nextStatus: Item["status"]) {
    if (!detail || !projectStatuses(detail, item.nodeId).some(s => s.id === nextStatus)) return;
    setError("");
    const id = requestId.current;
    try {
      const updated = await api<Item>(
        `${workspacePath(item.workspaceId)}/items/${item.id}`,
        "PATCH",
        { status: nextStatus, expectedUpdatedAt: item.updatedAt },
      );
      if (id === requestId.current)
        setItems((current) =>
          current.map((i) => (i.id === item.id ? updated : i)),
        );
    } catch (e) {
      if (id === requestId.current) setError(message(e));
    }
  }
  const hierarchyEntries: TreeNode[] = detail ? [...detail.nodes, ...(detail.documents ?? []).map(documentNode)] : [];
  const selectedNode = hierarchyEntries.find((n) => n.id === nodeId);
  const selectedDocument = detail?.documents?.find(document => document.id === nodeId);
  const selectedFieldOwner = detail ? fieldOwnerForNode(detail.nodes, nodeId) : undefined;
  useEffect(() => {
    setEditingNodeName(false);
    setNodeName(selectedNode?.name || "");
    setNodeNameError("");
  }, [selectedNode?.id, selectedNode?.name]);
  async function saveNodeName(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!detail || !selectedNode || nodeNameBusy) return;
    const name = nodeName.trim();
    if (!name) {
      setNodeNameError("Enter a name.");
      return;
    }
    if (name === selectedNode.name) {
      setEditingNodeName(false);
      return;
    }
    setNodeNameBusy(true);
    setNodeNameError("");
    try {
      if (selectedNode.kind === "document") {
        const updated = await api<{ id: string; title: string; parentId: string | null; updatedAt: string }>(`${workspacePath(detail.workspace.id)}/documents/${selectedNode.id}`, "PATCH", { title: name, expectedUpdatedAt: selectedNode.updatedAt });
        setDetail(current => current && current.workspace.id === detail.workspace.id ? { ...current,
          documents: current.documents?.map(document => document.id === updated.id ? { ...document, title: updated.title, parentId: updated.parentId, updatedAt: updated.updatedAt } : document),
        } : current);
      } else {
        const updated = await api<TreeNode>(`${workspacePath(detail.workspace.id)}/nodes/${selectedNode.id}`, "PATCH", { name });
        setDetail(current => current && current.workspace.id === detail.workspace.id ? { ...current, nodes: current.nodes.map(node => node.id === updated.id ? updated : node) } : current);
      }
      setEditingNodeName(false);
    } catch (cause) {
      setNodeNameError(message(cause));
    } finally {
      setNodeNameBusy(false);
    }
  }
  const allowedIds = new Set<string>();
  if (nodeId) {
    allowedIds.add(nodeId);
    for (let i = 0; i < (detail?.nodes.length || 0); i++)
      for (const node of detail?.nodes || [])
        if (node.parentId && allowedIds.has(node.parentId))
          allowedIds.add(node.id);
  }
  const scopedLists =
    detail?.nodes.filter(
      (n) => n.kind === "list" && (!nodeId || allowedIds.has(n.id)),
    ) || [];
  const filterStatuses = new Map<string, Set<string>>();
  for (const list of scopedLists) {
    for (const s of projectStatuses(detail!, list.id)) {
      if (!filterStatuses.has(s.id)) filterStatuses.set(s.id, new Set());
      filterStatuses.get(s.id)!.add(s.name);
    }
  }
  const effectiveStatus = filterStatuses.has(status) ? status : "";
  const scopedItemCount = items.filter(i => !nodeId || allowedIds.has(i.nodeId)).length;
  const completedCount = detail ? items.filter(i => (!nodeId || allowedIds.has(i.nodeId)) &&
    projectStatuses(detail, i.nodeId).some(s => s.id === i.status && s.completed)).length : 0;
  const visibleItems = items.filter(
    (i) =>
      (!nodeId || allowedIds.has(i.nodeId)) &&
      (!effectiveStatus || i.status === effectiveStatus) &&
      (!deferredSearch ||
        `${i.title} ${i.description} ${i.tags.join(" ")}`
          .toLowerCase()
          .includes(deferredSearch.toLowerCase())),
  );
  const groupedChildren = detail && (!selectedNode || (selectedNode.kind !== "list" && selectedNode.kind !== "document"))
    ? hierarchyEntries.filter(node => node.kind !== "document" && (selectedNode ? node.parentId === selectedNode.id : node.parentId === null))
    : undefined;
  const readable = detail?.permissions.includes("items:read") || false;
  const writable =
    readable && (detail?.permissions.includes("items:write") || false);
  const structureWritable =
    detail?.permissions.includes("structure:write") || false;
  const documentReadable = detail?.permissions.includes("documents:read") || false;
  const documentWritable = detail?.permissions.includes("documents:write") || false;
  const defaultTaskNode = selectedNode?.kind === "list" ? selectedNode.id : scopedLists[0]?.id;
  useEffect(() => {
    if (!detail) return;
    const query = new URLSearchParams(window.location.search);
    const action = query.get("structure");
    if (action !== "create" && action !== "rename" && action !== "details") return;
    const target = action === "create" ? undefined : hierarchyEntries.find(node => node.id === query.get("node"));
    if (action === "create") setStructure({ initialKind: structureWritable ? "project" : "document" });
    else if (target) setStructure({ node: target, mode: action });
    query.delete("structure");
    history.replaceState(null, "", `${window.location.pathname}?${query}`);
  }, [detail?.workspace.id]);
  useEffect(() => {
    if (!writable || !defaultTaskNode) return;
    const createWithKeyboard = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "c" || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || event.repeat) return;
      const target = event.target;
      if (target instanceof HTMLElement && (target.matches("input, textarea, select, [contenteditable=true]") || target.closest("[role=dialog]"))) return;
      if (document.querySelector('[role="dialog"]')) return;
      event.preventDefault();
      setEditor({ defaultNode: selectedNode?.kind === "list" ? selectedNode.id : undefined });
    };
    window.addEventListener("keydown", createWithKeyboard);
    return () => window.removeEventListener("keydown", createWithKeyboard);
  }, [writable, defaultTaskNode, selectedNode]);
  return (
    <Shell user={user} active="app" navigation={{
      workspaces,
      workspaceId,
      detail,
      selectedNodeId: nodeId,
      itemCount: readable ? items.length : undefined,
      items,
      loading,
      onWorkspaceChange: selectWorkspace,
      onNodeSelect: selectNode,
      onItemPageSelect: (item, documentId) => { selectNode(documentId); openTask(item); },
      onCreateWorkspace: () => {
        setWorkspaceError("");
        setCreatingWorkspace(true);
      },
      onCreateNode: structureWritable || documentWritable ? () => setStructure({ initialKind: structureWritable ? "project" : "document" }) : undefined,
      onRenameNode: structureWritable || documentWritable ? (node) => setStructure({ node, mode: "rename" }) : undefined,
      onEditNode: structureWritable || documentWritable ? (node) => setStructure({ node, mode: "details" }) : undefined,
      onDeleteNode: structureWritable || detail?.permissions.includes("documents:delete") ? deleteHierarchyNode : undefined,
      canEditNode: node => node.kind === "document" ? documentWritable : structureWritable,
      canDeleteNode: node => node.kind === "document" ? Boolean(detail?.permissions.includes("documents:delete")) : structureWritable,
    }}>
      <header className="page-top">
        <Breadcrumbs detail={detail} nodeId={nodeId} />
        <a className="quiet-link" href="/settings">
          Manage workspace ↗
        </a>
      </header>
      <div className="workspace-body">
        {!selectedDocument && <section className="workspace-heading">
          <div>
            {selectedNode && (selectedNode.kind === "document" ? documentWritable : structureWritable) ? editingNodeName ? (
              <form className="hierarchy-title-editor inline-title-editor" onSubmit={saveNodeName}>
                <label className="sr-only" htmlFor="hierarchy-title">{`Rename ${selectedNode.kind}`}</label>
                <input id="hierarchy-title" autoFocus value={nodeName} maxLength={selectedNode.kind === "document" ? 300 : 120} required
                  disabled={nodeNameBusy} onChange={event => setNodeName(event.target.value)} onKeyDown={event => {
                    if (event.key === "Escape") {
                      event.preventDefault();
                      setEditingNodeName(false);
                      setNodeName(selectedNode.name);
                      setNodeNameError("");
                    }
                  }} />
                <button type="submit" className="inline-title-action inline-save" aria-label={`Save ${selectedNode.kind} name`}
                  disabled={nodeNameBusy || !nodeName.trim()}><span aria-hidden="true">✓</span></button>
                <button type="button" className="inline-title-action" aria-label={`Cancel renaming ${selectedNode.kind}`} disabled={nodeNameBusy}
                  onClick={() => { setEditingNodeName(false); setNodeName(selectedNode.name); setNodeNameError(""); }}>×</button>
              </form>
            ) : (
              <h1 ref={heading} tabIndex={-1}>
                <button type="button" className="hierarchy-title-button" aria-label={`Rename ${selectedNode.kind}`}
                  onClick={() => setEditingNodeName(true)}><NodeGlyph node={selectedNode} />{selectedNode.name}</button>
              </h1>
            ) : (
              <h1 ref={heading} tabIndex={-1}>
                {detail && !readable ? detail.workspace.name : "All tasks"}
              </h1>
            )}
            <ErrorNotice error={nodeNameError} />
            {selectedNode?.kind === "project" && selectedNode.description && (
              <p className="project-description">{selectedNode.description}</p>
            )}
             {selectedNode?.kind !== "document" && <p className="muted">
              {detail && !readable
                ? "Manage the parts of this workspace available to your role."
                : loading
                  ? "Loading workspace tasks..."
                  : detail
                    ? `${completedCount} complete · ${scopedItemCount - completedCount} in motion`
                    : "A clear place for every next step."}
             </p>}
          </div>
          <div className="heading-actions">
            {readable &&
              config?.aiEnabled &&
              detail?.permissions.includes("agent:use") && (
                <button
                  aria-expanded={agentOpen}
                  onClick={() => setAgentOpen(!agentOpen)}
                >
                  ✧ Assistant
                </button>
              )}
            {writable && selectedNode?.kind !== "document" && (
              <button
                className="primary"
                disabled={loading || !scopedLists.length}
                onClick={() => setEditor({ defaultNode: selectedNode?.kind === "list" ? selectedNode.id : undefined })}
              >
                + New task
              </button>
            )}
          </div>
        </section>}
        <ErrorNotice error={authError || error} />
        {error && (
          <button
            onClick={() => {
              if (workspaceId) setRevision((r) => r + 1);
              else window.location.reload();
            }}
          >
            Retry loading
          </button>
        )}
        {authError ? (
          <button onClick={() => window.location.reload()}>
            Retry sign-in check
          </button>
        ) : !user || loading ? (
          loadedCount > 0 ? (
            <p role="status">
              Loading workspace tasks... {loadedCount} loaded. Waiting for all
              pages.
            </p>
          ) : (
            <Loading />
          )
        ) : !workspaceId ? (
          <Empty
            title="A fresh space for your team"
            action={
              <button
                className="primary"
                onClick={() => setCreatingWorkspace(true)}
              >
                Create your first workspace
              </button>
            }
          >
            Bring your work together. Create a workspace, then add a project
            and a list inside it.
          </Empty>
        ) : (
          detail &&
          (selectedDocument ? !documentReadable ? (
            <section className="notice" aria-labelledby="document-access-heading"><h2 id="document-access-heading">Document access is not included in your role</h2><p>You can see this hierarchy entry but cannot read its contents.</p></section>
          ) : (
            <DocumentEditor key={selectedDocument.id} detail={detail} summary={selectedDocument} items={items} currentUserId={user?.id}
              onOpenDocument={document => {
                setDetail(current => current && !current.documents?.some(candidate => candidate.id === document.id)
                  ? { ...current, documents: [...(current.documents ?? []), document] } : current);
                selectNode(document.id);
              }} onDocumentDeleted={fallbackId => { setRevision(value => value + 1); selectNode(fallbackId); }}
              onChanged={() => setRevision(value => value + 1)} />
          ) : !readable ? (
            <section className="notice" aria-labelledby="task-access-heading">
              <h2 id="task-access-heading">
                Task access is not included in your role
              </h2>
              <p>
                You are a member of this workspace, but cannot read its tasks.
                This is a permission restriction, not an empty task list.
              </p>
              <a href="/settings">Open workspace settings</a>
            </section>
          ) : (
            <>
              <div className="view-toolbar">
                <div
                  className="view-tabs"
                  role="tablist"
                  aria-label="Task view"
                >
                  {(
                    ["list", "board", "calendar", "gallery", "gantt"] as View[]
                  ).map((v) => (
                    <button
                      key={v}
                      role="tab"
                      id={`tab-${v}`}
                      aria-controls="task-view"
                      aria-selected={view === v}
                      tabIndex={view === v ? 0 : -1}
                      onClick={() => setView(v)}
                      onKeyDown={(e) => {
                        const views: View[] = [
                          "list",
                          "board",
                          "calendar",
                          "gallery",
                          "gantt",
                        ];
                        let next: View | undefined;
                        if (e.key === "ArrowRight")
                          next = views[(views.indexOf(v) + 1) % views.length];
                        if (e.key === "ArrowLeft")
                          next =
                            views[
                              (views.indexOf(v) + views.length - 1) %
                                views.length
                            ];
                        if (e.key === "Home") next = views[0];
                        if (e.key === "End") next = views.at(-1);
                        if (next) {
                          e.preventDefault();
                          setView(next);
                          document.getElementById(`tab-${next}`)?.focus();
                        }
                      }}
                    >
                      {v === "board"
                        ? "Board"
                        : v === "gantt"
                          ? "Timeline"
                          : label(v)}
                    </button>
                  ))}
                </div>
                <div className="filters">
                  {view === "list" && structureWritable && (
                    <button type="button" disabled={!selectedNode || selectedNode.kind === "document" || !selectedFieldOwner}
                      onClick={() => { if (selectedNode && selectedNode.kind !== "document" && selectedFieldOwner) setFieldTarget(selectedNode.id); }}>Add fields</button>
                  )}
                  <label className="search">
                    <span className="sr-only">Search tasks</span>
                    <input
                      type="search"
                      aria-label="Search tasks"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      placeholder="Search tasks..."
                      maxLength={300}
                    />
                  </label>
                  <label>
                    <span className="sr-only">Filter status</span>
                    <Select
                      value={effectiveStatus}
                      onChange={(e) => setStatus(e.target.value)}
                    >
                      <option value="">All statuses</option>
                      {[...filterStatuses].map(([id, names]) => (
                        <option key={id} value={id}>
                          {[...names].join(" / ")}
                        </option>
                      ))}
                    </Select>
                  </label>
                </div>
              </div>
              <div
                ref={taskView}
                id="task-view"
                role="tabpanel"
                aria-labelledby={`tab-${view}`}
                tabIndex={0}
              >
                {!scopedLists.length ? (
                  <Empty
                    title={
                      selectedNode
                        ? `No lists in this ${selectedNode.kind}`
                        : "Give your work a home"
                    }
                    action={
                      structureWritable ? (
                        <button
                          className="primary"
                          onClick={() =>
                            setStructure({
                              initialKind: "list",
                              initialParentId:
                                selectedNode && selectedNode.kind !== "list"
                                  ? selectedNode.id
                                  : undefined,
                            })
                          }
                        >
                          {selectedNode
                            ? "Add a list here"
                            : "Add a list"}
                        </button>
                      ) : undefined
                    }
                  >
                    {selectedNode
                      ? `This ${selectedNode.kind} has no lists. Add a list here before creating tasks in this location.`
                      : "Create a list at the workspace root or place it inside a project. Tasks live in lists, and every view stays connected."}
                    {!structureWritable &&
                      " Ask a workspace manager to add a list here."}
                  </Empty>
                ) : !visibleItems.length &&
                  view !== "calendar" &&
                  view !== "gantt" &&
                  !(view === "list" && groupedChildren?.length) &&
                  view !== "board" ? (
                  <Empty
                    title={
                      search || status
                        ? "No matching tasks"
                        : "Your next step starts here"
                    }
                    action={
                      search || status ? (
                        <button
                          onClick={() => {
                            setSearch("");
                            setStatus("");
                          }}
                        >
                          Clear filters
                        </button>
                      ) : writable ? (
                        <button
                          className="primary"
                          disabled={!scopedLists.length}
                          onClick={() => setEditor({ defaultNode: selectedNode?.kind === "list" ? selectedNode.id : undefined })}
                        >
                          Create a task
                        </button>
                      ) : undefined
                    }
                  >
                    {search || status
                      ? "Try a different phrase or make your filters a little wider."
                      : "No tasks to juggle yet. Capture one thing that matters and give it a place to begin."}
                  </Empty>
                ) : (
                  <TaskViews
                    key={view === "list" ? JSON.stringify([workspaceId, nodeId, view]) : `${workspaceId}:${view}`}
                    projectId={selectedFieldOwner?.id}
                    scopedLists={scopedLists}
                    groupedNodes={view === "list" ? groupedChildren : undefined}
                    onItemUpdated={updateItem}
                    filtered={Boolean(search || status)}
                    onCreateTask={(defaultNode) => setEditor({ defaultNode })}
                    view={view}
                    month={month}
                    setMonth={setMonth}
                    items={visibleItems}
                    detail={detail}
                    onOpen={openTask}
                    onMove={move}
                    writable={writable}
                    deletable={detail.permissions.includes("items:delete")}
                    limit={display.limit}
                    onSaved={refresh}
                    onShowMore={() =>
                      setDisplay((current) => ({
                        ...current,
                        limit: current.limit + 100,
                      }))
                    }
                  />
                )}
              </div>
                <footer className="workspace-footer">
                  <span>
                    {visibleItems.length}{" "}
                    {visibleItems.length === 1 ? "task" : "tasks"} in this view
                  </span>
                </footer>
            </>
          ))
        )}
      </div>
      {editor && detail && (
        <TaskEditor
          key={editor.item?.id || "new"}
          detail={detail}
          {...editor}
          mentionItems={items}
          currentUserId={user?.id}
          defaultNode={editor.proposal ? undefined : editor.defaultNode}
          onClose={closeTaskEditor}
          onMetadataChange={updateMetadata}
          onItemUpdated={updateItem}
          onSaved={() => {
            savedTaskFocus.current = { workspaceId, taskId: editor.item?.id };
            const query = new URLSearchParams(window.location.search);
            query.delete("task"); query.delete("comment");
            history.replaceState(null, "", `${window.location.pathname}?${query}`);
            refresh();
          }}
        />
      )}
      {structure && detail && (
        <StructureEditor
          detail={detail}
          {...structure}
          onClose={() => setStructure(null)}
          onSaved={refresh}
        />
      )}
      {fieldTarget !== null && detail && (
        <ProjectFields detail={detail} targetId={fieldTarget || undefined}
          onClose={() => setFieldTarget(null)} onUpdated={updateMetadata} />
      )}
      {creatingWorkspace && (
        <Modal
          title="Create a workspace"
          onClose={() => {
            if (!busy) setCreatingWorkspace(false);
          }}
        >
          <p className="muted">
            A separate space for a team, a client, or a new idea.
          </p>
          <ErrorNotice error={workspaceError} />
          <form onSubmit={createWorkspace} className="stack">
            <label>
              Workspace name
              <input
                autoFocus
                name="name"
                required
                maxLength={120}
                placeholder="e.g. Studio team"
              />
            </label>
            <button className="primary" disabled={busy}>
              {busy ? "Creating..." : "Create workspace"}
            </button>
          </form>
        </Modal>
      )}
      {agentOpen && detail && (
        <Agent
          key={workspaceId}
          workspaceId={workspaceId}
          writable={writable}
          onReview={(proposal) => setEditor({ proposal })}
          onClose={() => setAgentOpen(false)}
        />
      )}
    </Shell>
  );
}
