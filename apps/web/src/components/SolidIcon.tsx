import type { SVGProps } from "react";

const paths = {
  diamond: "M12 2 22 12 12 22 2 12 12 2Z",
  document: "M6 2h9l5 5v15H6a2 2 0 0 1-2-2V4c0-1.1.9-2 2-2Zm8 1.5V8h4.5L14 3.5Z",
  inbox: "M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5c0-1.1.9-2 2-2Zm0 2v9h4a3 3 0 0 0 6 0h4V5H5Z",
  trash: "M8 3h8l1 2h4v2H3V5h4l1-2Zm-3 6h14l-1 12H6L5 9Z",
  pencil: "m14.06 4.19 5.75 5.75L8.75 21H3v-5.75L14.06 4.19Zm1.41-1.42 1.3-1.3a1.5 1.5 0 0 1 2.12 0l3.64 3.64a1.5 1.5 0 0 1 0 2.12l-1.3 1.3-5.76-5.76Z",
  subtask: "M4 3h4v9a2 2 0 0 0 2 2h6.17l-2.58-2.59L15 10l5 5-5 5-1.41-1.41L16.17 16H10a4 4 0 0 1-4-4V3H4Z",
  eye: "M12 4.5c5 0 9.27 3.11 11 7.5-1.73 4.39-6 7.5-11 7.5S2.73 16.39 1 12c1.73-4.39 6-7.5 11-7.5Zm0 4a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Zm0 2a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3Z",
  eyeOff: "M2.7 1.3 22.7 21.3l-1.4 1.4-3.12-3.12A11.74 11.74 0 0 1 12 21C7 21 2.73 17.89 1 13.5a12.8 12.8 0 0 1 3.15-4.57L1.3 6.1l1.4-1.4Zm4.5 10.68a4.8 4.8 0 0 0-.2 1.52 5 5 0 0 0 6.52 4.77L7.2 11.98ZM12 6c5 0 9.27 3.11 11 7.5a12.7 12.7 0 0 1-2.3 3.65l-3.17-3.17A5 5 0 0 0 11.52 8L9.17 5.65A11.9 11.9 0 0 1 12 6Z",
  arrowLeft: "M11 5 4 12l7 7v-4h9v-6h-9V5Z",
  arrowRight: "m13 5 7 7-7 7v-4H4V9h9V5Z",
  chevronRight: "m9 5 7 7-7 7V5Z",
  chevronUp: "m5 15 7-7 7 7H5Z",
  chevronDown: "m5 9 7 7 7-7H5Z",
} as const;

export type SolidIconName = keyof typeof paths;

export default function SolidIcon({ name, className = "solid-icon", ...props }: { name: SolidIconName } & Omit<SVGProps<SVGSVGElement>, "name">) {
  return <svg {...props} className={className} aria-hidden="true" viewBox="0 0 24 24"><path fillRule="evenodd" d={paths[name]} /></svg>;
}
