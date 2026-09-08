CREATE TABLE password_reset_tokens (
  id TEXT PRIMARY KEY,
  userId TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  tokenHash TEXT NOT NULL UNIQUE,
  expiresAt TEXT NOT NULL,
  createdAt TEXT NOT NULL
);
CREATE INDEX password_reset_tokens_expiry ON password_reset_tokens(expiresAt);
