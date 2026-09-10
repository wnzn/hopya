import { useEffect, useState, type SubmitEvent } from "react";
import { api, ApiError, message, workspacePath, type CommentAnchor, type Detail, type DocumentRecord, type DocumentSummary, type Item } from "../lib/api";
import RichTextEditor, { type TextSelection } from "./RichTextEditor";
import CommentsPanel from "./CommentsPanel";
import { ErrorNotice, Loading } from "./Shared";

function pageDepth(item: Item, byId: Map<string, Item>) {
  let depth = 0;
  let current = item.parentId ? byId.get(item.parentId) : undefined;
  const seen = new Set([item.id]);
  while (current && depth < 32 && !seen.has(current.id)) {
    seen.add(current.id); depth++; current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return depth;
}

export default function DocumentEditor({ detail, summary, items, currentUserId, onOpenTask, onChanged }: {
  detail: Detail; summary: DocumentSummary; items: Item[]; currentUserId?: string;
  onOpenTask: (item: Item) => void; onChanged: () => void;
}) {
  const [document, setDocument] = useState<DocumentRecord | null>(null);
  const [pages, setPages] = useState<Item[]>([]);
  const [totalPages, setTotalPages] = useState(0);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(summary.title);
  const [body, setBody] = useState("");
  const [anchor, setAnchor] = useState<CommentAnchor | null>(null);
  const [annotations, setAnnotations] = useState<CommentAnchor[]>([]);
  const [linkId, setLinkId] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const base = `${workspacePath(detail.workspace.id)}/documents/${summary.id}`;
  const canReadTasks = detail.permissions.includes("items:read");
  const canWrite = detail.permissions.includes("documents:write");
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(""); setAnchor(null); setEditing(false);
    Promise.all([
      api<DocumentRecord>(base, "GET", undefined, controller.signal),
      canReadTasks ? api<{ items: Item[]; total: number; truncated: boolean }>(`${base}/pages`, "GET", undefined, controller.signal) : Promise.resolve({ items: [], total: 0, truncated: false }),
    ]).then(([next, result]) => {
      if (controller.signal.aborted) return;
      setDocument(next); setTitle(next.title); setBody(next.body); setPages(result.items); setTotalPages(result.total);
    }).catch(cause => { if (!controller.signal.aborted) setError(message(cause)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [base, canReadTasks]);

  function selectForComment(selection: TextSelection) {
    setAnchor({ ...selection, state: "attached" });
  }

  async function save(event: SubmitEvent) {
    event.preventDefault();
    if (!document || busy || !title.trim()) return;
    setBusy(true); setError("");
    try {
      const updated = await api<DocumentRecord>(base, "PATCH", { title: title.trim(), body, expectedUpdatedAt: document.updatedAt });
      setDocument(updated); setTitle(updated.title); setBody(updated.body); setEditing(false); setAnchor(null); onChanged();
    } catch (cause) {
      setError(cause instanceof ApiError && cause.status === 409 ? `${message(cause)} Your draft remains here; reload before saving again.` : message(cause));
    } finally { setBusy(false); }
  }

  async function linkPage() {
    if (!linkId || busy) return;
    setBusy(true); setError("");
    try {
      await api(`${base}/pages`, "POST", { itemId: linkId, position: totalPages });
      const result = await api<{ items: Item[]; total: number }>(`${base}/pages`);
      setPages(result.items); setTotalPages(result.total); setLinkId(""); onChanged();
    } catch (cause) { setError(message(cause)); }
    finally { setBusy(false); }
  }

  async function unlinkPage(itemId: string) {
    if (busy || !window.confirm("Remove this task from the document? The task and its subtasks will be preserved.")) return;
    setBusy(true); setError("");
    try {
      await api(`${base}/pages/${itemId}`, "DELETE");
      const result = await api<{ items: Item[]; total: number }>(`${base}/pages`);
      setPages(result.items); setTotalPages(result.total); onChanged();
    } catch (cause) { setError(message(cause)); }
    finally { setBusy(false); }
  }

  if (loading) return <Loading />;
  if (!document) return <ErrorNotice error={error || "Document could not be loaded."} />;
  const byId = new Map(pages.map(item => [item.id, item]));
  const linkedIds = new Set(detail.documentPages?.map(page => page.itemId) ?? []);
  const linkable = items.filter(item => !item.archivedAt && !item.parentId && !linkedIds.has(item.id));
  return <div className="document-layout">
    <main className="document-main">
      <ErrorNotice error={error} />
      {editing ? <form className="document-editor-form" onSubmit={save}>
        <label>Document title<input value={title} onChange={event => setTitle(event.target.value)} maxLength={300} required /></label>
        <RichTextEditor aria-label="Document body" value={body} onChange={setBody} mentionTargets={[]} placeholder="Write the document..." />
        <div className="modal-actions"><button type="button" disabled={busy} onClick={() => { setEditing(false); setTitle(document.title); setBody(document.body); }}>Cancel</button><button className="primary" disabled={busy || !title.trim()}>{busy ? "Saving..." : "Save document"}</button></div>
      </form> : <>
        <div className="document-actions">{canWrite && <button type="button" onClick={() => setEditing(true)}>Edit document</button>}</div>
        {document.body ? <RichTextEditor aria-label="Document body" value={document.body} onChange={() => {}} readOnly
          commentRevision={document.bodyRevision} annotations={annotations} onCommentSelection={detail.permissions.includes("comments:create") ? selectForComment : undefined} />
          : <p className="document-empty">This document has no body yet.</p>}
      </>}
      {canReadTasks && <section className="document-pages" aria-labelledby="document-pages-heading">
        <header><div><span>PAGES</span><h2 id="document-pages-heading">Task pages</h2></div><strong>{totalPages}</strong></header>
        {pages.length ? <ol>{pages.map(item => <li key={item.id} style={{ marginInlineStart: `${Math.min(pageDepth(item, byId), 6) * 20}px` }}>
          <button type="button" onClick={() => onOpenTask(item)}>{item.title}</button>
          {!item.parentId && canWrite && <button type="button" className="quiet-button" onClick={() => void unlinkPage(item.id)}>Unlink</button>}
        </li>)}</ol> : <p className="muted">Link a top-level task to make it a page. Its subtasks appear below it automatically.</p>}
        {canWrite && <div className="document-page-link"><label>Link an existing task<select value={linkId} onChange={event => setLinkId(event.target.value)}><option value="">Choose a top-level task</option>{linkable.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label><button type="button" disabled={busy || !linkId} onClick={() => void linkPage()}>Link task</button></div>}
        {totalPages > pages.length && <p className="notice">Showing the first {pages.length} of {totalPages} pages. Search and exports remain complete.</p>}
      </section>}
    </main>
    <CommentsPanel detail={detail} document={document} items={items} currentUserId={currentUserId} anchor={anchor} onAnchorUsed={() => setAnchor(null)}
      onCommentsChange={comments => setAnnotations(comments.flatMap(comment => comment.anchor ? [comment.anchor] : []))} />
  </div>;
}
