/**
 * Shared integration boundary. All service operations enforce workspace permissions.
 * db: synchronous better-sqlite3 Database. SQL migrations live in database/migrations/
 * and are applied in filename order, once, using schema_migrations(name, appliedAt).
 * Reserve 001_core.sql for core; integrations own 002_*.sql. Copy SQL on build.
 * Tables/columns use camelCase; users: id,name,email,passwordHash,isAdmin,disabled,
 * createdAt. External identities may use a NULL passwordHash (cannot password-login).
 *
 * authenticate(ctx: HttpContext): User (throws HttpError on failure)
 * requirePermission(userId: string, workspaceId: string, permission: Permission): Membership
 * audit(actorId: string | null, workspaceId: string | null, action: string,
 *       resourceId: string | null, details?: Record<string, unknown>): void
 *   Call audit inside the same db.transaction as an integration mutation; never pass secrets.
 * createSession(ctx: HttpContext, userId: string): void (sets HttpOnly session cookie)
 * publicUser(user: User | UserRow): User
 * service.getWorkspace(userId, wid), service.listItems(userId, wid, filters?),
 * service.getItem(userId, wid, id), service.createItem(userId, wid, input),
 * service.updateItem(userId, wid, id, input), service.deleteItem(userId, wid, id).
 * Inputs are unknown and validated internally; returned items follow the REST contract.
 */
export { db, audit } from './database.js'
export { authenticate, createSession, publicUser } from './security.js'
export { requirePermission, service } from './service.js'
export { HttpError, permissions } from './types.js'
export type { User, UserRow, Permission, Membership, Item } from './types.js'
