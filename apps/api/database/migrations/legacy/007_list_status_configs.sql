CREATE TABLE list_status_configs (
  workspaceId TEXT NOT NULL, listId TEXT NOT NULL, statuses TEXT,
  updatedAt TEXT NOT NULL,
  PRIMARY KEY(workspaceId,listId),
  FOREIGN KEY(workspaceId,listId) REFERENCES nodes(workspaceId,id) ON DELETE CASCADE,
  CHECK(statuses IS NULL OR (json_valid(statuses) AND json_type(statuses)='array' AND json_array_length(statuses) BETWEEN 1 AND 50))
);
INSERT INTO list_status_configs(workspaceId,listId,statuses,updatedAt)
  SELECT workspaceId,id,NULL,createdAt FROM nodes WHERE kind='list';
