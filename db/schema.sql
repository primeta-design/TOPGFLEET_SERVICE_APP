CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,
  email       TEXT NOT NULL UNIQUE,
  username    TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  role        TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin','member','driver')),
  is_owner    BOOLEAN NOT NULL DEFAULT FALSE,
  pass_hash   TEXT NOT NULL,
  totp_secret TEXT,
  totp_on     BOOLEAN NOT NULL DEFAULT FALSE,
  totp_last   BIGINT NOT NULL DEFAULT 0,
  must_change BOOLEAN NOT NULL DEFAULT FALSE,
  disabled    BOOLEAN NOT NULL DEFAULT FALSE,
  failed      INT NOT NULL DEFAULT 0,
  locked_until TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stage       TEXT NOT NULL DEFAULT 'full' CHECK (stage IN ('pw','full')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL,
  ip          TEXT,
  ua          TEXT
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
-- every fleet record (truck, trailer, driver, issue...) lives here as JSON
CREATE TABLE IF NOT EXISTS records (
  coll        TEXT NOT NULL,
  id          TEXT NOT NULL,
  data        JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  TEXT,
  PRIMARY KEY (coll, id)
);
-- settings and other single documents (priorities, statuses, checklists, PTI...)
CREATE TABLE IF NOT EXISTS kv (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  TEXT
);
CREATE TABLE IF NOT EXISTS audit (
  id          BIGSERIAL PRIMARY KEY,
  at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_id     TEXT,
  action      TEXT NOT NULL,
  target      TEXT,
  detail      JSONB,
  ip          TEXT
);
CREATE INDEX IF NOT EXISTS audit_at ON audit(at DESC);
CREATE TABLE IF NOT EXISTS files (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  mime        TEXT NOT NULL,
  size        INT NOT NULL,
  path        TEXT NOT NULL,
  uploaded_by TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- v2: company access per user, own colour, test accounts
ALTER TABLE users ADD COLUMN IF NOT EXISTS companies JSONB;
ALTER TABLE users ADD COLUMN IF NOT EXISTS color TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS prefs JSONB NOT NULL DEFAULT '{}';
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS av_lock BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_test BOOLEAN NOT NULL DEFAULT FALSE;

-- v3: Telegram bot (private chats linked to users; one-time link codes)
CREATE TABLE IF NOT EXISTS tg_chats (
  chat_id   TEXT PRIMARY KEY,
  user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  digest    BOOLEAN NOT NULL DEFAULT TRUE,
  linked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS tg_codes (
  code    TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires TIMESTAMPTZ NOT NULL
);
