import assert from "node:assert/strict";
import test from "node:test";
import type { AutomationCatalog, AutomationGraph } from "./api";
import { changeSwitchBranch, connectNodes, createGraph, flowEdges, insertNode, moveNode, nodeBranches, publicHeaderNameError, reaches, removeEdges, runOutputRows, setNextNode, topToBottomGraph, updateItemSupported, upstreamChoices } from "./automation-graph";

test("graph connections reject cycles and replace ordinary fanout", () => {
  let graph = createGraph();
  const first = insertNode(graph, "log", "trigger"); graph = first.graph;
  const second = insertNode(graph, "http", first.id!); graph = second.graph;
  assert.equal(connectNodes(graph, second.id!, first.id!), graph);
  const replacement = insertNode(graph, "email", "trigger");
  assert.equal(replacement.graph.edges.filter((edge) => edge.source === "trigger").length, 1);
  assert.equal(connectNodes(graph, first.id!, second.id!, "unexpected"), graph);
  const migrated = { ...graph, nodes: graph.nodes.map((node) => node.type === "trigger" ? { ...node, id: "migrated-trigger" } : node), edges: [] };
  assert.equal(connectNodes(migrated, first.id!, "migrated-trigger"), migrated);
});

test("insertion preserves ordinary and selected condition branch successors", () => {
  let graph = createGraph();
  const ordinary = insertNode(graph, "log", "trigger"); graph = ordinary.graph;
  const successor = insertNode(graph, "http", ordinary.id!); graph = successor.graph;
  const inserted = insertNode(graph, "email", ordinary.id!);
  assert.equal(inserted.graph.edges.some((edge) => edge.source === inserted.id && edge.target === successor.id), true);

  const conditionId = "condition-fixed";
  const conditionGraph = {
    nodes: [
      graph.nodes[0]!,
      { id: conditionId, type: "condition" as const, position: { x: 200, y: 0 }, config: { path: "item.status", operator: "equals", value: "done" } },
      { id: "yes", type: "log" as const, position: { x: 400, y: -100 }, config: { message: "yes" } },
      { id: "no", type: "log" as const, position: { x: 400, y: 100 }, config: { message: "no" } },
    ],
    edges: [
      { id: "to-condition", source: "trigger", target: conditionId },
      { id: "true-edge", source: conditionId, target: "yes", branch: "true" },
      { id: "false-edge", source: conditionId, target: "no", branch: "false" },
    ],
  };
  assert.equal(insertNode(conditionGraph, "email", conditionId).id, null);
  const branchInsert = insertNode(conditionGraph, "email", conditionId, "false");
  assert.equal(branchInsert.graph.edges.some((edge) => edge.source === conditionId && edge.target === branchInsert.id && edge.branch === "false"), true);
  assert.equal(branchInsert.graph.edges.some((edge) => edge.source === branchInsert.id && edge.target === "no"), true);

  for (const type of ["condition", "switch"] as const) {
    const control = insertNode(graph, type, ordinary.id!);
    const preservedBranch = type === "condition" ? "false" : "default";
    assert.equal(control.graph.edges.find((edge) => edge.source === control.id)?.branch, preservedBranch);
    assert.equal(control.graph.edges.find((edge) => edge.source === control.id)?.target, successor.id);
    const complete = insertNode(control.graph, "log", control.id!);
    const controlNode = complete.graph.nodes.find((node) => node.id === control.id)!;
    assert.deepEqual(complete.graph.edges.filter((edge) => edge.source === control.id).map((edge) => edge.branch).sort(), nodeBranches(controlNode).sort());
    assert.ok(complete.graph.nodes.every((node) => reaches(complete.graph, "trigger", node.id)));
    assert.equal(connectNodes(complete.graph, control.id!, successor.id!), complete.graph);
    assert.equal(connectNodes(complete.graph, control.id!, successor.id!, "unknown"), complete.graph);
  }
});

test("switch branch edits preserve connections and reject orphaning or colliding changes", () => {
  const graph: AutomationGraph = {
    nodes: [
      ...createGraph().nodes,
      { id: "switch", type: "switch", position: { x: 100, y: 0 }, config: { path: "item.status", cases: [{ branch: "a", value: "todo" }, { branch: "b", value: "done" }], defaultBranch: "default" } },
      { id: "left", type: "log", position: { x: 200, y: 0 }, config: { message: "left" } },
      { id: "right", type: "log", position: { x: 200, y: 100 }, config: { message: "right" } },
    ],
    edges: [
      { id: "root", source: "trigger", target: "switch" },
      { id: "a", source: "switch", target: "left", branch: "a" },
      { id: "b", source: "switch", target: "right", branch: "b" },
      { id: "default", source: "switch", target: "right", branch: "default" },
    ],
  };
  const original = structuredClone(graph);
  const renamed = changeSwitchBranch(graph, "switch", 0, "renamed");
  assert.deepEqual(renamed.edges.find((edge) => edge.id === "a"), { id: "a", source: "switch", target: "left", branch: "renamed" });
  assert.deepEqual(nodeBranches(renamed.nodes[1]!), ["renamed", "b", "default"]);
  const newDefault = changeSwitchBranch(renamed, "switch", "default", "fallback");
  assert.equal(newDefault.edges.find((edge) => edge.id === "default")?.branch, "fallback");
  assert.equal(newDefault.edges.find((edge) => edge.id === "default")?.target, "right");
  assert.equal(changeSwitchBranch(graph, "switch", 0, "default"), graph);
  assert.equal(changeSwitchBranch(graph, "switch", 0, ""), graph);
  assert.equal(changeSwitchBranch(graph, "switch", 0, null), graph, "exclusive downstream action must not be orphaned");
  const removed = changeSwitchBranch(graph, "switch", 1, null);
  assert.deepEqual(nodeBranches(removed.nodes[1]!), ["a", "default"]);
  assert.deepEqual(removed.nodes.filter((node) => node.type === "log"), graph.nodes.filter((node) => node.type === "log"));
  assert.equal(removed.edges.some((edge) => edge.branch === "b"), false);
  assert.equal(changeSwitchBranch(removed, "switch", 0, null), removed, "at least one case must remain");
  assert.deepEqual(graph, original);

  const shared: AutomationGraph = { ...removed, nodes: removed.nodes.map((node) => node.id === "switch" ? { ...node, config: { ...node.config, defaultBranch: "a" } } : node), edges: removed.edges.filter((edge) => edge.branch !== "default").concat({ id: "continue", source: "left", target: "right" }) };
  const split = changeSwitchBranch(shared, "switch", "default", "fallback");
  assert.deepEqual(split.edges.filter((edge) => edge.source === "switch").map((edge) => [edge.branch, edge.target]), [["a", "left"], ["fallback", "left"]]);
  assert.equal(new Set(split.edges.map((edge) => edge.id)).size, split.edges.length);
});

test("flow edges select the matching control handles without changing persisted graph fields", () => {
  for (const type of ["condition", "switch"] as const) {
    const control = insertNode(createGraph(), type, "trigger");
    let graph = insertNode(control.graph, "log", control.id!).graph;
    graph = insertNode(graph, "log", control.id!).graph;
    const original = structuredClone(graph);
    const branches = nodeBranches(graph.nodes.find((node) => node.id === control.id)!);
    const edges = flowEdges(graph);
    assert.ok(edges.filter((edge) => edge.source === control.id).every((edge) => edge.type === (type === "condition" ? "smoothstep" : "straight")));
    assert.equal(edges.find((edge) => edge.source === "trigger")?.type, "straight");
    assert.deepEqual(edges.filter((edge) => edge.source === control.id).map((edge) => edge.sourceHandle), branches);
    assert.deepEqual(edges.filter((edge) => edge.source === control.id).map((edge) => edge.label), branches);
    assert.equal(edges.find((edge) => edge.source === "trigger")?.sourceHandle, undefined);
    assert.deepEqual(graph, original);
    assert.equal(JSON.stringify(graph).includes("sourceHandle"), false);
  }
});

test("old horizontal graphs are oriented top to bottom without changing valid vertical layouts", () => {
  const horizontal = insertNode(createGraph(), "log", "trigger").graph;
  const vertical = topToBottomGraph(horizontal);
  const edge = vertical.edges[0]!;
  const source = vertical.nodes.find((node) => node.id === edge.source)!;
  const target = vertical.nodes.find((node) => node.id === edge.target)!;
  assert.ok(target.position.y > source.position.y);
  assert.equal(topToBottomGraph(vertical), vertical);
});

test("next-node selection can replace or end a path but rejects cycles", () => {
  const first = insertNode(createGraph(), "log", "trigger");
  const second = insertNode(first.graph, "http", first.id!);
  const replaced = setNextNode(second.graph, "trigger", second.id!);
  assert.equal(replaced.edges.find((edge) => edge.source === "trigger")?.target, second.id);
  assert.equal(replaced.edges.some((edge) => edge.target === first.id), false);
  assert.equal(setNextNode(second.graph, second.id!, "trigger"), second.graph);
  assert.equal(setNextNode(replaced, "trigger", "").edges.some((edge) => edge.source === "trigger"), false);
});

test("execution ordering swaps adjacent ordinary steps and preserves the chain", () => {
  const first = insertNode(createGraph(), "log", "trigger");
  const second = insertNode(first.graph, "http", first.id!);
  const third = insertNode(second.graph, "email", second.id!);
  const moved = moveNode(third.graph, second.id!, "earlier");
  assert.equal(moved.edges.find((edge) => edge.source === "trigger")?.target, second.id);
  assert.equal(moved.edges.find((edge) => edge.source === second.id)?.target, first.id);
  assert.equal(moved.edges.find((edge) => edge.source === first.id)?.target, third.id);
  const condition = insertNode(third.graph, "condition", second.id!);
  assert.equal(moveNode(condition.graph, condition.id!, "earlier"), condition.graph);
});

test("direct rewiring rejects orphaning a displaced downstream subtree", () => {
  let graph = createGraph();
  const first = insertNode(graph, "log", "trigger"); graph = first.graph;
  const displaced = insertNode(graph, "http", first.id!); graph = displaced.graph;
  const target = insertNode(graph, "email", displaced.id!); graph = target.graph;
  assert.equal(connectNodes(graph, first.id!, target.id!), graph);
  assert.equal(graph.edges.some((edge) => edge.source === first.id && edge.target === displaced.id), true);
});

test("public headers and update-task availability mirror graph safety rules", () => {
  assert.match(publicHeaderNameError(" Authorization ") ?? "", /authentication profile/);
  assert.match(publicHeaderNameError("X-API-Key") ?? "", /sensitive/);
  assert.equal(publicHeaderNameError("X-Request-ID"), null);
  assert.equal(updateItemSupported(createGraph("item.created")), true);
  assert.equal(updateItemSupported(createGraph("comment.created")), false);
});

test("upstream choices recursively flatten dominant node and event descriptors", () => {
  let graph = createGraph("item.created");
  const first = insertNode(graph, "log", "trigger"); graph = first.graph;
  const second = insertNode(graph, "http", first.id!); graph = second.graph;
  const catalog = {
    limits: { maxNodes: 50, maxEdges: 75, maxGraphBytes: 262144, maxNodeConfigBytes: 32768, maxExecutionNodes: 50 },
    events: [{ type: "item.created", output: { item: { title: "string", status: "string" }, itemId: "string" } }],
    nodes: [
      { type: "log", kind: "action", inputs: {}, outputs: { result: { message: "string", delivered: "boolean" } }, config: {} },
      { type: "http", kind: "action", inputs: {}, outputs: { body: "string" }, config: {} },
    ],
  } as AutomationCatalog;
  const choices = upstreamChoices(graph, second.id!, catalog);
  assert.deepEqual(choices.map((choice) => choice.value), [
    "{{event.item.title}}",
    "{{event.item.status}}",
    "{{event.itemId}}",
    `{{nodes.${first.id}.output.result.message}}`,
    `{{nodes.${first.id}.output.result.delivered}}`,
  ]);
  assert.deepEqual(choices.map((choice) => choice.rawPath), [
    "item.title",
    "item.status",
    "itemId",
    `nodes.${first.id}.output.result.message`,
    `nodes.${first.id}.output.result.delivered`,
  ]);
  assert.equal(choices.find((choice) => choice.value.endsWith("delivered}}"))?.type, "boolean");
  assert.equal(upstreamChoices(graph, first.id!, catalog).some((choice) => choice.value.includes(second.id!)), false);
});

test("upstream choices exclude a branch-local producer after convergence", () => {
  const graph = {
    nodes: [
      { id: "trigger", type: "trigger" as const, position: { x: 0, y: 0 }, config: { event: "item.created" } },
      { id: "condition", type: "condition" as const, position: { x: 100, y: 0 }, config: { path: "item.status", operator: "equals", value: "done" } },
      { id: "true-log", type: "log" as const, position: { x: 200, y: -50 }, config: { message: "yes" } },
      { id: "false-log", type: "log" as const, position: { x: 200, y: 50 }, config: { message: "no" } },
      { id: "consumer", type: "http" as const, position: { x: 300, y: 0 }, config: { url: "https://example.test", method: "POST" } },
    ],
    edges: [
      { id: "a", source: "trigger", target: "condition" },
      { id: "b", source: "condition", target: "true-log", branch: "true" },
      { id: "c", source: "condition", target: "false-log", branch: "false" },
      { id: "d", source: "true-log", target: "consumer" },
      { id: "e", source: "false-log", target: "consumer" },
    ],
  };
  const catalog = {
    limits: { maxNodes: 50, maxEdges: 75, maxGraphBytes: 262144, maxNodeConfigBytes: 32768, maxExecutionNodes: 50 },
    events: [{ type: "item.created", output: { itemId: "string" } }],
    nodes: [{ type: "condition", kind: "control", inputs: {}, outputs: { matched: "boolean" }, config: {} }, { type: "log", kind: "action", inputs: {}, outputs: { message: "string" }, config: {} }, { type: "http", kind: "action", inputs: {}, outputs: { status: "number" }, config: {} }],
  } as AutomationCatalog;
  const values = upstreamChoices(graph, "consumer", catalog).map((choice) => choice.value);
  assert.equal(values.some((value) => value.includes("true-log") || value.includes("false-log")), false);
  assert.equal(values.some((value) => value.includes("condition")), true);
});

test("edge deletion persists only when all graph invariants remain valid", () => {
  const graph = createGraph();
  const first = insertNode(graph, "log", "trigger");
  assert.equal(removeEdges(first.graph, new Set(first.graph.edges.map((edge) => edge.id))), first.graph);
});

test("run output rows summarize known structured JSON and safely fall back", () => {
  assert.deepEqual(runOutputRows('{"status":201,"body":"created"}'), [{ label: "Status", value: "201" }, { label: "Body", value: "created" }]);
  assert.deepEqual(runOutputRows('{"item":{"title":"Fix issue","status":"done"}}'), [{ label: "Task", value: "Fix issue" }, { label: "Task status", value: "done" }]);
  assert.equal(runOutputRows("not json"), null);
  assert.equal(runOutputRows('{"unknown":{"nested":true}}'), null);
});
