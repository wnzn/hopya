import { useEffect, useState } from "react";
import { api, message, workspacePath, type Comment, type CommentAnchor, type Detail, type DocumentRecord, type Item } from "../lib/api";
import { markdownToHtml, plainText } from "../lib/rich-text";
import RichTextEditor, { type MentionTarget } from "./RichTextEditor";
import { ErrorNotice } from "./Shared";
import SolidIcon from "./SolidIcon";
import Avatar from "./Avatar";
import { readTextDraft, writeTextDraft } from '../lib/text-drafts';

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

function Discussion({ detail, item, document: documentTarget, items, currentUserId, anchor, onAnchorUsed, onCommentsChange }: {
  detail: Detail; item?: Item; document?: DocumentRecord; items: Item[]; currentUserId?: string;
  anchor?: Omit<CommentAnchor, "state"> | null; onAnchorUsed?: () => void;
  onCommentsChange?: (comments: Comment[]) => void;
}) {
  const base = `${workspacePath(detail.workspace.id)}/${documentTarget ? `documents/${documentTarget.id}` : `items/${item!.id}`}/comments`;
  const draftBase = `hopya.comment-draft:${currentUserId ?? 'current'}:${base}`;
  const bodyDraftKey = `${draftBase}:new`;
  const [comments, setComments] = useState<Comment[]>([]);
  const [body, setBody] = useState(() => readTextDraft(bodyDraftKey) ?? '');
  const [replyingTo, setReplyingTo] = useState<string | null>(null);
  const [replyBody, setReplyBody] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [bodyImagesPending, setBodyImagesPending] = useState(false);
  const [replyImagesPending, setReplyImagesPending] = useState(false);
  const [draftStorageError, setDraftStorageError] = useState(false);
  const imageTarget = { workspaceId: detail.workspace.id, kind: documentTarget ? 'document-comment' as const : 'task-comment' as const, resourceId: documentTarget?.id ?? item!.id };
  function changeBody(value: string) {
    setBody(value); setDraftStorageError(!writeTextDraft(bodyDraftKey, value));
  }
  function changeReply(value: string) {
    setReplyBody(value); setDraftStorageError(!writeTextDraft(`${draftBase}:reply:${replyingTo}`, value));
  }
  useEffect(() => {
    if (!body && !replyBody && !bodyImagesPending && !replyImagesPending) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [body, replyBody, bodyImagesPending, replyImagesPending]);
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
    if (!value.trim() || busy || (parentId ? replyImagesPending : bodyImagesPending)) return;
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
      if (parentId) { changeReply(''); setReplyingTo(null); } else { changeBody(''); onAnchorUsed?.(); }
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
    {draftStorageError && <p role="alert">Browser draft storage is unavailable. Keep this discussion open until your draft is posted.</p>}
    {loading ? <p role="status">Loading comments...</p> : comments.length === 0 ? <p className="muted">No comments yet.</p> : (
      <ol className="comment-list">
        {thread(comments).map(({ comment, depth }) => <li key={comment.id} id={`comment-${comment.id}`} tabIndex={-1} className={depth ? "comment-reply" : undefined} style={{ marginInlineStart: `${Math.min(depth, 4) * 18}px` }}>
          <header className="comment-meta">
            <Avatar name={comment.authorName} photoUrl={comment.authorPhotoUrl} />
            <span className="comment-author"><strong>{comment.authorName}</strong><time dateTime={comment.createdAt}>{new Date(comment.createdAt).toLocaleString()}</time></span>
          </header>
          {comment.anchor && <blockquote className={`comment-anchor ${comment.anchor.state}`}>
            <span>{comment.anchor.state === "orphaned" ? "Original selection" : "Commented text"}</span>
            <q>{plainText(comment.anchor.exact)}</q>
          </blockquote>}
          {comment.deletedAt ? <p className="muted comment-deleted"><em>Comment deleted</em></p> : <div className="comment-body" dangerouslySetInnerHTML={{ __html: markdownToHtml(comment.body) }} />}
          {comment.deletedAt && manager && <div className="comment-actions"><button type="button" className="comment-action-button danger" disabled={busy} aria-label="Remove deleted comment entry" onClick={() => void remove(comment)}><SolidIcon name="trash" /></button></div>}
          {!comment.deletedAt && <div className="comment-actions">
            <div className="comment-reactions" aria-label="Comment reactions">
              {comment.reactions.map(reaction => <button key={reaction.emoji} type="button" className={reaction.reactedByMe ? "selected" : undefined} disabled={busy} aria-pressed={reaction.reactedByMe} aria-label={`${reaction.reactedByMe ? "Remove" : "Add"} ${reaction.emoji} reaction`} onClick={() => void react(comment, reaction.emoji)}>{reaction.emoji} <span>{reaction.count}</span></button>)}
              {writable && <details className="comment-reaction-picker"><summary aria-label="Add reaction"><SolidIcon name="smilePlus" /></summary><div>{reactionEmojis.map(emoji => <button key={emoji} type="button" disabled={busy} aria-label={`React with ${emoji}`} onClick={() => void react(comment, emoji)}>{emoji}</button>)}</div></details>}
            </div>
            {writable && <button type="button" className="comment-action-button" disabled={busy} aria-label={`Reply to ${comment.authorName}`} onClick={() => { setReplyingTo(comment.id); setReplyBody(readTextDraft(`${draftBase}:reply:${comment.id}`) ?? ''); }}><SolidIcon name="reply" /></button>}
            {(comment.authorId === currentUserId || manager) && <button type="button" className="comment-action-button danger" disabled={busy} aria-label={`Delete comment by ${comment.authorName}`} onClick={() => void remove(comment)}><SolidIcon name="trash" /></button>}
          </div>}
          {replyingTo === comment.id && <div className="comment-reply-composer">
            <RichTextEditor key={`${draftBase}:reply:${comment.id}`} aria-label={`Reply to ${comment.authorName}`} value={replyBody} onChange={changeReply} maxLength={10000}
              readOnly={busy} imageTarget={imageTarget} draftKey={`${draftBase}:reply:${comment.id}`} onImagePendingChange={setReplyImagesPending} placeholder="Write a reply..." mentionTargets={targets} />
            <div><button type="button" className="quiet-button" disabled={busy} onClick={() => setReplyingTo(null)}>Close reply (keep draft)</button><button type="button" className="primary" disabled={busy || replyImagesPending || !replyBody.trim()} onClick={() => void post(comment.id)}>{busy ? "Posting..." : "Post reply"}</button></div>
          </div>}
        </li>)}
      </ol>
    )}
    {writable && <div className="comment-composer">
      {anchor && <div className="pending-comment-anchor"><span>Commenting on</span><q>{plainText(anchor.exact)}</q><button type="button" className="quiet-button" onClick={onAnchorUsed}>Clear selection</button></div>}
      <RichTextEditor key={bodyDraftKey} aria-label="New comment" value={body} onChange={changeBody} maxLength={10000}
        readOnly={busy} imageTarget={imageTarget} draftKey={bodyDraftKey} onImagePendingChange={setBodyImagesPending}
        placeholder={documentTarget ? "Write a comment. Use @@ for pages or @@@ for structure." : "Write a comment. Use @ for people, @@ for tasks, or @@@ for structure."} mentionTargets={targets} />
      {(body || replyBody || bodyImagesPending || replyImagesPending) && <p className="body-draft-notice">Draft text is kept in this tab. Unposted image uploads expire after 24 hours.</p>}
      <button type="button" className="primary" disabled={busy || bodyImagesPending || !body.trim()} onClick={() => void post(null)}>{busy ? "Posting..." : "Post comment"}</button>
    </div>}
  </aside>;
}

export default function CommentsPanel(props: Parameters<typeof Discussion>[0]) {
  return <Discussion key={`${props.currentUserId}:${props.detail.workspace.id}:${props.document?.id ?? props.item?.id}`} {...props} />;
}
