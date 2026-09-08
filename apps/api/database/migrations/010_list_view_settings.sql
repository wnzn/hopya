CREATE TABLE list_view_settings (
  id TEXT PRIMARY KEY,
  workspaceId TEXT NOT NULL,
  userId TEXT NOT NULL,
  view TEXT NOT NULL CHECK(view='list'),
  projectId TEXT,
  columnOrder TEXT NOT NULL CHECK(json_valid(columnOrder) AND json_type(columnOrder)='array' AND json_array_length(columnOrder)<=111),
  hiddenColumns TEXT NOT NULL CHECK(json_valid(hiddenColumns) AND json_type(hiddenColumns)='array' AND json_array_length(hiddenColumns)<=110),
  sort TEXT CHECK(sort IS NULL OR (json_valid(sort) AND json_type(sort)='object')),
  updatedAt TEXT NOT NULL,
  FOREIGN KEY(workspaceId,userId) REFERENCES memberships(workspaceId,userId) ON DELETE CASCADE,
  FOREIGN KEY(workspaceId,projectId) REFERENCES nodes(workspaceId,id) ON DELETE CASCADE
);
-- SQLite considers NULL values distinct in ordinary UNIQUE constraints. Split
-- indexes guarantee one all-project row and one row per concrete project.
CREATE UNIQUE INDEX list_view_settings_all_scope
  ON list_view_settings(workspaceId,userId,view) WHERE projectId IS NULL;
CREATE UNIQUE INDEX list_view_settings_project_scope
  ON list_view_settings(workspaceId,userId,view,projectId) WHERE projectId IS NOT NULL;
