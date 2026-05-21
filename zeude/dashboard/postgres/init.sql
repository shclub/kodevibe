-- Zeude PostgreSQL Schema (standalone - no Supabase/PostgREST required)
-- Generated from all migrations. RLS removed; auth handled at application layer.

CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- gen_random_uuid()

-- ============================================================
-- zeude_users
-- ============================================================
CREATE TABLE IF NOT EXISTS zeude_users (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email        TEXT UNIQUE NOT NULL,
  name         TEXT,
  agent_key    TEXT UNIQUE NOT NULL,
  team         TEXT NOT NULL DEFAULT 'default',
  role         TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  status       TEXT NOT NULL DEFAULT 'active'  CHECK (status IN ('active', 'inactive', 'deleted')),
  disabled_skills TEXT[] NOT NULL DEFAULT '{}',
  invited_by   UUID REFERENCES zeude_users(id),
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_zeude_users_agent_key ON zeude_users(agent_key);
CREATE INDEX IF NOT EXISTS idx_zeude_users_email     ON zeude_users(email);
CREATE INDEX IF NOT EXISTS idx_zeude_users_team      ON zeude_users(team);
CREATE INDEX IF NOT EXISTS idx_zeude_users_status    ON zeude_users(status);

-- ============================================================
-- zeude_one_time_tokens
-- ============================================================
CREATE TABLE IF NOT EXISTS zeude_one_time_tokens (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token      TEXT UNIQUE NOT NULL,
  user_id    UUID NOT NULL REFERENCES zeude_users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_zeude_ott_token   ON zeude_one_time_tokens(token);
CREATE INDEX IF NOT EXISTS idx_zeude_ott_expires ON zeude_one_time_tokens(expires_at);

-- ============================================================
-- zeude_sessions
-- ============================================================
CREATE TABLE IF NOT EXISTS zeude_sessions (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token      TEXT UNIQUE NOT NULL,
  user_id    UUID NOT NULL REFERENCES zeude_users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_zeude_sessions_token   ON zeude_sessions(token);
CREATE INDEX IF NOT EXISTS idx_zeude_sessions_user_id ON zeude_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_zeude_sessions_expires ON zeude_sessions(expires_at);

-- ============================================================
-- zeude_invites
-- ============================================================
CREATE TABLE IF NOT EXISTS zeude_invites (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token      TEXT UNIQUE NOT NULL,
  team       TEXT NOT NULL,
  role       TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  created_by UUID REFERENCES zeude_users(id) ON DELETE SET NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at    TIMESTAMPTZ,
  used_by    UUID REFERENCES zeude_users(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_zeude_invites_token   ON zeude_invites(token);
CREATE INDEX IF NOT EXISTS idx_zeude_invites_expires ON zeude_invites(expires_at);

-- ============================================================
-- zeude_mcp_servers
-- ============================================================
CREATE TABLE IF NOT EXISTS zeude_mcp_servers (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL,
  url        TEXT,
  command    TEXT NOT NULL DEFAULT '',
  args       JSONB NOT NULL DEFAULT '[]',
  env        JSONB DEFAULT '{}',
  teams      TEXT[] NOT NULL DEFAULT '{}',
  is_global  BOOLEAN NOT NULL DEFAULT false,
  status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_by UUID REFERENCES zeude_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_zeude_mcp_teams  ON zeude_mcp_servers USING GIN(teams);
CREATE INDEX IF NOT EXISTS idx_zeude_mcp_status ON zeude_mcp_servers(status);

-- ============================================================
-- zeude_mcp_install_status
-- ============================================================
CREATE TABLE IF NOT EXISTS zeude_mcp_install_status (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES zeude_users(id) ON DELETE CASCADE,
  mcp_server_id UUID NOT NULL REFERENCES zeude_mcp_servers(id) ON DELETE CASCADE,
  installed     BOOLEAN NOT NULL DEFAULT false,
  version       TEXT,
  last_checked_at TIMESTAMPTZ,
  updated_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, mcp_server_id)
);

-- ============================================================
-- zeude_skills
-- ============================================================
CREATE TABLE IF NOT EXISTS zeude_skills (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name              TEXT NOT NULL,
  slug              TEXT NOT NULL UNIQUE,
  description       TEXT,
  content           TEXT,
  files             JSONB,
  teams             TEXT[] NOT NULL DEFAULT '{}',
  is_global         BOOLEAN NOT NULL DEFAULT false,
  status            TEXT NOT NULL DEFAULT 'active',
  created_by        UUID REFERENCES zeude_users(id),
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW(),
  keywords          TEXT[] DEFAULT '{}',
  hint              TEXT DEFAULT '',
  is_general        BOOLEAN DEFAULT false,
  is_command        BOOLEAN DEFAULT false,
  primary_keywords  TEXT[] DEFAULT '{}',
  secondary_keywords TEXT[] DEFAULT '{}',
  contributors      UUID[] NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_zeude_skills_teams             ON zeude_skills USING GIN(teams);
CREATE INDEX IF NOT EXISTS idx_zeude_skills_status            ON zeude_skills(status);
CREATE INDEX IF NOT EXISTS idx_zeude_skills_slug              ON zeude_skills(slug);
CREATE INDEX IF NOT EXISTS idx_zeude_skills_primary_keywords  ON zeude_skills USING GIN(primary_keywords);
CREATE INDEX IF NOT EXISTS idx_zeude_skills_secondary_keywords ON zeude_skills USING GIN(secondary_keywords);

-- ============================================================
-- zeude_hooks
-- ============================================================
CREATE TABLE IF NOT EXISTS zeude_hooks (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name           TEXT NOT NULL,
  event          TEXT NOT NULL,
  description    TEXT,
  script_content TEXT NOT NULL,
  script_type    TEXT NOT NULL DEFAULT 'bash',
  is_global      BOOLEAN NOT NULL DEFAULT false,
  teams          TEXT[] DEFAULT '{}',
  env            JSONB DEFAULT '{}',
  status         TEXT NOT NULL DEFAULT 'active',
  created_by     UUID REFERENCES zeude_users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_at     TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_zeude_hooks_status ON zeude_hooks(status);
CREATE INDEX IF NOT EXISTS idx_zeude_hooks_event  ON zeude_hooks(event);

-- ============================================================
-- zeude_hook_install_status
-- ============================================================
CREATE TABLE IF NOT EXISTS zeude_hook_install_status (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES zeude_users(id) ON DELETE CASCADE,
  hook_id         UUID NOT NULL REFERENCES zeude_hooks(id) ON DELETE CASCADE,
  installed       BOOLEAN NOT NULL DEFAULT false,
  version         TEXT,
  last_checked_at TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, hook_id)
);

-- ============================================================
-- zeude_agents
-- ============================================================
CREATE TABLE IF NOT EXISTS zeude_agents (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL UNIQUE CHECK (name ~ '^[a-z]+(-[a-z]+)*$' AND length(name) <= 64),
  description TEXT,
  files       JSONB NOT NULL,
  teams       TEXT[] DEFAULT '{}',
  is_global   BOOLEAN DEFAULT false,
  status      TEXT DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_by  UUID REFERENCES zeude_users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_zeude_agents_teams  ON zeude_agents USING GIN(teams);
CREATE INDEX IF NOT EXISTS idx_zeude_agents_status ON zeude_agents(status);

-- ============================================================
-- zeude_cohort_members
-- ============================================================
CREATE TABLE IF NOT EXISTS zeude_cohort_members (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cohort_key TEXT NOT NULL,
  user_id    UUID NOT NULL REFERENCES zeude_users(id) ON DELETE CASCADE,
  created_by UUID REFERENCES zeude_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(cohort_key, user_id)
);
CREATE INDEX IF NOT EXISTS idx_zeude_cohort_key     ON zeude_cohort_members(cohort_key);
CREATE INDEX IF NOT EXISTS idx_zeude_cohort_user_id ON zeude_cohort_members(user_id);

-- ============================================================
-- Functions
-- ============================================================
CREATE OR REPLACE FUNCTION cleanup_expired_tokens()
RETURNS void AS $$
BEGIN
  DELETE FROM zeude_one_time_tokens WHERE expires_at < NOW();
  DELETE FROM zeude_sessions WHERE expires_at < NOW();
  DELETE FROM zeude_invites WHERE expires_at < NOW() AND used_at IS NULL;
END;
$$ LANGUAGE plpgsql;

-- Atomically add/remove a slug from a user's disabled_skills array.
-- Auth checks removed: enforced at the application layer.
CREATE OR REPLACE FUNCTION toggle_disabled_skill(
  p_user_id UUID,
  p_slug    TEXT,
  p_disabled BOOLEAN
) RETURNS TEXT[] AS $$
DECLARE
  result TEXT[];
BEGIN
  IF p_disabled THEN
    UPDATE zeude_users
    SET disabled_skills = array_append(array_remove(disabled_skills, p_slug), p_slug),
        updated_at = NOW()
    WHERE id = p_user_id
    RETURNING disabled_skills INTO result;
  ELSE
    UPDATE zeude_users
    SET disabled_skills = array_remove(disabled_skills, p_slug),
        updated_at = NOW()
    WHERE id = p_user_id
    RETURNING disabled_skills INTO result;
  END IF;
  RETURN result;
END;
$$ LANGUAGE plpgsql;
