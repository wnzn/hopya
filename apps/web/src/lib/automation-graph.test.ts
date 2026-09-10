import assert from "node:assert/strict";
import test from "node:test";
import type { AutomationCatalog } from "./api";
import { connectNodes, createGraph, insertNode, publicHeaderNameError, removeEdges, runOutputRows, updateItemSupported, upstreamChoices } from "./automation-graph";

test("graph connections reject cycles and replace ordinary fanout", () => {
  let graph = createGraph();
  const first = insertNode(graph, "log", "trigger"); graph = first.graph;
  const second = insertNode(graph, "http", first.id!); graph = second.graph;
  assert.equal(connectNodes(graph, second.id!, first.id!), graph);
  const replacement = insertNode(graph, "email", "trigger");
  assert.equal(replacement.graph.edges.filter((edge) => edge.source === "trigger").length, 1);
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
