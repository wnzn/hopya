import type { BuiltInField, Detail, Field, TreeNode } from "./api";

export const optionalBuiltIns: { id: BuiltInField; label: string }[] = [
  { id: "priority", label: "Priority" },
  { id: "startDate", label: "Start date" },
  { id: "tags", label: "Tags" },
  { id: "description", label: "Description" },
  { id: "nodeId", label: "List" },
  { id: "createdAt", label: "Created" },
  { id: "updatedAt", label: "Updated" },
];

export function projectForNode(nodes: TreeNode[], nodeId?: string | null): TreeNode | undefined {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const visited = new Set<string>();
  let node = nodeId ? byId.get(nodeId) : undefined;
  for (let depth = 0; node && depth <= 32; depth++) {
    if (visited.has(node.id)) return undefined;
    visited.add(node.id);
    if (node.kind === "project") return node;
    node = node.parentId ? byId.get(node.parentId) : undefined;
  }
  return undefined;
}

export function fieldOwnerForNode(nodes: TreeNode[], nodeId?: string | null): TreeNode | undefined {
  const node = nodeId ? nodes.find(candidate => candidate.id === nodeId) : undefined;
  if (node?.kind === "list" && node.parentId === null) return node;
  return projectForNode(nodes, nodeId);
}

export function hierarchyLabels(nodes: TreeNode[], targets: TreeNode[]): Map<string, string> {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const paths = targets.map(target => {
    const names: string[] = [];
    const seen = new Set<string>();
    let node: TreeNode | undefined = target;
    while (node && !seen.has(node.id)) {
      seen.add(node.id);
      names.unshift(node.name);
      node = node.parentId ? byId.get(node.parentId) : undefined;
    }
    return names.join(" / ");
  });
  const counts = new Map<string, number>();
  for (const path of paths) counts.set(path, (counts.get(path) || 0) + 1);
  const labels = paths.map((path, index) => counts.get(path)! > 1 ? `${path} (${targets[index].id})` : path);
  // A literal node name can itself look like a disambiguated path.
  if (new Set(labels).size !== labels.length)
    labels.forEach((_, index) => { labels[index] = `${paths[index]} (${targets[index].id})`; });
  return new Map(targets.map((target, index) => [target.id, labels[index]]));
}

export function projectCustomFields(detail: Detail, projectId?: string | null): Field[] {
  // Older metadata clients/fixtures lack assignments; existing installations
  // receive explicit backfilled configurations from migration 005.
  if (detail.projectFields === undefined) return detail.fields;
  const ids = new Set(detail.projectFields
    .filter(config => !projectId || config.projectId === projectId)
    .flatMap(config => config.fieldIds));
  return detail.fields.filter(field => ids.has(field.id));
}

export function projectBuiltIns(detail: Detail, projectId?: string | null): BuiltInField[] {
  if (detail.projectFields === undefined)
    return ["priority", "startDate", "tags", "nodeId", "createdAt", "updatedAt"];
  const ids = new Set(detail.projectFields
    .filter(config => !projectId || config.projectId === projectId)
    .flatMap(config => config.builtInFields));
  return optionalBuiltIns.filter(field => ids.has(field.id)).map(field => field.id);
}
