import { test } from "node:test";
import assert from "node:assert/strict";
import { htmlToMarkdown, markdownToHtml, plainText } from "./rich-text.js";

// Distinct failure protected: the core markdown subset renders.
test("headings, emphasis, code, lists, links and blockquotes render", () => {
  assert.match(markdownToHtml("# Title"), /<h1>Title<\/h1>/);
  assert.match(markdownToHtml("## Sub"), /<h2>Sub<\/h2>/);
  assert.match(markdownToHtml("### Tiny"), /<h3>Tiny<\/h3>/);
  assert.match(markdownToHtml("**bold**"), /<strong>bold<\/strong>/);
  assert.match(markdownToHtml("*italic*"), /<em>italic<\/em>/);
  assert.match(markdownToHtml("~~gone~~"), /<del>gone<\/del>/);
  assert.match(markdownToHtml("`code`"), /<code>code<\/code>/);
  assert.match(
    markdownToHtml("```\nfenced()\n```"),
    /<pre><code>fenced\(\)<\/code><\/pre>/,
  );
  const list = markdownToHtml("- a\n- b");
  assert.match(list, /<ul>/);
  assert.match(list, /<li>a<\/li>/);
  const ordered = markdownToHtml("1. one\n2. two");
  assert.match(ordered, /<ol>/);
  assert.match(ordered, /<li>two<\/li>/);
  assert.match(
    markdownToHtml("[docs](https://example.com)"),
    /<a href="https:\/\/example\.com">docs<\/a>/,
  );
  assert.match(
    markdownToHtml("> quoted"),
    /<blockquote>quoted<\/blockquote>/,
  );
});

// Distinct failure protected: XSS through descriptions is neutralized.
test("script tags, javascript: URLs, event handlers and raw HTML are neutralized", () => {
  const script = markdownToHtml('<script>alert("x")</script>');
  assert.doesNotMatch(script, /<script/);
  assert.match(script, /&lt;script&gt;/);
  const jsLink = markdownToHtml("[click](javascript:alert(1))");
  assert.doesNotMatch(jsLink, /<a /);
  assert.doesNotMatch(jsLink, /javascript:/);
  assert.match(jsLink, /click/);
  const img = markdownToHtml('<img src="x" onerror="alert(1)">');
  // The payload survives only as fully escaped text, never as live markup.
  assert.equal(
    img,
    "<p>&lt;img src=&quot;x&quot; onerror=&quot;alert(1)&quot;&gt;</p>",
  );
  const dataLink = markdownToHtml("[x](data:text/html,<b>hi</b>)");
  assert.doesNotMatch(dataLink, /<a /);
  const boldHtml = markdownToHtml("<b>not a tag</b>");
  assert.doesNotMatch(boldHtml, /<b>/);
  assert.match(boldHtml, /&lt;b&gt;/);
});

test("same-origin Hopya mention links round-trip while protocol-relative links stay unsafe", () => {
  const mention = "[@Alex](/app?workspace=11111111-1111-4111-8111-111111111111&mentionUser=22222222-2222-4222-8222-222222222222)";
  const html = markdownToHtml(mention);
  assert.match(html, /href="\/app\?workspace=/);
  assert.equal(htmlToMarkdown(html), mention);
  assert.doesNotMatch(markdownToHtml("[unsafe](//evil.example/app?x=1)"), /<a /);
});

// Distinct failure protected: legacy plain-text descriptions keep line breaks.
test("single newlines inside paragraphs become breaks", () => {
  const html = markdownToHtml("first line\nsecond line");
  assert.match(html, /<p>first line<br>second line<\/p>/);
  assert.match(markdownToHtml("a\n\nb"), /<p>a<\/p><p>b<\/p>/);
});

// Distinct failure protected: editor serialization round-trips the core subset.
test("htmlToMarkdown round-trips the core subset", () => {
  const cases: Array<[string, string]> = [
    ["**bold** and *italic* text", "**bold** and *italic* text"],
    ["~~gone~~", "~~gone~~"],
    ["`code`", "`code`"],
    ["## Heading", "## Heading"],
    ["- a\n- b", "- a\n- b"],
    ["1. one\n2. two", "1. one\n2. two"],
    ["> quoted", "> quoted"],
    ["[docs](https://example.com)", "[docs](https://example.com)"],
  ];
  for (const [markdown, expected] of cases) {
    const html = markdownToHtml(markdown);
    assert.equal(htmlToMarkdown(html), expected);
  }
  // Paragraph breaks from P/DIV/BR survive the round trip.
  assert.equal(htmlToMarkdown("<p>one</p><p>two</p>"), "one\n\ntwo");
  assert.equal(htmlToMarkdown("one<br>two"), "one\ntwo");
});

// Distinct failure protected: unsafe editor HTML serializes to inert text.
test("htmlToMarkdown drops scripts, styles and unsafe links but keeps text", () => {
  assert.equal(
    htmlToMarkdown('<p>keep<script>alert("x")</script></p>'),
    "keepalert(\"x\")",
  );
  assert.equal(
    htmlToMarkdown('<p><a href="javascript:alert(1)">click</a></p>'),
    "click",
  );
  assert.equal(
    htmlToMarkdown('<p><a href="https://example.com">docs</a></p>'),
    "[docs](https://example.com)",
  );
  assert.equal(
    htmlToMarkdown("<div><h2>Title</h2></div>"),
    "## Title",
  );
  assert.equal(htmlToMarkdown("<ul><li>a</li><li>b</li></ul>"), "- a\n- b");
});

// Distinct failure protected: TipTap emits element variants the legacy
// converter must keep round-tripping (strike marks, p-wrapped list items,
// pre>code blocks, blockquote paragraphs).
test("htmlToMarkdown serializes TipTap element variants", () => {
  // Strike element variants from TipTap marks and pasted HTML.
  assert.equal(
    htmlToMarkdown("<p><s>gone</s><strike>old</strike><del>also</del></p>"),
    "~~gone~~~~old~~~~also~~",
  );
  // TipTap wraps list item content in paragraphs.
  assert.equal(
    htmlToMarkdown(
      '<ul><li><p>alpha</p></li><li><p>beta <strong>hot</strong></p></li></ul>',
    ),
    "- alpha\n- beta **hot**",
  );
  // Ordered lists with p-wrapped items keep numbering.
  assert.equal(
    htmlToMarkdown("<ol><li><p>one</p></li><li><p>two</p></li></ol>"),
    "1. one\n2. two",
  );
  // Code blocks arrive as pre>code; content stays verbatim.
  assert.equal(
    htmlToMarkdown("<pre><code>const x = 1;\nkeep(**this**)</code></pre>"),
    "```\nconst x = 1;\nkeep(**this**)\n```",
  );
  // Inline code inside paragraphs keeps backticks.
  assert.equal(
    htmlToMarkdown("<p>run <code>npm test</code> now</p>"),
    "run `npm test` now",
  );
  // Blockquote paragraphs flatten with quote markers preserved.
  assert.equal(
    htmlToMarkdown(
      "<blockquote><p>first</p><p>second <em>part</em></p></blockquote>",
    ),
    "> first\n>\n> second *part*",
  );
  // Links inside p-wrapped items keep safe hrefs only.
  assert.equal(
    htmlToMarkdown(
      '<ul><li><p><a href="https://example.com">docs</a></p></li></ul>',
    ),
    "- [docs](https://example.com)",
  );
});

// Distinct failure protected: nested lists keep indented structure instead of
// flattening into a single item (ProseMirror list depth changes).
test("htmlToMarkdown preserves nested list markers", () => {
  assert.equal(
    htmlToMarkdown(
      "<ul><li><p>a</p><ul><li><p>b</p></li></ul></li><li><p>c</p></li></ul>",
    ),
    "- a\n  - b\n- c",
  );
  assert.equal(
    htmlToMarkdown(
      "<ol><li><p>one</p><ol><li><p>two</p></li></ol></li></ol>",
    ),
    "1. one\n   1. two",
  );
});

// Distinct failure protected: compact previews never leak markdown syntax.
test("plainText strips syntax and collapses whitespace", () => {
  assert.equal(
    plainText("## Report\n\n**Done** and *soon* with `code`"),
    "Report Done and soon with code",
  );
  assert.equal(
    plainText("- item one\n- item two\n\n> quoted"),
    "item one item two quoted",
  );
  assert.equal(
    plainText("[docs](https://example.com) and more"),
    "docs and more",
  );
  assert.equal(plainText("a   b\n\n\nc"), "a b c");
  assert.ok(plainText("x".repeat(1000)).length <= 500);
});
