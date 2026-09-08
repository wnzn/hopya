CREATE TABLE comments (
  id TEXT PRIMARY KEY,
  workspaceId TEXT NOT NULL,
  itemId TEXT NOT NULL,
  authorId TEXT REFERENCES users(id) ON DELETE SET NULL,
  body TEXT NOT NULL CHECK(length(body) BETWEEN 1 AND 10000),
  createdAt TEXT NOT NULL,
  deletedAt TEXT,
  UNIQUE(workspaceId,itemId,id),
  FOREIGN KEY(workspaceId,itemId) REFERENCES items(workspaceId,id) ON DELETE CASCADE
);

CREATE TABLE item_mentions (
  workspaceId TEXT NOT NULL,
  itemId TEXT NOT NULL,
  userId TEXT NOT NULL,
  PRIMARY KEY(workspaceId,itemId,userId),
  FOREIGN KEY(workspaceId,itemId) REFERENCES items(workspaceId,id) ON DELETE CASCADE,
  FOREIGN KEY(workspaceId,userId) REFERENCES memberships(workspaceId,userId) ON DELETE CASCADE
);

CREATE TABLE comment_mentions (
  workspaceId TEXT NOT NULL,
  itemId TEXT NOT NULL,
  commentId TEXT NOT NULL,
  userId TEXT NOT NULL,
  PRIMARY KEY(workspaceId,commentId,userId),
  FOREIGN KEY(workspaceId,itemId,commentId) REFERENCES comments(workspaceId,itemId,id) ON DELETE CASCADE,
  FOREIGN KEY(workspaceId,userId) REFERENCES memberships(workspaceId,userId) ON DELETE CASCADE
);

CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  workspaceId TEXT NOT NULL,
  userId TEXT NOT NULL,
  actorId TEXT REFERENCES users(id) ON DELETE SET NULL,
  type TEXT NOT NULL CHECK(type IN ('assignment','mention')),
  itemId TEXT NOT NULL,
  commentId TEXT,
  createdAt TEXT NOT NULL,
  readAt TEXT,
  FOREIGN KEY(workspaceId,userId) REFERENCES memberships(workspaceId,userId) ON DELETE CASCADE,
  FOREIGN KEY(workspaceId,itemId) REFERENCES items(workspaceId,id) ON DELETE CASCADE,
  FOREIGN KEY(workspaceId,itemId,commentId) REFERENCES comments(workspaceId,itemId,id) ON DELETE CASCADE
);

CREATE INDEX comments_item ON comments(workspaceId,itemId,createdAt,id);
CREATE INDEX notifications_user ON notifications(workspaceId,userId,createdAt DESC,id DESC);
CREATE INDEX notifications_unread ON notifications(workspaceId,userId,createdAt DESC,id DESC) WHERE readAt IS NULL;

UPDATE roles
SET permissions=json_insert(permissions,'$[#]','comments:manage')
WHERE isOwner=1
  AND NOT EXISTS (SELECT 1 FROM json_each(roles.permissions) WHERE value='comments:manage');
