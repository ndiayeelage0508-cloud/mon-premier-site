-- Additive: leaves free_usage and its existing AI quotas unchanged.
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS account_users (
 id TEXT PRIMARY KEY,
 provider TEXT NOT NULL CHECK (provider IN ('password','google')),
 subject TEXT NOT NULL,
 email TEXT NOT NULL,
 password_hash TEXT,
 password_salt TEXT,
 recovery_hash TEXT,
 created_at INTEGER NOT NULL,
 UNIQUE(provider,subject)
);
CREATE TABLE IF NOT EXISTS account_sessions (
 token_hash TEXT PRIMARY KEY,
 user_id TEXT NOT NULL REFERENCES account_users(id) ON DELETE CASCADE,
 expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS account_sessions_user ON account_sessions(user_id,expires_at);
CREATE INDEX IF NOT EXISTS account_sessions_expiry ON account_sessions(expires_at);
CREATE TABLE IF NOT EXISTS account_libraries (
 user_id TEXT PRIMARY KEY REFERENCES account_users(id) ON DELETE CASCADE,
 data TEXT NOT NULL,
 revision INTEGER NOT NULL DEFAULT 0,
 updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS auth_limits (
 key TEXT NOT NULL,
 bucket INTEGER NOT NULL,
 count INTEGER NOT NULL,
 expires_at INTEGER NOT NULL,
 PRIMARY KEY (key,bucket)
);
CREATE INDEX IF NOT EXISTS auth_limits_expiry ON auth_limits(expires_at);
