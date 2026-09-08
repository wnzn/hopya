import { label, statuses, type DateFormat, type Detail, type ProjectStatus } from "./api";
import { projectForNode } from "./project-fields";

export const defaultStatuses: ProjectStatus[] = statuses.map((id, index) => ({
  id, name: label(id), color: ["#64748b", "#2563eb", "#d97706", "#9333ea", "#15803d"][index], completed: id === "done",
})).sort((a, b) => Number(b.id === "todo") - Number(a.id === "todo"));
function configuration(data: Detail, nodeId?: string | null) {
  const project = projectForNode(data.nodes, nodeId);
  return project ? data.projectFields?.find(config => config.projectId === project.id) : undefined;
}
export function projectStatuses(data: Detail, nodeId?: string | null): ProjectStatus[] {
  const node = data.nodes.find(value => value.id === nodeId);
  if (node?.kind === "list") {
    const override = data.listStatusConfigs?.find(config => config.listId === node.id)?.statuses;
    if (override) return override;
  }
  return configuration(data, nodeId)?.statuses ?? defaultStatuses;
}
export function projectDateFormat(data: Detail, nodeId?: string | null): DateFormat {
  return configuration(data, nodeId)?.dateFormat ?? "yyyy-MM-dd";
}
export function statusLabel(data: Detail, nodeId: string | null | undefined, status: string): string {
  return projectStatuses(data, nodeId).find(value => value.id === status)?.name ?? label(status);
}
export function statusStyle(color: string) {
  const backgroundColor = /^#[0-9a-f]{6}$/i.test(color) ? color : "#64748b";
  const rgb = [1, 3, 5].map(offset => parseInt(backgroundColor.slice(offset, offset + 2), 16) / 255)
    .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  const luminance = rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
  return { backgroundColor, color: luminance > 0.179 ? "#000000" : "#ffffff" };
}
export function tagStyle(data: Detail | undefined, nodeId: string, tag: string) {
  const color = data?.listTagColorConfigs?.find(config => config.listId === nodeId)?.colors[tag];
  return color ? statusStyle(color) : undefined;
}
