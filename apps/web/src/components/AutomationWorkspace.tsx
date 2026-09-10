import { useEffect, useRef, useState, type SubmitEvent } from "react";
import {
  Background,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  useUpdateNodeInternals,
  type Connection,
  type EdgeChange,
  type Node,
  type NodeChange,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  api,
  ApiError,
  label,
  message,
  workspacePath,
  type Automation,
  type AutomationCatalog,
  type AutomationCredential,
  type AutomationCredentialType,
  type AutomationDraft,
  type AutomationGraph,
  type AutomationGraphNode,
  type AutomationNodeType,
  type AutomationPreview,
  type AutomationRun,
  type AutomationValidation,
  type Detail,
} from "../lib/api";
import { changeSwitchBranch, connectNodes, deleteNode, flowEdges, insertNode, nodeBranches, nodeLabel, publicHeaderNameError, removeEdges, runOutputRows, updateItemSupported, upstreamChoices } from "../lib/automation-graph";
import { ErrorNotice, Loading, Modal } from "./Shared";

const palette: Exclude<AutomationNodeType, "trigger">[] = ["http", "webhook", "email", "log", "update_item", "condition", "switch"];
const stringValue = (value: unknown) => typeof value === "string" ? value : "";
const eventName = (catalog: AutomationCatalog | null, value: string) => catalog?.events.find((event) => event.type === value)?.type.replaceAll(".", " ") ?? value;

type FlowData = { graphNode: AutomationGraphNode; selected: boolean; errors: string[]; previewed: boolean };
type FlowNode = Node<FlowData, "automation">;

function nodeSummary(node: AutomationGraphNode) {
  const config = node.config;
  if (node.type === "trigger") return String(config.event ?? "Choose an event");
  if (node.type === "http" || node.type === "webhook") return `${config.method ?? "POST"} ${config.url || "URL required"}`;
  if (node.type === "email") return `To ${Array.isArray(config.to) && config.to.length ? config.to.join(", ") : "recipient required"}`;
  if (node.type === "log") return stringValue(config.message) || "Message required";
  if (node.type === "update_item") return `${Object.keys((config.patch as Record<string, unknown>) ?? {}).length} task fields`;
  if (node.type === "condition") return `${config.path || "path"} ${config.operator || "equals"} ${String(config.value ?? "")}`;
  return `${config.path || "path"} by ${Array.isArray(config.cases) ? config.cases.length : 0} cases`;
}

function AutomationNodeCard({ data }: NodeProps<FlowNode>) {
  const { graphNode: node } = data;
  const control = node.type === "condition" || node.type === "switch";
  const branches = nodeBranches(node);
  const branchKey = JSON.stringify(branches);
  const updateNodeInternals = useUpdateNodeInternals();
  useEffect(() => { updateNodeInternals(node.id); }, [node.id, branchKey, updateNodeInternals]);
  return (
    <article style={node.type === "switch" ? { minHeight: Math.max(180, branches.length * 24) } : undefined} className={`automation-node automation-node-${node.type}${data.selected ? " selected" : ""}${data.errors.length ? " invalid" : ""}${data.previewed ? " previewed" : ""}`}>
      {node.type !== "trigger" && <Handle type="target" position={Position.Left} aria-label="Incoming connection" />}
      <span className="automation-node-kind">{control ? "Control" : node.type === "trigger" ? "Fixed trigger" : "Action"}</span>
      <strong>{nodeLabel(node.type)}</strong>
      <small>{nodeSummary(node)}</small>
      <span className={`automation-node-state ${data.errors.length ? "failed" : "delivered"}`}>{data.errors.length ? `${data.errors.length} issue${data.errors.length === 1 ? "" : "s"}` : data.previewed ? "Preview path" : "Ready to inspect"}</span>
      {control ? branches.map((branch, index) => <Handle key={branch} id={branch} type="source" position={Position.Right} style={{ top: `${100 * (index + 1) / (branches.length + 1)}%` }} aria-label={`${branch} branch`} title={branch} />) : <Handle type="source" position={Position.Right} aria-label="Outgoing connection" />}
      {node.type === "switch" && <span className="automation-node-hint">Connect branches in the inspector</span>}
    </article>
  );
}

const nodeTypes = { automation: AutomationNodeCard };

function DataPicker({ graph, nodeId, catalog, raw, onInsert }: { graph: AutomationGraph; nodeId: string; catalog: AutomationCatalog; raw?: boolean; onInsert: (value: string) => void }) {
  const choices = upstreamChoices(graph, nodeId, catalog).filter((choice) => !raw || choice.rawPath);
  const [selected, setSelected] = useState(choices[0]?.value ?? "");
  const choice = choices.find((entry) => entry.value === selected) ?? choices[0];
  if (!choices.length) return <p className="muted">No upstream data is available.</p>;
  return <div className="data-picker">
    <label>Insert data
      <select value={choice?.value ?? ""} onChange={(event) => setSelected(event.target.value)}>
        {choices.map((entry) => <option key={entry.value} value={entry.value}>{entry.label} [{entry.type}]</option>)}
      </select>
    </label>
    <button type="button" onClick={() => choice && onInsert(raw ? choice.rawPath! : choice.value)}>Insert</button>
  </div>;
}

type Scalar = string | number | boolean | null;
type ScalarType = "string" | "number" | "boolean" | "null";
const scalarType = (value: unknown): ScalarType => value === null ? "null" : typeof value === "number" ? "number" : typeof value === "boolean" ? "boolean" : "string";
const scalarDefault = (type: ScalarType): Scalar => type === "number" ? 0 : type === "boolean" ? false : type === "null" ? null : "";

function ScalarEditor({ label: fieldLabel, value, onChange }: { label: string; value: Scalar; onChange: (value: Scalar) => void }) {
  const type = scalarType(value);
  return <div className="scalar-editor"><label>{fieldLabel} type<select value={type} onChange={(event) => onChange(scalarDefault(event.target.value as ScalarType))}><option value="string">Text</option><option value="number">Number</option><option value="boolean">Boolean</option><option value="null">Null</option></select></label>{type === "string" ? <label>{fieldLabel}<input value={String(value ?? "")} onChange={(event) => onChange(event.target.value)} /></label> : type === "number" ? <label>{fieldLabel}<input type="number" value={String(value)} onChange={(event) => onChange(event.target.value === "" ? 0 : Number(event.target.value))} /></label> : type === "boolean" ? <label>{fieldLabel}<select value={String(value)} onChange={(event) => onChange(event.target.value === "true")}><option value="true">True</option><option value="false">False</option></select></label> : <p className="view-help">This comparison uses null.</p>}</div>;
}

function TargetSelect({ graph, source, branch, onChange }: { graph: AutomationGraph; source: string; branch?: string; onChange: (target: string) => void }) {
  const selected = graph.edges.find((edge) => edge.source === source && edge.branch === branch)?.target ?? "";
  return <label>{branch ? `${branch} target` : "Next node"}
    <select value={selected} onChange={(event) => onChange(event.target.value)}>
      <option value="">End workflow</option>
      {graph.nodes.filter((node) => node.id !== source && node.type !== "trigger").map((node) => <option key={node.id} value={node.id}>{nodeLabel(node.type)} · {node.id.slice(0, 14)}</option>)}
    </select>
  </label>;
}

function Inspector({ graph, selectedId, catalog, credentials, members, errors, onChange, onSelect, onDelete, onAdd, onStatus }: {
  graph: AutomationGraph; selectedId: string; catalog: AutomationCatalog; credentials: AutomationCredential[]; errors: string[];
  members: Detail["members"];
  onChange: (graph: AutomationGraph) => void; onSelect: (id: string) => void; onDelete: () => void; onAdd: (type: Exclude<AutomationNodeType, "trigger">, branch?: string) => void; onStatus: (status: string) => void;
}) {
  const [insertBranch, setInsertBranch] = useState("");
  const node = graph.nodes.find((entry) => entry.id === selectedId) ?? graph.nodes[0]!;
  const config = node.config;
  const replaceConfig = (next: Record<string, unknown>) => onChange({ ...graph, nodes: graph.nodes.map((entry) => entry.id === node.id ? { ...entry, config: next } : entry) });
  const setConfig = (patch: Record<string, unknown>) => replaceConfig({ ...config, ...patch });
  const setTarget = (target: string, branch?: string) => {
    const current = graph.edges.find((edge) => edge.source === node.id && edge.branch === branch);
    if ((current?.target ?? "") === target) return;
    const next = target ? connectNodes(graph, node.id, target, branch) : removeEdges(graph, new Set(current ? [current.id] : []));
    if (next === graph) { onStatus("Flow change rejected because it would orphan an existing downstream path or break a required branch. Delete or restructure that path explicitly first."); return; }
    onChange(next);
    onStatus(target ? "Flow target updated." : "Flow path ended.");
  };
  const move = (x: number, y: number) => onChange({ ...graph, nodes: graph.nodes.map((entry) => entry.id === node.id ? { ...entry, position: { x: entry.position.x + x, y: entry.position.y + y } } : entry) });
  const insert = (key: string, value: string) => setConfig({ [key]: `${stringValue(config[key])}${value}` });
  const headers = Object.entries((config.headers as Record<string, string>) ?? {});
  const headerErrors = headers.map(([name]) => publicHeaderNameError(name));
  const patch = (config.patch as Record<string, unknown>) ?? {};
  const setPatch = (key: string, value: unknown) => setConfig({ patch: { ...patch, [key]: value } });
  const removePatch = (key: string) => { const next = { ...patch }; delete next[key]; setConfig({ patch: next }); };
  const insertPatch = (key: string, value: string) => setPatch(key, `${stringValue(patch[key])}${value}`);
  const cases = Array.isArray(config.cases) ? config.cases as { branch: string; value: string | number | boolean | null }[] : [];
  const branches = nodeBranches(node);
  const changeBranch = (index: number | "default", value: string | null) => {
    const next = changeSwitchBranch(graph, node.id, index, value);
    if (next === graph) { onStatus("Branch change rejected. Names must be nonempty and unique, at least one case must remain, and removal must not orphan a downstream path. Reconnect or explicitly delete that path first."); return; }
    onChange(next);
    onStatus(value === null ? "Case removed; downstream nodes were preserved." : "Branch renamed with its connections preserved.");
  };
  const legacyHeaderNames = Array.isArray(config.legacyHeaderNames) ? config.legacyHeaderNames.filter((name): name is string => typeof name === "string") : [];
  const canUpdateItem = updateItemSupported(graph);
  const acknowledgeLegacyHeaders = () => {
    if (!config.credentialId) return;
    const next = { ...config };
    delete next.legacyHeaderNames;
    delete next.legacyHeaderMigrationRequired;
    replaceConfig(next);
  };
  return <aside className="automation-inspector" aria-label="Selected node inspector">
    <div className="inspector-heading"><div><span>{node.id}</span><h3>{nodeLabel(node.type)}</h3></div>{node.type !== "trigger" && <button type="button" className="danger" onClick={onDelete}>Delete node</button>}</div>
    <fieldset className="bare-fieldset"><legend>Canvas position</legend><div className="button-group"><button type="button" onClick={() => move(-80, 0)}>Move left</button><button type="button" onClick={() => move(80, 0)}>Move right</button><button type="button" onClick={() => move(0, -80)}>Move up</button><button type="button" onClick={() => move(0, 80)}>Move down</button></div></fieldset>
    {errors.length > 0 && <ul className="node-errors">{errors.map((error) => <li key={error}>{error}</li>)}</ul>}
    {(legacyHeaderNames.length > 0 || config.legacyHeaderMigrationRequired === true) && <section className="legacy-header-warning" role="alert"><strong>Legacy authentication headers need remediation</strong>{legacyHeaderNames.length > 0 && <p>Removed header names: {legacyHeaderNames.join(", ")}.</p>}<p>Choose or replace an authentication credential, then acknowledge this migration. Secret values will not be restored. The old published automation continues executing unchanged until you publish this draft.</p><label className="inline-check"><input type="checkbox" disabled={!config.credentialId} onChange={(event) => { if (event.target.checked) acknowledgeLegacyHeaders(); }} /><span>I moved these headers to the selected credential</span></label>{!config.credentialId && <small>Select an authentication profile below first.</small>}</section>}
    {node.type === "trigger" && <label>Trigger event<select value={stringValue(config.event)} onChange={(event) => { setConfig({ event: event.target.value }); if (event.target.value !== "item.created" && event.target.value !== "item.updated" && graph.nodes.some((entry) => entry.type === "update_item")) onStatus("Update task nodes require an item created or item updated trigger. Change the trigger back or remove those nodes before saving a valid graph."); }}>{catalog.events.map((entry) => <option key={entry.type} value={entry.type}>{eventName(catalog, entry.type)}</option>)}</select></label>}
    {(node.type === "http" || node.type === "webhook") && <>
      <label>Destination URL<input required type="url" maxLength={2000} value={stringValue(config.url)} onChange={(event) => setConfig({ url: event.target.value })} placeholder="https://api.example.com/tasks" /></label>
      <p className="view-help">Destination URLs are fixed so they can be resolved and checked against credential origin and path bindings. Insert data into request bodies, subjects, logs, or task fields instead.</p>
      <label>Method<select value={stringValue(config.method) || "POST"} onChange={(event) => setConfig({ method: event.target.value })}>{(node.type === "webhook" ? ["POST", "PUT", "PATCH"] : ["GET", "POST", "PUT", "PATCH", "DELETE"]).map((method) => <option key={method}>{method}</option>)}</select></label>
      <label>Authentication profile<select value={stringValue(config.credentialId)} onChange={(event) => { const next = { ...config }; if (event.target.value) next.credentialId = event.target.value; else delete next.credentialId; replaceConfig(next); }}><option value="">No credential</option>{credentials.filter((credential) => credential.status === "active").map((credential) => <option key={credential.id} value={credential.id}>{credential.name} · {credential.origin}{credential.pathPrefix}</option>)}</select></label>
      <fieldset className="bare-fieldset stack"><legend>Public headers</legend><p className="muted">Authorization, cookies, API keys, and other sensitive headers belong in the authentication profile above, not in public headers.</p>{headers.map(([name, value], index) => { const headerError = headerErrors[index]; const errorId = `header-${node.id}-${index}-error`; return <div className="header-entry" key={index}><div className="header-row"><input aria-label={`Header ${index + 1} name`} aria-invalid={Boolean(headerError)} aria-describedby={headerError ? errorId : undefined} value={name} onChange={(event) => { const next = Object.fromEntries(headers.map((entry, entryIndex) => entryIndex === index ? [event.target.value, entry[1]] : entry)); setConfig({ headers: next }); }} /><input aria-label={`Header ${index + 1} value`} value={value} onChange={(event) => setConfig({ headers: Object.fromEntries(headers.map((entry, entryIndex) => entryIndex === index ? [entry[0], event.target.value] : entry)) })} /><button type="button" aria-label={`Remove header ${index + 1}`} onClick={() => setConfig({ headers: Object.fromEntries(headers.filter((_, entryIndex) => entryIndex !== index)) })}>Remove</button></div>{headerError && <small id={errorId} className="inline-field-error" role="alert">{headerError} The draft is retained and cannot be sent until this row is fixed.</small>}</div>; })}<button type="button" disabled={headers.length >= 20} onClick={() => setConfig({ headers: { ...Object.fromEntries(headers), [`X-Header-${headers.length + 1}`]: "" } })}>Add public header</button></fieldset>
      {node.type === "http" && <><label>Body template<textarea rows={5} maxLength={20000} value={stringValue(config.body)} onChange={(event) => setConfig({ body: event.target.value })} /></label><DataPicker graph={graph} nodeId={node.id} catalog={catalog} onInsert={(value) => insert("body", value)} /></>}
    </>}
    {node.type === "email" && <><label>Recipients, comma separated<input type="text" value={Array.isArray(config.to) ? config.to.join(", ") : ""} onChange={(event) => setConfig({ to: event.target.value.split(",").map((value) => value.trim()).filter(Boolean) })} /></label><label>Subject<input maxLength={200} value={stringValue(config.subject)} onChange={(event) => setConfig({ subject: event.target.value })} /></label><DataPicker graph={graph} nodeId={node.id} catalog={catalog} onInsert={(value) => insert("subject", value)} /></>}
    {node.type === "log" && <><label>Log message<textarea rows={5} maxLength={2000} value={stringValue(config.message)} onChange={(event) => setConfig({ message: event.target.value })} /></label><DataPicker graph={graph} nodeId={node.id} catalog={catalog} onInsert={(value) => insert("message", value)} /></>}
    {node.type === "update_item" && <fieldset className="bare-fieldset stack"><legend>Task patch</legend><div className="patch-field"><label>Title<input required value={stringValue(patch.title)} onChange={(event) => event.target.value ? setPatch("title", event.target.value) : removePatch("title")} /></label>{"title" in patch && <button type="button" onClick={() => removePatch("title")}>Do not change title</button>}</div><DataPicker graph={graph} nodeId={node.id} catalog={catalog} onInsert={(value) => insertPatch("title", value)} /><div className="patch-field"><label>Description<textarea value={stringValue(patch.description)} onChange={(event) => setPatch("description", event.target.value)} /></label><small>{"description" in patch ? patch.description === "" ? "Will clear description" : "Will set description" : "Will not change description"}</small><div className="button-group"><button type="button" onClick={() => setPatch("description", "")}>Clear description</button><button type="button" onClick={() => removePatch("description")}>Do not change</button></div></div><DataPicker graph={graph} nodeId={node.id} catalog={catalog} onInsert={(value) => insertPatch("description", value)} /><div className="patch-field"><label>Status<input value={stringValue(patch.status)} onChange={(event) => event.target.value ? setPatch("status", event.target.value) : removePatch("status")} /></label>{"status" in patch && <button type="button" onClick={() => removePatch("status")}>Do not change status</button>}</div><DataPicker graph={graph} nodeId={node.id} catalog={catalog} onInsert={(value) => insertPatch("status", value)} /><label>Priority<select value={stringValue(patch.priority)} onChange={(event) => event.target.value ? setPatch("priority", event.target.value) : removePatch("priority")}><option value="">Do not change</option>{["none", "low", "medium", "high", "urgent"].map((value) => <option key={value}>{value}</option>)}</select></label><label>Assignee<select value={patch.assigneeId === null ? "__none" : stringValue(patch.assigneeId)} onChange={(event) => event.target.value ? setPatch("assigneeId", event.target.value === "__none" ? null : event.target.value) : removePatch("assigneeId")}><option value="">Do not change</option><option value="__none">Unassign</option>{members.filter((member) => !member.disabled).map((member) => <option key={member.userId} value={member.userId}>{member.name}</option>)}</select></label><div className="patch-field"><label>Start date<input type="date" value={stringValue(patch.startDate)} onChange={(event) => setPatch("startDate", event.target.value || null)} /></label><small>{"startDate" in patch ? patch.startDate === null ? "Will clear start date" : "Will set start date" : "Will not change start date"}</small><div className="button-group"><button type="button" onClick={() => setPatch("startDate", null)}>Clear start date</button><button type="button" onClick={() => removePatch("startDate")}>Do not change</button></div></div><div className="patch-field"><label>Due date<input type="date" value={stringValue(patch.dueDate)} onChange={(event) => setPatch("dueDate", event.target.value || null)} /></label><small>{"dueDate" in patch ? patch.dueDate === null ? "Will clear due date" : "Will set due date" : "Will not change due date"}</small><div className="button-group"><button type="button" onClick={() => setPatch("dueDate", null)}>Clear due date</button><button type="button" onClick={() => removePatch("dueDate")}>Do not change</button></div></div><div className="patch-field"><label>Tags, comma separated<input value={Array.isArray(patch.tags) ? patch.tags.join(", ") : ""} onChange={(event) => setPatch("tags", event.target.value.split(",").map((value) => value.trim()).filter(Boolean))} /></label><small>{"tags" in patch ? Array.isArray(patch.tags) && patch.tags.length === 0 ? "Will clear tags" : "Will replace tags" : "Will not change tags"}</small><div className="button-group"><button type="button" onClick={() => setPatch("tags", [])}>Clear tags</button><button type="button" onClick={() => removePatch("tags")}>Do not change</button></div></div></fieldset>}
    {(node.type === "condition" || node.type === "switch") && <><label>Event path<input value={stringValue(config.path)} onChange={(event) => setConfig({ path: event.target.value })} placeholder="item.status" /></label><DataPicker raw graph={graph} nodeId={node.id} catalog={catalog} onInsert={(value) => setConfig({ path: value })} /></>}
    {node.type === "condition" && <><label>Operator<select value={stringValue(config.operator)} onChange={(event) => { const next: Record<string, unknown> = { ...config, operator: event.target.value }; if (event.target.value === "exists") delete next.value; else if (!("value" in next)) next.value = ""; replaceConfig(next); }}>{["equals", "not_equals", "exists", "contains"].map((value) => <option key={value} value={value}>{label(value)}</option>)}</select></label>{config.operator !== "exists" && <ScalarEditor label="Comparison value" value={(config.value === null || ["string", "number", "boolean"].includes(typeof config.value)) ? config.value as Scalar : ""} onChange={(value) => setConfig({ value })} />}</>}
    {node.type === "switch" && <fieldset className="bare-fieldset stack"><legend>Cases</legend><p className="view-help">Renaming preserves connections. Removing a case is allowed only if its downstream nodes remain reachable; otherwise reconnect or explicitly delete that path first.</p>{cases.map((entry, index) => <div className="switch-case" key={index}><label>Branch name<input maxLength={100} value={entry.branch} onChange={(event) => changeBranch(index, event.target.value)} /></label><ScalarEditor label={`Case ${index + 1} value`} value={entry.value} onChange={(value) => setConfig({ cases: cases.map((item, i) => i === index ? { ...item, value } : item) })} /><button type="button" disabled={cases.length <= 1} onClick={() => changeBranch(index, null)}>Remove case</button></div>)}<button type="button" disabled={cases.length >= 20} onClick={() => { let number = 1; while (branches.includes(`case-${number}`)) number++; setConfig({ cases: [...cases, { branch: `case-${number}`, value: "" }] }); }}>Add case</button><label>Default branch<input maxLength={100} value={stringValue(config.defaultBranch)} onChange={(event) => changeBranch("default", event.target.value)} /></label></fieldset>}
    <fieldset className="bare-fieldset stack"><legend>Flow</legend>{branches.length ? branches.map((branch) => <TargetSelect key={branch} graph={graph} source={node.id} branch={branch} onChange={(target) => setTarget(target, branch)} />) : <TargetSelect graph={graph} source={node.id} onChange={setTarget} />}</fieldset>
    <fieldset className="bare-fieldset stack"><legend>Add after selected</legend>{branches.length > 0 && <label>Branch to insert into<select value={branches.includes(insertBranch) ? insertBranch : branches[0]} onChange={(event) => setInsertBranch(event.target.value)}>{branches.map((branch) => <option key={branch} value={branch}>{branch}</option>)}</select></label>}<div className="inspector-add">{palette.map((type) => <button type="button" key={type} disabled={type === "update_item" && !canUpdateItem} title={type === "update_item" && !canUpdateItem ? "Requires an item created or item updated trigger" : undefined} onClick={() => onAdd(type, branches.length ? branches.includes(insertBranch) ? insertBranch : branches[0] : undefined)}>+ {nodeLabel(type)}</button>)}</div>{!canUpdateItem && <p className="muted">Update task is unavailable because this trigger does not provide a triggering task. Choose item created or item updated first.</p>}</fieldset>
    <label>Selected node<select value={node.id} onChange={(event) => onSelect(event.target.value)}>{graph.nodes.map((entry) => <option key={entry.id} value={entry.id}>{nodeLabel(entry.type)} · {entry.id.slice(0, 16)}</option>)}</select></label>
  </aside>;
}

function GraphEditor({ wid, automation, catalog, credentials, members, onClose, onPublished }: { wid: string; automation: Automation; catalog: AutomationCatalog; credentials: AutomationCredential[]; members: Detail["members"]; onClose: () => void; onPublished: () => void }) {
  const base = `${workspacePath(wid)}/automations/${automation.id}`;
  const [graph, setGraph] = useState<AutomationGraph | null>(null);
  const [revision, setRevision] = useState(0);
  const [selectedId, setSelectedId] = useState("trigger");
  const [dirty, setDirty] = useState(false);
  const [busy, setBusyState] = useState(false);
  const pending = useRef(false);
  const setBusy = (value: boolean) => { pending.current = value; setBusyState(value); };
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [validation, setValidation] = useState<AutomationValidation | null>(null);
  const [preview, setPreview] = useState<AutomationPreview | null>(null);
  const [previewEvent, setPreviewEvent] = useState("{}");
  const [panel, setPanel] = useState<"palette" | "canvas" | "inspector">("canvas");
  const [paletteQuery, setPaletteQuery] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    api<AutomationDraft>(`${base}/draft`, "GET", undefined, controller.signal).then((draft) => { if (controller.signal.aborted) return; setGraph(draft.graph); setRevision(draft.revision); setSelectedId(draft.graph.nodes.find((node) => node.type === "trigger")?.id ?? draft.graph.nodes[0]?.id ?? ""); }).catch((cause) => { if (!controller.signal.aborted) setError(message(cause)); });
    return () => controller.abort();
  }, [base]);
  useEffect(() => {
    if (!dirty && !busy && !conflict) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, busy, conflict]);
  const update = (next: AutomationGraph) => { if (pending.current) return; setGraph(next); setDirty(true); setValidation(null); setPreview(null); };
  const publicHeaderIssues = graph?.nodes.flatMap((node) => node.type === "http" || node.type === "webhook" ? Object.keys((node.config.headers as Record<string, string> | undefined) ?? {}).flatMap((name) => { const issue = publicHeaderNameError(name); return issue ? [{ nodeId: node.id, message: `Node ${node.id}: ${issue}` }] : []; }) : []) ?? [];
  const updateCompatibilityIssues = graph && !updateItemSupported(graph) ? graph.nodes.filter((node) => node.type === "update_item").map((node) => `Update task node ${node.id} requires an item created or item updated trigger.`) : [];
  const localValidationErrors = [...publicHeaderIssues.map((issue) => issue.message), ...updateCompatibilityIssues];
  const displayedErrors = [...new Set([...localValidationErrors, ...(validation?.errors ?? [])])];
  const nodeErrors = (id: string) => displayedErrors.filter((entry) => entry.includes(id));
  const blockUnsafeHeaders = () => {
    const issue = publicHeaderIssues[0];
    if (!issue) return false;
    setSelectedId(issue.nodeId); setPanel("inspector"); setStatus("Remove the sensitive public header or move it to an authentication profile. The draft was retained and no graph data was sent.");
    return true;
  };
  const add = (type: Exclude<AutomationNodeType, "trigger">, branch?: string) => { if (pending.current || !graph || graph.nodes.length >= catalog.limits.maxNodes) return; if (type === "update_item" && !updateItemSupported(graph)) { setStatus("Update task requires an item created or item updated trigger. Change the trigger first."); return; } const result = insertNode(graph, type, selectedId, branch); if (!result.id) { setStatus("Choose a condition or switch branch before inserting so its existing path is preserved."); setPanel("inspector"); return; } update(result.graph); setSelectedId(result.id); setPanel("inspector"); setStatus(`${nodeLabel(type)} added after the selected node${branch ? ` on ${branch}` : ""}.`); };
  async function save() {
    if (pending.current || conflict || !graph || blockUnsafeHeaders()) return;
    setBusy(true); setError("");
    try { const result = await api<AutomationDraft & { validation: AutomationValidation }>(`${base}/draft`, "PUT", { expectedRevision: revision, graph }); setRevision(result.revision); setGraph(result.graph); setDirty(false); setValidation(result.validation); setStatus(`Draft revision ${result.revision} saved.`); }
    catch (cause) { if (cause instanceof ApiError && cause.status === 409) { setConflict(true); setError("This draft is stale. Your local graph is retained. Reload the server draft before saving or publishing again."); } else setError(message(cause)); }
    finally { setBusy(false); }
  }
  async function validate() { if (pending.current || !graph || blockUnsafeHeaders()) return; setBusy(true); setError(""); try { const result = await api<AutomationValidation>(`${base}/validate`, "POST", { graph }); setValidation(result); setStatus(result.valid ? "Validation passed." : `Validation found ${result.errors.length} issue(s).`); } catch (cause) { setError(message(cause)); } finally { setBusy(false); } }
  async function runPreview() { if (pending.current || !graph || blockUnsafeHeaders()) return; let event: unknown; try { event = JSON.parse(previewEvent); } catch { setError("Preview event must be valid JSON."); return; } setBusy(true); setError(""); try { const result = await api<AutomationPreview>(`${base}/preview`, "POST", { graph, event }); setPreview(result); setValidation(result); setStatus(result.valid ? `Dry preview selected ${result.path.length} node(s); no effects were run.` : "Preview could not run because the graph is invalid."); } catch (cause) { setError(message(cause)); } finally { setBusy(false); } }
  async function publish() { if (pending.current || conflict) return; if (!graph || dirty || revision < 1) { setError("Save the current draft before publishing."); return; } if (!window.confirm(`Publish draft revision ${revision}? Future events will use this immutable version. The automation remains ${automation.enabled ? "enabled" : "paused"}.`)) return; setBusy(true); setError(""); try { await api(`${base}/publish`, "POST", { expectedRevision: revision }); setStatus("Published successfully."); onPublished(); onClose(); } catch (cause) { if (cause instanceof ApiError && cause.status === 409) { setConflict(true); setError("This draft changed before publishing. Your local graph is retained. Reload and review the server draft."); } else setError(message(cause)); } finally { setBusy(false); } }
  async function reload() {
    if (pending.current || !window.confirm("Discard your local graph and reload the server draft? Your local graph will be kept if loading fails.")) return;
    setBusy(true); setError("");
    try {
      const draft = await api<AutomationDraft>(`${base}/draft`, "GET");
      setGraph(draft.graph); setRevision(draft.revision);
      setSelectedId(draft.graph.nodes.find((node) => node.type === "trigger")?.id ?? draft.graph.nodes[0]?.id ?? "");
      setDirty(false); setConflict(false); setValidation(null); setPreview(null);
      setStatus(`Server draft revision ${draft.revision} loaded. Review it before publishing.`);
    } catch (cause) { setError(`Local graph retained. ${message(cause)}`); }
    finally { setBusy(false); }
  }
  if (!graph) return <Modal title={`Edit ${automation.name}`} onClose={onClose} className="automation-editor-modal"><Loading /><ErrorNotice error={error} /></Modal>;
  const requestClose = () => { if (pending.current) return; if ((!dirty && !conflict) || window.confirm("Close the builder and discard your local graph?")) onClose(); };
  const flowNodes: FlowNode[] = graph.nodes.map((node) => ({ id: node.id, type: "automation", position: node.position, selected: node.id === selectedId, deletable: false, data: { graphNode: node, selected: node.id === selectedId, errors: nodeErrors(node.id), previewed: Boolean(preview?.path.some((entry) => entry.nodeId === node.id)) } }));
  const searchPalette = (type: AutomationNodeType) => `${nodeLabel(type)} ${catalog.nodes.find((node) => node.type === type)?.kind}`;
  const visiblePalette = palette.filter((type) => searchPalette(type).toLowerCase().includes(paletteQuery.trim().toLowerCase()));
  return <Modal title={`Automation builder: ${automation.name}`} onClose={requestClose} focusFirstField={false} className="automation-editor-modal" heading={<div><h2>{automation.name}</h2><span className="draft-badge">Draft r{revision}</span>{dirty && <span className="dirty-badge">Unsaved changes</span>}</div>} headerActions={<><button type="button" disabled={busy || conflict || !dirty || publicHeaderIssues.length > 0} title={publicHeaderIssues.length ? "Fix sensitive public headers before saving" : undefined} onClick={() => void save()}>Save draft</button><button type="button" disabled={busy || publicHeaderIssues.length > 0} title={publicHeaderIssues.length ? "Fix sensitive public headers before validation" : undefined} onClick={() => void validate()}>Validate</button><button type="button" className="primary" disabled={busy || conflict || dirty || revision < 1} onClick={() => void publish()}>Publish</button></>}>
    <div className="automation-status" role="status" aria-live="polite">{busy ? "Request in progress. Editing and closing are temporarily locked." : status}</div><ErrorNotice error={error} />
    {conflict && <section className="notice"><p>Your local graph has not been discarded. Saving and publishing are blocked until you explicitly reload the server draft.</p><details><summary>Local graph JSON for comparison or copying before discard</summary><textarea aria-label="Local graph JSON" readOnly rows={8} value={JSON.stringify(graph, null, 2)} /></details><button type="button" disabled={busy} onClick={() => void reload()}>Discard local graph and reload</button></section>}
    <div inert={busy} aria-busy={busy}>
    <div className="automation-mobile-tabs" role="tablist" aria-label="Builder panels">{(["palette", "canvas", "inspector"] as const).map((value) => <button type="button" role="tab" aria-selected={panel === value} key={value} onClick={() => setPanel(value)}>{label(value)}</button>)}</div>
    <div className="automation-builder">
      <aside className={`automation-palette panel-${panel}`} aria-label="Node palette"><label>Search nodes<input type="search" placeholder="HTTP, condition..." value={paletteQuery} onChange={(event) => setPaletteQuery(event.target.value)} /></label><p className="muted">Choose a node to add it after the current selection. Dragging is optional.</p>{visiblePalette.map((type) => <button type="button" key={type} disabled={type === "update_item" && !updateItemSupported(graph)} title={type === "update_item" && !updateItemSupported(graph) ? "Requires an item created or item updated trigger" : undefined} onClick={() => add(type)}><span>{catalog.nodes.find((node) => node.type === type)?.kind}</span><strong>{nodeLabel(type)}</strong>{type === "update_item" && !updateItemSupported(graph) && <small>Requires item trigger</small>}</button>)}{!visiblePalette.length && <p className="muted" role="status">No nodes match that search.</p>}</aside>
      <section className={`automation-canvas panel-${panel}`} aria-label="Automation graph canvas"><ReactFlow nodes={flowNodes} edges={flowEdges(graph)} nodeTypes={nodeTypes} fitView minZoom={0.25} maxZoom={1.8} nodesDraggable={!busy} nodesConnectable={!busy} nodesFocusable edgesFocusable elementsSelectable deleteKeyCode={busy ? null : ["Backspace", "Delete"]} onNodeClick={(_, node) => setSelectedId(node.id)} onNodesChange={(changes: NodeChange<FlowNode>[]) => { if (pending.current) return; let next = graph; for (const change of changes) { if (change.type === "select" && change.selected) setSelectedId(change.id); if (change.type === "position" && change.position) next = { ...next, nodes: next.nodes.map((node) => node.id === change.id ? { ...node, position: change.position! } : node) }; if (change.type === "remove") next = deleteNode(next, change.id); } if (next !== graph) update(next); }} onEdgesChange={(changes: EdgeChange[]) => { if (pending.current) return; const edgeIds = new Set(changes.filter((change) => change.type === "remove").map((change) => change.id)); if (edgeIds.size === 0) return; const next = removeEdges(graph, edgeIds); if (next === graph) { setStatus("Connection removal rejected because it would break a required branch or make a node unreachable."); return; } update(next); setStatus(`${edgeIds.size === 1 ? "Connection" : "Connections"} removed.`); }} onConnect={(connection: Connection) => { if (pending.current || !connection.source || !connection.target) return; const next = connectNodes(graph, connection.source, connection.target, connection.sourceHandle ?? undefined); if (next === graph) setStatus("Connection rejected because it would create a cycle, replace a required branch, or orphan an existing path. Delete or restructure that path explicitly first."); else { update(next); setStatus("Nodes connected."); } }}><Background /><MiniMap pannable zoomable /><Controls showInteractive={false} /></ReactFlow></section>
      <div className={`automation-inspector-wrap panel-${panel}`}><Inspector graph={graph} selectedId={selectedId} catalog={catalog} credentials={credentials} members={members} errors={nodeErrors(selectedId)} onChange={update} onSelect={setSelectedId} onDelete={() => { const next = deleteNode(graph, selectedId); update(next); setSelectedId(next.nodes[0]!.id); }} onAdd={add} onStatus={setStatus} /></div>
    </div>
    <section className="automation-outline" aria-labelledby="outline-heading"><div><h3 id="outline-heading">Accessible graph outline</h3><p className="muted">Select, connect, reorder visually, or edit every branch without pointer dragging.</p></div><ol>{graph.nodes.map((node) => <li key={node.id}><button type="button" aria-pressed={selectedId === node.id} onClick={() => { setSelectedId(node.id); setPanel("inspector"); }}><strong>{nodeLabel(node.type)}</strong><span>{nodeSummary(node)}</span></button></li>)}</ol></section>
    {displayedErrors.length > 0 && <section className="validation-summary" aria-labelledby="validation-heading"><h3 id="validation-heading">Validation issues</h3><ul>{displayedErrors.map((entry) => { const matched = graph.nodes.find((node) => entry.includes(node.id)); return <li key={entry}><button type="button" onClick={() => { if (matched) { setSelectedId(matched.id); setPanel("inspector"); } }}>{entry}</button></li>; })}</ul></section>}
    <section className="preview-panel"><label>Dry preview event JSON<textarea rows={3} value={previewEvent} onChange={(event) => setPreviewEvent(event.target.value)} /></label><button type="button" disabled={busy || publicHeaderIssues.length > 0} title={publicHeaderIssues.length ? "Fix sensitive public headers before previewing" : undefined} onClick={() => void runPreview()}>Preview path, no effects</button>{preview?.valid && <><p className={preview.uncertain ? "preview-uncertain" : "preview-confirmed"}><strong>{preview.uncertain ? "Potential path only." : "Confirmed preview path."}</strong> {preview.uncertain ? "Some template or branch values cannot be resolved from this sample event; no effects were executed." : "All shown branches were resolved from this sample event; no effects were executed."}</p><ol>{preview.path.map((entry) => <li key={entry.nodeId}>{nodeLabel(entry.type)}{entry.branch ? ` → ${entry.branch}` : ""}{entry.uncertain ? ` (unresolved${entry.candidateBranches?.length ? `; candidates: ${entry.candidateBranches.join(", ")}` : ""})` : ""}</li>)}</ol></>}</section>
    </div>
  </Modal>;
}

type SecretDraft = Record<string, string>;
const credentialHeaderName = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const forbiddenCredentialHeaders = new Set(["host", "content-length", "connection", "transfer-encoding", "upgrade", "te", "trailer", "keep-alive", "proxy-authorization"]);

function customSecretHeaders(value: string): Record<string, string> {
  const headers: Record<string, string> = {};
  const names = new Set<string>();
  for (const [index, line] of value.split("\n").entries()) {
    if (!line.trim()) continue;
    const colon = line.indexOf(":");
    const name = colon > 0 ? line.slice(0, colon).trim() : "";
    const normalized = name.toLowerCase();
    if (!credentialHeaderName.test(name)) throw new Error(`Secret header line ${index + 1} needs a valid HTTP header name followed by a colon.`);
    if (forbiddenCredentialHeaders.has(normalized)) throw new Error(`Secret header ${name} cannot be set by a credential.`);
    if (names.has(normalized)) throw new Error(`Secret header ${name} is duplicated.`);
    names.add(normalized);
    headers[name] = line.slice(colon + 1).trim();
  }
  if (!Object.keys(headers).length) throw new Error("Add at least one secret header in Name: value format.");
  return headers;
}

function secretPayload(type: AutomationCredentialType, fields: SecretDraft) {
  if (type === "bearer") return { token: fields.token };
  if (type === "api_key") return { name: fields.keyName, value: fields.value };
  if (type === "basic") return { username: fields.username, password: fields.password };
  if (type === "custom_headers") return { headers: customSecretHeaders(fields.headers || "") };
  return { authorizationUrl: fields.authorizationUrl, tokenUrl: fields.tokenUrl, clientId: fields.clientId, ...(fields.clientSecret ? { clientSecret: fields.clientSecret } : {}), scopes: (fields.scopes || "").split(/\s+/).filter(Boolean) };
}

function CredentialDialog({ credential, busy, onClose, onSave }: { credential?: AutomationCredential; busy: boolean; onClose: () => void; onSave: (payload: unknown) => Promise<void> }) {
  const [name, setName] = useState(credential?.name ?? "");
  const [type, setType] = useState<AutomationCredentialType>(credential?.type ?? "bearer");
  const [origin, setOrigin] = useState(credential?.origin ?? "https://");
  const [pathPrefix, setPathPrefix] = useState(credential?.pathPrefix ?? "");
  const [fields, setFields] = useState<SecretDraft>({});
  const [error, setError] = useState("");
  const field = (key: string, title: string, inputType = "password", required = true) => <label>{title}<input required={required} type={inputType} autoComplete="new-password" value={fields[key] ?? ""} onChange={(event) => setFields((current) => ({ ...current, [key]: event.target.value }))} /></label>;
  const submit = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError("");
    try {
      const secret = secretPayload(type, fields);
      await onSave(credential ? { expectedVersion: credential.version, name: name.trim(), secret } : { name: name.trim(), type, origin, pathPrefix: pathPrefix || null, secret });
    } catch (cause) {
      setError(message(cause));
    }
  };
  return <Modal title={credential ? `Replace ${credential.name}` : "Add credential"} onClose={onClose}><form className="stack" onSubmit={(event) => void submit(event)}><p className="notice">Secrets are write-only and are never prefilled. Origin must be exactly scheme, host, and optional port. Path prefix further limits where this profile may be sent, for example <code>/api/team</code>.</p><ErrorNotice error={error} /><label>Name<input required maxLength={120} value={name} onChange={(event) => setName(event.target.value)} /></label>{!credential && <><label>Type<select value={type} onChange={(event) => { setType(event.target.value as AutomationCredentialType); setFields({}); setError(""); }}>{["bearer", "api_key", "basic", "custom_headers", "oauth2"].map((value) => <option key={value} value={value}>{label(value)}</option>)}</select></label><label>Exact origin<input required type="url" placeholder="https://api.example.com" value={origin} onChange={(event) => setOrigin(event.target.value)} /></label><label>Optional path prefix<input placeholder="/v1/team" value={pathPrefix} onChange={(event) => setPathPrefix(event.target.value)} /></label></>}{type === "bearer" && field("token", "Bearer token")}{type === "api_key" && <>{field("keyName", "API key header name", "text")}{field("value", "API key value")}<p className="view-help">API keys are sent as headers only.</p></>}{type === "basic" && <>{field("username", "Username", "text")}{field("password", "Password")}</>}{type === "custom_headers" && <label>Secret headers, one Name: value per line<textarea required rows={5} value={fields.headers ?? ""} onChange={(event) => setFields((current) => ({ ...current, headers: event.target.value }))} /></label>}{type === "oauth2" && <>{field("authorizationUrl", "Authorization URL", "url")}{field("tokenUrl", "Token URL", "url")}{field("clientId", "Client ID", "text")}{field("clientSecret", "Client secret (optional)", "password", false)}<label>Scopes, space separated<input value={fields.scopes ?? ""} onChange={(event) => setFields((current) => ({ ...current, scopes: event.target.value }))} /></label></>}<div className="modal-actions"><button type="button" onClick={onClose}>Cancel</button><button className="primary" disabled={busy}>{credential ? "Replace secret" : "Create profile"}</button></div></form></Modal>;
}

function Credentials({ wid, credentials, onChange }: { wid: string; credentials: AutomationCredential[]; onChange: (rows: AutomationCredential[]) => void }) {
  const base = `${workspacePath(wid)}/automations/credentials`;
  const [dialog, setDialog] = useState<AutomationCredential | "new" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const refresh = () => api<AutomationCredential[]>(base, "GET").then(onChange);
  async function mutate(operation: () => Promise<unknown>) { setBusy(true); setError(""); try { await operation(); await refresh(); setDialog(null); } catch (cause) { setError(message(cause)); } finally { setBusy(false); } }
  async function save(payload: unknown) { setBusy(true); setError(""); try { if (dialog === "new") await api(base, "POST", payload); else if (dialog) await api(`${base}/${dialog.id}`, "PUT", payload); await refresh(); setDialog(null); } catch (cause) { throw cause; } finally { setBusy(false); } }
  async function oauth(credential: AutomationCredential) { setBusy(true); setError(""); try { const result = await api<{ authorizationUrl: string }>(`${base}/${credential.id}/oauth/start`, "POST"); window.location.assign(result.authorizationUrl); } catch (cause) { setError(message(cause)); setBusy(false); } }
  return <section className="settings-section" aria-labelledby="credentials-heading"><div className="section-intro"><h2 id="credentials-heading">Automation credentials</h2><p>Write-only authentication profiles bound to an exact destination origin and optional path. Values are encrypted by the server and never returned here.</p></div><ErrorNotice error={error} /><ul className="record-list">{credentials.map((credential) => <li key={credential.id}><div><strong>{credential.name}</strong><small className="muted">{label(credential.type)} · {credential.origin}{credential.pathPrefix || ""} · version {credential.version}</small></div><div className="button-group"><span className={credential.status === "active" ? "count ok" : "count"}>{label(credential.status)}</span>{credential.status === "active" && <><button type="button" disabled={busy} onClick={() => setDialog(credential)}>Replace</button>{credential.type === "oauth2" && <button type="button" disabled={busy} onClick={() => void oauth(credential)}>Connect / reconnect</button>}<button type="button" className="danger" disabled={busy} onClick={() => { if (window.confirm(`Revoke credential "${credential.name}"? Published versions may stop working.`)) void mutate(() => api(`${base}/${credential.id}`, "DELETE")); }}>Revoke</button></>}</div></li>)}</ul>{!credentials.length && <p className="muted">No credential profiles yet.</p>}<button type="button" onClick={() => setDialog("new")}>Add credential</button>{dialog && <CredentialDialog credential={dialog === "new" ? undefined : dialog} busy={busy} onClose={() => setDialog(null)} onSave={save} />}</section>;
}

export function CredentialManager({ wid }: { wid: string }) {
  const [credentials, setCredentials] = useState<AutomationCredential[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    api<AutomationCredential[]>(`${workspacePath(wid)}/automations/credentials`, "GET", undefined, controller.signal)
      .then(setCredentials)
      .catch((cause) => { if (!controller.signal.aborted) setError(message(cause)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [wid]);
  if (loading) return <Loading />;
  return <><ErrorNotice error={error} /><Credentials wid={wid} credentials={credentials} onChange={setCredentials} /></>;
}

function RunOutput({ output }: { output: string }) {
  const rows = runOutputRows(output);
  if (!rows) return <p><strong>Sanitized output:</strong> {output}</p>;
  return <dl className="run-output-summary">{rows.map((row) => <div key={row.label}><dt>{row.label}</dt><dd>{row.value}</dd></div>)}</dl>;
}

function RunMonitor({ wid, automations, refreshKey }: { wid: string; automations: Automation[]; refreshKey: number }) {
  const base = `${workspacePath(wid)}/automations/runs`;
  const [runs, setRuns] = useState<AutomationRun[]>([]);
  const [status, setStatus] = useState("");
  const [automationId, setAutomationId] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => { const query = new URLSearchParams({ limit: "30" }); if (status) query.set("status", status); if (automationId) query.set("automationId", automationId); try { const next = await api<AutomationRun[]>(`${base}?${query}`, "GET", undefined, controller.signal); if (controller.signal.aborted) return; setRuns(next); setError(""); if (next.some((run) => run.status === "pending" || run.status === "running")) timer = setTimeout(() => void load(), 2000); } catch (cause) { if (!controller.signal.aborted) setError(message(cause)); } finally { if (!controller.signal.aborted) setLoading(false); } };
    setLoading(true); void load();
    return () => { controller.abort(); if (timer) clearTimeout(timer); };
  }, [base, status, automationId, refreshKey]);
  return <section className="settings-section" aria-labelledby="job-monitor-heading"><div className="section-intro"><h2 id="job-monitor-heading">Run monitor</h2><p>Recent bounded, server-sanitized run details. Active runs refresh until completion; leaving this view aborts polling.</p></div><div className="run-filters"><label>Status<select value={status} onChange={(event) => setStatus(event.target.value)}><option value="">All statuses</option>{["pending", "running", "delivered", "failed"].map((value) => <option key={value}>{value}</option>)}</select></label><label>Automation<select value={automationId} onChange={(event) => setAutomationId(event.target.value)}><option value="">All targets</option>{automations.map((automation) => <option key={automation.id} value={automation.id}>{automation.name}</option>)}</select></label></div><ErrorNotice error={error} />{loading && !runs.length ? <Loading /> : <ul className="record-list compact">{runs.map((run) => <li key={run.id}><details className="run-log"><summary><strong className={run.status}>{run.status}</strong> {run.targetType === "automation" ? automations.find((entry) => entry.id === run.targetId)?.name ?? "Unavailable automation" : `Webhook ${run.targetId}`} <span className="muted">· {new Date(run.createdAt).toLocaleString()}</span></summary><div className="stack"><p>{run.detail || "No run detail recorded yet."}</p>{run.nodes?.length > 0 ? <ol className="node-run-list">{run.nodes.map((node) => <li key={node.id}><strong>{nodeLabel(node.type)} · {node.nodeId}</strong> <span className={node.status}>{node.status}</span>{node.log && <p><strong>Sanitized log:</strong> {node.log}</p>}{node.output && <RunOutput output={node.output} />}</li>)}</ol> : run.steps?.length > 0 && <ol>{run.steps.map((step) => <li key={step.id}><strong>Step {step.position}: {label(step.type)}</strong> <span className={step.status}>{step.status}</span>{step.log && <p><strong>Sanitized log:</strong> {step.log}</p>}{step.output && <RunOutput output={step.output} />}</li>)}</ol>}</div></details></li>)}</ul>}</section>;
}

export default function AutomationWorkspace({ detail, revision }: { detail: Detail; revision: number }) {
  const wid = detail.workspace.id;
  const base = `${workspacePath(wid)}/automations`;
  const [rows, setRows] = useState<Automation[]>([]);
  const [catalog, setCatalog] = useState<AutomationCatalog | null>(null);
  const [credentials, setCredentials] = useState<AutomationCredential[]>([]);
  const [editing, setEditing] = useState<Automation | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [runRefresh, setRunRefresh] = useState(0);
  const refresh = async () => { const [automations, credentialRows] = await Promise.all([api<Automation[]>(base, "GET"), api<AutomationCredential[]>(`${base}/credentials`, "GET")]); setRows(automations); setCredentials(credentialRows); };
  useEffect(() => { const controller = new AbortController(); setLoading(true); Promise.all([api<Automation[]>(base, "GET", undefined, controller.signal), api<AutomationCatalog>(`${base}/catalog`, "GET", undefined, controller.signal), api<AutomationCredential[]>(`${base}/credentials`, "GET", undefined, controller.signal)]).then(([automations, loadedCatalog, credentialRows]) => { setRows(automations); setCatalog(loadedCatalog); setCredentials(credentialRows); }).catch((cause) => { if (!controller.signal.aborted) setError(message(cause)); }).finally(() => { if (!controller.signal.aborted) setLoading(false); }); return () => controller.abort(); }, [base, revision]);
  async function mutate(operation: () => Promise<unknown>) { setBusy(true); setError(""); try { await operation(); await refresh(); return true; } catch (cause) { setError(message(cause)); return false; } finally { setBusy(false); } }
  async function create(event: SubmitEvent<HTMLFormElement>) { event.preventDefault(); if (createBusy) return; setCreateBusy(true); setCreateError(""); try { const automation = await api<Automation>(base, "POST", { name: name.trim(), event: "item.updated", enabled: false, steps: [{ type: "log", config: { message: "Automation started" } }] }); setRows((current) => [...current, automation]); setCreating(false); setName(""); setEditing(automation); } catch (cause) { setCreateError(message(cause)); } finally { setCreateBusy(false); } }
  if (loading) return <Loading />;
  return <><section className="settings-section" aria-labelledby="automations-heading"><div className="section-intro"><h2 id="automations-heading">Automations</h2><p>Build versioned event graphs with exclusive branches and explicit publishing. New automations start paused so setup cannot trigger accidental effects.</p></div><ErrorNotice error={error} /><ul className="record-list">{rows.map((automation) => { const count = automation.steps?.length ?? (automation.action ? 1 : 0); return <li key={automation.id}><div><strong>{automation.name}</strong><small className="muted">On {eventName(catalog, automation.event)} · {automation.graph ? "published graph" : `${count} legacy step${count === 1 ? "" : "s"}`} · version {automation.version}</small></div><div className="button-group"><span className={automation.enabled ? "count ok" : "count"}>{automation.enabled ? "Enabled" : "Paused"}</span><button type="button" disabled={busy} onClick={() => void mutate(() => api(`${base}/${automation.id}`, "PATCH", { enabled: !automation.enabled }))}>{automation.enabled ? "Pause" : "Resume"}</button><button type="button" disabled={!catalog} onClick={() => setEditing(automation)}>Edit graph</button><button type="button" disabled={busy} onClick={() => { if (window.confirm(`Queue a real test run for "${automation.name}"? Published actions may contact services. No triggering task is supplied, so graphs containing Update task are rejected before effects run.`)) void mutate(() => api(`${base}/${automation.id}/test`, "POST")).then((queued) => { if (queued) setRunRefresh((value) => value + 1); }); }}>Test run</button><button type="button" className="danger" disabled={busy} onClick={() => { if (window.confirm(`Delete automation "${automation.name}" and its run history?`)) void mutate(() => api(`${base}/${automation.id}`, "DELETE")); }}>Delete</button></div></li>; })}</ul>{!rows.length && <p className="muted">No automations yet.</p>}<button type="button" onClick={() => { setCreateError(""); setCreating(true); }}>New automation</button></section>
    <p className="notice">Real tests use the published version without a triggering task. Graphs containing Update task are rejected before effects run; use a dry preview or a real task event instead.</p>
    {detail.permissions.includes("credentials:manage") && <Credentials wid={wid} credentials={credentials} onChange={setCredentials} />}
    <RunMonitor wid={wid} automations={rows} refreshKey={runRefresh} />
    {creating && <Modal title="Start a graph automation" onClose={() => { if (!createBusy) setCreating(false); }}><form className="stack" onSubmit={(event) => void create(event)}><p className="notice">This creates a paused starter automation and opens its graph draft immediately. Nothing is enabled by creating it.</p><ErrorNotice error={createError} /><label>Name<input required maxLength={120} disabled={createBusy} value={name} onChange={(event) => setName(event.target.value)} /></label><div className="modal-actions"><button type="button" disabled={createBusy} onClick={() => setCreating(false)}>Cancel</button><button className="primary" disabled={createBusy}>{createBusy ? "Creating…" : "Create and open builder"}</button></div></form></Modal>}
    {editing && catalog && <GraphEditor key={`${wid}:${editing.id}`} wid={wid} automation={editing} catalog={catalog} credentials={credentials} members={detail.members} onClose={() => setEditing(null)} onPublished={() => { void refresh().catch((cause) => setError(message(cause))); }} />}
  </>;
}
