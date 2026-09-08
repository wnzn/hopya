import assert from "node:assert/strict";
import test from "node:test";
import type { TreeNode } from "./api";
import { safeAncestorPath } from "./shared-navigation";

test("shared navigation returns the complete safe ancestor path", () => {
  const nodes: TreeNode[] = [
    { id: "project", name: "Project", kind: "project", parentId: null },
    { id: "folder", name: "Folder", kind: "folder", parentId: "project" },
    { id: "list", name: "List", kind: "list", parentId: "folder" },
  ];
  assert.deepEqual(safeAncestorPath(nodes, "list").map((node) => node.id), ["project", "folder", "list"]);
  const rootList: TreeNode = { id: "root-list", name: "Root list", kind: "list", parentId: null };
  assert.deepEqual(safeAncestorPath([rootList], rootList.id), [rootList]);
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
