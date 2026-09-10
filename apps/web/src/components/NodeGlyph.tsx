import type { CSSProperties } from "react";
import type { TreeNode } from "../lib/api";

export const nodeColorValues: Record<NonNullable<TreeNode["color"]>, string> = {
  slate: "#64748b", orange: "#c45d0a", amber: "#9a7411", green: "#4d7a47",
  teal: "#17776f", blue: "#2563a6", violet: "#7652a8", rose: "#a5415b",
};
const paths: Record<NonNullable<TreeNode["icon"]>, string> = {
  diamond: "M12 2 22 12 12 22 2 12 12 2Z",
  briefcase: "M9 3h6a2 2 0 0 1 2 2v1h3a2 2 0 0 1 2 2v3H2V8a2 2 0 0 1 2-2h3V5a2 2 0 0 1 2-2Zm0 3h6V5H9v1ZM2 13h8v2h4v-2h8v7a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-7Z",
  target: "M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20Zm0 4a6 6 0 1 0 0 12 6 6 0 0 0 0-12Zm0 3a3 3 0 1 1 0 6 3 3 0 0 1 0-6Z",
  folder: "M3 5h7l2 2h9a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z",
  archive: "M3 3h18a1 1 0 0 1 1 1v4H2V4a1 1 0 0 1 1-1Zm1 7h16v11H4V10Zm5 3v2h6v-2H9Z",
  bookmark: "M6 2h12a2 2 0 0 1 2 2v19l-8-5-8 5V4a2 2 0 0 1 2-2Z",
  list: "M3 5h4v4H3V5Zm6 0h12v4H9V5ZM3 11h4v4H3v-4Zm6 0h12v4H9v-4ZM3 17h4v4H3v-4Zm6 0h12v4H9v-4Z",
  checklist: "M2 4h7v7H2V4Zm9 1h11v3H11V5ZM2 13h7v7H2v-7Zm9 1h11v3H11v-3ZM3.5 7l1.3 1.3L7.5 5.6 8.9 7 4.8 11.1 2.1 8.4 3.5 7Z",
  calendar: "M6 2h3v3h6V2h3v3h2a2 2 0 0 1 2 2v14H2V7a2 2 0 0 1 2-2h2V2Zm-2 9v8h16v-8H4Z",
  flag: "M4 2h3v2h12l-2 5 2 5H7v8H4V2Z",
};

export default function NodeGlyph({ node, className = "node-glyph" }: { node: Pick<TreeNode, "kind" | "icon" | "color">; className?: string }) {
  const icon = node.icon || (node.kind === "project" ? "diamond" : node.kind === "folder" ? "folder" : node.kind === "document" ? "bookmark" : "list");
  return <svg className={`${className} solid-icon`} aria-hidden="true" viewBox="0 0 24 24" style={node.color ? { color: nodeColorValues[node.color] } as CSSProperties : undefined}>
    <path fillRule={icon === "target" || icon === "archive" || icon === "checklist" || icon === "calendar" ? "evenodd" : undefined} d={paths[icon]} />
  </svg>;
}
