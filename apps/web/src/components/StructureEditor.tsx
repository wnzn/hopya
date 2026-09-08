import { useState, type SubmitEvent } from "react";
import {
  api,
  ApiError,
  message,
  workspacePath,
  nodeColors,
  nodeIcons,
  type Detail,
  type TreeNode,
} from "../lib/api";
import { ErrorNotice, Modal } from "./Shared";
import NodeGlyph from "./NodeGlyph";

function ListTagColors({ detail, node, onSaved }: { detail: Detail; node: TreeNode; onSaved: () => void }) {
  const config = detail.listTagColorConfigs?.find(value => value.listId === node.id);
  const [entries, setEntries] = useState(() => Object.entries(config?.colors ?? {}));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (!config) return null;
  const revision = config.updatedAt;
  async function save(event: SubmitEvent) {
    event.preventDefault();
    const normalized = entries.map(([tag, color]) => [tag.trim(), color] as const);
    if (normalized.some(([tag]) => !tag) || new Set(normalized.map(([tag]) => tag)).size !== normalized.length) {
      setError("Use a unique, non-empty tag name for every color.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await api(`${workspacePath(detail.workspace.id)}/lists/${node.id}/tag-colors`, "PATCH", {
        colors: Object.fromEntries(normalized), expectedUpdatedAt: revision,
      });
      onSaved();
    } catch (cause) {
      setError(cause instanceof ApiError && cause.status === 409
        ? `${message(cause)}. Your changes remain here; reload before trying again.` : message(cause));
      setBusy(false);
    }
  }
  return <form className="stack tag-color-settings" onSubmit={save}>
    <div><h3>Tag colors</h3><p className="muted">These colors apply only to this list. Tags without a configured color keep the neutral style.</p></div>
    {entries.map(([tag, color], index) => <div className="tag-color-row" key={index}>
      <label>Tag<input aria-label={`Tag name ${index + 1}`} value={tag} maxLength={60} required onChange={event => setEntries(current => current.map((entry, at) => at === index ? [event.target.value, entry[1]] : entry))} /></label>
      <label>Color<input aria-label={`Color for ${tag || `tag ${index + 1}`}`} type="color" value={color} onChange={event => setEntries(current => current.map((entry, at) => at === index ? [entry[0], event.target.value] : entry))} /></label>
      <button type="button" disabled={busy} onClick={() => setEntries(current => current.filter((_, at) => at !== index))}>Remove</button>
    </div>)}
    <ErrorNotice error={error} />
    <div className="modal-actions">
      <button type="button" disabled={busy || entries.length >= 30} onClick={() => setEntries(current => [...current, ["", "#64748b"]])}>Add tag color</button>
      <span className="spacer" />
      <button className="primary" disabled={busy}>{busy ? "Saving..." : "Save tag colors"}</button>
    </div>
  </form>;
}

export default function StructureEditor({
  detail,
  node,
  initialKind = "project",
  initialParentId,
  onClose,
  onSaved,
}: {
  detail: Detail;
  node?: TreeNode;
  initialKind?: TreeNode["kind"];
  initialParentId?: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(node?.name || "");
  const [description, setDescription] = useState(node?.description || "");
  const [kind, setKind] = useState<TreeNode["kind"]>(initialKind);
  const [parentId, setParentId] = useState(
    node?.parentId || initialParentId || "",
  );
  const [icon, setIcon] = useState<TreeNode["icon"]>(node?.icon || null);
  const [color, setColor] = useState<TreeNode["color"]>(node?.color || null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const nodeKind = node?.kind || kind;
  const isProject = nodeKind === "project";
  const canHaveParent = !isProject;
  const requiresParent = nodeKind === "folder";
  const nodesById = new Map(detail.nodes.map((n) => [n.id, n]));
  const parents = detail.nodes.flatMap((candidate) => {
    if (candidate.kind === "list") return [];
    const path: string[] = [];
    const seen = new Set<string>();
    let ancestor: TreeNode | undefined = candidate;
    // Bound ancestry walks and omit unsafe or incomplete paths, including this subtree.
    while (ancestor) {
      if (ancestor.id === node?.id || seen.has(ancestor.id) || path.length > 32)
        return [];
      seen.add(ancestor.id);
      path.unshift(ancestor.name);
      if (ancestor.parentId === null)
        return [
          {
            id: candidate.id,
            label: `${path.join(" / ")} (${candidate.kind})`,
          },
        ];
      ancestor = nodesById.get(ancestor.parentId);
    }
    return [];
  });
  const labelCounts = new Map<string, number>();
  for (const parent of parents)
    labelCounts.set(parent.label, (labelCounts.get(parent.label) || 0) + 1);
  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (busy) return;
    if (
      !name.trim() ||
      (requiresParent && !parents.some((p) => p.id === parentId)) ||
      (canHaveParent && parentId !== "" && !parents.some((p) => p.id === parentId))
    ) {
      setError(
        requiresParent
          ? "Enter a name and choose an available parent project or folder."
          : "Enter a name and choose an available location.",
      );
      return;
    }
    const changes = {
      ...(node && isProject && description !== (node.description || "")
        ? { description } : {}),
      ...(node && name.trim() !== node.name ? { name: name.trim() } : {}),
      ...(node && canHaveParent && (parentId || null) !== node.parentId
        ? { parentId: parentId || null, expectedParentId: node.parentId }
        : {}),
      ...(node && icon !== (node.icon || null) ? { icon } : {}),
      ...(node && color !== (node.color || null) ? { color } : {}),
    };
    if (node && !Object.keys(changes).length) {
      onClose();
      return;
    }
    setBusy(true);
    setError("");
    try {
      await api(
        `${workspacePath(detail.workspace.id)}/nodes${node ? `/${node.id}` : ""}`,
        node ? "PATCH" : "POST",
        node
          ? changes
          : { name: name.trim(), kind, parentId: canHaveParent ? parentId || null : null, icon, color,
              ...(isProject ? { description } : {}) },
      );
      onSaved();
    } catch (e) {
      setError(
        e instanceof ApiError && e.status === 409
          ? `${message(e)}. Your draft is still here. Note your changes, then cancel and reload the page before trying again.`
          : message(e),
      );
      setBusy(false);
    }
  }
  async function remove() {
    if (
      !window.confirm(
        `Delete "${node!.name}"? Only empty nodes can be deleted.`,
      )
    )
      return;
    setBusy(true);
    setError("");
    try {
      await api(
        `${workspacePath(detail.workspace.id)}/nodes/${node!.id}`,
        "DELETE",
      );
      onSaved();
    } catch (e) {
      setError(message(e));
      setBusy(false);
    }
  }
  return (
    <Modal
      title={node ? `Manage ${node.kind}` : "Organize your workspace"}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <ErrorNotice error={error} />
      <p className="muted">
        Projects may hold folders and lists. Standalone lists may also live at the workspace root.
      </p>
      <form className="stack" onSubmit={submit}>
        <label>
          Name
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            maxLength={120}
          />
        </label>
        {!node && (
          <label>
            Type
            <select
              value={kind}
              onChange={(e) => {
                setKind(e.target.value as TreeNode["kind"]);
                setParentId("");
              }}
            >
              <option value="project">Project</option>
              <option value="folder">Folder</option>
              <option value="list">List</option>
            </select>
          </label>
        )}
        <fieldset className="appearance-fields">
          <legend>Appearance</legend>
          <NodeGlyph node={{ kind: node?.kind || kind, icon, color }} className="node-glyph node-glyph-preview" />
          <label>Icon<select value={icon || ""} onChange={event => setIcon(event.target.value ? event.target.value as NonNullable<TreeNode["icon"]> : null)}>
            <option value="">Default for type</option>
            {nodeIcons.map(value => <option key={value} value={value}>{value[0].toUpperCase() + value.slice(1)}</option>)}
          </select></label>
          <label>Color<select value={color || ""} onChange={event => setColor(event.target.value ? event.target.value as NonNullable<TreeNode["color"]> : null)}>
            <option value="">Default</option>
            {nodeColors.map(value => <option key={value} value={value}>{value[0].toUpperCase() + value.slice(1)}</option>)}
          </select></label>
        </fieldset>
        {isProject && (
          <label>
            Project description
            <textarea value={description} onChange={(e) => setDescription(e.target.value)}
              maxLength={10000} rows={4} />
          </label>
        )}
        {/* Contain WebKit's native-option overflow with room for the focus ring. */}
        {canHaveParent && (
          <label style={{ overflow: "clip", padding: 6, margin: -6 }}>
            Parent project or folder
            <select
              required={requiresParent}
              value={parentId}
              onChange={(e) => setParentId(e.target.value)}
            >
              <option value="">{nodeKind === "list" ? "Workspace root (standalone list)" : "Choose a parent"}</option>
              {parents.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.label}
                  {labelCounts.get(n.label)! > 1 ? ` [${n.id}]` : ""}
                </option>
              ))}
            </select>
            <small>
              {node
                ? nodeKind === "list"
                  ? "A standalone list keeps its contents, permissions, and list-specific statuses."
                  : "Moving keeps all contents and the same workspace permissions."
                : detail.nodes.length === 0
                  ? nodeKind === "list" ? "Create this list at the workspace root." : "Create a project before adding a folder."
                  : nodeKind === "list" ? "Choose a project or folder, or keep the list at workspace root." : "Folders may nest inside projects or other folders."}
            </small>
          </label>
        )}
        <div className="modal-actions">
          {node && (
            <button
              type="button"
              className="danger"
              disabled={busy}
              onClick={remove}
            >
              Delete empty {node.kind}
            </button>
          )}
          <span className="spacer" />
          <button type="button" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button className="primary" disabled={busy}>
            {busy
              ? "Saving..."
              : node
                ? "Save changes"
                : `Create ${kind}`}
          </button>
        </div>
      </form>
      {node?.kind === "list" && <ListTagColors detail={detail} node={node} onSaved={onSaved} />}
    </Modal>
  );
}
