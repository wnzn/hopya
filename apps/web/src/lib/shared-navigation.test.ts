import assert from "node:assert/strict";
import test from "node:test";
import type { TreeNode } from "./api";
import { hierarchyEntries, safeAncestorPath } from "./shared-navigation";

test("shared navigation returns the complete safe ancestor path", () => {
  const nodes: TreeNode[] = [
    { id: "project", name: "Project", kind: "project", parentId: null },
    { id: "folder", name: "Folder", kind: "folder", parentId: "project" },
    { id: "list", name: "List", kind: "list", parentId: "folder" },
  ];
  assert.deepEqual(safeAncestorPath(nodes, "list").map((node) => node.id), ["project", "folder", "list"]);
  const rootList: TreeNode = { id: "root-list", name: "Root list", kind: "list", parentId: null };
  assert.deepEqual(safeAncestorPath([rootList], rootList.id), [rootList]);
  const rootTable: TreeNode = { id: "root-table", name: "Root table", kind: "table", parentId: null };
  assert.deepEqual(safeAncestorPath([rootTable], rootTable.id), [rootTable]);
});

test("shared navigation merges nodes, top-level documents, and tables", () => {
  const entries = hierarchyEntries({
    nodes: [{ id: "project", name: "Project", kind: "project", parentId: null }],
    documents: [
      { id: "document", workspaceId: "w", parentId: "project", title: "Document", createdAt: "1", updatedAt: "2" },
      { id: "page", workspaceId: "w", parentId: "project", parentDocumentId: "document", title: "Page", createdAt: "1", updatedAt: "2" },
    ],
    tables: [{ id: "table", workspaceId: "w", parentId: "project", name: "Table", createdAt: "1", updatedAt: "2" }],
  });
  assert.deepEqual(entries.map(entry => [entry.id, entry.kind]), [["project", "project"], ["document", "document"], ["table", "table"]]);
});

test("shared navigation rejects missing roots, cycles, and excessive depth", () => {
  const cycle: TreeNode[] = [
    { id: "a", name: "A", kind: "folder", parentId: "b" },
    { id: "b", name: "B", kind: "folder", parentId: "a" },
  ];
  const deep: TreeNode[] = Array.from({ length: 33 }, (_, index) => ({
    id: String(index),
    name: String(index),
    kind: index === 0 ? "project" : "folder",
    parentId: index ? String(index - 1) : null,
  }));
  assert.deepEqual(safeAncestorPath(cycle, "a"), []);
  assert.deepEqual(safeAncestorPath([{ id: "orphan", name: "Orphan", kind: "folder", parentId: null }], "orphan"), []);
  assert.deepEqual(safeAncestorPath(deep, "32"), []);
});
