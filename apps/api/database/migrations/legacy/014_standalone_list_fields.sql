-- Field configurations are owned by either a root project or a standalone root list.
INSERT INTO project_field_configs(workspaceId,projectId,updatedAt)
  SELECT workspaceId,id,createdAt FROM nodes
  WHERE kind='list' AND parentId IS NULL
  ON CONFLICT(workspaceId,projectId) DO NOTHING;
