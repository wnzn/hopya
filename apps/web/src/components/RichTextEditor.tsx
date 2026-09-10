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
  plainText,
  selectionAnchor,
} from "../lib/rich-text";
import type { CommentAnchor } from "../lib/api";
import Select from "./Select";

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
  annotations?: TextAnnotation[];
  onAnnotationActivate?: (commentId: string) => void;
};

export type TextSelection = {
  revision: number;
  start: number;
  end: number;
  exact: string;
  prefix: string;
  suffix: string;
};

export type TextAnnotation = {
  id: string;
  authorName: string;
  body: string;
  anchor: CommentAnchor;
};

export type MentionTarget = {
  id: string;
  kind: "user" | "task" | "node";
  label: string;
  href: string;
};
type MentionMenu = { from: number; to: number; trigger: string; query: string };
const noAnnotations: TextAnnotation[] = [];

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
  annotations = noAnnotations,
  onAnnotationActivate,
}: Props) {
  const mountRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
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
  const [annotationBubble, setAnnotationBubble] = useState<{ id: string; left: number; top: number } | null>(null);
  const annotationHoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const annotationLeaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingAnnotationId = useRef<string | null>(null);
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
            for (const annotation of latest.current.annotations.filter(value => value.anchor.state === "attached")) {
              const anchor = annotation.anchor;
              const segments: { from: number; start: number; end: number }[] = [];
              let rendered = "";
              state.doc.descendants((node, pos) => {
                if (!node.isText || !node.text) return;
                const start = rendered.length;
                rendered += node.text;
                segments.push({ from: pos, start, end: rendered.length });
              });
              const findRanges = (exact: string) => {
                const found: { from: number; to: number }[] = [];
                let at = rendered.indexOf(exact);
                while (at !== -1) {
                  const first = segments.find(segment => at >= segment.start && at < segment.end);
                  const lastIndex = at + exact.length - 1;
                  const last = segments.find(segment => lastIndex >= segment.start && lastIndex < segment.end);
                  if (first && last) found.push({ from: first.from + at - first.start, to: last.from + lastIndex - last.start + 1 });
                  at = rendered.indexOf(exact, at + 1);
                }
                return found;
              };
              let ranges = findRanges(anchor.exact);
              if (!ranges.length && /[*_~`\[\]]/.test(anchor.exact)) {
                const container = document.createElement("div");
                container.innerHTML = markdownToHtml(anchor.exact);
                const visibleExact = container.textContent ?? "";
                if (visibleExact) ranges = findRanges(visibleExact);
              }
              const sourceStarts: number[] = [];
              let sourceAt = latest.current.value.indexOf(anchor.exact);
              while (sourceAt !== -1) {
                sourceStarts.push(sourceAt);
                sourceAt = latest.current.value.indexOf(anchor.exact, sourceAt + 1);
              }
              const occurrence = sourceStarts.indexOf(anchor.start);
              const range = occurrence >= 0 ? ranges[occurrence] : ranges.length === 1 ? ranges[0] : undefined;
              if (range) decorations.push(Decoration.inline(range.from, range.to, {
                class: "comment-highlight",
                "data-comment-id": annotation.id,
                role: "link",
                tabindex: "0",
                "aria-label": `Open comment by ${annotation.authorName}`,
              }));
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
        if (latest.current.readOnly) return;
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
    if (!editor || editor.isDestroyed || !readOnly || !onCommentSelection) {
      setCommentSelection(null);
      return;
    }
    const content = editor.view.dom;
    function updateCommentSelection() {
      const selection = document.getSelection();
      if (!selection || selection.rangeCount === 0 || selection.isCollapsed ||
        !selection.anchorNode || !selection.focusNode ||
        !content.contains(selection.anchorNode) || !content.contains(selection.focusNode)) {
        setCommentSelection(null);
        return;
      }
      const exact = selection.toString();
      const range = selection.getRangeAt(0);
      const prefixRange = document.createRange();
      prefixRange.selectNodeContents(content);
      prefixRange.setEnd(range.startContainer, range.startOffset);
      const selectedStart = prefixRange.toString().length;
      const rendered = document.createRange();
      rendered.selectNodeContents(content);
      const renderedText = rendered.toString();
      const starts: number[] = [];
      let match = renderedText.indexOf(exact);
      while (match !== -1) {
        starts.push(match);
        match = renderedText.indexOf(exact, match + 1);
      }
      const occurrence = starts.indexOf(selectedStart);
      const fragment = document.createElement("div");
      fragment.append(range.cloneContents());
      const formattedExact = htmlToMarkdown(fragment.innerHTML);
      const candidates = formattedExact && plainText(formattedExact) === exact.replace(/\s+/g, " ").trim()
        ? [exact, formattedExact] : [exact];
      let anchored = null;
      if (occurrence >= 0) {
        for (const candidate of candidates) {
          anchored = selectionAnchor(value, candidate, commentRevision, occurrence)
            ?? selectionAnchor(value, candidate, commentRevision);
          if (anchored) break;
        }
      }
      setCommentSelection(anchored ? {
        start: anchored.start, end: anchored.end, exact: anchored.exact,
        prefix: anchored.prefix, suffix: anchored.suffix,
      } : null);
    }
    function clearStaleSelection() {
      setCommentSelection(null);
    }
    document.addEventListener("selectionchange", updateCommentSelection);
    content.addEventListener("pointerdown", clearStaleSelection);
    content.addEventListener("pointerup", updateCommentSelection);
    content.addEventListener("keyup", updateCommentSelection);
    updateCommentSelection();
    return () => {
      document.removeEventListener("selectionchange", updateCommentSelection);
      content.removeEventListener("pointerdown", clearStaleSelection);
      content.removeEventListener("pointerup", updateCommentSelection);
      content.removeEventListener("keyup", updateCommentSelection);
    };
  }, [editor, readOnly, onCommentSelection, value, commentRevision]);

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

  function showAnnotation(target: HTMLElement) {
    const id = target.dataset.commentId;
    const root = rootRef.current;
    if (!id || !root) return;
    const targetBounds = target.getBoundingClientRect();
    const rootBounds = root.getBoundingClientRect();
    setAnnotationBubble({
      id,
      left: Math.max(8, Math.min(targetBounds.left - rootBounds.left, rootBounds.width - 288)),
      top: Math.max(8, Math.min(targetBounds.bottom - rootBounds.top + 6, rootBounds.height - 96)),
    });
  }
  function cancelAnnotationHover() {
    if (annotationHoverTimer.current) clearTimeout(annotationHoverTimer.current);
    annotationHoverTimer.current = null;
    pendingAnnotationId.current = null;
  }
  function cancelAnnotationLeave() {
    if (annotationLeaveTimer.current) clearTimeout(annotationLeaveTimer.current);
    annotationLeaveTimer.current = null;
  }
  function scheduleAnnotationClose() {
    cancelAnnotationLeave();
    annotationLeaveTimer.current = setTimeout(() => {
      annotationLeaveTimer.current = null;
      setAnnotationBubble(null);
    }, 120);
  }
  function scheduleAnnotation(target: HTMLElement) {
    const id = target.dataset.commentId;
    if (!id || annotationBubble?.id === id || pendingAnnotationId.current === id) return;
    cancelAnnotationLeave();
    cancelAnnotationHover();
    setAnnotationBubble(null);
    pendingAnnotationId.current = id;
    annotationHoverTimer.current = setTimeout(() => {
      annotationHoverTimer.current = null;
      pendingAnnotationId.current = null;
      if (target.isConnected) showAnnotation(target);
    }, 1000);
  }
  useEffect(() => () => {
    cancelAnnotationHover();
    cancelAnnotationLeave();
  }, []);
  const activeAnnotation = annotationBubble ? annotations.find(annotation => annotation.id === annotationBubble.id) : null;

  return (
    <div
      ref={rootRef}
      className={`rich-editor${readOnly ? " rich-editor-readonly" : ""}${readOnly && onActivate ? " rich-editor-activatable" : ""}`}
      onClick={event => {
        const target = (event.target as Element).closest?.<HTMLElement>(".comment-highlight[data-comment-id]");
        if (target?.dataset.commentId) onAnnotationActivate?.(target.dataset.commentId);
        else if (readOnly) onActivate?.();
      }}
      onKeyDown={event => {
        if (event.key !== "Enter" && event.key !== " ") return;
        const target = (event.target as Element).closest?.<HTMLElement>(".comment-highlight[data-comment-id]");
        if (!target?.dataset.commentId) return;
        event.preventDefault();
        onAnnotationActivate?.(target.dataset.commentId);
      }}
      onMouseOver={event => {
        const target = (event.target as Element).closest?.<HTMLElement>(".comment-highlight[data-comment-id]");
        if (target) {
          cancelAnnotationLeave();
          scheduleAnnotation(target);
        }
      }}
      onMouseOut={event => {
        const target = (event.target as Element).closest?.<HTMLElement>(".comment-highlight[data-comment-id]");
        if (target && pendingAnnotationId.current === target.dataset.commentId && !target.contains(event.relatedTarget as Node | null)) {
          cancelAnnotationHover();
        }
        if (target && annotationBubble?.id === target.dataset.commentId && !target.contains(event.relatedTarget as Node | null)) {
          scheduleAnnotationClose();
        }
      }}
      onMouseLeave={() => {
        cancelAnnotationHover();
        cancelAnnotationLeave();
        setAnnotationBubble(null);
      }}
      onFocusCapture={event => {
        if (readOnly) onActivate?.();
        const target = (event.target as Element).closest?.<HTMLElement>(".comment-highlight[data-comment-id]");
        if (target) {
          cancelAnnotationHover();
          showAnnotation(target);
        }
      }}
    >
        {(!readOnly || onCommentSelection && commentSelection) && <div className={`rich-editor-toolbar${readOnly ? " rich-editor-selection-toolbar" : ""}`} role="group" aria-label={readOnly ? "Selection actions" : "Formatting"}>
          {readOnly ? (
            <button type="button" title="Comment on selected text"
              onMouseDown={event => event.preventDefault()} onClick={event => {
                event.stopPropagation();
                if (commentSelection) onCommentSelection?.({ revision: commentRevision, ...commentSelection });
              }}>Comment</button>
          ) : <>
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
          <Select aria-label="Text style" disabled={readOnly || !editor}
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
          </Select>
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
          </>}
        </div>}
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
      {activeAnnotation && annotationBubble && (
        <button type="button" className="comment-highlight-bubble" style={{ left: annotationBubble.left, top: annotationBubble.top }}
          onMouseEnter={cancelAnnotationLeave} onMouseLeave={() => setAnnotationBubble(null)}
          onClick={event => { event.stopPropagation(); onAnnotationActivate?.(activeAnnotation.id); }}>
          <strong>{activeAnnotation.authorName}</strong>
          <span>{plainText(activeAnnotation.body).slice(0, 180) || "Deleted comment"}</span>
          <small>Open discussion</small>
        </button>
      )}
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
