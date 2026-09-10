import type { CSSProperties } from "react";
import type { TreeNode } from "../lib/api";

const colors: Record<NonNullable<TreeNode["color"]>, string> = {
  slate: "#64748b", orange: "#c45d0a", amber: "#9a7411", green: "#4d7a47",
  teal: "#17776f", blue: "#2563a6", violet: "#7652a8", rose: "#a5415b",
};
const paths: Record<NonNullable<TreeNode["icon"]>, string> = {
  diamond: "M12 3 21 12 12 21 3 12Z",
  briefcase: "M4 7h16v12H4zM9 7V4h6v3M4 12h16",
  target: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-5a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm0-4h.01",
  folder: "M3 6h7l2 2h9v11H3z",
  archive: "M4 7h16v13H4zM3 4h18v4H3zm6 8h6",
  bookmark: "M6 3h12v18l-6-4-6 4z",
  list: "M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01",
  checklist: "m3 6 2 2 3-4m2 3h11M3 13l2 2 3-4m2 3h11M3 20l2 2 3-4m2 3h11",
  calendar: "M4 5h16v16H4zM8 3v4m8-4v4M4 10h16",
  flag: "M5 21V4m0 1h12l-2 4 2 4H5",
};

export default function NodeGlyph({ node, className = "node-glyph" }: { node: Pick<TreeNode, "kind" | "icon" | "color">; className?: string }) {
  const icon = node.icon || (node.kind === "project" ? "diamond" : node.kind === "folder" ? "folder" : node.kind === "document" ? "bookmark" : "list");
  return <svg className={className} aria-hidden="true" viewBox="0 0 24 24" style={node.color ? { color: colors[node.color] } as CSSProperties : undefined}>
    <path d={paths[icon]} />
  </svg>;
}
