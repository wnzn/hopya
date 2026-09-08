// Dependency-free markdown subset for task descriptions.
// markdownToHtml is safe by construction: all source text is HTML-escaped
// first and only an allowlist of elements is ever generated. Raw HTML in the
// source can therefore never pass through.

export const RICH_TEXT_MAX = 50000;
export const PLAIN_TEXT_MAX = 500;

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#(\d+);/g, (_, code: string) => {
      const point = Number(code);
      return Number.isFinite(point) ? String.fromCodePoint(point) : _;
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => {
      const point = parseInt(code, 16);
      return Number.isFinite(point) ? String.fromCodePoint(point) : _;
    })
    .replace(/&amp;/gi, "&");
}

export function isSafeUrl(url: string): boolean {
  const trimmed = url.trim();
  if (!trimmed || /[\s<>]/.test(trimmed)) return false;
  const lower = trimmed.toLowerCase();
  return (
    /^\/app\?(?!\/)/.test(trimmed) ||
    lower.startsWith("http://") ||
    lower.startsWith("https://") ||
    lower.startsWith("mailto:")
  );
}

// Emphasis is applied only to non-tag segments so generated attributes
// (e.g. href values with underscores) can never be corrupted.
function applyEmphasis(text: string): string {
  return text
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\b__([^_]+?)__\b/g, "<strong>$1</strong>")
    .replace(/\*([^*]+?)\*/g, "<em>$1</em>")
    .replace(/\b_([^_]+?)_\b/g, "<em>$1</em>")
    .replace(/~~([^~]+?)~~/g, "<del>$1</del>");
}

function applyEmphasisSafe(html: string): string {
  return html
    .split(/(<[^>]*>)/g)
    .map((segment, index) =>
      index % 2 === 1 ? segment : applyEmphasis(segment),
    )
    .join("");
}

function autolinkSafe(html: string): string {
  return html
    .split(/(<[^>]*>)/g)
    .map((segment, index) => {
      if (index % 2 === 1) return segment;
      return segment.replace(
        /(^|[\s(])(https?:\/\/[^\s<]+)/g,
        (match: string, prefix: string, url: string) => {
          let clean = url;
          let trail = "";
          while (/[.,;:!?)\]]$/.test(clean)) {
            trail = clean.slice(-1) + trail;
            clean = clean.slice(0, -1);
          }
          const decoded = decodeHtmlEntities(clean);
          if (!isSafeUrl(decoded)) return match;
          return `${prefix}<a href="${escapeHtml(decoded)}">${clean}</a>`;
        },
      );
    })
    .join("");
}

function inlineToHtml(source: string): string {
  const parts = source.split(/(`[^`\n]+`)/g);
  return parts
    .map((part) => {
      if (/^`[^`\n]+`$/.test(part))
        return `<code>${escapeHtml(part.slice(1, -1))}</code>`;
      let text = escapeHtml(part);
      // Explicit [text](url) links first; unsafe protocols keep text only.
      text = text.replace(
        /\[([^\]]+)\]\(([^)]+)\)/g,
        (_match: string, label: string, url: string) => {
          const decoded = decodeHtmlEntities(url.trim());
          if (!isSafeUrl(decoded)) return applyEmphasis(label);
          return `<a href="${escapeHtml(decoded)}">${applyEmphasis(label)}</a>`;
        },
      );
      text = autolinkSafe(text);
      return applyEmphasisSafe(text);
    })
    .join("");
}

function isListItem(line: string): boolean {
  return /^\s*(?:[-*]\s+|\d+\.\s+)/.test(line);
}

function isBlockStart(line: string): boolean {
  return (
    /^```/.test(line) ||
    /^(#{1,3})\s+/.test(line) ||
    /^\s*>\s?/.test(line) ||
    isListItem(line)
  );
}

export function markdownToHtml(markdown: string): string {
  const src = (markdown ?? "").slice(0, RICH_TEXT_MAX).replace(/\r\n?/g, "\n");
  if (!src.trim()) return "";
  const lines = src.split("\n");
  const blocks: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (/^\s*$/.test(line)) {
      index++;
      continue;
    }
    if (/^```/.test(line)) {
      const content: string[] = [];
      index++;
      while (index < lines.length && !/^```\s*$/.test(lines[index])) {
        content.push(lines[index]);
        index++;
      }
      if (index < lines.length) index++; // consume closing fence
      blocks.push(`<pre><code>${escapeHtml(content.join("\n"))}</code></pre>`);
      continue;
    }
    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      blocks.push(`<h${level}>${inlineToHtml(heading[2].trim())}</h${level}>`);
      index++;
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      const quoted: string[] = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
        quoted.push(lines[index].replace(/^\s*>\s?/, ""));
        index++;
      }
      blocks.push(
        `<blockquote>${quoted.map((l) => inlineToHtml(l)).join("<br>")}</blockquote>`,
      );
      continue;
    }
    if (isListItem(line)) {
      const items: string[] = [];
      let ordered: boolean | null = null;
      while (index < lines.length && isListItem(lines[index])) {
        const current = lines[index];
        const isOrdered = /^\s*\d+\.\s+/.test(current);
        if (ordered === null) ordered = isOrdered;
        else if (ordered !== isOrdered) break;
        items.push(
          current.replace(/^\s*(?:[-*]\s+|\d+\.\s+)/, ""),
        );
        index++;
      }
      const tag = ordered ? "ol" : "ul";
      blocks.push(
        `<${tag}>${items.map((item) => `<li>${inlineToHtml(item)}</li>`).join("")}</${tag}>`,
      );
      continue;
    }
    const paragraph: string[] = [];
    while (
      index < lines.length &&
      !/^\s*$/.test(lines[index]) &&
      !isBlockStart(lines[index])
    ) {
      paragraph.push(lines[index]);
      index++;
    }
    blocks.push(
      `<p>${paragraph.map((l) => inlineToHtml(l)).join("<br>")}</p>`,
    );
  }
  return blocks.join("");
}

// --- htmlToMarkdown: dependency-free HTML -> markdown serializer ---------

type RichNode =
  | { kind: "text"; text: string }
  | {
      kind: "element";
      tag: string;
      href: string | null;
      alt: string | null;
      children: RichNode[];
    };

function parseAttr(html: string, name: string): string | null {
  const match = html.match(
    new RegExp(
      `${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`,
      "i",
    ),
  );
  if (!match) return null;
  const value = match[2] ?? match[3] ?? match[4] ?? "";
  return decodeHtmlEntities(value);
}

const VOID_TAGS = new Set([
  "br",
  "hr",
  "img",
  "input",
  "meta",
  "link",
  "source",
]);

function parseHtml(html: string): RichNode[] {
  const root: RichNode[] = [];
  const stack: RichNode[] = [];
  const parent = (): RichNode[] =>
    stack.length > 0
      ? (stack[stack.length - 1] as { children: RichNode[] }).children
      : root;
  const tokens = html.match(/<[^>]*>|[^<]+/g) ?? [];
  for (const token of tokens) {
    if (!token.startsWith("<")) {
      parent().push({ kind: "text", text: decodeHtmlEntities(token) });
      continue;
    }
    const tagMatch = token.match(/^<\s*(\/?)\s*([a-zA-Z0-9]+)?([^>]*)>$/);
    if (!tagMatch) continue;
    const closing = tagMatch[1] === "/";
    const tag = (tagMatch[2] ?? "").toLowerCase();
    if (!tag) continue;
    if (closing) {
      for (let at = stack.length - 1; at >= 0; at--) {
        const node = stack[at] as Extract<RichNode, { kind: "element" }>;
        if (node.kind === "element" && node.tag === tag) {
          stack.length = at;
          break;
        }
      }
      continue;
    }
    const selfClosing = /\/\s*$/.test(tagMatch[3] ?? "") || VOID_TAGS.has(tag);
    const element: RichNode = {
      kind: "element",
      tag,
      href: tag === "a" ? parseAttr(token, "href") : null,
      alt: tag === "img" ? parseAttr(token, "alt") : null,
      children: [],
    };
    parent().push(element);
    if (!selfClosing) stack.push(element);
  }
  return root;
}

function textContent(nodes: RichNode[]): string {
  let out = "";
  for (const node of nodes) {
    if (node.kind === "text") out += node.text;
    else if (node.tag === "br") out += "\n";
    else out += textContent(node.children);
  }
  return out;
}

function inlineMarkdown(nodes: RichNode[]): string {
  let out = "";
  for (const node of nodes) {
    if (node.kind === "text") {
      out += node.text.replace(/[ \t]+\n[ \t]*/g, " ");
      continue;
    }
    switch (node.tag) {
      case "br":
        out += "\n";
        break;
      case "b":
      case "strong":
        out += `**${inlineMarkdown(node.children)}**`;
        break;
      case "i":
      case "em":
        out += `*${inlineMarkdown(node.children)}*`;
        break;
      case "s":
      case "strike":
      case "del":
        out += `~~${inlineMarkdown(node.children)}~~`;
        break;
      case "code": {
        const content = textContent(node.children);
        out += content.includes("`")
          ? `\`\` ${content} \`\``
          : `\`${content}\``;
        break;
      }
      case "a": {
        const label = inlineMarkdown(node.children);
        if (node.href && isSafeUrl(node.href))
          out += `[${label}](${node.href.trim()})`;
        else out += label;
        break;
      }
      case "img":
        out += node.alt ?? "";
        break;
      case "script":
      case "style":
        // Drop the element but keep its text (markdown output is inert).
        out += textContent(node.children);
        break;
      default:
        // Drop SCRIPT/STYLE/comments/unknown elements but keep their text.
        out += inlineMarkdown(node.children);
        break;
    }
  }
  return out;
}

const BLOCK_TAGS = new Set([
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "p",
  "div",
  "section",
  "article",
  "pre",
  "blockquote",
  "ul",
  "ol",
  "li",
  "hr",
  "table",
  "thead",
  "tbody",
  "tr",
  "td",
  "th",
]);

function isBlockNode(node: RichNode): boolean {
  return node.kind === "element" && BLOCK_TAGS.has(node.tag);
}

// List items: the leading inline run (plus one leading paragraph, which is
// how TipTap wraps list item text) becomes the marker line; any deeper block
// content (nested lists, quotes) is indented under the marker so structure
// survives instead of flattening into the item text.
function liMarkdown(children: RichNode[], marker: string): string {
  const indent = " ".repeat(marker.length);
  let lead = "";
  let at = 0;
  while (at < children.length && !isBlockNode(children[at])) {
    lead += inlineMarkdown([children[at]]);
    at++;
  }
  if (
    at < children.length &&
    children[at].kind === "element" &&
    (children[at] as Extract<RichNode, { kind: "element" }>).tag === "p"
  ) {
    const p = children[at] as Extract<RichNode, { kind: "element" }>;
    const inner = inlineMarkdown(p.children).replace(/^[ \t\n]+|[ \t\n]+$/g, "");
    if (inner) lead = lead ? `${lead.replace(/\s+$/, "")} ${inner}` : inner;
    at++;
  }
  lead = lead.replace(/^[ \t\n]+|[ \t\n]+$/g, "");
  const lines = [`${marker}${lead}`];
  const nested = at < children.length ? blockMarkdown(children.slice(at)).trim() : "";
  if (nested) {
    for (const line of nested.split("\n")) lines.push(line ? indent + line : "");
  }
  return lines.join("\n");
}

function blockMarkdown(nodes: RichNode[]): string {
  let out = "";
  let inlineRun: RichNode[] = [];
  const flush = () => {
    if (inlineRun.length === 0) return;
    // BR inside a run yields a single newline; runs are paragraphs.
    const body = inlineMarkdown(inlineRun).replace(/^[ \t\n]+|[ \t\n]+$/g, "");
    inlineRun = [];
    if (body) out += `${body}\n\n`;
  };
  // Unknown elements are transparent: splice their children into the stream
  // so inline content stays inline and blocks stay blocks.
  const stream: RichNode[] = [];
  const expand = (items: RichNode[]) => {
    for (const item of items) {
      if (
        item.kind === "element" &&
        !BLOCK_TAGS.has(item.tag) &&
        !VOID_TAGS.has(item.tag) &&
        !["b", "strong", "i", "em", "s", "strike", "del", "code", "a", "img", "br", "script", "style", "span", "u", "font"].includes(item.tag)
      ) {
        expand(item.children);
      } else stream.push(item);
    }
  };
  expand(nodes);
  for (const node of stream) {
    if (!isBlockNode(node)) {
      if (node.kind === "text" && !node.text.trim() && inlineRun.length === 0)
        continue;
      inlineRun.push(node);
      continue;
    }
    flush();
    const element = node as Extract<RichNode, { kind: "element" }>;
    switch (element.tag) {
      case "h1":
      case "h2":
      case "h3": {
        const level = Number(element.tag[1]);
        const label = inlineMarkdown(element.children).trim();
        if (label) out += `${"#".repeat(level)} ${label}\n\n`;
        break;
      }
      case "h4":
      case "h5":
      case "h6":
      case "p":
      case "div":
      case "section":
      case "article": {
        const body = blockMarkdown(element.children).trim();
        if (body) out += `${body}\n\n`;
        break;
      }
      case "pre": {
        const body = textContent(element.children).replace(/^\n+|\n+$/g, "");
        out += body ? `\`\`\`\n${body}\n\`\`\`\n\n` : "";
        break;
      }
      case "blockquote": {
        const body = blockMarkdown(element.children).trim();
        if (body)
          out += `${body
            .split("\n")
            .map((l) => (l.trim() ? `> ${l}` : ">"))
            .join("\n")}\n\n`;
        break;
      }
      case "ul": {
        for (const child of element.children) {
          if (child.kind === "element" && child.tag === "li") {
            const body = liMarkdown(child.children, "- ");
            if (body) out += `${body}\n`;
          } else if (child.kind === "element") {
            const body = liMarkdown([child], "- ");
            if (body) out += `${body}\n`;
          }
        }
        out += "\n";
        break;
      }
      case "ol": {
        let number = 1;
        for (const child of element.children) {
          if (child.kind === "element" && child.tag === "li") {
            const body = liMarkdown(child.children, `${number}. `);
            if (body) out += `${body}\n`;
            number++;
          } else if (child.kind === "element") {
            const body = liMarkdown([child], `${number}. `);
            if (body) out += `${body}\n`;
            number++;
          }
        }
        out += "\n";
        break;
      }
      case "li": {
        const body = liMarkdown(element.children, "- ").replace(/\n+/g, " ");
        if (body) out += `${body}\n\n`;
        break;
      }
      case "br":
        out += "\n";
        break;
      case "hr":
        out += "---\n\n";
        break;
      case "script":
      case "style":
        out += textContent(element.children);
        break;
      default:
        out += blockMarkdown(element.children);
        break;
    }
  }
  flush();
  return out;
}

export function htmlToMarkdown(html: string): string {
  const nodes = parseHtml(html ?? "");
  const markdown = blockMarkdown(nodes)
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return markdown.slice(0, RICH_TEXT_MAX);
}

// --- plainText: compact preview ------------------------------------------

export function plainText(markdown: string): string {
  let text = (markdown ?? "").slice(0, RICH_TEXT_MAX);
  text = text.replace(/\r\n?/g, "\n");
  // Fenced code blocks keep their content.
  text = text.replace(/```[^\n]*\n([\s\S]*?)```/g, (_, code: string) => ` ${code} `);
  text = text.replace(/```/g, " ");
  // Images keep alt text; links keep text.
  text = text.replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1");
  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  // Inline code keeps content.
  text = text.replace(/``\s?([^`]+?)\s?``/g, "$1");
  text = text.replace(/`([^`]+?)`/g, "$1");
  // Headings, quotes and list markers are removed.
  text = text.replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, "");
  text = text.replace(/^[ \t]*>[ \t]?/gm, "");
  text = text.replace(/^[ \t]*[-*][ \t]+/gm, "");
  text = text.replace(/^[ \t]*\d+\.[ \t]+/gm, "");
  // Emphasis markers removed, content kept.
  text = text.replace(/\*\*([^*]+?)\*\*/g, "$1");
  text = text.replace(/__([^_]+?)__/g, "$1");
  text = text.replace(/\*([^*]+?)\*/g, "$1");
  text = text.replace(/\b_([^_]+?)_\b/g, "$1");
  text = text.replace(/~~([^~]+?)~~/g, "$1");
  // Any residual HTML tags are stripped to text (never rendered as markup).
  text = text.replace(/<[^>]*>/g, " ");
  text = decodeHtmlEntities(text);
  text = text.replace(/\s+/g, " ").trim();
  return text.slice(0, PLAIN_TEXT_MAX);
}
