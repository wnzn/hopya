import type { CSSProperties } from "react";
import { nodeColors, type NodeIcon, type TreeNode } from "../lib/api";
import SolidIcon, { type SolidIconName } from "./SolidIcon";

export const nodeColorValues: Record<(typeof nodeColors)[number], string> = {
  slate: "#64748b", orange: "#c45d0a", amber: "#9a7411", green: "#4d7a47",
  teal: "#17776f", blue: "#2563a6", violet: "#7652a8", rose: "#a5415b",
};

const icons: Record<NodeIcon, SolidIconName> = {
  diamond: "diamond",
  briefcase: "shoppingBag",
  target: "target",
  home: "home",
  star: "star",
  heart: "heart",
  globe: "globe",
  clock: "clock",
  mapPin: "mapPin",
  settings: "settings",
  lock: "lock",
  users: "users",
  user: "user",
  folder: "folder",
  archive: "archive",
  bookmark: "bookmark",
  list: "list",
  checklist: "checklist",
  calendar: "calendar",
  flag: "flag",
  package: "package",
  shoppingBag: "shoppingBag",
  fileText: "fileText",
  inbox: "inbox",
  trash: "trash",
  pencil: "pencil",
  eye: "eye",
  eyeOff: "eyeOff",
  sparkles: "sparkles",
  code: "code",
  link: "link",
  comment: "comment",
  save: "save",
};

export function resolveNodeColor(color?: string | null) {
  if (!color) return undefined;
  if (/^#[0-9a-f]{6}$/i.test(color)) return color;
  return nodeColorValues[color as keyof typeof nodeColorValues];
}

export default function NodeGlyph({ node, className = "node-glyph" }: { node: Pick<TreeNode, "kind" | "icon" | "color">; className?: string }) {
  const icon = node.icon || (node.kind === "project" ? "diamond" : node.kind === "folder" ? "folder" : node.kind === "document" ? "bookmark" : "list");
  const color = resolveNodeColor(node.color);
  return <SolidIcon name={icons[icon]} className={`${className} solid-icon`} style={color ? { color } as CSSProperties : undefined} />;
}
