ALTER TABLE comments ADD COLUMN parentId TEXT REFERENCES comments(id);

CREATE TRIGGER comments_parent_scope_insert
BEFORE INSERT ON comments
WHEN NEW.parentId IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM comments p
    WHERE p.id=NEW.parentId AND p.workspaceId=NEW.workspaceId AND p.itemId=NEW.itemId
  ) THEN RAISE(ABORT, 'Comment parent must belong to the same task') END;
END;

CREATE TABLE comment_reactions (
  workspaceId TEXT NOT NULL,
  itemId TEXT NOT NULL,
  commentId TEXT NOT NULL,
  userId TEXT NOT NULL,
  emoji TEXT NOT NULL CHECK(emoji IN ('👍','❤️','😂','🎉','😕','👀')),
  createdAt TEXT NOT NULL,
  PRIMARY KEY(workspaceId,commentId,userId,emoji),
  FOREIGN KEY(workspaceId,itemId,commentId) REFERENCES comments(workspaceId,itemId,id) ON DELETE CASCADE,
  FOREIGN KEY(workspaceId,userId) REFERENCES memberships(workspaceId,userId) ON DELETE CASCADE
);

CREATE INDEX comment_reactions_comment ON comment_reactions(workspaceId,itemId,commentId,emoji);
