-- Migration 018: Add assistant response (output prompt) to ai_prompts
--
-- The opencode/copilot shims already send the assistant response text on the
-- api_request log record (LogAttributes['response'] / ['response_length']),
-- but ai_prompts had no column to hold it and the bridge MVs did not map it,
-- so the response never reached the dashboard. This adds the columns and
-- recreates the bridge MVs to carry response through.
--
-- Columns are appended at the end of ai_prompts so the bridge MVs' positional
-- column mapping (SELECT order -> target columns) stays correct.

ALTER TABLE ai_prompts ADD COLUMN IF NOT EXISTS response String DEFAULT '' AFTER working_directory;
ALTER TABLE ai_prompts ADD COLUMN IF NOT EXISTS response_length UInt32 DEFAULT 0 AFTER response;

-- ============================================================
-- OpenCode bridge (with /skill-name detection + response)
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
    LogAttributes['working_directory']        AS working_directory,
    LogAttributes['response']                 AS response,
    toUInt32OrZero(LogAttributes['response_length']) AS response_length
FROM claude_code_logs
WHERE ServiceName ILIKE '%opencode%'
  AND LogAttributes['prompt'] != ''
  AND LogAttributes['prompt'] != '[REDACTED]';

-- ============================================================
-- Copilot bridge (+ response)
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
    LogAttributes['working_directory']        AS working_directory,
    LogAttributes['response']                 AS response,
    toUInt32OrZero(LogAttributes['response_length']) AS response_length
FROM claude_code_logs
WHERE ServiceName ILIKE '%copilot%'
  AND LogAttributes['prompt'] != ''
  AND LogAttributes['prompt'] != '[REDACTED]';
