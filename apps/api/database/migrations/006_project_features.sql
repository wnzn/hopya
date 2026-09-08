-- Applied with foreign keys disabled by the migration runner and checked before commit.
ALTER TABLE nodes ADD COLUMN description TEXT NOT NULL DEFAULT ''
  CHECK(length(description)<=50000 AND (kind='project' OR description=''));
ALTER TABLE project_field_configs ADD COLUMN dateFormat TEXT
  CHECK(dateFormat IN ('yyyy-MM-dd','MMM d, yyyy','MMMM d, yyyy','dd/MM/yyyy'));
ALTER TABLE project_field_configs ADD COLUMN statuses TEXT NOT NULL DEFAULT '[{"id":"todo","name":"To do","color":"#64748b","completed":false},{"id":"backlog","name":"Backlog","color":"#94a3b8","completed":false},{"id":"in_progress","name":"In progress","color":"#3b82f6","completed":false},{"id":"review","name":"Review","color":"#a855f7","completed":false},{"id":"done","name":"Done","color":"#22c55e","completed":true}]'
  CHECK(json_valid(statuses) AND json_type(statuses)='array' AND json_array_length(statuses) BETWEEN 1 AND 50);

CREATE TABLE fields_rebuild (
  id TEXT PRIMARY KEY, workspaceId TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL, type TEXT NOT NULL CHECK(type IN ('text','number','date','datetime','checkbox','select','checklist','rating','formula')),
  options TEXT NOT NULL DEFAULT '[]', settings TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(settings) AND json_type(settings)='object'),
  UNIQUE(workspaceId,name)
);
INSERT INTO fields_rebuild(id,workspaceId,name,type,options) SELECT id,workspaceId,name,type,options FROM fields;
DROP TABLE fields;
ALTER TABLE fields_rebuild RENAME TO fields;
CREATE UNIQUE INDEX fields_workspace_id ON fields(workspaceId,id);

CREATE TABLE items_rebuild (
  id TEXT PRIMARY KEY, workspaceId TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  nodeId TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK(length(status) BETWEEN 1 AND 64 AND status NOT GLOB '*[^A-Za-z0-9_-]*' AND substr(status,1,1) GLOB '[A-Za-z0-9]'),
  priority TEXT NOT NULL CHECK(priority IN ('none','low','medium','high','urgent')),
  startDate TEXT, dueDate TEXT, tags TEXT NOT NULL DEFAULT '[]', customFields TEXT NOT NULL DEFAULT '{}',
  assigneeId TEXT REFERENCES users(id), createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
  FOREIGN KEY(workspaceId,nodeId) REFERENCES nodes(workspaceId,id)
);
INSERT INTO items_rebuild SELECT * FROM items;
DROP TABLE items;
ALTER TABLE items_rebuild RENAME TO items;
CREATE INDEX items_workspace ON items(workspaceId,nodeId,status);
CREATE INDEX items_workspace_read ON items(workspaceId,createdAt,id);
CREATE UNIQUE INDEX items_workspace_id ON items(workspaceId,id);
