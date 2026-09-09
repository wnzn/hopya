CREATE TABLE list_tag_color_configs (
  workspaceId TEXT NOT NULL, listId TEXT NOT NULL, colors TEXT NOT NULL DEFAULT '{}',
  updatedAt TEXT NOT NULL,
  PRIMARY KEY(workspaceId,listId),
  FOREIGN KEY(workspaceId,listId) REFERENCES nodes(workspaceId,id) ON DELETE CASCADE,
  CHECK(json_valid(colors) AND json_type(colors)='object')
);
INSERT INTO list_tag_color_configs(workspaceId,listId,colors,updatedAt)
  SELECT workspaceId,id,'{}',createdAt FROM nodes WHERE kind='list';
