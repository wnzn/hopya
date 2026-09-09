/**
 * Shared integration boundary. All service operations enforce workspace permissions.
 * db: asynchronous Lucid-backed DatabaseApi. SQL migrations live in database/migrations/
 * and are applied by Lucid in migration order.
 * Tables/columns use camelCase; users: id,name,email,passwordHash,isAdmin,disabled,
 * createdAt. External identities may use a NULL passwordHash (cannot password-login).
 *
 * authenticate(ctx: HttpContext): Promise<User> (rejects with HttpError on failure)
 * requirePermission(userId: string, workspaceId: string, permission: Permission): Promise<Membership>
 * audit(actorId: string | null, workspaceId: string | null, action: string,
 *       resourceId: string | null, details?: Record<string, unknown>): Promise<void>
 *   Await audit inside the same db.transaction as an integration mutation; never pass secrets.
 * createSession(ctx: HttpContext, userId: string): Promise<void> (sets HttpOnly session cookie)
 * publicUser(user: User | UserRow): User
 * service.getWorkspace(userId, wid), service.listItems(userId, wid, filters?),
 * service.getItem(userId, wid, id), service.createItem(userId, wid, input),
 * service.updateItem(userId, wid, id, input), service.deleteItem(userId, wid, id).
 * Service inputs are unknown and validated internally; all service operations return Promises,
 * and returned items follow the REST contract.
 */
export { db, audit } from './database.js'
export { authenticate, createSession, publicUser } from './security.js'
export { requirePermission, service } from './service.js'
export { HttpError, permissions } from './types.js'
export type { User, UserRow, Permission, Membership, Item } from './types.js'
