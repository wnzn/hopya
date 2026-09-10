export const permissions = ['items:read', 'items:write', 'items:delete', 'comments:manage', 'structure:write', 'members:manage', 'roles:manage', 'workspace:manage', 'automations:manage', 'credentials:manage', 'agent:use'] as const
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
  archivedAt: string | null; createdAt: string; updatedAt: string
}
export interface Comment {
  id: string; workspaceId: string; itemId: string; authorId: string | null; authorName: string
  body: string; parentId: string | null; reactions: CommentReaction[]; createdAt: string; deletedAt: string | null
}
export interface CommentReaction { emoji: string; count: number; reactedByMe: boolean }
export interface Notification {
  id: string; workspaceId: string; type: 'assignment' | 'mention'; itemId: string; itemTitle: string
  commentId: string | null; actorId: string | null; actorName: string; createdAt: string; readAt: string | null
}
export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message) }
}
