import type { Detail, DocumentSummary, TableSummary, TreeNode } from "./api";

export function documentHierarchyNode(document: DocumentSummary): TreeNode {
  return { id: document.id, name: document.title, kind: "document", parentId: document.parentId, updatedAt: document.updatedAt, icon: document.icon, color: document.color };
}

export function tableHierarchyNode(table: TableSummary): TreeNode {
  return { id: table.id, name: table.name, kind: "table", parentId: table.parentId, updatedAt: table.updatedAt, icon: table.icon, color: table.color };
}

export function hierarchyEntries(detail: Pick<Detail, "nodes" | "documents" | "tables">): TreeNode[] {
  return [
    ...detail.nodes,
    ...(detail.documents ?? []).filter(document => !document.parentDocumentId).map(documentHierarchyNode),
    ...(detail.tables ?? []).map(tableHierarchyNode),
  ];
}

export function safeAncestorPath(nodes: TreeNode[], nodeId: string) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const path: TreeNode[] = [];
  const seen = new Set<string>();
  let current = byId.get(nodeId);
  while (current) {
    if (seen.has(current.id) || path.length >= 32) return [];
    seen.add(current.id);
    path.unshift(current);
    if (!current.parentId) return current.kind === "project" || current.kind === "list" || current.kind === "document" || current.kind === "table" ? path : [];
    current = byId.get(current.parentId);
  }
  return [];
}
