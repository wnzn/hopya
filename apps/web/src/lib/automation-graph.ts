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

function randomId(): string {
  try {
    return globalThis.crypto.randomUUID();
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }
}

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

export function nodeBranches(node: AutomationGraphNode): string[] {
  if (node.type === "condition") return ["true", "false"];
  if (node.type !== "switch") return [];
  const cases = (node.config.cases as { branch: string }[] | undefined) ?? [];
  return [...new Set([...cases.map((entry) => entry.branch), node.config.defaultBranch].filter((branch): branch is string => typeof branch === "string" && branch.length > 0))];
}

export function flowEdges(graph: AutomationGraph) {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  return graph.edges.map((edge) => ({ ...edge, type: byId.get(edge.source)?.type === "condition" ? "smoothstep" : "straight", ...(edge.branch ? { sourceHandle: edge.branch, label: edge.branch } : {}) }));
}

export function topToBottomGraph(graph: AutomationGraph): AutomationGraph {
  const trigger = graph.nodes.find((node) => node.type === "trigger");
  if (!trigger) return graph;
  const depths = new Map([[trigger.id, 0]]);
  for (let pass = 0; pass < graph.nodes.length; pass++) {
    for (const edge of graph.edges) {
      const sourceDepth = depths.get(edge.source);
      if (sourceDepth !== undefined) depths.set(edge.target, Math.max(depths.get(edge.target) ?? 0, sourceDepth + 1));
    }
  }
  const levels = new Map<number, AutomationGraphNode[]>();
  for (const node of graph.nodes) {
    const depth = depths.get(node.id);
    if (depth === undefined) continue;
    levels.set(depth, [...levels.get(depth) ?? [], node]);
  }
  const positions = new Map<string, { x: number; y: number }>();
  for (const [depth, nodes] of levels) {
    nodes.sort((a, b) => a.position.x - b.position.x);
    nodes.forEach((node, index) => positions.set(node.id, {
      x: trigger.position.x + (index - (nodes.length - 1) / 2) * 280,
      y: trigger.position.y + depth * 220,
    }));
  }
  let changed = false;
  const nodes = graph.nodes.map((node) => {
    const position = positions.get(node.id);
    if (!position || (position.x === node.position.x && position.y === node.position.y)) return node;
    changed = true;
    return { ...node, position };
  });
  return changed ? { ...graph, nodes } : graph;
}

export function changeSwitchBranch(graph: AutomationGraph, nodeId: string, index: number | "default", value: string | null): AutomationGraph {
  const node = graph.nodes.find((entry) => entry.id === nodeId);
  if (!node || node.type !== "switch") return graph;
  const cases = (node.config.cases as { branch: string; value: unknown }[] | undefined) ?? [];
  const previous = index === "default" ? node.config.defaultBranch : cases[index]?.branch;
  if (typeof previous !== "string" || value === previous) return graph;
  if (value === null ? index === "default" || cases.length <= 1 : !value.trim() || value.length > 100 || nodeBranches(node).includes(value)) return graph;
  const config = index === "default" ? { ...node.config, defaultBranch: value } : {
    ...node.config,
    cases: value === null ? cases.filter((_, i) => i !== index) : cases.map((entry, i) => i === index ? { ...entry, branch: value } : entry),
  };
  const updated = { ...node, config };
  // A case and default may share one route; renaming one must preserve the other.
  const shared = nodeBranches(updated).includes(previous);
  const next = {
    nodes: graph.nodes.map((entry) => entry.id === nodeId ? updated : entry),
    edges: graph.edges.flatMap((edge) => {
      if (edge.source !== nodeId || edge.branch !== previous) return [edge];
      return [...(shared ? [edge] : []), ...(value === null ? [] : [{ ...edge, id: shared ? `edge-${randomId()}` : edge.id, branch: value }])];
    }),
  };
  const trigger = graph.nodes.find((entry) => entry.type === "trigger");
  if (next.edges.length > 75 || !trigger || next.nodes.some((entry) => !reaches(next, trigger.id, entry.id))) return graph;
  return next;
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
  if (source === target || !graph.nodes.some((node) => node.id === source) || !graph.nodes.some((node) => node.id === target && node.type !== "trigger")) return graph;
  if (reaches(graph, target, source)) return graph;
  const sourceNode = graph.nodes.find((node) => node.id === source)!;
  if (sourceNode.type === "condition" || sourceNode.type === "switch") {
    if (!branch || !nodeBranches(sourceNode).includes(branch)) return graph;
  } else if (branch !== undefined) return graph;
  const replace = sourceNode.type === "condition" || sourceNode.type === "switch"
    ? (edge: AutomationGraph["edges"][number]) => edge.source === source && edge.branch === branch
    : (edge: AutomationGraph["edges"][number]) => edge.source === source;
  const displaced = graph.edges.filter(replace);
  const edges = graph.edges.filter((edge) => !replace(edge));
  const next = { ...graph, edges: [...edges, { id: `edge-${randomId()}`, source, target, ...(branch ? { branch } : {}) }] };
  const trigger = graph.nodes.find((node) => node.type === "trigger");
  if (trigger && displaced.some((edge) => !reaches(next, trigger.id, edge.target))) return graph;
  return next;
}

export function setNextNode(graph: AutomationGraph, source: string, target: string, branch?: string): AutomationGraph {
  const sourceNode = graph.nodes.find((node) => node.id === source);
  if (!sourceNode) return graph;
  const branches = nodeBranches(sourceNode);
  if (branches.length ? !branch || !branches.includes(branch) : branch !== undefined) return graph;
  const matchesSlot = (edge: AutomationGraph["edges"][number]) => edge.source === source && edge.branch === branch;
  const current = graph.edges.find(matchesSlot);
  if ((current?.target ?? "") === target) return graph;
  const edges = graph.edges.filter((edge) => !matchesSlot(edge));
  if (!target) return { ...graph, edges };
  if (target === source || !graph.nodes.some((node) => node.id === target && node.type !== "trigger")) return graph;
  const withoutCurrent = { ...graph, edges };
  if (reaches(withoutCurrent, target, source)) return graph;
  return { ...graph, edges: [...edges, { id: current?.id ?? `edge-${randomId()}`, source, target, ...(branch ? { branch } : {}) }] };
}

function swapAdjacent(graph: AutomationGraph, firstId: string, secondId: string): AutomationGraph {
  const first = graph.nodes.find((node) => node.id === firstId);
  const second = graph.nodes.find((node) => node.id === secondId);
  if (!first || !second || first.type === "trigger" || nodeBranches(first).length || nodeBranches(second).length) return graph;
  const between = graph.edges.filter((edge) => edge.source === firstId && edge.target === secondId);
  const firstIncoming = graph.edges.filter((edge) => edge.target === firstId);
  const firstOutgoing = graph.edges.filter((edge) => edge.source === firstId);
  const secondIncoming = graph.edges.filter((edge) => edge.target === secondId);
  const secondOutgoing = graph.edges.filter((edge) => edge.source === secondId);
  if (between.length !== 1 || firstIncoming.length !== 1 || firstOutgoing.length !== 1 || secondIncoming.length !== 1 || secondOutgoing.length > 1) return graph;
  const incomingId = firstIncoming[0]!.id;
  const betweenId = between[0]!.id;
  const outgoingId = secondOutgoing[0]?.id;
  return {
    ...graph,
    edges: graph.edges.map((edge) => {
      if (edge.id === incomingId) return { ...edge, target: secondId };
      if (edge.id === betweenId) return { ...edge, source: secondId, target: firstId };
      if (edge.id === outgoingId) return { ...edge, source: firstId };
      return edge;
    }),
  };
}

export function moveNode(graph: AutomationGraph, nodeId: string, direction: "earlier" | "later"): AutomationGraph {
  if (direction === "earlier") {
    const incoming = graph.edges.filter((edge) => edge.target === nodeId);
    return incoming.length === 1 ? swapAdjacent(graph, incoming[0]!.source, nodeId) : graph;
  }
  const outgoing = graph.edges.filter((edge) => edge.source === nodeId);
  return outgoing.length === 1 ? swapAdjacent(graph, nodeId, outgoing[0]!.target) : graph;
}

export function insertNode(graph: AutomationGraph, type: Exclude<AutomationNodeType, "trigger">, afterId: string, requestedBranch?: string): { graph: AutomationGraph; id: string | null } {
  const after = graph.nodes.find((node) => node.id === afterId) ?? graph.nodes[0]!;
  const controlBranches = nodeBranches(after);
  const branch = controlBranches.length
    ? requestedBranch && controlBranches.includes(requestedBranch) ? requestedBranch : controlBranches.find((candidate) => !graph.edges.some((edge) => edge.source === after.id && edge.branch === candidate))
    : undefined;
  if (controlBranches.length && !branch) return { graph, id: null };
  const outgoing = graph.edges.find((edge) => edge.source === after.id && (controlBranches.length ? edge.branch === branch : edge.branch === undefined));
  const id = `${type}-${randomId()}`;
  const branchIndex = branch ? controlBranches.indexOf(branch) : -1;
  const x = branchIndex < 0 ? after.position.x : after.position.x + (branchIndex - (controlBranches.length - 1) / 2) * 280;
  const node: AutomationGraphNode = { id, type, position: { x, y: after.position.y + 220 }, config: defaultConfig(type) };
  const successorBranch = type === "condition" ? "false" : type === "switch" ? String(node.config.defaultBranch) : undefined;
  const retainedEdges = outgoing ? graph.edges.filter((edge) => edge.id !== outgoing.id) : graph.edges;
  const next: AutomationGraph = {
    nodes: [...graph.nodes, node],
    edges: [
      ...retainedEdges,
      { id: `edge-${randomId()}`, source: after.id, target: id, ...(branch ? { branch } : {}) },
      ...(outgoing ? [{ id: `edge-${randomId()}`, source: id, target: outgoing.target, ...(successorBranch ? { branch: successorBranch } : {}) }] : []),
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
