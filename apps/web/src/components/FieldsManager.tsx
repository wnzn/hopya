import { useEffect, useMemo, useState } from "react";
import {
  api,
  message,
  workspacePath,
  type Detail,
  type TreeNode,
  type Workspace,
} from "../lib/api";
import { fieldOwnerForNode, hierarchyLabels, projectForNode } from "../lib/project-fields";
import { ErrorNotice, Loading, Shell, useSession } from "./Shared";
import { ProjectConfiguration } from "./ProjectFields";
import "../styles/project-fields.css";

const kindGlyph = (kind: TreeNode["kind"]) =>
  kind === "project" ? "◇" : kind === "folder" ? "▱" : "≡";

const kindLabel = (kind: TreeNode["kind"]) =>
  kind === "project" ? "Project" : kind === "folder" ? "Folder" : "List";

function TargetButton({ node, path, selected, showPath = false, onSelect }: {
  node: TreeNode;
  path: string;
  selected: boolean;
  showPath?: boolean;
  onSelect: (id: string) => void;
}) {
  return (
    <button
      type="button"
      className={`fields-manager-target${selected ? " selected" : ""}`}
      aria-pressed={selected}
      aria-current={selected ? true : undefined}
      aria-label={`${kindGlyph(node.kind)} ${node.name}, ${path}`}
      title={`${kindLabel(node.kind)}: ${path}`}
      onClick={() => onSelect(node.id)}
    >
      <span aria-hidden="true">{kindGlyph(node.kind)}</span>
      <span className="fields-manager-target-text">
        <span>{node.name}</span>
        {showPath && <small className="muted fields-manager-path">{path}</small>}
      </span>
    </button>
  );
}

export default function FieldsManager() {
  const { user, error: authError } = useSession();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState("");
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [targetId, setTargetId] = useState("");
  const [filter, setFilter] = useState("");
  const [collapsed, setCollapsed] = useState<string[]>([]);

  useEffect(() => {
    if (!user) return;
    const controller = new AbortController();
    api<Workspace[]>("/workspaces", "GET", undefined, controller.signal)
      .then((rows) => {
        controller.signal.throwIfAborted();
        const fallback = rows[0];
        if (!fallback) {
          setError("No workspaces available.");
          return;
        }
        setWorkspaces(rows);
        const stored = localStorage.getItem("hopya.workspace");
        setWorkspaceId((current) =>
          rows.some((workspace) => workspace.id === current)
            ? current
            : rows.find((workspace) => workspace.id === stored)?.id ?? fallback.id,
        );
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(message(e));
      });
    return () => controller.abort();
  }, [user, revision]);

  useEffect(() => {
    if (!workspaceId) return;
    const controller = new AbortController();
    setDetail(null);
    setTargetId("");
    setFilter("");
    setCollapsed([]);
    api<Detail>(workspacePath(workspaceId), "GET", undefined, controller.signal)
      .then((fresh) => {
        controller.signal.throwIfAborted();
        setDetail(fresh);
        setError("");
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(message(e));
      });
    return () => controller.abort();
  }, [workspaceId, revision]);

  const nodes = useMemo(() => detail?.nodes ?? [], [detail]);
  const labels = useMemo(() => hierarchyLabels(nodes, nodes), [nodes]);
  const target = nodes.find((node) => node.id === targetId);
  const project = target ? projectForNode(nodes, target.id) : undefined;
  const fieldOwner = target ? fieldOwnerForNode(nodes, target.id) : undefined;
  const listId = target?.kind === "list" ? target.id : undefined;
  const canWrite = detail?.permissions.includes("structure:write") ?? false;
  const query = filter.trim().toLowerCase();
  const matches = query
    ? nodes.filter((node) =>
      node.name.toLowerCase().includes(query) ||
      (labels.get(node.id) ?? "").toLowerCase().includes(query),
    )
    : [];
  const roots = nodes.filter((node) => node.parentId === null);

  function chooseWorkspace(id: string) {
    if (!workspaces.some((workspace) => workspace.id === id)) return;
    setWorkspaceId(id);
    try { localStorage.setItem("hopya.workspace", id); } catch {}
  }

  function renderSubtree(parentId: string, depth: number) {
    if (depth > 32) return null;
    const children = nodes.filter((node) => node.parentId === parentId);
    if (!children.length) return null;
    return (
      <ul className="fields-manager-tree">
        {children.map((child) => {
          const hasChildren = nodes.some((node) => node.parentId === child.id);
          const isCollapsed = collapsed.includes(child.id);
          return (
            <li key={child.id}>
              <div className="fields-manager-row">
                {hasChildren && (
                  <button
                    type="button"
                    className="fields-manager-toggle"
                    aria-expanded={!isCollapsed}
                    aria-label={`${isCollapsed ? "Expand" : "Collapse"} ${child.name}`}
                    onClick={() => setCollapsed((current) =>
                      isCollapsed
                        ? current.filter((id) => id !== child.id)
                        : [...current, child.id],
                    )}
                  >
                    <span aria-hidden="true">{isCollapsed ? "▸" : "▾"}</span>
                  </button>
                )}
                <TargetButton
                  node={child}
                  path={labels.get(child.id) ?? child.name}
                  selected={child.id === targetId}
                  onSelect={setTargetId}
                />
              </div>
              {!isCollapsed && renderSubtree(child.id, depth + 1)}
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <Shell user={user} active="app" currentPage="Field Management" navigation={{
      workspaces,
      workspaceId,
      detail,
      onWorkspaceChange: chooseWorkspace,
    }}>
      <div className="settings-body fields-manager">
        <h1>Field Management</h1>
        <p className="muted">
          Assign workspace fields and manage statuses for {detail?.workspace.name || "your workspace"}.
        </p>
        <ErrorNotice error={authError || error} />
        {(authError || error) && (
          <button onClick={() => setRevision((value) => value + 1)}>
            Retry loading
          </button>
        )}
        {!user || (!detail && !error) ? (
          <Loading />
        ) : !detail ? null : (
          <>
            <div className="fields-manager-layout">
              <section className="settings-section fields-manager-target-panel" aria-labelledby="fields-target-heading">
                <div className="section-intro">
                  <h2 id="fields-target-heading">Choose a target</h2>
                  <p>Pick a project, folder, or list to configure.</p>
                </div>
                <div className="stack fields-manager-panel-body">
                  <label>Filter targets
                    <input
                      type="search"
                      aria-label="Filter targets"
                      value={filter}
                      onChange={(event) => setFilter(event.target.value)}
                      placeholder="Filter by name or path"
                      maxLength={200}
                    />
                  </label>
                  {query ? (
                    matches.length ? (
                      <ul className="fields-manager-tree">
                        {matches.map((node) => (
                          <li key={node.id}>
                            <div className="fields-manager-row">
                              <TargetButton
                                node={node}
                               path={labels.get(node.id) ?? node.name}
                               selected={node.id === targetId}
                               showPath
                               onSelect={setTargetId}
                              />
                            </div>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="muted">No targets match this filter.</p>
                    )
                  ) : roots.length ? (
                    <ul className="fields-manager-tree">
                      {roots.map((root) => {
                        const hasChildren = nodes.some((node) => node.parentId === root.id);
                        const isCollapsed = collapsed.includes(root.id);
                        return (
                          <li key={root.id}>
                            <div className="fields-manager-row">
                              {hasChildren && (
                                <button
                                  type="button"
                                  className="fields-manager-toggle"
                                  aria-expanded={!isCollapsed}
                                  aria-label={`${isCollapsed ? "Expand" : "Collapse"} ${root.name}`}
                                  onClick={() => setCollapsed((current) =>
                                    isCollapsed
                                      ? current.filter((id) => id !== root.id)
                                      : [...current, root.id],
                                  )}
                                >
                                  <span aria-hidden="true">{isCollapsed ? "▸" : "▾"}</span>
                                </button>
                              )}
                              <TargetButton
                                node={root}
                                path={labels.get(root.id) ?? root.name}
                                selected={root.id === targetId}
                                onSelect={setTargetId}
                              />
                            </div>
                            {!isCollapsed && renderSubtree(root.id, 1)}
                          </li>
                        );
                      })}
                    </ul>
                  ) : (
                    <p className="muted">No projects, folders, or lists yet.</p>
                  )}
                </div>
              </section>
              <section className="settings-section fields-manager-configuration" aria-labelledby="fields-detail-heading">
                <div className="section-intro">
                  <h2 id="fields-detail-heading">Configuration</h2>
                  <p>Fields and workflows for the selected target.</p>
                </div>
                <div className="fields-manager-panel-body">
                  {!target || !detail || (target.kind !== "list" && !project) ? (
                    <div className="fields-manager-empty">
                      <span aria-hidden="true">◇</span>
                      <p>Select a project, folder, or list to manage its fields and statuses.</p>
                    </div>
                  ) : (
                    <div className="stack">
                      <div className="fields-manager-current">
                        <span className="fields-manager-current-glyph" aria-hidden="true">{kindGlyph(target.kind)}</span>
                        <div>
                          <small>Current {kindLabel(target.kind).toLowerCase()}</small>
                          <strong>{labels.get(target.id) ?? target.name}</strong>
                        </div>
                      </div>
                      {target.kind === "folder" && project && (
                        <p className="muted">Fields are assigned to project {project.name}; statuses follow the project.</p>
                      )}
                      {!canWrite ? (
                        <p className="notice">You need permission to manage project fields.</p>
                      ) : fieldOwner ? (
                        <ProjectConfiguration
                          key={`${detail.workspace.id}:${target.id}`}
                          detail={detail}
                          projectId={fieldOwner.id}
                          listId={listId}
                          onUpdated={setDetail}
                        />
                      ) : null}
                    </div>
                  )}
                </div>
              </section>
            </div>
          </>
        )}
      </div>
    </Shell>
  );
}
