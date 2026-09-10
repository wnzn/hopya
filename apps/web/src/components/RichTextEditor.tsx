import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Editor, Extension } from "@tiptap/core";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import {
  RICH_TEXT_MAX,
  htmlToMarkdown,
  isSafeUrl,
  markdownToHtml,
  selectionAnchor,
} from "../lib/rich-text";
import type { CommentAnchor } from "../lib/api";

type Props = {
  value: string;
  onChange: (markdown: string) => void;
  readOnly?: boolean;
  onActivate?: () => void;
  "aria-label"?: string;
  placeholder?: string;
  mentionTargets?: MentionTarget[];
  onCommentSelection?: (selection: TextSelection) => void;
  commentRevision?: number;
  annotations?: CommentAnchor[];
};

export type TextSelection = {
  revision: number;
  start: number;
  end: number;
  exact: string;
  prefix: string;
  suffix: string;
};

export type MentionTarget = {
  id: string;
  kind: "user" | "task" | "node";
  label: string;
  href: string;
};
type MentionMenu = { from: number; to: number; trigger: string; query: string };

// Product content subset: StarterKit pared down to the marks and nodes the
// markdown contract supports (bold, italic, strike, code, headings 2-3,
// bullet/ordered lists, blockquote, codeBlock, paragraph, text, document).
// Link is registered separately so typed, pasted, and parsed URLs face the
// same http/https/mailto gate as the toolbar. Editing infrastructure with no
// content types (hardBreak parses the <br> our markdown emits; undoRedo,
// listKeymap, dropcursor, gapcursor, trailingNode) stays at defaults.
const extensions = [
  StarterKit.configure({
    heading: { levels: [2, 3] },
    horizontalRule: false,
    underline: false,
    link: false,
  }),
  Link.configure({
    openOnClick: false,
    isAllowedUri: (url) => isSafeUrl(url),
    shouldAutoLink: (url) => isSafeUrl(url),
    HTMLAttributes: { rel: "noopener noreferrer nofollow ugc" },
  }),
];

function serialize(editor: Editor): string {
  return htmlToMarkdown(editor.getHTML());
}

// Drives the data-placeholder CSS: the ProseMirror element always contains a
// paragraph, so :empty never matches and emptiness is tracked explicitly.
function markEmpty(editor: Editor) {
  editor.view.dom.setAttribute(
    "data-empty",
    editor.isEmpty ? "true" : "false",
  );
}

export default function RichTextEditor({
  value,
  onChange,
  readOnly,
  onActivate,
  "aria-label": ariaLabel = "Body",
  placeholder = "",
  mentionTargets = [],
  onCommentSelection,
  commentRevision = 1,
  annotations = [],
}: Props) {
  const mountRef = useRef<HTMLDivElement>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  // Bumped on every transaction so toolbar isActive() states stay current.
  const [, setTick] = useState(0);
  // Last markdown rendered or emitted; external updates only re-render when
  // the incoming value differs, so the caret is never clobbered.
  const lastMarkdown = useRef<string | null>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState("");
  const [limitReached, setLimitReached] = useState(false);
  const [mentionMenu, setMentionMenu] = useState<MentionMenu | null>(null);
  const [commentSelection, setCommentSelection] = useState<Omit<TextSelection, "revision"> | null>(null);
  const mentionMenuRef = useRef<MentionMenu | null>(null);
  const mentionIndex = useRef(0);
  const latest = useRef({ value, onChange, readOnly, onActivate, ariaLabel, placeholder, mentionTargets, onCommentSelection, commentRevision, annotations });

  useLayoutEffect(() => {
    latest.current = { value, onChange, readOnly, onActivate, ariaLabel, placeholder, mentionTargets, onCommentSelection, commentRevision, annotations };
  });

  function matchingTargets(menu: MentionMenu | null) {
    if (!menu) return [];
    const kind = menu.trigger === "@" ? "user" : menu.trigger === "@@" ? "task" : "node";
    const query = menu.query.toLocaleLowerCase();
    return latest.current.mentionTargets
      .filter(target => target.kind === kind && target.label.toLocaleLowerCase().includes(query))
      .slice(0, 8);
  }

  function updateMentionMenu(current: Editor) {
    if (latest.current.readOnly || !latest.current.mentionTargets.length || !current.state.selection.empty) {
      mentionMenuRef.current = null;
      setMentionMenu(null);
      return;
    }
    const { $from } = current.state.selection;
    const before = $from.parent.textBetween(0, $from.parentOffset, undefined, "\ufffc");
    const match = before.match(/(?:^|\s)(@{1,3})([^@\s]*)$/);
    if (!match) {
      mentionMenuRef.current = null;
      setMentionMenu(null);
      return;
    }
    const menu = {
      from: current.state.selection.from - match[1].length - match[2].length,
      to: current.state.selection.from,
      trigger: match[1],
      query: match[2],
    };
    mentionIndex.current = 0;
    mentionMenuRef.current = menu;
    setMentionMenu(menu);
  }

  function insertMention(current: Editor, target: MentionTarget) {
    const menu = mentionMenuRef.current;
    if (!menu || !isSafeUrl(target.href)) return;
    const href = target.href.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
    const label = `${menu.trigger}${target.label}`.replaceAll("&", "&amp;").replaceAll("<", "&lt;");
    current.chain().focus().insertContentAt({ from: menu.from, to: menu.to }, `<a href="${href}">${label}</a> `).run();
    mentionMenuRef.current = null;
    setMentionMenu(null);
  }

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    const initial = latest.current;
    lastMarkdown.current = initial.value ?? "";
    const annotationsExtension = Extension.create({
      name: "commentAnnotations",
      addProseMirrorPlugins() {
        return [new Plugin({
          key: new PluginKey("commentAnnotations"),
          props: { decorations(state) {
            const decorations: Decoration[] = [];
            for (const annotation of latest.current.annotations.filter(value => value.state === "attached")) {
              const ranges: { from: number; to: number }[] = [];
              state.doc.descendants((node, pos) => {
                if (!node.isText || !node.text) return;
                let at = node.text.indexOf(annotation.exact);
                while (at !== -1) { ranges.push({ from: pos + at, to: pos + at + annotation.exact.length }); at = node.text.indexOf(annotation.exact, at + 1); }
              });
              if (ranges.length === 1) decorations.push(Decoration.inline(ranges[0].from, ranges[0].to, { class: "comment-highlight" }));
            }
            return DecorationSet.create(state.doc, decorations);
          } },
        })];
      },
    });
    const next = new Editor({
      element: mount,
      extensions: [...extensions, annotationsExtension],
      content: markdownToHtml(initial.value ?? ""),
      editable: !initial.readOnly,
      editorProps: {
        attributes: {
          role: "textbox",
          "aria-multiline": "true",
          "aria-label": initial.ariaLabel,
          tabindex: "0",
          class: "tiptap",
          ...(initial.placeholder
            ? {
                "aria-placeholder": initial.placeholder,
                "data-placeholder": initial.placeholder,
              }
            : {}),
        },
        handleKeyDown: (_view, event) => {
          const menu = mentionMenuRef.current;
          const targets = matchingTargets(menu);
          if (!menu || !targets.length) return false;
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            mentionIndex.current = (mentionIndex.current + (event.key === "ArrowDown" ? 1 : targets.length - 1)) % targets.length;
            setTick(tick => tick + 1);
            return true;
          }
          if (event.key === "Enter") {
            event.preventDefault();
            insertMention(next, targets[mentionIndex.current] ?? targets[0]);
            return true;
          }
          if (event.key === "Escape") {
            event.preventDefault();
            mentionMenuRef.current = null;
            setMentionMenu(null);
            return true;
          }
          return false;
        },
      },
      onCreate: ({ editor: created }) => {
        markEmpty(created);
        setEditor(created);
      },
      onUpdate: ({ editor: updated, transaction }) => {
        if (!transaction.docChanged || latest.current.readOnly) return;
        markEmpty(updated);
        const markdown = serialize(updated);
        if (markdown.length > RICH_TEXT_MAX) {
          const accepted = lastMarkdown.current ?? "";
          updated.commands.setContent(markdownToHtml(accepted), { emitUpdate: false });
          markEmpty(updated);
          setLimitReached(true);
          return;
        }
        setLimitReached(false);
        // setEditable() also emits update events without touching the
        // document; only propagate genuine content changes.
        if (markdown === lastMarkdown.current) return;
        lastMarkdown.current = markdown;
        latest.current.onChange(markdown);
      },
      onTransaction: ({ editor: current }) => {
        setTick((tick) => tick + 1);
        const selection = current.state.selection;
        if (selection.empty || !latest.current.onCommentSelection) setCommentSelection(null);
        else {
          const exact = current.state.doc.textBetween(selection.from, selection.to, "\n", "\n");
          const anchored = selectionAnchor(latest.current.value, exact, latest.current.commentRevision);
          setCommentSelection(anchored ? {
            start: anchored.start, end: anchored.end, exact: anchored.exact,
            prefix: anchored.prefix, suffix: anchored.suffix,
          } : null);
        }
        queueMicrotask(() => { if (!current.isDestroyed) updateMentionMenu(current); });
      },
    });
    return () => {
      setEditor(null);
      next.destroy();
    };
  }, []);

  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    if (editor.isFocused) return;
    const incoming = value ?? "";
    if (incoming === lastMarkdown.current) return;
    if (incoming === serialize(editor)) return;
    editor.commands.setContent(markdownToHtml(incoming), {
      emitUpdate: false,
    });
    markEmpty(editor);
    lastMarkdown.current = incoming;
  }, [editor, value]);

  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    editor.setEditable(!readOnly, false);
    // Viewers keep the caret (contenteditable="true") so text stays
    // keyboard-selectable; aria-readonly announces the mutation block.
    editor.view.dom.setAttribute("aria-readonly", String(!!readOnly));
  }, [editor, readOnly]);

  useEffect(() => {
    if (editor && !editor.isDestroyed) editor.view.dispatch(editor.state.tr);
  }, [editor, annotations]);

  function openLinkRow() {
    if (readOnly || !editor) return;
    // ProseMirror keeps selection state across blur, so focusing the URL
    // input never loses the range the link applies to.
    setLinkUrl((editor.getAttributes("link").href as string | undefined) ?? "");
    setLinkOpen(true);
  }

  function applyLink() {
    if (readOnly || !editor) return;
    const url = linkUrl.trim();
    if (!isSafeUrl(url)) return;
    editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
    setLinkOpen(false);
    setLinkUrl("");
  }

  const toolbarButton = (
    label: string,
    text: string,
    active: boolean,
    onPress: () => void,
  ) => (
    <button
      key={label}
      type="button"
      aria-label={label}
      aria-pressed={active}
      title={label}
      disabled={readOnly || !editor}
      onMouseDown={(event) => event.preventDefault()}
      onClick={(event) => {
        if (readOnly) return;
        // Pointer commands need document focus. Keyboard commands apply to the
        // preserved selection while the toolbar button stays focused.
        if (event.detail !== 0) editor?.commands.focus();
        onPress();
      }}
    >
      {text}
    </button>
  );

  return (
    <div
      className={`rich-editor${readOnly && onActivate ? " rich-editor-activatable" : ""}`}
      onClick={() => { if (readOnly) onActivate?.(); }}
      onFocusCapture={() => { if (readOnly) onActivate?.(); }}
    >
        <div className="rich-editor-toolbar" role="group" aria-label="Formatting">
          {readOnly && onCommentSelection && (
            <button type="button" disabled={!commentSelection} title={commentSelection ? "Comment on selected text" : "Select text to comment"}
              onMouseDown={event => event.preventDefault()} onClick={event => {
                event.stopPropagation();
                if (commentSelection) onCommentSelection({ revision: commentRevision, ...commentSelection });
              }}>Comment</button>
          )}
          {toolbarButton("Bold", "B", editor?.isActive("bold") ?? false, () =>
            editor?.chain().toggleBold().run(),
          )}
          {toolbarButton("Italic", "I", editor?.isActive("italic") ?? false, () =>
            editor?.chain().toggleItalic().run(),
          )}
          {toolbarButton(
            "Strikethrough",
            "S",
            editor?.isActive("strike") ?? false,
            () => editor?.chain().toggleStrike().run(),
          )}
          {toolbarButton("Code", "<>", editor?.isActive("code") ?? false, () =>
            editor?.chain().toggleCode().run(),
          )}
          <select aria-label="Text style" disabled={readOnly || !editor}
            value={editor?.isActive("heading", { level: 2 }) ? "2" : editor?.isActive("heading", { level: 3 }) ? "3" : "paragraph"}
            onChange={event => {
              if (!editor) return;
              const chain = editor.chain().focus();
              if (event.target.value === "paragraph") chain.setParagraph().run();
              else chain.setHeading({ level: event.target.value === "2" ? 2 : 3 }).run();
            }}>
            <option value="paragraph">Normal text</option>
            <option value="2">Heading</option>
            <option value="3">Subheading</option>
          </select>
          {toolbarButton(
            "Bulleted list",
            "• List",
            editor?.isActive("bulletList") ?? false,
            () => editor?.chain().toggleBulletList().run(),
          )}
          {toolbarButton(
            "Numbered list",
            "1. List",
            editor?.isActive("orderedList") ?? false,
            () => editor?.chain().toggleOrderedList().run(),
          )}
          {toolbarButton(
            "Quote",
            "Quote",
            editor?.isActive("blockquote") ?? false,
            () => editor?.chain().toggleBlockquote().run(),
          )}
          {toolbarButton(
            "Code block",
            "{ }",
            editor?.isActive("codeBlock") ?? false,
            () => editor?.chain().toggleCodeBlock().run(),
          )}
          {toolbarButton("Link", "Link", editor?.isActive("link") ?? false, openLinkRow)}
        </div>
      {!readOnly && linkOpen && (
        <div className="rich-editor-linkrow">
          <label>
            Link URL
            <input
              aria-label="Link URL"
              type="url"
              inputMode="url"
              autoFocus
              value={linkUrl}
              placeholder="https://example.com"
              onChange={(event) => setLinkUrl(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  applyLink();
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  setLinkOpen(false);
                  setLinkUrl("");
                  editor?.commands.focus();
                }
              }}
            />
          </label>
          <button type="button" disabled={!isSafeUrl(linkUrl.trim())} onClick={applyLink}>
            Apply link
          </button>
          {editor?.isActive("link") && (
            <button
              type="button"
              onClick={() => {
                if (readOnly) return;
                editor.chain().focus().extendMarkRange("link").unsetLink().run();
                setLinkOpen(false);
                setLinkUrl("");
              }}
            >
              Remove link
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              setLinkOpen(false);
              setLinkUrl("");
              editor?.commands.focus();
            }}
          >
            Cancel
          </button>
        </div>
      )}
      <div key="document" className="rich-editor-document" ref={mountRef} />
      {mentionMenu && matchingTargets(mentionMenu).length > 0 && (
        <div className="mention-menu" role="listbox" aria-label={`${mentionMenu.trigger === "@" ? "People" : mentionMenu.trigger === "@@" ? "Tasks" : "Projects, folders, and lists"} mentions`}>
          {matchingTargets(mentionMenu).map((target, index) => (
            <button key={`${target.kind}:${target.id}`} type="button" role="option" aria-selected={index === mentionIndex.current}
              onMouseDown={event => event.preventDefault()} onClick={() => editor && insertMention(editor, target)}>
              <span>{mentionMenu.trigger}</span>{target.label}
            </button>
          ))}
        </div>
      )}
      {limitReached && <p className="rich-editor-limit" role="status">Body is limited to {RICH_TEXT_MAX.toLocaleString()} characters. The last edit was not applied.</p>}
    </div>
  );
}
