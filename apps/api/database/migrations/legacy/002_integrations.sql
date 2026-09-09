CREATE UNIQUE INDEX items_workspace_id ON items(workspaceId,id);

-- Objects outlive item cascades, failed uploads, and failed remote deletes. The
-- storage collector removes unreferenced objects after a 24-hour upload grace.
CREATE TABLE storage_objects (
  objectKey TEXT PRIMARY KEY,
  driver TEXT NOT NULL CHECK(driver IN ('filesystem','s3')),
  location TEXT NOT NULL,
  createdAt TEXT NOT NULL
);
CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  workspaceId TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  itemId TEXT NOT NULL,
  objectKey TEXT NOT NULL UNIQUE REFERENCES storage_objects(objectKey),
  name TEXT NOT NULL,
  contentType TEXT NOT NULL,
  size INTEGER NOT NULL CHECK(size BETWEEN 0 AND 10485760),
  createdBy TEXT REFERENCES users(id) ON DELETE SET NULL,
  createdAt TEXT NOT NULL,
  FOREIGN KEY(workspaceId,itemId) REFERENCES items(workspaceId,id) ON DELETE CASCADE
);
CREATE INDEX attachments_item ON attachments(workspaceId,itemId,createdAt);
CREATE INDEX storage_objects_gc ON storage_objects(driver,location,createdAt);

CREATE TABLE oidc_identities (
  id TEXT PRIMARY KEY,
  userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  UNIQUE(issuer,subject)
);
CREATE INDEX oidc_identities_user ON oidc_identities(userId);
CREATE TABLE oidc_flows (
  cookieHash TEXT PRIMARY KEY,
  stateHash TEXT NOT NULL UNIQUE,
  nonce TEXT NOT NULL,
  codeVerifier TEXT NOT NULL,
  issuer TEXT NOT NULL,
  clientId TEXT NOT NULL,
  redirectUri TEXT NOT NULL,
  expiresAt TEXT NOT NULL
);
CREATE INDEX oidc_flows_expiry ON oidc_flows(expiresAt);
