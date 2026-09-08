import { test } from "node:test";
import assert from "node:assert/strict";
import { projectBuiltIns, projectCustomFields, projectForNode } from "./project-fields";
import type { Detail, TreeNode } from "./api";

const nodes: TreeNode[] = [
  { id: "p", kind: "project", name: "One", parentId: null },
  { id: "f", kind: "folder", name: "Folder", parentId: "p" },
  { id: "l", kind: "list", name: "List", parentId: "f" },
  { id: "q", kind: "project", name: "Two", parentId: null },
];
const detail: Detail = {
  workspace: { id: "w", name: "Workspace" }, nodes, members: [], roles: [], permissions: [],
  role: { id: "r", name: "Role", permissions: [], isOwner: false },
  fields: [{ id: "a", name: "Alpha", type: "text" }, { id: "b", name: "Beta", type: "number" }],
  projectFields: [
    { projectId: "p", fieldIds: ["a"], builtInFields: ["tags"], updatedAt: "1" },
    { projectId: "q", fieldIds: ["b"], builtInFields: ["priority"], updatedAt: "2" },
  ],
};

test("project ancestry resolves a nested list and rejects missing or cyclic chains", () => {
  assert.equal(projectForNode(nodes, "l")?.id, "p");
  assert.equal(projectForNode(nodes, "q")?.id, "q");
  assert.equal(projectForNode(nodes, "missing"), undefined);
  assert.equal(projectForNode([{ id: "cycle", kind: "folder", name: "Cycle", parentId: "cycle" }], "cycle"), undefined);
});
test("selected projects use only assigned custom fields and built-ins; all projects use a union", () => {
  assert.deepEqual(projectCustomFields(detail, "p").map(field => field.id), ["a"]);
  assert.deepEqual(projectCustomFields(detail, "q").map(field => field.id), ["b"]);
  assert.deepEqual(projectCustomFields(detail).map(field => field.id), ["a", "b"]);
  assert.deepEqual(projectBuiltIns(detail, "p"), ["tags"]);
  assert.deepEqual(projectBuiltIns(detail), ["priority", "tags"]);
  assert.deepEqual(projectCustomFields(detail, "unknown"), []);
});
test("explicit empty configuration differs from older metadata without assignments", () => {
  assert.deepEqual(projectCustomFields({ ...detail, projectFields: [] }), []);
  assert.deepEqual(projectBuiltIns({ ...detail, projectFields: [] }), []);
  const { projectFields: _, ...legacy } = detail;
  assert.deepEqual(projectCustomFields(legacy), detail.fields);
  assert.ok(projectBuiltIns(legacy).includes("priority"));
});
