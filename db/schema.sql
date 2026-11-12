-- Schema for the LTI tutor. Runs automatically at startup; every statement
-- is idempotent (IF NOT EXISTS), so it is safe to run on every deploy.

-- One row per person, identified the way LTI 1.3 identifies them: the
-- platform's issuer plus the user's stable LTI "sub" ID. The same student
-- launching from two courses is one user.
CREATE TABLE IF NOT EXISTS users (
  id              BIGSERIAL PRIMARY KEY,
  issuer          TEXT NOT NULL,
  lti_sub         TEXT NOT NULL,
  canvas_user_id  TEXT,
  name            TEXT,
  given_name      TEXT,
  family_name     TEXT,
  email           TEXT,
  -- Free-form place for anything the app learns about the learner later
  -- (preferences, reading level, etc.).
  profile         JSONB NOT NULL DEFAULT '{}'::jsonb,
  first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (issuer, lti_sub)
);

-- A Canvas course (LTI "context"). deployment_id identifies which
-- district/institution install the launch came from.
CREATE TABLE IF NOT EXISTS courses (
  id                BIGSERIAL PRIMARY KEY,
  issuer            TEXT NOT NULL,
  deployment_id     TEXT NOT NULL,
  context_id        TEXT NOT NULL,
  canvas_course_id  TEXT,
  title             TEXT,
  label             TEXT,
  platform_name     TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (issuer, deployment_id, context_id)
);

-- Which users have launched from which courses, and in what role.
CREATE TABLE IF NOT EXISTS enrollments (
  user_id         BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  course_id       BIGINT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  roles           TEXT[] NOT NULL DEFAULT '{}',
  is_instructor   BOOLEAN NOT NULL DEFAULT false,
  launch_count    INTEGER NOT NULL DEFAULT 0,
  last_launch_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, course_id)
);

-- Short-lived OIDC login state. Kept server-side (not in a cookie) because
-- browsers block third-party cookies inside the Canvas iframe. One-time use.
CREATE TABLE IF NOT EXISTS lti_states (
  state       TEXT PRIMARY KEY,
  nonce       TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Nonces already used in a launch, so an id_token can't be replayed.
CREATE TABLE IF NOT EXISTS lti_used_nonces (
  nonce       TEXT PRIMARY KEY,
  used_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- App sessions created by a successful launch. Only a SHA-256 hash of the
-- bearer token is stored.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  course_id   BIGINT REFERENCES courses(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions (expires_at);

CREATE TABLE IF NOT EXISTS conversations (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  course_id   BIGINT REFERENCES courses(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS conversations_user_idx ON conversations (user_id, course_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id               BIGSERIAL PRIMARY KEY,
  conversation_id  BIGINT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role             TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content          TEXT NOT NULL,
  model            TEXT,
  input_tokens     INTEGER,
  output_tokens    INTEGER,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS messages_conversation_idx ON messages (conversation_id, id);

-- Safety flags. Replaces flagged-messages.log, which didn't survive Render
-- redeploys. Linked to the student and course so staff can follow up.
CREATE TABLE IF NOT EXISTS flagged_messages (
  id          BIGSERIAL PRIMARY KEY,
  message_id  BIGINT REFERENCES messages(id) ON DELETE SET NULL,
  user_id     BIGINT REFERENCES users(id) ON DELETE SET NULL,
  course_id   BIGINT REFERENCES courses(id) ON DELETE SET NULL,
  category    TEXT NOT NULL,
  reason      TEXT,
  content     TEXT NOT NULL,
  reviewed    BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS flagged_messages_created_idx ON flagged_messages (created_at DESC);

-- Module outline read from the Canvas REST API (canvas.js), cached per course
-- so a whole class launching at once triggers one Canvas fetch, not thirty.
ALTER TABLE courses ADD COLUMN IF NOT EXISTS canvas_api_base TEXT;
ALTER TABLE courses ADD COLUMN IF NOT EXISTS outline TEXT;
ALTER TABLE courses ADD COLUMN IF NOT EXISTS outline_fetched_at TIMESTAMPTZ;
