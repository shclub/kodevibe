-- Migration 016: Add copilot_prompts_bridge and opencode_prompts_bridge MVs
--
-- Copilot and OpenCode send token usage (including prompt text) to claude_code_logs
-- via otlplog.SendTokenUsage with ServiceName='copilot' / ServiceName='opencode'.
-- This migration creates MVs to bridge those events into ai_prompts,
-- matching the existing codex_prompts_bridge pattern.
--
-- OpenCode uses /skill-name syntax (same as Claude Code) → skill detection included.
-- Copilot uses native @mentions / /commands (not zeude skills) → hardcoded 'natural'.

-- ============================================================
-- Copilot bridge
-- ============================================================
CREATE MATERIALIZED VIEW IF NOT EXISTS copilot_prompts_bridge
TO ai_prompts
AS SELECT
    generateUUIDv4()                          AS prompt_id,
    LogAttributes['session.id']               AS session_id,
    ResourceAttributes['zeude.user.id']       AS user_id,
    ResourceAttributes['zeude.user.email']    AS user_email,
    ResourceAttributes['zeude.team']          AS team,
    Timestamp                                 AS timestamp,
    LogAttributes['prompt']                   AS prompt_text,
    toUInt32OrZero(LogAttributes['prompt_length']) AS prompt_length,
    'natural'                                 AS prompt_type,
    ''                                        AS invoked_name,
    'copilot'                                 AS source,
    ''                                        AS project_path,
    ''                                        AS working_directory
FROM claude_code_logs
WHERE ServiceName ILIKE '%copilot%'
  AND LogAttributes['prompt'] != ''
  AND LogAttributes['prompt'] != '[REDACTED]';

-- ============================================================
-- OpenCode bridge (with /skill-name detection)
-- ============================================================
CREATE MATERIALIZED VIEW IF NOT EXISTS opencode_prompts_bridge
TO ai_prompts
AS SELECT
    generateUUIDv4()                          AS prompt_id,
    LogAttributes['session.id']               AS session_id,
    ResourceAttributes['zeude.user.id']       AS user_id,
    ResourceAttributes['zeude.user.email']    AS user_email,
    ResourceAttributes['zeude.team']          AS team,
    Timestamp                                 AS timestamp,
    LogAttributes['prompt']                   AS prompt_text,
    toUInt32OrZero(LogAttributes['prompt_length']) AS prompt_length,
    if(match(LogAttributes['prompt'], '^/[a-zA-Z0-9_:-]+'),
       'skill', 'natural')                    AS prompt_type,
    extract(LogAttributes['prompt'], '^/([a-zA-Z0-9_:-]+)') AS invoked_name,
    'opencode'                                AS source,
    ''                                        AS project_path,
    ''                                        AS working_directory
FROM claude_code_logs
WHERE ServiceName ILIKE '%opencode%'
  AND LogAttributes['prompt'] != ''
  AND LogAttributes['prompt'] != '[REDACTED]';

-- ============================================================
-- Backfill historical data
-- ============================================================
INSERT INTO ai_prompts
SELECT
    generateUUIDv4()                          AS prompt_id,
    LogAttributes['session.id']               AS session_id,
    ResourceAttributes['zeude.user.id']       AS user_id,
    ResourceAttributes['zeude.user.email']    AS user_email,
    ResourceAttributes['zeude.team']          AS team,
    Timestamp                                 AS timestamp,
    LogAttributes['prompt']                   AS prompt_text,
    toUInt32OrZero(LogAttributes['prompt_length']) AS prompt_length,
    'natural'                                 AS prompt_type,
    ''                                        AS invoked_name,
    'copilot'                                 AS source,
    ''                                        AS project_path,
    ''                                        AS working_directory
FROM claude_code_logs
WHERE ServiceName ILIKE '%copilot%'
  AND LogAttributes['prompt'] != ''
  AND LogAttributes['prompt'] != '[REDACTED]';

INSERT INTO ai_prompts
SELECT
    generateUUIDv4()                          AS prompt_id,
    LogAttributes['session.id']               AS session_id,
    ResourceAttributes['zeude.user.id']       AS user_id,
    ResourceAttributes['zeude.user.email']    AS user_email,
    ResourceAttributes['zeude.team']          AS team,
    Timestamp                                 AS timestamp,
    LogAttributes['prompt']                   AS prompt_text,
    toUInt32OrZero(LogAttributes['prompt_length']) AS prompt_length,
    if(match(LogAttributes['prompt'], '^/[a-zA-Z0-9_:-]+'),
       'skill', 'natural')                    AS prompt_type,
    extract(LogAttributes['prompt'], '^/([a-zA-Z0-9_:-]+)') AS invoked_name,
    'opencode'                                AS source,
    ''                                        AS project_path,
    ''                                        AS working_directory
FROM claude_code_logs
WHERE ServiceName ILIKE '%opencode%'
  AND LogAttributes['prompt'] != ''
  AND LogAttributes['prompt'] != '[REDACTED]';
