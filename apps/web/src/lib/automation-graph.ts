import type {
  AutomationCatalog,
  AutomationDataDescriptor,
  AutomationGraph,
  AutomationGraphNode,
  AutomationNodeType,
} from "./api";

export type DataChoice = { label: string; type: string; value: string; rawPath?: string };

const sensitivePublicHeaders = new Set([
  "authorization", "proxy-authorization", "cookie", "set-cookie", "host", "content-length", "connection", "transfer-encoding",
  "upgrade", "te", "trailer", "keep-alive", "x-api-key", "api-key", "apikey", "x-auth-token", "x-access-token",
]);

export function publicHeaderNameError(name: string): string | null {
  return sensitivePublicHeaders.has(name.trim().toLowerCase())
    ? `"${name}" is sensitive or hop-by-hop. Remove it and use an authentication profile for secret headers.`
    : null;
}

export function updateItemSupported(graph: AutomationGraph): boolean {
  const event = graph.nodes.find((node) => node.type === "trigger")?.config.event;
  return event === "item.created" || event === "item.updated";
}

function descriptorLeaves(descriptor: Record<string, AutomationDataDescriptor>, prefix = ""): { path: string; type: string }[] {
  const leaves: { path: string; type: string }[] = [];
  for (const [key, value] of Object.entries(descriptor)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") leaves.push({ path, type: value });
    else leaves.push(...descriptorLeaves(value, path));
  }
  return leaves;
}

export const nodeLabel = (type: AutomationNodeType) => ({
  trigger: "Trigger",
  http: "HTTP request",
  webhook: "Webhook request",
  email: "Email",
  log: "Log",
  update_item: "Update task",
  condition: "Condition",
  switch: "Switch",
})[type];

export function defaultConfig(type: AutomationNodeType): Record<string, unknown> {
  if (type === "trigger") return { event: "item.updated" };
  if (type === "http") return { url: "", method: "POST", headers: {} };
  if (type === "webhook") return { url: "", method: "POST", headers: {} };
  if (type === "email") return { to: [], subject: "" };
  if (type === "log") return { message: "" };
  if (type === "update_item") return { patch: {} };
  if (type === "condition") return { path: "item.status", operator: "equals", value: "" };
  return { path: "item.status", cases: [{ branch: "case-1", value: "" }], defaultBranch: "default" };
}

export function createGraph(event = "item.updated"): AutomationGraph {
  return { nodes: [{ id: "trigger", type: "trigger", position: { x: 80, y: 180 }, config: { event } }], edges: [] };
}

export function reaches(graph: AutomationGraph, source: string, target: string): boolean {
  const seen = new Set<string>();
  const visit = (id: string): boolean => {
    if (id === target) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    return graph.edges.some((edge) => edge.source === id && visit(edge.target));
  };
  return visit(source);
}

export function dominators(graph: AutomationGraph): Map<string, Set<string>> {
  const trigger = graph.nodes.find((node) => node.type === "trigger");
  if (!trigger) return new Map();
  const incoming = new Map<string, string[]>();
  for (const edge of graph.edges) incoming.set(edge.target, [...incoming.get(edge.target) ?? [], edge.source]);
  const result = new Map<string, Set<string>>([[trigger.id, new Set([trigger.id])]]);
  const unresolved = new Set(graph.nodes.map((node) => node.id).filter((id) => id !== trigger.id));
  while (unresolved.size) {
    let changed = false;
    for (const id of unresolved) {
      const predecessors = incoming.get(id) ?? [];
      if (!predecessors.length || predecessors.some((source) => !result.has(source))) continue;
      const intersection = new Set(result.get(predecessors[0]!)!);
      for (const source of predecessors.slice(1)) for (const candidate of intersection) if (!result.get(source)!.has(candidate)) intersection.delete(candidate);
      intersection.add(id);
      result.set(id, intersection);
      unresolved.delete(id);
      changed = true;
    }
    if (!changed) break;
  }
  return result;
}

export function connectNodes(graph: AutomationGraph, source: string, target: string, branch?: string): AutomationGraph {
  if (source === target || target === "trigger" || !graph.nodes.some((node) => node.id === source) || !graph.nodes.some((node) => node.id === target)) return graph;
  if (reaches(graph, target, source)) return graph;
  const sourceNode = graph.nodes.find((node) => node.id === source)!;
  const replace = sourceNode.type === "condition" || sourceNode.type === "switch"
    ? (edge: AutomationGraph["edges"][number]) => edge.source === source && edge.branch === branch
    : (edge: AutomationGraph["edges"][number]) => edge.source === source;
  const displaced = graph.edges.filter(replace);
  const edges = graph.edges.filter((edge) => !replace(edge));
  const next = { ...graph, edges: [...edges, { id: `edge-${crypto.randomUUID()}`, source, target, ...(branch ? { branch } : {}) }] };
  const trigger = graph.nodes.find((node) => node.type === "trigger");
  if (trigger && displaced.some((edge) => !reaches(next, trigger.id, edge.target))) return graph;
  return next;
}

export function insertNode(graph: AutomationGraph, type: Exclude<AutomationNodeType, "trigger">, afterId: string, requestedBranch?: string): { graph: AutomationGraph; id: string | null } {
  const after = graph.nodes.find((node) => node.id === afterId) ?? graph.nodes[0]!;
  const controlBranches = after.type === "condition" ? ["true", "false"] : after.type === "switch"
    ? [...((after.config.cases as { branch?: string }[] | undefined) ?? []).map((entry) => entry.branch).filter((branch): branch is string => Boolean(branch)), String(after.config.defaultBranch ?? "").trim()].filter(Boolean)
    : [];
  const branch = controlBranches.length
    ? requestedBranch && controlBranches.includes(requestedBranch) ? requestedBranch : controlBranches.find((candidate) => !graph.edges.some((edge) => edge.source === after.id && edge.branch === candidate))
    : undefined;
  if (controlBranches.length && !branch) return { graph, id: null };
  const outgoing = graph.edges.find((edge) => edge.source === after.id && (controlBranches.length ? edge.branch === branch : edge.branch === undefined));
  const id = `${type}-${crypto.randomUUID()}`;
  const node: AutomationGraphNode = { id, type, position: { x: after.position.x + 280, y: after.position.y }, config: defaultConfig(type) };
  const retainedEdges = outgoing ? graph.edges.filter((edge) => edge.id !== outgoing.id) : graph.edges;
  const next: AutomationGraph = {
    nodes: [...graph.nodes, node],
    edges: [
      ...retainedEdges,
      { id: `edge-${crypto.randomUUID()}`, source: after.id, target: id, ...(branch ? { branch } : {}) },
      ...(outgoing ? [{ id: `edge-${crypto.randomUUID()}`, source: id, target: outgoing.target }] : []),
    ],
  };
  return { graph: next, id };
}

export function removeEdges(graph: AutomationGraph, edgeIds: Set<string>): AutomationGraph {
  const next = { ...graph, edges: graph.edges.filter((edge) => !edgeIds.has(edge.id)) };
  if (next.edges.length === graph.edges.length) return graph;
  const trigger = next.nodes.find((node) => node.type === "trigger");
  if (!trigger || next.nodes.some((node) => !reaches(next, trigger.id, node.id))) return graph;
  for (const node of next.nodes) {
    const outgoing = next.edges.filter((edge) => edge.source === node.id);
    if (node.type === "condition" && (outgoing.length !== 2 || !outgoing.some((edge) => edge.branch === "true") || !outgoing.some((edge) => edge.branch === "false"))) return graph;
    if (node.type === "switch") {
      const expected = new Set([...((node.config.cases as { branch?: string }[] | undefined) ?? []).map((entry) => entry.branch).filter((branch): branch is string => Boolean(branch)), String(node.config.defaultBranch ?? "")]);
      if (outgoing.length !== expected.size || [...expected].some((branch) => outgoing.filter((edge) => edge.branch === branch).length !== 1)) return graph;
    }
  }
  return next;
}

export function deleteNode(graph: AutomationGraph, id: string): AutomationGraph {
  const node = graph.nodes.find((entry) => entry.id === id);
  if (!node || node.type === "trigger") return graph;
  const incoming = graph.edges.filter((edge) => edge.target === id);
  const outgoing = graph.edges.filter((edge) => edge.source === id);
  let next: AutomationGraph = { nodes: graph.nodes.filter((entry) => entry.id !== id), edges: graph.edges.filter((edge) => edge.source !== id && edge.target !== id) };
  if (incoming.length === 1 && outgoing.length === 1) next = connectNodes(next, incoming[0]!.source, outgoing[0]!.target, incoming[0]!.branch);
  return next;
}

export function upstreamChoices(graph: AutomationGraph, nodeId: string, catalog: AutomationCatalog): DataChoice[] {
  const trigger = graph.nodes.find((node) => node.type === "trigger");
  const event = catalog.events.find((entry) => entry.type === trigger?.config.event);
  const choices: DataChoice[] = descriptorLeaves(event?.output ?? {}).map(({ path, type }) => ({
    label: `Trigger: ${path}`,
    type,
    value: `{{event.${path}}}`,
    rawPath: path,
  }));
  const manifests = new Map(catalog.nodes.map((node) => [node.type, node]));
  const guaranteed = dominators(graph).get(nodeId) ?? new Set<string>();
  for (const node of graph.nodes) {
    if (node.id === nodeId || node.type === "trigger" || !guaranteed.has(node.id)) continue;
    const outputs = manifests.get(node.type)?.outputs ?? {};
    for (const { path, type } of descriptorLeaves(outputs)) choices.push({
      label: `${nodeLabel(node.type)} (${node.id.slice(0, 12)}): ${path}`,
      type,
      value: `{{nodes.${node.id}.output.${path}}}`,
      rawPath: `nodes.${node.id}.output.${path}`,
    });
  }
  return choices;
}

export type RunOutputRow = { label: string; value: string };

export function runOutputRows(output: string): RunOutputRow[] | null {
  if (!output || output.length > 16_384) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(output); } catch { return null; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const rows: RunOutputRow[] = [];
  const add = (name: string, value: unknown) => {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") rows.push({ label: name, value: String(value) });
  };
  add("Status", record.status);
  add("Body", record.body);
  add("Message", record.message);
  add("Message ID", record.messageId);
  add("Branch", record.branch);
  add("Matched", record.matched);
  add("Truncated", record.truncated);
  add("Encoded preview", record.previewBase64);
  if (record.item && typeof record.item === "object" && !Array.isArray(record.item)) {
    const item = record.item as Record<string, unknown>;
    add("Task", item.title ?? item.id);
    add("Task status", item.status);
    add("Priority", item.priority);
  }
  return rows.length ? rows : null;
}
