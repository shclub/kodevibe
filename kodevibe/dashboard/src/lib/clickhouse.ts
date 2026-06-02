import { createClient, ClickHouseClient } from '@clickhouse/client'
import { env } from './env'

// Check if ClickHouse is explicitly configured (not just using defaults)
const isClickHouseConfigured = process.env.CLICKHOUSE_URL !== undefined

// Only create the client if CLICKHOUSE_URL is explicitly configured
let _clickhouseClient: ClickHouseClient | null = null

function initClickHouseClient(): ClickHouseClient | null {
  if (!isClickHouseConfigured) {
    return null
  }
  if (!_clickhouseClient) {
    _clickhouseClient = createClient({
      url: env.CLICKHOUSE_URL,
      username: env.CLICKHOUSE_USER,
      password: env.CLICKHOUSE_PASSWORD,
      database: env.CLICKHOUSE_DATABASE,
      request_timeout: 30000,
    })
  }
  return _clickhouseClient
}

// Get the ClickHouse client (returns null if not configured)
export function getClickHouseClient(): ClickHouseClient | null {
  return initClickHouseClient()
}

// Legacy export for backward compatibility
export const clickhouse = createClient({
  url: env.CLICKHOUSE_URL || 'http://localhost:8123',
  username: env.CLICKHOUSE_USER,
  password: env.CLICKHOUSE_PASSWORD,
  database: env.CLICKHOUSE_DATABASE,
  request_timeout: 30000,
})

// Types for telemetry data
export interface SessionSummary {
  session_id: string
  started_at: string
  ended_at: string
  event_count: number
  total_cost: number
  input_tokens: number
  output_tokens: number
  premium_requests: number
  source: string
  is_closed: number
}

export interface DailyStats {
  date: string
  sessions: number
  cost: number
  input_tokens: number
  output_tokens: number
}

// Source filter type for all supported AI coding tools
export type SourceFilter = 'all' | 'claude' | 'codex' | 'copilot' | 'opencode'

// Query helpers
// Note: OTel schema uses Timestamp (capital), LogAttributes map with dot notation (user.email, session.id)
// For Bedrock users, email comes from ResourceAttributes['zeude.user.email'] instead of LogAttributes['user.email']

// Helper to build user matching condition (supports both Anthropic and Bedrock users)
// Zeude identity is SSOT; external source IDs (Claude, Codex) are last-resort fallback
const USER_MATCH_CONDITION = `(
  ResourceAttributes['zeude.user.id'] = {userId:String}
  OR ResourceAttributes['zeude.user.email'] = {userEmail:String}
  OR LogAttributes['user.email'] = {userEmail:String}
)`

// Helper to build source filter condition for claude_code_logs (raw log table).
// Uses ServiceName to identify the tool. Everything not matching a known tool is 'claude'.
function buildSourceCondition(source: SourceFilter): string {
  if (source === 'claude') return "AND NOT (ServiceName ILIKE 'codex%' OR ServiceName ILIKE 'copilot%' OR ServiceName ILIKE 'opencode%')"
  if (source === 'codex') return "AND ServiceName ILIKE 'codex%'"
  if (source === 'copilot') return "AND ServiceName ILIKE 'copilot%'"
  if (source === 'opencode') return "AND ServiceName ILIKE 'opencode%'"
  return '' // 'all' = no filter
}

// Helper to build source filter condition for materialized views (token_usage_hourly, tool_invocations_daily, etc.).
// Uses the pre-computed 'source' column (not ServiceName).
export function buildMVSourceCondition(source: SourceFilter): string {
  if (source === 'claude') return "AND source = 'claude'"
  if (source === 'codex') return "AND source = 'codex'"
  if (source === 'copilot') return "AND source = 'copilot'"
  if (source === 'opencode') return "AND source = 'opencode'"
  return '' // 'all' = no filter
}

// Validate and sanitize source parameter from URL search params.
export function parseSourceParam(value: string | null): SourceFilter {
  if (value === 'claude' || value === 'codex' || value === 'copilot' || value === 'opencode') return value
  return 'all'
}

// Returns true for sources that only track invocations, not token usage.
// Copilot and OpenCode now emit token data via their shims, so they are no longer
// invocation-only. This function is kept for backward compatibility but always returns false.
export function isInvocationOnlySource(_source: SourceFilter): boolean {
  return false
}

// All date comparisons use KST (Asia/Seoul) so that "today" matches the user's local day.
const TZ = 'Asia/Seoul'

// Build date filter SQL for claude_code_logs queries.
// When from/to are provided, filter by KST date range.
// When omitted, default to "today" in KST.
function buildDateFilter(from?: string, to?: string): string {
  if (from && to) {
    return `AND toDate(Timestamp, '${TZ}') >= '${from}' AND toDate(Timestamp, '${TZ}') <= '${to}'`
  }
  return `AND toDate(Timestamp, '${TZ}') = toDate(now('${TZ}'))`
}

// Escape a string value for safe interpolation in ClickHouse SQL.
// Only use for values that cannot be parameterized (e.g., dynamic column names).
export function escapeClickHouseString(value: string): string {
  return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`
}

// Pricing model JOIN clause for accurate cost calculation.
// Codex logs have cost_usd=0, so we JOIN pricing_model to compute cost
// from token counts. Falls back to LogAttributes['cost_usd'] when model
// is not found in pricing_model (e.g. Claude Code which includes cost).
const PRICING_JOIN = `
LEFT JOIN (
  SELECT model_id,
    argMax(input_price_per_million, effective_date) as input_price,
    argMax(output_price_per_million, effective_date) as output_price,
    argMax(cache_read_price_per_million, effective_date) as cache_read_price,
    argMax(cache_creation_price_per_million, effective_date) as cache_creation_price
  FROM pricing_model GROUP BY model_id
) pm ON LogAttributes['model'] = pm.model_id`

// Normalize input tokens for display: Codex reports full context (new + cached),
// while Claude Code reports only new tokens. Subtract cache for Codex to make
// the numbers comparable. Cost calculation (COST_EXPR) still uses full tokens.
const INPUT_TOKENS_EXPR = `sum(
  if(ServiceName ILIKE 'codex%',
    toInt64OrZero(LogAttributes['input_tokens']) - toInt64OrZero(LogAttributes['cache_read_tokens']),
    toInt64OrZero(LogAttributes['input_tokens'])
  )
)`

const COST_EXPR = `sum(
  if(pm.model_id != '',
    toInt64OrZero(LogAttributes['input_tokens']) * pm.input_price / 1000000.0
    + toInt64OrZero(LogAttributes['output_tokens']) * pm.output_price / 1000000.0
    + toInt64OrZero(LogAttributes['cache_read_tokens']) * pm.cache_read_price / 1000000.0
    + toInt64OrZero(LogAttributes['cache_creation_tokens']) * pm.cache_creation_price / 1000000.0,
    toFloat64OrZero(LogAttributes['cost_usd'])
  )
)`

async function _getSessionsToday(userEmail: string, userId: string = '', source: SourceFilter = 'all', from?: string, to?: string): Promise<SessionSummary[]> {
  const sourceCondition = buildSourceCondition(source)
  const dateFilter = buildDateFilter(from, to)
  const result = await clickhouse.query({
    query: `
      SELECT
        LogAttributes['session.id'] as session_id,
        min(Timestamp) as started_at,
        max(Timestamp) as ended_at,
        count() as event_count,
        ${COST_EXPR} as total_cost,
        ${INPUT_TOKENS_EXPR} as input_tokens,
        sum(toInt64OrZero(LogAttributes['output_tokens'])) as output_tokens,
        max(toInt64OrZero(LogAttributes['premium_requests'])) as premium_requests,
        multiIf(
          any(ServiceName) ILIKE 'codex%', 'codex',
          any(ServiceName) ILIKE 'opencode%', 'opencode',
          any(ServiceName) ILIKE 'copilot%', 'copilot',
          'claude'
        ) as source,
        if(countIf(Body IN ('session.shutdown', 'session.end')) > 0 OR dateDiff('minute', max(Timestamp), now()) > 60, 1, 0) as is_closed
      FROM claude_code_logs
      ${PRICING_JOIN}
      WHERE ${USER_MATCH_CONDITION}
        ${dateFilter}
        ${sourceCondition}
      GROUP BY session_id
      HAVING session_id != '' AND countIf(Body LIKE '%api_request') > 0
      ORDER BY started_at DESC
    `,
    query_params: { userEmail, userId },
    format: 'JSONEachRow',
  })
  return result.json()
}

export const getSessionsToday = _getSessionsToday;

async function _getDailyStats(userEmail: string, userId: string = '', days: number = 30, source: SourceFilter = 'all'): Promise<DailyStats[]> {
  const sourceCondition = buildSourceCondition(source)
  const result = await clickhouse.query({
    query: `
      SELECT
        toDate(Timestamp, '${TZ}') as date,
        count(DISTINCT LogAttributes['session.id']) as sessions,
        ${COST_EXPR} as cost,
        ${INPUT_TOKENS_EXPR} as input_tokens,
        sum(toInt64OrZero(LogAttributes['output_tokens'])) as output_tokens
      FROM claude_code_logs
      ${PRICING_JOIN}
      WHERE ${USER_MATCH_CONDITION}
        AND toDate(Timestamp, '${TZ}') >= toDate(now('${TZ}')) - {days:Int32}
        ${sourceCondition}
      GROUP BY date
      ORDER BY date DESC
    `,
    query_params: { userEmail, userId, days },
    format: 'JSONEachRow',
  })
  return result.json()
}

// 60s cache (daily data changes infrequently)
export const getDailyStats = _getDailyStats;

export interface OverviewStats {
  total_sessions: number
  total_cost: number
  total_input_tokens: number
  total_output_tokens: number
}

const defaultOverviewStats: OverviewStats = {
  total_sessions: 0,
  total_cost: 0,
  total_input_tokens: 0,
  total_output_tokens: 0
}

async function _getOverviewStats(userEmail: string, userId: string = '', source: SourceFilter = 'all', from?: string, to?: string): Promise<OverviewStats> {
  const sourceCondition = buildSourceCondition(source)
  const dateFilter = buildDateFilter(from, to)
  const result = await clickhouse.query({
    query: `
      SELECT
        count(DISTINCT LogAttributes['session.id']) as total_sessions,
        ${COST_EXPR} as total_cost,
        ${INPUT_TOKENS_EXPR} as total_input_tokens,
        sum(toInt64OrZero(LogAttributes['output_tokens'])) as total_output_tokens
      FROM claude_code_logs
      ${PRICING_JOIN}
      WHERE ${USER_MATCH_CONDITION}
        ${dateFilter}
        ${sourceCondition}
    `,
    query_params: { userEmail, userId },
    format: 'JSONEachRow',
  })
  const rows = (await result.json()) as OverviewStats[]
  if (rows.length === 0) {
    return defaultOverviewStats
  }
  return rows[0]
}

// 30s cache
export const getOverviewStats = _getOverviewStats;

// Per-source breakdown of today's stats (used on overview page when source='all').
export interface SourceStat {
  source: string
  sessions: number
  cost: number
  input_tokens: number
  output_tokens: number
  invocations: number // copilot/opencode only
}

async function _getTodayStatsBySource(userEmail: string, userId: string = '', from?: string, to?: string): Promise<SourceStat[]> {
  const dateFilter = buildDateFilter(from, to)
  const invDateFilter = from && to
    ? `AND date >= '${from}' AND date <= '${to}'`
    : `AND date = toDate(now('${TZ}'))`
  const [tokenResult, invocationResult] = await Promise.all([
    clickhouse.query({
      query: `
        SELECT
          multiIf(
            ServiceName ILIKE 'codex%', 'codex',
            ServiceName ILIKE 'opencode%', 'opencode',
            ServiceName ILIKE 'copilot%', 'copilot',
            'claude'
          ) as source,
          count(DISTINCT LogAttributes['session.id']) as sessions,
          ${COST_EXPR} as cost,
          ${INPUT_TOKENS_EXPR} as input_tokens,
          sum(toInt64OrZero(LogAttributes['output_tokens'])) as output_tokens
        FROM claude_code_logs
        ${PRICING_JOIN}
        WHERE ${USER_MATCH_CONDITION}
          ${dateFilter}
        GROUP BY source
        ORDER BY source
      `,
      query_params: { userEmail, userId },
      format: 'JSONEachRow',
    }),
    clickhouse.query({
      query: `
        SELECT source, sum(invocation_count) as invocations
        FROM tool_invocations_daily
        WHERE (user_id = {userId:String} OR user_email = {userEmail:String})
          ${invDateFilter}
          AND source IN ('copilot', 'opencode')
        GROUP BY source
      `,
      query_params: { userEmail, userId },
      format: 'JSONEachRow',
    }),
  ])

  const tokenRows = (await tokenResult.json()) as { source: string; sessions: string; cost: string; input_tokens: string; output_tokens: string }[]
  const invRows = (await invocationResult.json()) as { source: string; invocations: string }[]

  const result: SourceStat[] = tokenRows.map(r => ({
    source: r.source,
    sessions: Number(r.sessions),
    cost: Number(r.cost),
    input_tokens: Number(r.input_tokens),
    output_tokens: Number(r.output_tokens),
    invocations: 0,
  }))

  for (const inv of invRows) {
    const existing = result.find(r => r.source === inv.source)
    if (existing) {
      existing.invocations = Number(inv.invocations)
    } else {
      result.push({ source: inv.source, sessions: 0, cost: 0, input_tokens: 0, output_tokens: 0, invocations: Number(inv.invocations) })
    }
  }

  return result.sort((a, b) => a.source.localeCompare(b.source))
}

export const getTodayStatsBySource = _getTodayStatsBySource;

// Today's invocation count from tool_invocations_daily for invocation-only sources.
// Used by overview page to add copilot+opencode counts when source='all'.
async function _getTodayInvocationCount(
  userEmail: string,
  userId: string = '',
  source: SourceFilter = 'all'
): Promise<number> {
  // When source='all', fetch only copilot+opencode (token sources covered by getOverviewStats).
  // When source is a specific invocation-only source, fetch just that source.
  const sourceCondition = source === 'all'
    ? INVOCATION_ONLY_CONDITION
    : buildMVSourceCondition(source)
  const result = await clickhouse.query({
    query: `
      SELECT sum(invocation_count) as total
      FROM tool_invocations_daily
      WHERE (user_id = {userId:String} OR user_email = {userEmail:String})
        AND date = toDate(now('${TZ}'))
        ${sourceCondition}
    `,
    query_params: { userEmail, userId },
    format: 'JSONEachRow',
  })
  const rows = await result.json() as { total: string }[]
  return Number(rows[0]?.total ?? 0)
}

export const getTodayInvocationCount = _getTodayInvocationCount;

// Returns true for sources that only have invocation data (no tokens).
// Used to decide whether to also fetch tool_invocations_daily when source='all'.
export function isInvocationOnlySourceName(source: string): boolean {
  return source === 'copilot' || source === 'opencode'
}

// SQL condition that restricts to invocation-only sources (copilot + opencode).
// Used when combining token data (claude/codex) with invocation data for source='all'.
const INVOCATION_ONLY_CONDITION = "AND source IN ('copilot', 'opencode')"

// Daily invocation stats from tool_invocations_daily MV (copilot/opencode).
// Groups by date and model_id so callers can build model breakdowns.
export interface DailyInvocation {
  date: string
  model_id: string
  source: string
  invocation_count: number
}

async function _getDailyInvocations(
  userEmail: string,
  userId: string = '',
  days: number = 30,
  source: SourceFilter = 'all'
): Promise<DailyInvocation[]> {
  // When source='all', only fetch copilot+opencode from this MV to avoid
  // double-counting claude/codex which are already covered by token_usage_hourly.
  const sourceCondition = source === 'all'
    ? INVOCATION_ONLY_CONDITION
    : buildMVSourceCondition(source)
  const result = await clickhouse.query({
    query: `
      SELECT
        date,
        model_id,
        source,
        sum(invocation_count) as invocation_count
      FROM tool_invocations_daily
      WHERE (user_id = {userId:String} OR user_email = {userEmail:String})
        AND date >= toDate(now('${TZ}')) - {days:Int32}
        ${sourceCondition}
      GROUP BY date, model_id, source
      ORDER BY date DESC, invocation_count DESC
    `,
    query_params: { userEmail, userId, days },
    format: 'JSONEachRow',
  })
  return result.json()
}

export const getDailyInvocations = _getDailyInvocations;

export interface SessionEvent {
  timestamp: string
  event_name: string
  model: string
  prompt_id: string
  prompt_length: number
  tool_name: string
  tool_decision: string
  query_source: string
  duration_ms: number
  command_name: string
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_creation_tokens: number
  cost_usd: number
  attributes: Record<string, string>
}

export async function getSessionDetails(userEmail: string, userId: string, sessionId: string): Promise<SessionEvent[]> {
  const result = await clickhouse.query({
    query: `
      SELECT
        Timestamp as timestamp,
        Body as event_name,
        LogAttributes['model'] as model,
        LogAttributes['prompt.id'] as prompt_id,
        toInt64OrZero(LogAttributes['prompt_length']) as prompt_length,
        LogAttributes['tool_name'] as tool_name,
        LogAttributes['decision'] as tool_decision,
        LogAttributes['query_source'] as query_source,
        toInt64OrZero(LogAttributes['duration_ms']) as duration_ms,
        LogAttributes['command_name'] as command_name,
        toInt64OrZero(LogAttributes['input_tokens']) as input_tokens,
        toInt64OrZero(LogAttributes['output_tokens']) as output_tokens,
        toInt64OrZero(LogAttributes['cache_read_tokens']) as cache_read_tokens,
        toInt64OrZero(LogAttributes['cache_creation_tokens']) as cache_creation_tokens,
        if(pm.model_id != '',
          toInt64OrZero(LogAttributes['input_tokens']) * pm.input_price / 1000000.0
          + toInt64OrZero(LogAttributes['output_tokens']) * pm.output_price / 1000000.0
          + toInt64OrZero(LogAttributes['cache_read_tokens']) * pm.cache_read_price / 1000000.0
          + toInt64OrZero(LogAttributes['cache_creation_tokens']) * pm.cache_creation_price / 1000000.0,
          toFloat64OrZero(LogAttributes['cost_usd'])
        ) as cost_usd,
        LogAttributes as attributes
      FROM claude_code_logs
      ${PRICING_JOIN}
      WHERE ${USER_MATCH_CONDITION}
        AND LogAttributes['session.id'] = {sessionId:String}
      ORDER BY Timestamp ASC
    `,
    query_params: { userEmail, userId, sessionId },
    format: 'JSONEachRow',
  })
  return result.json()
}

export interface TopDurationSession {
  session_id: string
  user_email: string
  source: string
  started_at: string
  ended_at: string
  duration_seconds: number
  event_count: number
  input_tokens: number
  output_tokens: number
  total_cost: number
  is_closed: number
}

export async function getTopSessionsByDuration(from?: string, to?: string): Promise<TopDurationSession[]> {
  const dateFilter = buildDateFilter(from, to)
  const result = await clickhouse.query({
    query: `
      SELECT
        LogAttributes['session.id'] as session_id,
        any(ResourceAttributes['zeude.user.email']) as user_email,
        multiIf(
          any(ServiceName) ILIKE 'codex%', 'codex',
          any(ServiceName) ILIKE 'opencode%', 'opencode',
          any(ServiceName) ILIKE 'copilot%', 'copilot',
          'claude'
        ) as source,
        min(Timestamp) as started_at,
        max(Timestamp) as ended_at,
        dateDiff('second', min(Timestamp), max(Timestamp)) as duration_seconds,
        count() as event_count,
        ${INPUT_TOKENS_EXPR} as input_tokens,
        sum(toInt64OrZero(LogAttributes['output_tokens'])) as output_tokens,
        ${COST_EXPR} as total_cost,
        if(countIf(Body IN ('session.shutdown', 'session.end')) > 0 OR dateDiff('minute', max(Timestamp), now()) > 60, 1, 0) as is_closed
      FROM claude_code_logs
      ${PRICING_JOIN}
      WHERE 1=1
        ${dateFilter}
      GROUP BY session_id
      HAVING session_id != '' AND duration_seconds > 0 AND countIf(Body LIKE '%api_request') > 0
      ORDER BY duration_seconds DESC
      LIMIT 10
    `,
    format: 'JSONEachRow',
  })
  return result.json()
}

export interface ModelUsageStat {
  model: string
  call_count: number
  input_tokens: number
  output_tokens: number
  total_cost: number
}

export async function getTopModelsByUsage(
  userEmail: string,
  userId: string = '',
  source: SourceFilter = 'all',
  from?: string,
  to?: string,
  limit: number = 10
): Promise<ModelUsageStat[]> {
  const sourceCondition = buildSourceCondition(source)
  const dateFilter = buildDateFilter(from, to)
  const result = await clickhouse.query({
    query: `
      SELECT
        LogAttributes['model'] as model,
        count() as call_count,
        ${INPUT_TOKENS_EXPR} as input_tokens,
        sum(toInt64OrZero(LogAttributes['output_tokens'])) as output_tokens,
        ${COST_EXPR} as total_cost
      FROM claude_code_logs
      ${PRICING_JOIN}
      WHERE ${USER_MATCH_CONDITION}
        ${dateFilter}
        ${sourceCondition}
        AND Body LIKE '%api_request'
        AND LogAttributes['model'] != ''
      GROUP BY model
      ORDER BY call_count DESC
      LIMIT {limit:UInt32}
    `,
    query_params: { userEmail, userId, limit },
    format: 'JSONEachRow',
  })
  const rows = (await result.json()) as Record<string, string>[]
  return rows.map(r => ({
    model: r.model,
    call_count: Number(r.call_count),
    input_tokens: Number(r.input_tokens),
    output_tokens: Number(r.output_tokens),
    total_cost: Number(r.total_cost),
  }))
}
