import { useEffect, useId, useRef, useState, type CSSProperties, type SubmitEvent } from "react";
import {
  api,
  ApiError,
  message,
  workspacePath,
  nodeIconOptions,
  type NodeIcon,
  type Detail,
  type TreeNode,
} from "../lib/api";
import { ErrorNotice, Modal } from "./Shared";
import NodeGlyph, { resolveNodeColor } from "./NodeGlyph";
import SolidIcon from "./SolidIcon";
import Select from "./Select";

function NodeIconPicker({ kind, value, color, onChange }: {
  kind: TreeNode["kind"];
  value: NodeIcon | null;
  color: string | null;
  onChange: (value: NodeIcon | null) => void;
}) {
  const id = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const selectedLabel = value ? nodeIconOptions.find(option => option.id === value)?.label ?? value : "Default for type";
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const showDefault = !normalizedQuery || "default for type".includes(normalizedQuery);
  const options = nodeIconOptions.filter(option => !normalizedQuery || `${option.label} ${option.id} ${option.searchTerms}`.toLocaleLowerCase().includes(normalizedQuery));

  useEffect(() => {
    if (!open) return;
    searchRef.current?.focus();
    const dismiss = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [open]);

  function choose(next: NodeIcon | null) {
    onChange(next);
    setOpen(false);
    setQuery("");
    requestAnimationFrame(() => triggerRef.current?.focus());
  }

  return <div ref={rootRef} className="node-icon-picker" onKeyDown={event => {
    if (event.key !== "Escape" || !open) return;
    event.preventDefault();
    event.stopPropagation();
    setOpen(false);
    setQuery("");
    triggerRef.current?.focus();
  }}>
    <span id={`${id}-label`} className="appearance-control-label">Icon</span>
    <button ref={triggerRef} type="button" className="node-icon-trigger" aria-labelledby={`${id}-label ${id}-value`}
      aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? `${id}-picker` : undefined}
      onClick={() => setOpen(current => !current)}>
      <NodeGlyph node={{ kind, icon: value, color }} />
      <span id={`${id}-value`}>{selectedLabel}</span>
      <SolidIcon name="chevronDown" />
    </button>
    {open && <div id={`${id}-picker`} className="node-icon-panel" role="dialog" aria-label="Choose icon">
      <label className="sr-only" htmlFor={`${id}-search`}>Search icons</label>
      <input ref={searchRef} id={`${id}-search`} type="search" aria-label="Search icons" value={query} autoComplete="off" placeholder="Search icons"
        onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === "Enter") event.preventDefault(); }} />
      <div className="node-icon-grid" role="group" aria-label="Node icons">
        {showDefault && <button type="button" aria-pressed={!value} className={!value ? "selected" : ""}
          title="Default for type" aria-label="Default for type" onClick={() => choose(null)}>
          <NodeGlyph node={{ kind, icon: null, color: null }} /><span>Default</span>
        </button>}
        {options.map(option => <button key={option.id} type="button" aria-pressed={value === option.id}
          className={value === option.id ? "selected" : ""} title={option.label} aria-label={option.label} onClick={() => choose(option.id)}>
          <NodeGlyph node={{ kind, icon: option.id, color: null }} /><span>{option.label}</span>
        </button>)}
      </div>
      {normalizedQuery && !showDefault && options.length === 0 && <p className="node-icon-empty">No matching icons.</p>}
    </div>}
  </div>;
}

const validHexColor = (value: string) => value === "" || /^#[0-9a-f]{6}$/i.test(value);

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
  mode = "details",
  onClose,
  onSaved,
}: {
  detail: Detail;
  node?: TreeNode;
  initialKind?: TreeNode["kind"];
  initialParentId?: string;
  mode?: "rename" | "details";
  onClose: () => void;
  onSaved: () => void;
}) {
  const creationKinds = [
    ...(detail.permissions.includes("structure:write") ? ["project", "folder", "list"] as const : []),
    ...(detail.permissions.includes("documents:write") ? ["document"] as const : []),
  ] satisfies readonly TreeNode["kind"][];
  const defaultKind = creationKinds.includes(initialKind) ? initialKind : creationKinds[0] ?? initialKind;
  const [name, setName] = useState(node?.name || "");
  const [description, setDescription] = useState(node?.description || "");
  const [kind, setKind] = useState<TreeNode["kind"]>(defaultKind);
  const [parentId, setParentId] = useState(
    node?.parentId || initialParentId || "",
  );
  const [icon, setIcon] = useState<NodeIcon | null>(node?.icon || null);
  const [color, setColor] = useState(() => resolveNodeColor(node?.color) ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const nodeKind = node?.kind || kind;
  const isProject = nodeKind === "project";
  const isDocument = nodeKind === "document";
  const canHaveParent = !isProject;
  const requiresParent = nodeKind === "folder";
  const colorValid = validHexColor(color);
  const submittedColor = color ? color.toLocaleLowerCase() : null;
  const originalColor = resolveNodeColor(node?.color)?.toLocaleLowerCase() ?? null;
  const nodesById = new Map(detail.nodes.map((n) => [n.id, n]));
  const parents = detail.nodes.flatMap((candidate) => {
    if (candidate.kind === "list" || candidate.kind === "document") return [];
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
    if (busy || !colorValid) return;
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
      ...(node && submittedColor !== originalColor ? { color: submittedColor } : {}),
    };
    if (node && !Object.keys(changes).length) {
      onClose();
      return;
    }
    setBusy(true);
    setError("");
    try {
      if (isDocument) {
        await api(
          `${workspacePath(detail.workspace.id)}/documents${node ? `/${node.id}` : ""}`,
          node ? "PATCH" : "POST",
          node
            ? { title: name.trim(), parentId: parentId || null, expectedUpdatedAt: node.updatedAt }
            : { title: name.trim(), body: "", parentId: parentId || null },
        );
        onSaved();
        return;
      }
      await api(
        `${workspacePath(detail.workspace.id)}/nodes${node ? `/${node.id}` : ""}`,
        node ? "PATCH" : "POST",
        node
          ? changes
          : { name: name.trim(), kind, parentId: canHaveParent ? parentId || null : null, icon, color: submittedColor,
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
    const warning = node!.kind === "document"
      ? `Delete "${node!.name}" and all of its nested document pages? This cannot be undone.`
      : `Delete "${node!.name}"? Only empty nodes can be deleted.`;
    if (
      !window.confirm(warning)
    )
      return;
    setBusy(true);
    setError("");
    try {
      await api(
        `${workspacePath(detail.workspace.id)}/${node!.kind === "document" ? "documents" : "nodes"}/${node!.id}`,
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
      title={node ? mode === "rename" ? `Rename ${node.kind}` : `Manage ${node.kind}` : "Organize your workspace"}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <ErrorNotice error={error} />
      {mode === "details" && <p className="muted">
        Projects may hold folders, lists, and documents. Lists and documents may also live at the workspace root.
      </p>}
      <form className={mode === "rename" ? "inline-title-editor structure-title-editor" : "stack"} onSubmit={submit}>
        {mode === "rename" ? <>
          <label className="sr-only" htmlFor="structure-title-name">Name</label>
          <input id="structure-title-name"
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            maxLength={kind === "document" || node?.kind === "document" ? 300 : 120}
          />
        </> : <label>
          Name
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} required
            maxLength={kind === "document" || node?.kind === "document" ? 300 : 120} />
        </label>}
        {mode === "rename" && <>
          <button type="submit" className="inline-title-action inline-save" aria-label={`Save ${node?.kind ?? kind} name`} disabled={busy || !name.trim()}><SolidIcon name="check" /></button>
          <button type="button" className="inline-title-action" aria-label={`Cancel renaming ${node?.kind ?? kind}`} disabled={busy} onClick={onClose}><SolidIcon name="x" /></button>
        </>}
        {mode === "details" && !node && (
          <label>
            Type
            <Select
              value={kind}
              onChange={(e) => {
                setKind(e.target.value as TreeNode["kind"]);
                setParentId("");
              }}
            >
              {creationKinds.map(value => <option key={value} value={value}>{value[0]!.toUpperCase() + value.slice(1)}</option>)}
            </Select>
          </label>
        )}
        {mode === "details" && !isDocument && <fieldset className="appearance-fields">
          <legend>Appearance</legend>
          <div className="appearance-preview" aria-label="Appearance preview">
            <NodeGlyph node={{ kind: node?.kind || kind, icon, color: colorValid ? submittedColor : null }} className="node-glyph node-glyph-preview" />
            <span>Preview</span>
          </div>
          <div className="appearance-controls">
            <NodeIconPicker kind={node?.kind || kind} value={icon} color={colorValid ? submittedColor : null} onChange={setIcon} />
            <div className="node-color-field">
              <label htmlFor="node-color-text">Color</label>
              <div className="node-color-controls">
                <span className={`node-color-native${color && colorValid ? " has-preview" : colorValid ? " is-default" : " is-invalid"}`}
                  style={color && colorValid ? { "--node-color-preview": submittedColor } as CSSProperties : undefined}>
                  <input type="color" value={color && colorValid ? submittedColor! : "#64748b"} aria-label="Choose node color"
                    onChange={event => setColor(event.target.value)} />
                  <span aria-hidden="true" />
                </span>
                <input id="node-color-text" aria-label="Hex color" value={color} maxLength={7} placeholder="#64748b" autoComplete="off" spellCheck={false}
                  aria-invalid={!colorValid} aria-describedby={!colorValid ? "node-color-error" : undefined}
                  onChange={event => setColor(event.target.value)} />
                <button type="button" className="node-color-default" disabled={!color} onClick={() => setColor("")}>Default</button>
              </div>
              {!colorValid && <small id="node-color-error" className="field-error">Use # followed by six hexadecimal digits.</small>}
            </div>
          </div>
        </fieldset>}
        {mode === "details" && isProject && (
          <label>
            Project description
            <textarea value={description} onChange={(e) => setDescription(e.target.value)}
              maxLength={50000} rows={4} />
          </label>
        )}
        {/* Contain WebKit's native-option overflow with room for the focus ring. */}
        {mode === "details" && canHaveParent && (
          <label style={{ overflow: "clip", padding: 6, margin: -6 }}>
            Parent project or folder
            <Select
              required={requiresParent}
              value={parentId}
              onChange={(e) => setParentId(e.target.value)}
            >
              <option value="">{nodeKind === "list" ? "Workspace root (standalone list)" : nodeKind === "document" ? "Workspace root" : "Choose a parent"}</option>
              {parents.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.label}
                  {labelCounts.get(n.label)! > 1 ? ` [${n.id}]` : ""}
                </option>
              ))}
            </Select>
            <small>
              {node
                  ? nodeKind === "list"
                  ? "A standalone list keeps its contents, permissions, and list-specific statuses."
                  : nodeKind === "document" ? "Moving preserves the document body, comments, and pages." : "Moving keeps all contents and the same workspace permissions."
                : detail.nodes.length === 0
                  ? nodeKind === "list" ? "Create this list at the workspace root." : "Create a project before adding a folder."
                   : nodeKind === "list" ? "Choose a project or folder, or keep the list at workspace root." : nodeKind === "document" ? "Choose a project or folder, or keep the document at workspace root." : "Folders may nest inside projects or other folders."}
            </small>
          </label>
        )}
        {mode !== "rename" && <div className="modal-actions">
          {mode === "details" && node && (
            <button
              type="button"
              className="danger"
              disabled={busy}
              onClick={remove}
            >
              {node.kind === "document" ? "Delete document and nested pages" : `Delete empty ${node.kind}`}
            </button>
          )}
          <span className="spacer" />
          <button type="button" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button className="primary" disabled={busy || !colorValid}>
            {busy
              ? "Saving..."
              : node
                ? "Save changes"
                : `Create ${kind}`}
          </button>
        </div>}
      </form>
      {mode === "details" && node?.kind === "list" && <ListTagColors detail={detail} node={node} onSaved={onSaved} />}
    </Modal>
  );
}
