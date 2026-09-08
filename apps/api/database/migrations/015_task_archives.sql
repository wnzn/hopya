ALTER TABLE items ADD COLUMN archivedAt TEXT;
CREATE INDEX items_workspace_archive_read ON items(workspaceId, archivedAt, createdAt, id);
