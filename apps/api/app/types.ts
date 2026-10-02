export const permissions = ['items:read', 'items:write', 'items:delete', 'documents:read', 'documents:write', 'documents:delete', 'tables:read', 'tables:write', 'tables:delete', 'comments:create', 'comments:manage', 'structure:write', 'members:manage', 'roles:manage', 'workspace:manage', 'automations:manage', 'credentials:manage', 'agent:use'] as const
export type Permission = typeof permissions[number]
export interface User { id: string; name: string; email: string; isAdmin: boolean; photoUrl?: string | null }
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
  authorPhotoUrl?: string | null
  id: string; workspaceId: string; itemId: string; authorId: string | null; authorName: string
  body: string; parentId: string | null; anchor: CommentAnchor | null; reactions: CommentReaction[]; createdAt: string; deletedAt: string | null
}
export interface ResourceAppearance { icon: import('./appearance.js').NodeIcon | null; color: string | null }
export interface DocumentRecord extends ResourceAppearance {
  id: string; workspaceId: string; parentId: string | null; title: string; body: string
  bodyRevision: number; createdAt: string; updatedAt: string; createdByName: string | null; updatedByName: string | null
}
export type TableColumnType = 'text' | 'number' | 'date' | 'datetime' | 'checkbox' | 'select'
export type TableValue = string | number | boolean | null
export interface TableMetadata extends ResourceAppearance {
  id: string; workspaceId: string; parentId: string | null; name: string; createdAt: string; updatedAt: string
}
export interface TableColumn {
  readOnly?: boolean; sourceType?: string; primaryKey?: boolean
  id: string; workspaceId: string; tableId: string; name: string; type: TableColumnType; options: string[]
  position: number; createdAt: string; updatedAt: string
}
export interface TableRecord {
  id: string; workspaceId: string; tableId: string; values: Record<string, TableValue>; createdAt: string; updatedAt: string
}
export interface CommentReaction { emoji: string; count: number; reactedByMe: boolean }
export interface Notification {
  id: string; workspaceId: string; type: 'assignment' | 'mention'; itemId: string; itemTitle: string
  commentId: string | null; actorId: string | null; actorName: string; createdAt: string; readAt: string | null
}
export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message) }
}
