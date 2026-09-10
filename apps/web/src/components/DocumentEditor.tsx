import { useEffect, useRef, useState, type ReactNode, type SubmitEvent } from "react";
import { api, ApiError, message, workspacePath, type Detail, type DocumentRecord, type DocumentSummary, type Item } from "../lib/api";
import RichTextEditor, { type TextAnnotation, type TextSelection } from "./RichTextEditor";
import CommentsPanel from "./CommentsPanel";
import { ErrorNotice, Loading } from "./Shared";

const noDocumentAnnotations: TextAnnotation[] = [];
const documentTimestamp = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

function documentPageSubtree(pageId: string, pages: DocumentSummary[]) {
  const ids = new Set([pageId]);
  for (let index = 0; index < pages.length; index++) {
    for (const page of pages) if (page.parentDocumentId && ids.has(page.parentDocumentId)) ids.add(page.id);
  }
  return ids;
}

export default function DocumentEditor({ detail, summary, items, currentUserId, onOpenDocument, onDocumentDeleted, onChanged }: {
  detail: Detail; summary: DocumentSummary; items: Item[]; currentUserId?: string;
  onOpenDocument: (document: DocumentSummary) => void; onDocumentDeleted: (fallbackId: string) => void; onChanged: () => void;
}) {
  const [document, setDocument] = useState<DocumentRecord | null>(null);
  const [pages, setPages] = useState<DocumentSummary[]>([]);
  const [pageTotal, setPageTotal] = useState(0);
  const [pagesTruncated, setPagesTruncated] = useState(false);
  const [rootId, setRootId] = useState(summary.id);
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState("");
  const [titleDraft, setTitleDraft] = useState(summary.title);
  const [editingTitle, setEditingTitle] = useState(false);
  const [annotations, setAnnotations] = useState<TextAnnotation[]>([]);
  const [commentAnchor, setCommentAnchor] = useState<TextSelection | null>(null);
  const [pageName, setPageName] = useState("");
  const [pageParentId, setPageParentId] = useState<string | null>(null);
  const [pagePlacement, setPagePlacement] = useState<"page" | "subpage" | null>(null);
  const [collapsedPages, setCollapsedPages] = useState<Set<string>>(new Set());
  const [pageMenuId, setPageMenuId] = useState<string | null>(null);
  const [renamingPageId, setRenamingPageId] = useState<string | null>(null);
  const [pageTitleDraft, setPageTitleDraft] = useState("");
  const [commentsOpen, setCommentsOpen] = useState(false);
  const commentsDialog = useRef<HTMLDivElement>(null);
  const requestedCommentFocus = useRef<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const base = `${workspacePath(detail.workspace.id)}/documents/${summary.id}`;
  const canWrite = detail.permissions.includes("documents:write");
  const canDelete = detail.permissions.includes("documents:delete");
  function openComment(commentId: string) {
    const url = new URL(window.location.href);
    url.searchParams.set("comment", commentId);
    window.history.replaceState({}, "", url);
    requestedCommentFocus.current = commentId;
    const alreadyOpen = commentsOpen;
    setCommentsOpen(true);
    if (alreadyOpen) requestAnimationFrame(() => {
      const target = window.document.getElementById(`comment-${CSS.escape(commentId)}`);
      target?.scrollIntoView({ block: "center", behavior: "smooth" });
      target?.focus({ preventScroll: true });
      requestedCommentFocus.current = null;
    });
  }
  function selectForComment(selection: TextSelection) {
    setCommentAnchor(selection);
    setCommentsOpen(true);
  }
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(""); setEditing(false);
    Promise.all([
      api<DocumentRecord>(base, "GET", undefined, controller.signal),
      api<{ rootId: string; documents: DocumentSummary[]; total: number; truncated: boolean }>(`${base}/subpages`, "GET", undefined, controller.signal),
    ]).then(([next, result]) => {
      if (controller.signal.aborted) return;
      setDocument(next); setBody(next.body); setTitleDraft(next.title); setEditingTitle(false); setRootId(result.rootId); setPages(result.documents);
      setPageTotal(result.total); setPagesTruncated(result.truncated); setCommentAnchor(null);
    }).catch(cause => { if (!controller.signal.aborted) setError(message(cause)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [base]);
  useEffect(() => {
    if (new URLSearchParams(location.search).has("comment")) setCommentsOpen(true);
  }, []);
  useEffect(() => {
    try {
      const stored = JSON.parse(localStorage.getItem(`hopya.document.pages.collapsed.${detail.workspace.id}.${rootId}`) || "[]");
      setCollapsedPages(new Set(Array.isArray(stored) ? stored.filter(value => typeof value === "string") : []));
    } catch { setCollapsedPages(new Set()); }
  }, [detail.workspace.id, rootId]);
  useEffect(() => {
    if (!commentsOpen) return;
    const previousFocus = window.document.activeElement instanceof HTMLElement ? window.document.activeElement : null;
    requestAnimationFrame(() => {
      const commentId = requestedCommentFocus.current;
      const target = commentId ? window.document.getElementById(`comment-${CSS.escape(commentId)}`) : null;
      if (target) {
        target.scrollIntoView({ block: "center", behavior: "smooth" });
        target.focus({ preventScroll: true });
        requestedCommentFocus.current = null;
      } else commentsDialog.current?.querySelector<HTMLElement>(".document-comments-close")?.focus();
    });
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); setCommentsOpen(false); return; }
      if (event.key !== "Tab") return;
      const focusable = [...(commentsDialog.current?.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])') ?? [])]
        .filter(element => !element.hidden);
      if (!focusable.length) return;
      const first = focusable[0]!;
      const last = focusable.at(-1)!;
      if (event.shiftKey && window.document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && window.document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.document.addEventListener("keydown", close);
    return () => {
      window.document.removeEventListener("keydown", close);
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [commentsOpen]);
  useEffect(() => {
    if (!pageMenuId) return;
    const closeMenu = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent && event.key !== "Escape") return;
      if (event instanceof MouseEvent && event.target instanceof Element && event.target.closest(".document-page-options, .document-page-menu")) return;
      setPageMenuId(null);
    };
    window.document.addEventListener("click", closeMenu);
    window.document.addEventListener("keydown", closeMenu);
    return () => {
      window.document.removeEventListener("click", closeMenu);
      window.document.removeEventListener("keydown", closeMenu);
    };
  }, [pageMenuId]);

  async function save(event: SubmitEvent) {
    event.preventDefault();
    if (!document || busy) return;
    setBusy(true); setError("");
    try {
      const updated = await api<DocumentRecord>(base, "PATCH", { body, expectedUpdatedAt: document.updatedAt });
      setDocument(updated); setBody(updated.body); setEditing(false); setCommentAnchor(null); onChanged();
    } catch (cause) {
      setError(cause instanceof ApiError && cause.status === 409 ? `${message(cause)} Your draft remains here; reload before saving again.` : message(cause));
    } finally { setBusy(false); }
  }

  function cancelEditing() {
    setEditing(false); setBody(document?.body ?? "");
  }

  async function saveTitle() {
    const title = titleDraft.trim();
    if (!document || !title || busy) return;
    if (title === document.title) { setEditingTitle(false); return; }
    setBusy(true); setError("");
    try {
      const updated = await api<DocumentRecord>(base, "PATCH", { title, expectedUpdatedAt: document.updatedAt });
      setDocument(updated); setTitleDraft(updated.title); setEditingTitle(false); onChanged();
    } catch (cause) { setError(message(cause)); }
    finally { setBusy(false); }
  }

  async function createPage(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const title = pageName.trim();
    if (!title || !pageParentId || !pagePlacement || busy) return;
    setBusy(true); setError("");
    try {
      const created = await api<DocumentRecord>(`${workspacePath(detail.workspace.id)}/documents/${pageParentId}/subpages`, "POST", { title, placement: pagePlacement });
      const page = { ...created, parentDocumentId: pageParentId, pagePlacement };
      setPages(current => [...current, page]); setPageName(""); setPageParentId(null); setPagePlacement(null); onChanged(); onOpenDocument(page);
    } catch (cause) { setError(message(cause)); }
    finally { setBusy(false); }
  }

  async function savePageTitle(page: DocumentSummary) {
    const title = pageTitleDraft.trim();
    if (!title || busy) return;
    if (title === page.title) { setRenamingPageId(null); return; }
    setBusy(true); setError("");
    try {
      const updated = await api<DocumentRecord>(`${workspacePath(detail.workspace.id)}/documents/${page.id}`, "PATCH", { title, expectedUpdatedAt: page.updatedAt });
      setPages(current => current.map(candidate => candidate.id === page.id ? { ...candidate, title: updated.title, updatedAt: updated.updatedAt } : candidate));
      if (document?.id === page.id) { setDocument(updated); setTitleDraft(updated.title); }
      setRenamingPageId(null); onChanged();
    } catch (cause) { setError(message(cause)); }
    finally { setBusy(false); }
  }

  async function deletePage(page: DocumentSummary) {
    if (busy) return;
    const subtree = documentPageSubtree(page.id, pages);
    const nestedCount = subtree.size - 1;
    const warning = pagesTruncated
      ? `Delete "${page.title}" and all of its nested document pages, including pages not shown here? This cannot be undone.`
      : nestedCount
      ? `Delete "${page.title}" and its ${nestedCount} nested subpage${nestedCount === 1 ? "" : "s"}? This cannot be undone.`
      : `Delete "${page.title}"? This cannot be undone.`;
    if (!window.confirm(warning)) return;
    setPageMenuId(null); setBusy(true); setError("");
    try {
      await api(`${workspacePath(detail.workspace.id)}/documents/${page.id}`, "DELETE");
      setPages(current => current.filter(candidate => !subtree.has(candidate.id)));
      onChanged();
      if (subtree.has(summary.id)) onDocumentDeleted(page.id === rootId ? page.parentId ?? "" : page.parentDocumentId ?? rootId);
    } catch (cause) { setError(message(cause)); }
    finally { setBusy(false); }
  }

  if (loading) return <Loading />;
  if (!document) return <ErrorNotice error={error || "Document could not be loaded."} />;
  const root = document.id === rootId ? { ...summary, title: document.title, updatedAt: document.updatedAt }
    : (detail.documents ?? []).find(candidate => candidate.id === rootId) ?? (summary.id === rootId ? summary : undefined);
  const navigationPages = root ? [root, ...pages] : pages;
  const pageRoots = root ? [root, ...pages.filter(page => page.pagePlacement === "page" && page.parentDocumentId === rootId)] : pages;
  const pageParent = navigationPages.find(page => page.id === pageParentId);
  const addingTopLevelPage = pageParentId === rootId && pagePlacement === "page";
  const togglePage = (pageId: string) => {
    setCollapsedPages(current => {
      const next = new Set(current);
      if (next.has(pageId)) next.delete(pageId); else next.add(pageId);
      try { localStorage.setItem(`hopya.document.pages.collapsed.${detail.workspace.id}.${rootId}`, JSON.stringify([...next])); } catch {}
      return next;
    });
  };
  const renderPage = (page: DocumentSummary, depth: number): ReactNode => {
    const children = pages.filter(candidate => candidate.pagePlacement === "subpage" && candidate.parentDocumentId === page.id);
    const hasChildren = children.length > 0;
    return <li key={page.id} className={depth ? "document-page-subpage" : "document-page-root"}>
      <div className={`document-page-row${hasChildren ? " has-children" : ""}`}>
        {hasChildren ? <button type="button" className={`document-page-toggle${collapsedPages.has(page.id) ? "" : " expanded"}`}
          aria-label={`${collapsedPages.has(page.id) ? "Expand" : "Collapse"} ${page.title}`} aria-expanded={!collapsedPages.has(page.id)} onClick={() => togglePage(page.id)}><span aria-hidden="true">›</span></button>
          : <span className="document-page-toggle-spacer" aria-hidden="true" />}
        {renamingPageId === page.id ? <>
          <input className="document-page-rename" aria-label={`Rename ${page.title}`} autoFocus value={pageTitleDraft} maxLength={300} disabled={busy}
            onChange={event => setPageTitleDraft(event.target.value)} onKeyDown={event => {
              if (event.key === "Enter") { event.preventDefault(); void savePageTitle(page); }
              if (event.key === "Escape") setRenamingPageId(null);
            }} />
          <button type="button" className="document-page-rename-action" aria-label={`Save ${page.title} name`} disabled={busy || !pageTitleDraft.trim()} onClick={() => void savePageTitle(page)}>✓</button>
          <button type="button" className="document-page-rename-action" aria-label={`Cancel renaming ${page.title}`} disabled={busy} onClick={() => setRenamingPageId(null)}>×</button>
        </> : <>
          <button type="button" className={`document-page-select${page.id === summary.id ? " selected" : ""}`} title={page.title} onClick={() => onOpenDocument(page)}><span>{page.title}</span></button>
          {canWrite && <button type="button" className="document-page-add" aria-label={pageParentId === page.id && pagePlacement === "subpage" ? `Close subpage form for ${page.title}` : `Add subpage to ${page.title}`} aria-expanded={pageParentId === page.id && pagePlacement === "subpage"}
            onClick={() => { const closing = pageParentId === page.id && pagePlacement === "subpage"; setPageName(""); setPageParentId(closing ? null : page.id); setPagePlacement(closing ? null : "subpage"); }}>{pageParentId === page.id && pagePlacement === "subpage" ? "−" : "+"}</button>}
          {(canWrite || canDelete) && <button type="button" className="document-page-options" aria-label={`Options for ${page.title}`} aria-expanded={pageMenuId === page.id}
            onClick={() => setPageMenuId(current => current === page.id ? null : page.id)}>···</button>}
          {pageMenuId === page.id && <div className="document-page-menu" role="menu">
            <button type="button" role="menuitem" onClick={() => { setPageMenuId(null); onOpenDocument(page); }}>Open</button>
            {canWrite && <button type="button" role="menuitem" onClick={() => { setPageMenuId(null); setPageTitleDraft(page.title); setRenamingPageId(page.id); }}>Rename</button>}
            {canDelete && <button type="button" role="menuitem" className="danger" onClick={() => void deletePage(page)}>Delete</button>}
          </div>}
        </>}
      </div>
      {hasChildren && !collapsedPages.has(page.id) && <ol className="document-page-children">{children.map(child => renderPage(child, depth + 1))}</ol>}
    </li>;
  };
  return <div className="document-layout">
    <aside className="document-pages" aria-labelledby="document-pages-heading">
      <header><h2 id="document-pages-heading">Pages</h2><div className="document-pages-actions"><strong>{pageTotal + 1}</strong>{canWrite && <button type="button" className="icon-button" aria-label={addingTopLevelPage ? "Close new page" : "Add page"} aria-expanded={addingTopLevelPage} onClick={() => { setPageName(""); setPageParentId(addingTopLevelPage ? null : rootId); setPagePlacement(addingTopLevelPage ? null : "page"); }}>{addingTopLevelPage ? "−" : "+"}</button>}</div></header>
      {pagesTruncated && <p className="muted">Showing the first {pages.length} of {pageTotal} nested pages.</p>}
      {pageParentId && pagePlacement && <form className="document-page-link" onSubmit={createPage}><label>{pagePlacement === "page" ? "Page name" : `Subpage of ${pageParent?.title ?? "page"}`}<input aria-label={pagePlacement === "page" ? "Page name" : "Subpage name"} autoFocus value={pageName} maxLength={300} required onChange={event => setPageName(event.target.value)} /></label><button type="submit" disabled={busy || !pageName.trim()}>{busy ? "Creating..." : "Create"}</button></form>}
      <ol>{pageRoots.map(page => renderPage(page, 0))}</ol>
    </aside>
    <main className="document-main">
      <ErrorNotice error={error} />
      <form className="document-editor-form" onSubmit={save}>
        <div className="document-actions">{editing ? <>
          <button key="cancel" type="button" disabled={busy} onClick={cancelEditing}>Cancel</button><button key="save" type="submit" className="primary" disabled={busy}>{busy ? "Saving..." : "Save"}</button>
        </> : <><button key="comments" type="button" aria-expanded={commentsOpen} aria-controls="document-comments" onClick={() => setCommentsOpen(value => !value)}>Comments</button>{canWrite && <button key="edit" type="button" className="primary" onClick={event => { event.preventDefault(); setEditing(true); }}>Edit</button>}</>}</div>
        <article className={`document-paper${editing ? " document-paper-editing" : ""}`}>
          <div className="document-paper-title">
            {editingTitle ? <div className="document-paper-title-editor inline-title-editor">
              <input aria-label="Document title" autoFocus value={titleDraft} maxLength={300} disabled={busy}
                onChange={event => setTitleDraft(event.target.value)} onKeyDown={event => {
                  if (event.key === "Enter") { event.preventDefault(); void saveTitle(); }
                  if (event.key === "Escape") { setEditingTitle(false); setTitleDraft(document.title); }
                }} />
              <button type="button" className="inline-title-action inline-save" aria-label="Save document title" disabled={busy || !titleDraft.trim()} onClick={() => void saveTitle()}>✓</button>
              <button type="button" className="inline-title-action" aria-label="Cancel renaming document" disabled={busy} onClick={() => { setEditingTitle(false); setTitleDraft(document.title); }}>×</button>
            </div> : <h1>{canWrite ? <button type="button" aria-label="Rename document" onClick={() => setEditingTitle(true)}>{document.title}</button> : document.title}</h1>}
            <p className="document-paper-meta">Created {documentTimestamp.format(new Date(document.createdAt))} · Updated {documentTimestamp.format(new Date(document.updatedAt))}{document.updatedByName ? ` by ${document.updatedByName}` : ""}</p>
          </div>
          <RichTextEditor aria-label="Document body" value={editing ? body : document.body} onChange={editing ? setBody : () => {}} readOnly={!editing}
            placeholder={editing ? "Write the document..." : "This document has no body yet."}
            commentRevision={document.bodyRevision} annotations={editing ? noDocumentAnnotations : annotations}
            onAnnotationActivate={openComment}
            onCommentSelection={!editing && detail.permissions.includes("comments:create") ? selectForComment : undefined} />
        </article>
      </form>
    </main>
    <div className="document-comments-layer" hidden={!commentsOpen} onMouseDown={event => { if (event.target === event.currentTarget) setCommentsOpen(false); }}>
      <div ref={commentsDialog} className="document-comments-drawer" id="document-comments" role="dialog" aria-modal="true" aria-labelledby="comments-heading">
        <button type="button" className="icon-button document-comments-close" aria-label="Close comments" onClick={() => setCommentsOpen(false)}>×</button>
        <CommentsPanel key={document.id} detail={detail} document={document} items={items} currentUserId={currentUserId}
          anchor={commentAnchor} onAnchorUsed={() => setCommentAnchor(null)}
          onCommentsChange={comments => setAnnotations(comments.flatMap(comment => comment.anchor ? [{
            id: comment.id, authorName: comment.authorName, body: comment.body, anchor: comment.anchor,
          }] : []))} />
      </div>
    </div>
  </div>;
}
