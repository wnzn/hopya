export const permissions = ['items:read', 'items:write', 'items:delete', 'documents:read', 'documents:write', 'documents:delete', 'comments:create', 'comments:manage', 'structure:write', 'members:manage', 'roles:manage', 'workspace:manage', 'automations:manage', 'credentials:manage', 'agent:use'] as const
export type Permission = typeof permissions[number]
export interface User { id: string; name: string; email: string; isAdmin: boolean }
export interface UserRow { id: string; name: string; email: string; isAdmin: number; disabled: number; passwordHash: string | null; createdAt: string }
export interface Membership { userId: string; workspaceId: string; roleId: string; roleName: string; isOwner: boolean; permissions: Permission[] }
export interface Item {
  id: string; workspaceId: string; nodeId: string; title: string; description: string
  status: string
  priority: 'none' | 'low' | 'medium' | 'high' | 'urgent'
  startDate: string | null; dueDate: string | null; tags: string[]
  customFields: Record<string, string | number | boolean | string[] | null>; assigneeId: string | null
  bodyRevision: number; archivedAt: string | null; createdAt: string; updatedAt: string
}
export interface CommentAnchor {
  revision: number; start: number; end: number; exact: string; prefix: string; suffix: string
  state: 'attached' | 'orphaned'
}
export interface Comment {
  id: string; workspaceId: string; itemId: string; authorId: string | null; authorName: string
  body: string; parentId: string | null; anchor: CommentAnchor | null; reactions: CommentReaction[]; createdAt: string; deletedAt: string | null
}
export interface DocumentRecord {
  id: string; workspaceId: string; parentId: string | null; title: string; body: string
  bodyRevision: number; createdAt: string; updatedAt: string
}
export interface CommentReaction { emoji: string; count: number; reactedByMe: boolean }
export interface Notification {
  id: string; workspaceId: string; type: 'assignment' | 'mention'; itemId: string; itemTitle: string
  commentId: string | null; actorId: string | null; actorName: string; createdAt: string; readAt: string | null
}
export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message) }
}
