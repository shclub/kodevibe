-- Migration 017: Populate project_path / working_directory for opencode & copilot
--
-- Migration 016 created copilot_prompts_bridge and opencode_prompts_bridge but
-- hardcoded project_path and working_directory to ''. The opencode shim now
-- sends the session cwd via the zeude.project_path / zeude.working_directory
-- resource attributes (mapped by the collector into the project_path /
-- working_directory log columns), so the bridge MVs can read them like the
-- codex bridge does. This drops and recreates both MVs to carry the values
-- through, then backfills historical rows.

-- ============================================================
-- Copilot bridge
-- ============================================================
DROP VIEW IF EXISTS copilot_prompts_bridge;

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
    LogAttributes['project_path']             AS project_path,
    LogAttributes['working_directory']        AS working_directory
FROM claude_code_logs
WHERE ServiceName ILIKE '%copilot%'
  AND LogAttributes['prompt'] != ''
  AND LogAttributes['prompt'] != '[REDACTED]';

-- ============================================================
-- OpenCode bridge (with /skill-name detection)
-- ============================================================
DROP VIEW IF EXISTS opencode_prompts_bridge;

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
    LogAttributes['project_path']             AS project_path,
    LogAttributes['working_directory']        AS working_directory
FROM claude_code_logs
WHERE ServiceName ILIKE '%opencode%'
  AND LogAttributes['prompt'] != ''
  AND LogAttributes['prompt'] != '[REDACTED]';

-- ============================================================
-- Backfill project_path / working_directory onto existing ai_prompts rows.
-- ai_prompts is a ReplacingMergeTree-style target; re-insert the matching
-- rows with the now-populated path columns so old prompts also resolve a
-- project. Rows logged before the shim started sending the cwd will simply
-- carry empty paths (no value was ever recorded for them).
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
    if(match(LogAttributes['prompt'], '^/[a-zA-Z0-9_:-]+'),
       'skill', 'natural')                    AS prompt_type,
    extract(LogAttributes['prompt'], '^/([a-zA-Z0-9_:-]+)') AS invoked_name,
    'opencode'                                AS source,
    LogAttributes['project_path']             AS project_path,
    LogAttributes['working_directory']        AS working_directory
FROM claude_code_logs
WHERE ServiceName ILIKE '%opencode%'
  AND LogAttributes['prompt'] != ''
  AND LogAttributes['prompt'] != '[REDACTED]'
  AND LogAttributes['project_path'] != '';

-- NOTE: No copilot backfill. On already-running deployments the live
-- copilot_prompts_bridge MV is already reading LogAttributes['project_path'],
-- so those rows exist in ai_prompts. prompt_id is a fresh generateUUIDv4()
-- per row, so a backfill INSERT cannot dedup against them and would create
-- duplicates. The recreated MV above is enough for new copilot events.
