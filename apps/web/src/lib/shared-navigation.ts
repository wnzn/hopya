import type { TreeNode } from "./api";

export function safeAncestorPath(nodes: TreeNode[], nodeId: string) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const path: TreeNode[] = [];
  const seen = new Set<string>();
  let current = byId.get(nodeId);
  while (current) {
    if (seen.has(current.id) || path.length >= 32) return [];
    seen.add(current.id);
    path.unshift(current);
    if (!current.parentId) return current.kind === "project" || current.kind === "list" ? path : [];
    current = byId.get(current.parentId);
  }
  return [];
}
