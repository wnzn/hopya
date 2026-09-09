CREATE TABLE users (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL COLLATE NOCASE UNIQUE,
  passwordHash TEXT, isAdmin INTEGER NOT NULL DEFAULT 0 CHECK(isAdmin IN (0,1)),
  disabled INTEGER NOT NULL DEFAULT 0 CHECK(disabled IN (0,1)), createdAt TEXT NOT NULL
);
CREATE TABLE sessions (
  id TEXT PRIMARY KEY, userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tokenHash TEXT NOT NULL UNIQUE, expiresAt TEXT NOT NULL, createdAt TEXT NOT NULL
);
CREATE TABLE tokens (
  id TEXT PRIMARY KEY, userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL, tokenHash TEXT NOT NULL UNIQUE, expiresAt TEXT NOT NULL, createdAt TEXT NOT NULL
);
CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, createdAt TEXT NOT NULL);
CREATE TABLE roles (
  id TEXT PRIMARY KEY, workspaceId TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL COLLATE NOCASE, permissions TEXT NOT NULL,
  isOwner INTEGER NOT NULL DEFAULT 0 CHECK(isOwner IN (0,1)), UNIQUE(workspaceId,name), UNIQUE(workspaceId,id)
);
CREATE TABLE memberships (
  workspaceId TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, roleId TEXT NOT NULL,
  PRIMARY KEY(workspaceId,userId), FOREIGN KEY(workspaceId,roleId) REFERENCES roles(workspaceId,id)
);
CREATE TABLE nodes (
  id TEXT PRIMARY KEY, workspaceId TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('project','folder','list')),
  parentId TEXT, createdAt TEXT NOT NULL, UNIQUE(workspaceId,id),
  FOREIGN KEY(workspaceId,parentId) REFERENCES nodes(workspaceId,id)
);
CREATE TABLE fields (
  id TEXT PRIMARY KEY, workspaceId TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL, type TEXT NOT NULL CHECK(type IN ('text','number','date','checkbox','select')),
  options TEXT NOT NULL DEFAULT '[]', UNIQUE(workspaceId,name)
);
CREATE TABLE items (
  id TEXT PRIMARY KEY, workspaceId TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  nodeId TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK(status IN ('backlog','todo','in_progress','review','done')),
  priority TEXT NOT NULL CHECK(priority IN ('none','low','medium','high','urgent')),
  startDate TEXT, dueDate TEXT, tags TEXT NOT NULL DEFAULT '[]', customFields TEXT NOT NULL DEFAULT '{}',
  assigneeId TEXT REFERENCES users(id), createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
  FOREIGN KEY(workspaceId,nodeId) REFERENCES nodes(workspaceId,id)
);
CREATE TABLE audit_logs (
  id TEXT PRIMARY KEY, actorId TEXT REFERENCES users(id), workspaceId TEXT,
  action TEXT NOT NULL, resourceId TEXT, details TEXT NOT NULL DEFAULT '{}', createdAt TEXT NOT NULL
);
CREATE INDEX sessions_expiry ON sessions(expiresAt);
CREATE INDEX tokens_user ON tokens(userId);
CREATE INDEX memberships_user ON memberships(userId);
CREATE INDEX nodes_workspace ON nodes(workspaceId,parentId);
CREATE INDEX items_workspace ON items(workspaceId,nodeId,status);
CREATE INDEX audit_workspace ON audit_logs(workspaceId,createdAt);
