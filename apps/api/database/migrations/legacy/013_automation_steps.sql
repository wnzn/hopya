ALTER TABLE automations ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1);

CREATE TABLE automation_steps (
  id TEXT PRIMARY KEY,
  workspaceId TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  automationId TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version >= 1),
  position INTEGER NOT NULL CHECK(position >= 1),
  type TEXT NOT NULL CHECK(type IN ('webhook','email','http','log')),
  config TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  UNIQUE(automationId, version, position),
  UNIQUE(workspaceId, id),
  FOREIGN KEY(workspaceId, automationId) REFERENCES automations(workspaceId, id) ON DELETE CASCADE
);
CREATE INDEX automation_steps_version ON automation_steps(workspaceId,automationId,version,position);

INSERT INTO automation_steps (id,workspaceId,automationId,version,position,type,config,createdAt)
SELECT lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) ||
  '-' || substr('89ab',abs(random()) % 4 + 1,1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6))),
  workspaceId,id,1,1,json_extract(config,'$.type'),json_extract(config,'$.config'),createdAt
FROM automations;

ALTER TABLE automation_runs RENAME TO automation_runs_legacy;
CREATE TABLE automation_runs (
  id TEXT PRIMARY KEY,
  workspaceId TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  automationId TEXT,
  targetType TEXT NOT NULL CHECK(targetType IN ('automation','webhook')),
  targetId TEXT NOT NULL,
  automationVersion INTEGER,
  status TEXT NOT NULL CHECK(status IN ('pending','running','delivered','failed')),
  event TEXT,
  detail TEXT NOT NULL DEFAULT '',
  createdAt TEXT NOT NULL,
  startedAt TEXT,
  completedAt TEXT,
  UNIQUE(workspaceId, id)
);
INSERT INTO automation_runs (id,workspaceId,automationId,targetType,targetId,automationVersion,status,detail,createdAt,completedAt)
SELECT id,workspaceId,
  CASE WHEN EXISTS(SELECT 1 FROM automations a WHERE a.workspaceId=automation_runs_legacy.workspaceId AND a.id=automation_runs_legacy.automationId) THEN automationId ELSE NULL END,
  CASE WHEN EXISTS(SELECT 1 FROM automations a WHERE a.workspaceId=automation_runs_legacy.workspaceId AND a.id=automation_runs_legacy.automationId) THEN 'automation' ELSE 'webhook' END,
  automationId,
  CASE WHEN EXISTS(SELECT 1 FROM automations a WHERE a.workspaceId=automation_runs_legacy.workspaceId AND a.id=automation_runs_legacy.automationId) THEN 1 ELSE NULL END,
  CASE WHEN status='pending' THEN 'failed' ELSE status END,
  CASE WHEN status='pending' THEN 'Interrupted legacy run' ELSE substr(detail,1,2000) END,
  createdAt,createdAt
FROM automation_runs_legacy;
DROP TABLE automation_runs_legacy;
CREATE INDEX automation_runs_workspace ON automation_runs(workspaceId,createdAt,id);
CREATE INDEX automation_runs_pending ON automation_runs(status,createdAt,id);
CREATE INDEX automation_runs_automation ON automation_runs(workspaceId,automationId,createdAt,id);

CREATE TABLE automation_step_runs (
  id TEXT PRIMARY KEY,
  workspaceId TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  runId TEXT NOT NULL,
  stepId TEXT NOT NULL,
  position INTEGER NOT NULL CHECK(position >= 1),
  type TEXT NOT NULL CHECK(type IN ('webhook','email','http','log')),
  status TEXT NOT NULL CHECK(status IN ('pending','running','delivered','failed','skipped')),
  output TEXT NOT NULL DEFAULT '',
  log TEXT NOT NULL DEFAULT '',
  startedAt TEXT,
  completedAt TEXT,
  UNIQUE(runId,position),
  FOREIGN KEY(workspaceId,runId) REFERENCES automation_runs(workspaceId,id) ON DELETE CASCADE,
  FOREIGN KEY(workspaceId,stepId) REFERENCES automation_steps(workspaceId,id) ON DELETE CASCADE
);
CREATE INDEX automation_step_runs_run ON automation_step_runs(workspaceId,runId,position);
