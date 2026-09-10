import { useEffect, useState } from "react";
import { api, message, workspacePath, type Comment, type CommentAnchor, type Detail, type DocumentRecord, type Item } from "../lib/api";
import { markdownToHtml, plainText } from "../lib/rich-text";
import RichTextEditor, { type MentionTarget } from "./RichTextEditor";
import { ErrorNotice } from "./Shared";

const reactionEmojis = ["👍", "❤️", "😂", "🎉", "😕", "👀"] as const;

function thread(comments: Comment[]): { comment: Comment; depth: number }[] {
  const ids = new Set(comments.map(comment => comment.id));
  const children = new Map<string | null, Comment[]>();
  for (const comment of comments) {
    const parent = comment.parentId && ids.has(comment.parentId) ? comment.parentId : null;
    children.set(parent, [...(children.get(parent) ?? []), comment]);
  }
  const result: { comment: Comment; depth: number }[] = [];
  const seen = new Set<string>();
  function visit(comment: Comment, depth: number) {
    if (seen.has(comment.id)) return;
    seen.add(comment.id); result.push({ comment, depth });
    for (const child of children.get(comment.id) ?? []) visit(child, depth + 1);
  }
  for (const root of children.get(null) ?? []) visit(root, 0);
  for (const comment of comments) visit(comment, 0);
  return result;
}

export function mentionTargets(detail: Detail, items: Item[], document = false): MentionTarget[] {
  const workspace = encodeURIComponent(detail.workspace.id);
  return [
    ...(document ? [] : detail.members.filter(member => !member.disabled && detail.roles.find(role => role.id === member.roleId)?.permissions.includes("items:read")).map(member => ({
      id: member.userId, kind: "user" as const, label: member.name,
      href: `/app?workspace=${workspace}&mentionUser=${encodeURIComponent(member.userId)}`,
    }))),
    ...(document ? (detail.documents ?? []).map(page => ({
      id: page.id, kind: "task" as const, label: page.title,
      href: `/app?workspace=${workspace}&node=${encodeURIComponent(page.id)}`,
    })) : items.filter(item => !item.archivedAt).map(item => ({
      id: item.id, kind: "task" as const, label: item.title,
      href: `/app?workspace=${workspace}&task=${encodeURIComponent(item.id)}`,
    }))),
    ...detail.nodes.map(node => ({
      id: node.id, kind: "node" as const, label: node.name,
      href: `/app?workspace=${workspace}&node=${encodeURIComponent(node.id)}`,
    })),
  ];
}

export default function CommentsPanel({ detail, item, document: documentTarget, items, currentUserId, anchor, onAnchorUsed, onCommentsChange }: {
  detail: Detail; item?: Item; document?: DocumentRecord; items: Item[]; currentUserId?: string;
  anchor?: Omit<CommentAnchor, "state"> | null; onAnchorUsed?: () => void;
  onCommentsChange?: (comments: Comment[]) => void;
}) {
  const base = `${workspacePath(detail.workspace.id)}/${documentTarget ? `documents/${documentTarget.id}` : `items/${item!.id}`}/comments`;
  const [comments, setComments] = useState<Comment[]>([]);
  const [body, setBody] = useState("");
  const [replyingTo, setReplyingTo] = useState<string | null>(null);
  const [replyBody, setReplyBody] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const targets = mentionTargets(detail, items, Boolean(documentTarget));
  useEffect(() => onCommentsChange?.(comments), [comments]);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(""); setComments([]);
    api<Comment[]>(base, "GET", undefined, controller.signal)
      .then(setComments).catch(cause => { if (!controller.signal.aborted) setError(message(cause)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [base, documentTarget?.bodyRevision, item?.bodyRevision]);
  useEffect(() => {
    if (loading) return;
    const commentId = new URLSearchParams(location.search).get("comment");
    if (!commentId) return;
    requestAnimationFrame(() => {
      const target = document.getElementById(`comment-${CSS.escape(commentId)}`);
      target?.scrollIntoView({ block: "center" });
      target?.focus({ preventScroll: true });
    });
  }, [comments, loading]);
  async function post(parentId: string | null = null) {
    const value = parentId ? replyBody : body;
    if (!value.trim() || busy) return;
    setBusy(true); setError("");
    try {
      const anchorInput = anchor ? {
        revision: anchor.revision,
        start: anchor.start,
        end: anchor.end,
        exact: anchor.exact,
        prefix: anchor.prefix,
        suffix: anchor.suffix,
      } : null;
      const created = await api<Comment>(base, "POST", { body: value, ...(parentId ? { parentId } : {}), ...(!parentId && anchorInput ? { anchor: anchorInput } : {}) });
      setComments(current => [...current, created]);
      if (parentId) { setReplyBody(""); setReplyingTo(null); } else { setBody(""); onAnchorUsed?.(); }
      window.dispatchEvent(new Event("hopya-notifications-changed"));
    } catch (cause) { setError(message(cause)); }
    finally { setBusy(false); }
  }
  async function remove(comment: Comment) {
    const purging = Boolean(comment.deletedAt);
    if (busy || !window.confirm(purging ? "Remove this deleted comment entry permanently? Replies will remain in the discussion." : "Delete this comment? Replies and notifications will retain a deleted marker.")) return;
    setBusy(true); setError("");
    try {
      await api(`${base}/${comment.id}`, "DELETE");
      setComments(current => purging
        ? current.filter(entry => entry.id !== comment.id).map(entry => entry.parentId === comment.id ? { ...entry, parentId: comment.parentId } : entry)
        : current.map(entry => entry.id === comment.id ? { ...entry, body: "", deletedAt: new Date().toISOString() } : entry));
    } catch (cause) { setError(message(cause)); }
    finally { setBusy(false); }
  }
  async function react(comment: Comment, emoji: string) {
    if (busy || comment.deletedAt) return;
    const existing = comment.reactions.find(reaction => reaction.emoji === emoji);
    setBusy(true); setError("");
    try {
      const result = await api<{ emoji: string; active: boolean; count: number }>(`${base}/${comment.id}/reaction`, "PATCH", { emoji, active: !existing?.reactedByMe });
      setComments(current => current.map(entry => entry.id !== comment.id ? entry : {
        ...entry,
        reactions: [...entry.reactions.filter(reaction => reaction.emoji !== emoji),
          ...(result.count ? [{ emoji, count: result.count, reactedByMe: result.active }] : [])],
      }));
    } catch (cause) { setError(message(cause)); }
    finally { setBusy(false); }
  }
  const writable = detail.permissions.includes("comments:create");
  const manager = detail.permissions.includes("comments:manage");
  return <aside className="comments-panel" aria-labelledby="comments-heading">
    <header><div><span>DISCUSSION</span><h3 id="comments-heading">Comments</h3></div><strong aria-label={`${comments.length} comments`}>{comments.length}</strong></header>
    <ErrorNotice error={error} />
    {loading ? <p role="status">Loading comments...</p> : comments.length === 0 ? <p className="muted">No comments yet.</p> : (
      <ol className="comment-list">
        {thread(comments).map(({ comment, depth }) => <li key={comment.id} id={`comment-${comment.id}`} tabIndex={-1} className={depth ? "comment-reply" : undefined} style={{ marginInlineStart: `${Math.min(depth, 4) * 18}px` }}>
          <div className="comment-meta"><strong>{comment.authorName}</strong><time dateTime={comment.createdAt}>{new Date(comment.createdAt).toLocaleString()}</time></div>
          {comment.anchor && <blockquote className={`comment-anchor ${comment.anchor.state}`}>
            <span>{comment.anchor.state === "orphaned" ? "Original selection" : "Commented text"}</span>
            <q>{plainText(comment.anchor.exact)}</q>
          </blockquote>}
          {comment.deletedAt ? <p className="muted"><em>Comment deleted</em></p> : <div className="comment-body" dangerouslySetInnerHTML={{ __html: markdownToHtml(comment.body) }} />}
          {comment.deletedAt && manager && <div className="comment-actions"><button type="button" className="quiet-button" disabled={busy} onClick={() => void remove(comment)}>Remove entry</button></div>}
          {!comment.deletedAt && <div className="comment-actions">
            <div className="comment-reactions" aria-label="Comment reactions">
              {comment.reactions.map(reaction => <button key={reaction.emoji} type="button" className={reaction.reactedByMe ? "selected" : undefined} disabled={busy} aria-pressed={reaction.reactedByMe} aria-label={`${reaction.reactedByMe ? "Remove" : "Add"} ${reaction.emoji} reaction`} onClick={() => void react(comment, reaction.emoji)}>{reaction.emoji} <span>{reaction.count}</span></button>)}
              {writable && <details className="comment-reaction-picker"><summary aria-label="Add reaction">+</summary><div>{reactionEmojis.map(emoji => <button key={emoji} type="button" disabled={busy} aria-label={`React with ${emoji}`} onClick={() => void react(comment, emoji)}>{emoji}</button>)}</div></details>}
            </div>
            {writable && <button type="button" className="quiet-button" disabled={busy} onClick={() => { setReplyingTo(comment.id); setReplyBody(""); }}>Reply</button>}
            {(comment.authorId === currentUserId || manager) && <button type="button" className="quiet-button" disabled={busy} onClick={() => void remove(comment)}>Delete</button>}
          </div>}
          {replyingTo === comment.id && <div className="comment-reply-composer">
            <RichTextEditor aria-label={`Reply to ${comment.authorName}`} value={replyBody} onChange={value => setReplyBody(value.slice(0, 10000))} placeholder="Write a reply..." mentionTargets={targets} />
            <div><button type="button" className="quiet-button" disabled={busy} onClick={() => { setReplyingTo(null); setReplyBody(""); }}>Cancel</button><button type="button" className="primary" disabled={busy || !replyBody.trim()} onClick={() => void post(comment.id)}>{busy ? "Posting..." : "Post reply"}</button></div>
          </div>}
        </li>)}
      </ol>
    )}
    {writable && <div className="comment-composer">
      {anchor && <div className="pending-comment-anchor"><span>Commenting on</span><q>{plainText(anchor.exact)}</q><button type="button" className="quiet-button" onClick={onAnchorUsed}>Clear selection</button></div>}
      <RichTextEditor aria-label="New comment" value={body} onChange={value => setBody(value.slice(0, 10000))}
        placeholder={documentTarget ? "Write a comment. Use @@ for pages or @@@ for structure." : "Write a comment. Use @ for people, @@ for tasks, or @@@ for structure."} mentionTargets={targets} />
      <button type="button" className="primary" disabled={busy || !body.trim()} onClick={() => void post(null)}>{busy ? "Posting..." : "Post comment"}</button>
    </div>}
  </aside>;
}
