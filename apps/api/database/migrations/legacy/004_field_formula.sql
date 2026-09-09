-- SQLite cannot alter a CHECK constraint. Rebuild the fields table so the
-- type check also admits 'formula' values while preserving every row.
CREATE TABLE fields_rebuild (
  id TEXT PRIMARY KEY, workspaceId TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL, type TEXT NOT NULL CHECK(type IN ('text','number','date','checkbox','select','formula')),
  options TEXT NOT NULL DEFAULT '[]', UNIQUE(workspaceId,name)
);
INSERT INTO fields_rebuild (id,workspaceId,name,type,options) SELECT id,workspaceId,name,type,options FROM fields;
DROP TABLE fields;
ALTER TABLE fields_rebuild RENAME TO fields;