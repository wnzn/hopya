CREATE UNIQUE INDEX fields_workspace_id ON fields(workspaceId,id);
CREATE TABLE project_field_configs (
  workspaceId TEXT NOT NULL, projectId TEXT NOT NULL,
  builtInFields TEXT NOT NULL DEFAULT '[]', updatedAt TEXT NOT NULL,
  PRIMARY KEY(workspaceId,projectId),
  FOREIGN KEY(workspaceId,projectId) REFERENCES nodes(workspaceId,id) ON DELETE CASCADE
);
CREATE TABLE project_field_assignments (
  workspaceId TEXT NOT NULL, projectId TEXT NOT NULL, fieldId TEXT NOT NULL, position INTEGER NOT NULL,
  PRIMARY KEY(workspaceId,projectId,fieldId),
  FOREIGN KEY(workspaceId,projectId) REFERENCES project_field_configs(workspaceId,projectId) ON DELETE CASCADE,
  FOREIGN KEY(workspaceId,fieldId) REFERENCES fields(workspaceId,id) ON DELETE CASCADE
);
CREATE INDEX project_field_assignments_field ON project_field_assignments(workspaceId,fieldId,projectId);
INSERT INTO project_field_configs(workspaceId,projectId,builtInFields,updatedAt)
  SELECT workspaceId,id,'["priority","startDate","tags","nodeId","createdAt","updatedAt"]',createdAt
  FROM nodes WHERE kind='project' AND parentId IS NULL;
INSERT INTO project_field_assignments(workspaceId,projectId,fieldId,position)
  SELECT c.workspaceId,c.projectId,f.id,row_number() OVER (PARTITION BY c.workspaceId,c.projectId ORDER BY f.name,f.id)-1
  FROM project_field_configs c JOIN fields f ON f.workspaceId=c.workspaceId;
