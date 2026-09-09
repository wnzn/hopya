CREATE TABLE site_settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updatedAt TEXT NOT NULL
);
CREATE TABLE webhooks (
  id TEXT PRIMARY KEY,
  workspaceId TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  events TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  secret TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  UNIQUE(workspaceId, id)
);
CREATE INDEX webhooks_workspace ON webhooks(workspaceId);
CREATE TABLE automations (
  id TEXT PRIMARY KEY,
  workspaceId TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  event TEXT NOT NULL,
  config TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  UNIQUE(workspaceId, id)
);
CREATE INDEX automations_workspace ON automations(workspaceId);
CREATE TABLE automation_runs (
  id TEXT PRIMARY KEY,
  workspaceId TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  automationId TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','delivered','failed')),
  detail TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  FOREIGN KEY(workspaceId, automationId) REFERENCES automations(workspaceId, id) ON DELETE CASCADE
);
CREATE INDEX automation_runs_workspace ON automation_runs(workspaceId, createdAt);
CREATE INDEX automation_runs_pending ON automation_runs(status, createdAt);