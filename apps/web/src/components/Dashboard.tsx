import {
  useDeferredValue,
  useEffect,
  useRef,
  useState,
  type SubmitEvent,
} from "react";
import {
  api,
  ApiError,
  label,
  loadWorkspaceItems,
  message,
  workspacePath,
  type Config,
  type Detail,
  type Item,
  type NodeIcon,
  type Proposal,
  type TreeNode,
  type Workspace,
} from "../lib/api";
import {
  Empty,
  CreateWorkspaceDialog,
  ErrorNotice,
  Loading,
  Breadcrumbs,
  Shell,
  safeAncestorPath,
  useSession,
} from "./Shared";
import NodeGlyph from "./NodeGlyph";
import NodeIconPicker from "./NodeIconPicker";
import SolidIcon, { type SolidIconName } from "./SolidIcon";
import TaskViews, { type View } from "./TaskViews";
import TaskEditor from "./TaskEditor";
import ProjectFields from "./ProjectFields";
import Select from "./Select";
import { fieldOwnerForNode } from "../lib/project-fields";
import { projectStatuses } from "../lib/project-statuses";
import StructureEditor from "./StructureEditor";
import Agent from "./Agent";
import DocumentEditor from "./DocumentEditor";
import TableResourceEditor from "./TableResourceEditor";
import { documentHierarchyNode, hierarchyEntries as getHierarchyEntries } from "../lib/shared-navigation";

const viewIcons: Record<View, SolidIconName> = {
  list: "list",
  board: "board",
  calendar: "calendar",
  gallery: "gallery",
  gantt: "timeline",
};

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
  const [config, setConfig] = useState<Config | null>(null);
  const [agentOpen, setAgentOpen] = useState(false);
  const [fieldTarget, setFieldTarget] = useState<string | null>(null);
  const [editingNodeName, setEditingNodeName] = useState(false);
  const [nodeName, setNodeName] = useState("");
  const [nodeNameBusy, setNodeNameBusy] = useState(false);
  const [nodeNameError, setNodeNameError] = useState("");
  const [nodeNameConflict, setNodeNameConflict] = useState(false);
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
           const hierarchyEntries = [...getHierarchyEntries(nextDetail), ...(nextDetail.documents ?? []).filter(document => document.parentDocumentId).map(documentHierarchyNode)];
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
    if (id === workspaceId || !workspaces.some((workspace) => workspace.id === id)) return;
    activateWorkspace(id);
  }
  function selectNode(id: string) {
    const entries = detail ? [...getHierarchyEntries(detail), ...(detail.documents ?? []).filter(document => document.parentDocumentId).map(documentHierarchyNode)] : [];
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
      const path = node.kind === "document" ? `${workspacePath(detail.workspace.id)}/documents/${node.id}`
        : node.kind === "table" ? `${workspacePath(detail.workspace.id)}/tables/${node.id}` : `${workspacePath(detail.workspace.id)}/nodes/${node.id}`;
      await api(path, "DELETE");
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
  const hierarchyEntries = detail ? getHierarchyEntries(detail) : [];
  const selectedNode = hierarchyEntries.find((n) => n.id === nodeId);
  const selectedDocument = detail?.documents?.find(document => document.id === nodeId);
  const selectedTable = detail?.tables?.find(table => table.id === nodeId);
  const selectedFieldOwner = detail ? fieldOwnerForNode(detail.nodes, nodeId) : undefined;
  useEffect(() => {
    setEditingNodeName(false);
    setNodeName(selectedNode?.name || "");
    setNodeNameError("");
    setNodeNameConflict(false);
  }, [selectedNode?.id]);
  useEffect(() => {
    if (!editingNodeName) setNodeName(selectedNode?.name || "");
  }, [editingNodeName, selectedNode?.name]);
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
    setNodeNameConflict(false);
    try {
      if (selectedNode.kind === "document") {
        const updated = await api<{ id: string; title: string; parentId: string | null; updatedAt: string }>(`${workspacePath(detail.workspace.id)}/documents/${selectedNode.id}`, "PATCH", { title: name, expectedUpdatedAt: selectedNode.updatedAt });
        setDetail(current => current && current.workspace.id === detail.workspace.id ? { ...current,
          documents: current.documents?.map(document => document.id === updated.id ? { ...document, title: updated.title, parentId: updated.parentId, updatedAt: updated.updatedAt } : document),
        } : current);
      } else if (selectedNode.kind === "table") {
        const updated = await api<NonNullable<Detail["tables"]>[number]>(`${workspacePath(detail.workspace.id)}/tables/${selectedNode.id}`, "PATCH", { name, expectedUpdatedAt: selectedNode.updatedAt });
        setDetail(current => current && current.workspace.id === detail.workspace.id ? { ...current,
          tables: current.tables?.map(table => table.id === updated.id ? updated : table),
        } : current);
      } else {
        const updated = await api<TreeNode>(`${workspacePath(detail.workspace.id)}/nodes/${selectedNode.id}`, "PATCH", { name });
        setDetail(current => current && current.workspace.id === detail.workspace.id ? { ...current, nodes: current.nodes.map(node => node.id === updated.id ? updated : node) } : current);
      }
      setEditingNodeName(false);
    } catch (cause) {
      const conflict = selectedNode.kind === "table" && cause instanceof ApiError && cause.status === 409;
      setNodeNameConflict(conflict);
      setNodeNameError(conflict ? `${message(cause)}. The name remains available; reload before retrying.` : message(cause));
    } finally {
      setNodeNameBusy(false);
    }
  }
  async function reloadConflictedTable() {
    if (!detail || selectedNode?.kind !== "table") return;
    setNodeNameBusy(true);
    setNodeNameError("");
    try {
      const fresh = await api<NonNullable<Detail["tables"]>[number]>(`${workspacePath(detail.workspace.id)}/tables/${selectedNode.id}`);
      setDetail(current => current && current.workspace.id === detail.workspace.id ? { ...current,
        tables: current.tables?.map(table => table.id === fresh.id ? fresh : table),
      } : current);
      setNodeNameConflict(false);
      requestAnimationFrame(() => document.getElementById("hierarchy-title")?.focus());
    } catch (cause) { setNodeNameError(message(cause)); }
    finally { setNodeNameBusy(false); }
  }
  async function saveNodeIcon(icon: NodeIcon | null) {
    if (!detail || !selectedNode || !selectedNodeWritable || icon === (selectedNode.icon ?? null)) return;
    if (selectedNode.kind === "table") {
      const updated = await api<NonNullable<Detail["tables"]>[number]>(`${workspacePath(detail.workspace.id)}/tables/${selectedNode.id}`, "PATCH", {
        icon, expectedUpdatedAt: selectedNode.updatedAt,
      });
      setDetail(current => current && current.workspace.id === detail.workspace.id ? { ...current,
        tables: current.tables?.map(table => table.id === updated.id ? updated : table),
      } : current);
    } else {
      const updated = await api<TreeNode>(`${workspacePath(detail.workspace.id)}/nodes/${selectedNode.id}`, "PATCH", { icon });
      setDetail(current => current && current.workspace.id === detail.workspace.id ? { ...current,
        nodes: current.nodes.map(node => node.id === updated.id ? updated : node),
      } : current);
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
  const groupedChildren = detail && (!selectedNode || (selectedNode.kind !== "list" && selectedNode.kind !== "document" && selectedNode.kind !== "table"))
    ? detail.nodes.filter(node => selectedNode ? node.parentId === selectedNode.id : node.parentId === null)
    : undefined;
  const readable = detail?.permissions.includes("items:read") || false;
  const writable =
    readable && (detail?.permissions.includes("items:write") || false);
  const structureWritable =
    detail?.permissions.includes("structure:write") || false;
  const documentReadable = detail?.permissions.includes("documents:read") || false;
  const documentWritable = detail?.permissions.includes("documents:write") || false;
  const documentEditable = documentReadable && documentWritable;
  const tableReadable = detail?.permissions.includes("tables:read") || false;
  const tableWritable = detail?.permissions.includes("tables:write") || false;
  const tableEditable = tableReadable && tableWritable;
  const tableDeletable = detail?.permissions.includes("tables:delete") || false;
  const selectedNodeWritable = selectedNode?.kind === "document" ? documentEditable : selectedNode?.kind === "table" ? tableEditable : structureWritable;
  const defaultTaskNode = selectedNode?.kind === "list" ? selectedNode.id : scopedLists[0]?.id;
  useEffect(() => {
    if (!detail) return;
    const query = new URLSearchParams(window.location.search);
    const action = query.get("structure");
    if (action !== "create" && action !== "rename" && action !== "details") return;
    const target = action === "create" ? undefined : hierarchyEntries.find(node => node.id === query.get("node"));
    const canEditTarget = target && (target.kind === "document" ? documentEditable : target.kind === "table" ? tableEditable : structureWritable);
    if (action === "create" && (structureWritable || documentWritable || tableWritable)) setStructure({ initialKind: structureWritable ? "project" : documentWritable ? "document" : "table" });
    else if (action !== "create" && target && canEditTarget) setStructure({ node: target, mode: action });
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
        setCreatingWorkspace(true);
      },
      onCreateNode: structureWritable || documentWritable || tableWritable ? () => setStructure({ initialKind: structureWritable ? "project" : documentWritable ? "document" : "table" }) : undefined,
      onRenameNode: structureWritable || documentWritable || tableWritable ? (node) => setStructure({ node, mode: "rename" }) : undefined,
      onEditNode: structureWritable || documentWritable || tableWritable ? (node) => setStructure({ node, mode: "details" }) : undefined,
      onDeleteNode: structureWritable || detail?.permissions.includes("documents:delete") || tableDeletable ? deleteHierarchyNode : undefined,
      canEditNode: node => node.kind === "document" ? documentEditable : node.kind === "table" ? tableEditable : structureWritable,
      canDeleteNode: node => node.kind === "document" ? Boolean(detail?.permissions.includes("documents:delete")) : node.kind === "table" ? tableDeletable : structureWritable,
    }}>
      <header className="page-top">
        <Breadcrumbs detail={detail} nodeId={nodeId} />
        <a className="quiet-link" href="/settings">
          Manage workspace <SolidIcon name="externalLink" />
        </a>
      </header>
      <div className="workspace-body">
        {!selectedDocument && <section className={`workspace-heading${selectedTable ? " table-workspace-heading" : ""}`}>
          <div>
            {selectedNode ? <div className="resource-title-row">
              {selectedNodeWritable ? <NodeIconPicker key={selectedNode.id} kind={selectedNode.kind} value={selectedNode.icon ?? null}
                color={selectedNode.color ?? null} compact label={`Change ${selectedNode.kind} icon`}
                disabled={nodeNameBusy || editingNodeName} onChange={saveNodeIcon} /> : <NodeGlyph node={selectedNode} />}
              {selectedNodeWritable && editingNodeName ? (
              <form className="hierarchy-title-editor inline-title-editor" onSubmit={saveNodeName}>
                <label className="sr-only" htmlFor="hierarchy-title">{`Rename ${selectedNode.kind}`}</label>
                <input id="hierarchy-title" autoFocus value={nodeName} maxLength={selectedNode.kind === "document" ? 300 : 120} required
                  disabled={nodeNameBusy} onChange={event => setNodeName(event.target.value)} onKeyDown={event => {
                    if (event.key === "Escape") {
                      event.preventDefault();
                      setEditingNodeName(false);
                      setNodeName(selectedNode.name);
                      setNodeNameError("");
                      setNodeNameConflict(false);
                    }
                  }} />
                <button type="submit" className="inline-title-action inline-save" aria-label={`Save ${selectedNode.kind} name`}
                  disabled={nodeNameBusy || !nodeName.trim() || nodeNameConflict}><SolidIcon name="check" /></button>
                <button type="button" className="inline-title-action" aria-label={`Cancel renaming ${selectedNode.kind}`} disabled={nodeNameBusy}
                  onClick={() => { setEditingNodeName(false); setNodeName(selectedNode.name); setNodeNameError(""); setNodeNameConflict(false); }}><SolidIcon name="x" /></button>
              </form>
            ) : selectedNodeWritable ? (
              <h1 ref={heading} tabIndex={-1}>
                <button type="button" className="hierarchy-title-button" aria-label={`Rename ${selectedNode.kind}`}
                  onClick={() => { setEditingNodeName(true); setNodeNameConflict(false); }}>{selectedNode.name}</button>
              </h1>
            ) : (
              <h1 ref={heading} tabIndex={-1}>{selectedNode.name}</h1>
            )}</div> : (
              <h1 ref={heading} tabIndex={-1}>
                {detail && !readable ? detail.workspace.name : "All tasks"}
              </h1>
            )}
            <ErrorNotice error={nodeNameError} />
            {nodeNameConflict && <button type="button" disabled={nodeNameBusy} onClick={reloadConflictedTable}>Reload current Table and keep draft</button>}
            {selectedNode?.kind === "project" && selectedNode.description && (
              <p className="project-description">{selectedNode.description}</p>
            )}
            {selectedNode?.kind !== "document" && selectedNode?.kind !== "table" && <p className="muted">
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
            {readable && selectedNode?.kind !== "table" &&
              config?.aiEnabled &&
              detail?.permissions.includes("agent:use") && (
                <button
                  aria-expanded={agentOpen}
                  onClick={() => setAgentOpen(!agentOpen)}
                >
                  <SolidIcon name="sparkles" /> Assistant
                </button>
              )}
            {writable && selectedNode?.kind !== "document" && selectedNode?.kind !== "table" && (
              <button
                className="primary"
                aria-label="+ New task"
                disabled={loading || !scopedLists.length}
                onClick={() => setEditor({ defaultNode: selectedNode?.kind === "list" ? selectedNode.id : undefined })}
              >
                <SolidIcon name="plus" /> New task
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
          (selectedTable ? !tableReadable && !tableWritable ? (
            <section className="notice" aria-labelledby="table-access-heading"><h2 id="table-access-heading">Table access is not included in your role</h2><p>You can see this hierarchy entry but cannot read its columns or records.</p></section>
          ) : (
            <TableResourceEditor key={selectedTable.id} detail={detail} table={selectedTable} currentUserId={user?.id} />
          ) : selectedDocument ? !documentReadable ? (
            <section className="notice" aria-labelledby="document-access-heading"><h2 id="document-access-heading">Document access is not included in your role</h2><p>You can see this hierarchy entry but cannot read its contents.</p></section>
          ) : (
            <DocumentEditor key={selectedDocument.id} detail={detail} summary={selectedDocument} items={items} currentUserId={user?.id}
              onOpenDocument={document => {
                setDetail(current => current && !current.documents?.some(candidate => candidate.id === document.id)
                  ? { ...current, documents: [...(current.documents ?? []), document] } : current);
                selectNode(document.id);
              }} onDocumentDeleted={fallbackId => { setRevision(value => value + 1); selectNode(fallbackId); }}
              onChanged={updated => {
                if (!updated) { setRevision(value => value + 1); return; }
                // Metadata saves must not remount the editor and discard an open body draft.
                setDetail(current => current?.workspace.id === updated.workspaceId ? { ...current,
                  documents: current.documents?.map(document => document.id === updated.id ? { ...document,
                    title: updated.title, parentId: updated.parentId, icon: updated.icon, color: updated.color, updatedAt: updated.updatedAt,
                  } : document),
                } : current);
              }} />
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
                      <SolidIcon name={viewIcons[v]} />
                      <span>{v === "board"
                        ? "Board"
                        : v === "gantt"
                          ? "Timeline"
                          : label(v)}</span>
                    </button>
                  ))}
                </div>
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
      {creatingWorkspace && <CreateWorkspaceDialog onClose={() => setCreatingWorkspace(false)} onCreated={workspace => {
        setWorkspaces(current => current.some(value => value.id === workspace.id) ? current : [...current, workspace]);
        setCreatingWorkspace(false);
        activateWorkspace(workspace.id);
      }} />}
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
