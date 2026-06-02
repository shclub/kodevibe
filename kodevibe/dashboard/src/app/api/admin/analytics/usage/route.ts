import { getSession } from '@/lib/session'
import { getClickHouseClient, buildMVSourceCondition, parseSourceParam } from '@/lib/clickhouse'
import { createServerClient } from '@/lib/supabase'
import { resolveUserNames } from '@/lib/name-resolution'
import type { SourceBreakdown, SourceTrendPoint, UserSourceUsage } from '@/lib/source-types'

// Source filtering is now centralized in lib/clickhouse.ts (buildMVSourceCondition)

interface UsageSummary {
  totalInputTokens: number
  totalOutputTokens: number
  totalCost: number
  cacheHitRate: number
  totalRequests: number
}

interface UserUsage {
  userId: string
  userName: string
  team: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cost: number
  cacheHitRate: number
  requestCount: number
}

interface TrendPoint {
  date: string
  inputTokens: number
  outputTokens: number
  cost: number
}

interface UsageResponse {
  summary: UsageSummary
  byUser: UserUsage[]
  trend: TrendPoint[]
  sourceBreakdown?: SourceBreakdown[]
  trendBySource?: SourceTrendPoint[]
  byUserBySource?: UserSourceUsage[]
  pagination: {
    page: number
    pageSize: number
    totalUsers: number
    totalPages: number
    search: string
  }
}

// GET: Fetch token usage analytics
export async function GET(req: Request) {
  try {
    const session = await getSession()

    if (!session) {
      return Response.json({ error: 'Not authenticated' }, { status: 401 })
    }

    if (session.user.role !== 'admin') {
      return Response.json({ error: 'Admin access required' }, { status: 403 })
    }

    const { searchParams } = new URL(req.url)
    const period = searchParams.get('period') || '7d'
    const usersOnly = searchParams.get('usersOnly') === '1'
    const overviewOnly = searchParams.get('overviewOnly') === '1'
    const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10) || 1)
    const pageSize = Math.min(200, Math.max(10, parseInt(searchParams.get('pageSize') || '50', 10) || 50))
    const search = (searchParams.get('search') || '').trim()
    const offset = (page - 1) * pageSize
    const source = searchParams.get('source') || 'all' // 'all' | 'claude' | 'codex'
    const compare = searchParams.get('compare') === 'true' // comparison mode

    // Calculate date range
    const days = period === '30d' ? 30 : period === '90d' ? 90 : 7

    // Build source filter clause for ClickHouse queries
    const sourceFilter = buildMVSourceCondition(parseSourceParam(source))

    // Try to query ClickHouse
    const clickhouse = getClickHouseClient()

    if (!clickhouse) {
      // ClickHouse not configured - return 501 Not Implemented
      return Response.json(
        {
          error: 'Analytics not yet configured',
          message: 'ClickHouse connection is not configured. Please set CLICKHOUSE_URL environment variable.',
          _notImplemented: true,
        },
        { status: 501 }
      )
    }

    try {
      const searchClause = search
        ? `
            WHERE positionCaseInsensitiveUTF8(user_id, {search:String}) > 0
               OR positionCaseInsensitiveUTF8(user_email, {search:String}) > 0
          `
        : ''

      const userQueryParams: Record<string, string | number> = {
        limit: pageSize,
        offset,
      }
      if (search) {
        userQueryParams.search = search
      }

      // Query MV for performance (cost_usd stored directly)
      const [summaryResult, trendResult, userResult, userCountResult, sourceBreakdownResult, invocationBreakdownResult] = await Promise.all([
        // Summary query - from MV with cost_usd
        usersOnly ? null : clickhouse.query({
          query: `
            SELECT
              sum(input_tokens) as input_tokens,
              sum(output_tokens) as output_tokens,
              sum(cache_read_tokens) as cache_read_tokens,
              sum(cost_usd) as cost,
              sum(request_count) as request_count
            FROM token_usage_hourly
            WHERE hour >= now() - INTERVAL ${days} DAY
              ${sourceFilter}
          `,
          format: 'JSONEachRow',
        }),

        // Trend query - from MV with cost_usd
        usersOnly ? null : clickhouse.query({
          query: `
            SELECT
              formatDateTime(toDate(hour), '%Y-%m-%d') as date,
              sum(input_tokens) as input_tokens,
              sum(output_tokens) as output_tokens,
              sum(cache_read_tokens) as cache_read_tokens,
              sum(cost_usd) as cost
            FROM token_usage_hourly
            WHERE hour >= now() - INTERVAL ${days} DAY
              ${sourceFilter}
            GROUP BY date
            ORDER BY date
          `,
          format: 'JSONEachRow',
        }),

        // User breakdown query - paginated + searchable
        overviewOnly ? null : clickhouse.query({
          query: `
            SELECT
              user_id,
              user_email,
              input_tokens,
              output_tokens,
              cache_read_tokens,
              cost_usd as cost,
              request_count
            FROM (
              SELECT
                user_id,
                any(user_email) as user_email,
                sum(input_tokens) as input_tokens,
                sum(output_tokens) as output_tokens,
                sum(cache_read_tokens) as cache_read_tokens,
                sum(cost_usd) as cost_usd,
                sum(request_count) as request_count
              FROM token_usage_hourly
              WHERE hour >= now() - INTERVAL ${days} DAY
                AND user_id != ''
                ${sourceFilter}
              GROUP BY user_id
            )
            ${searchClause}
            ORDER BY (input_tokens + output_tokens + cache_read_tokens) DESC
            LIMIT {limit:UInt32}
            OFFSET {offset:UInt32}
          `,
          query_params: userQueryParams,
          format: 'JSONEachRow',
        }),

        // Total user count for pagination
        overviewOnly ? null : clickhouse.query({
          query: `
            SELECT count() as total_users
            FROM (
              SELECT
                user_id,
                any(user_email) as user_email
              FROM token_usage_hourly
              WHERE hour >= now() - INTERVAL ${days} DAY
                AND user_id != ''
                ${sourceFilter}
              GROUP BY user_id
            )
            ${searchClause}
          `,
          query_params: search ? { search } : undefined,
          format: 'JSONEachRow',
        }),

        // Source breakdown query — token_usage_hourly covers claude + codex only.
        // Always returns all token-based sources (no sourceFilter) for comparison chart.
        usersOnly ? null : clickhouse.query({
          query: `
            SELECT
              source,
              sum(input_tokens) as input_tokens,
              sum(output_tokens) as output_tokens,
              sum(cost_usd) as cost,
              sum(request_count) as request_count
            FROM token_usage_hourly
            WHERE hour >= now() - INTERVAL ${days} DAY
            GROUP BY source
            ORDER BY source
          `,
          format: 'JSONEachRow',
        }),

        // Invocation breakdown for copilot + opencode (tool_invocations_daily).
        // These sources have no token data, so request_count = invocation_count.
        usersOnly ? null : clickhouse.query({
          query: `
            SELECT
              source,
              sum(invocation_count) as request_count
            FROM tool_invocations_daily
            WHERE date >= today() - INTERVAL ${days} DAY
              AND source IN ('copilot', 'opencode')
            GROUP BY source
            ORDER BY source
          `,
          format: 'JSONEachRow',
        }),
      ])

      // Parse results in parallel
      const [summaryDataRaw, trendDataRaw, userDataRaw, userCountRaw, sourceBreakdownDataRaw, invocationBreakdownDataRaw] = await Promise.all([
        summaryResult ? summaryResult.json() : Promise.resolve([]),
        trendResult ? trendResult.json() : Promise.resolve([]),
        userResult ? userResult.json() : Promise.resolve([]),
        userCountResult ? userCountResult.json() : Promise.resolve([]),
        sourceBreakdownResult ? sourceBreakdownResult.json() : Promise.resolve([]),
        invocationBreakdownResult ? invocationBreakdownResult.json() : Promise.resolve([]),
      ])

      const summaryData = summaryDataRaw as {
        input_tokens: string
        output_tokens: string
        cache_read_tokens: string
        cost: string
        request_count: string
      }[]
      const trendData = trendDataRaw as {
        date: string
        input_tokens: string
        output_tokens: string
        cache_read_tokens: string
        cost: string
      }[]
      const userData = userDataRaw as {
        user_email: string
        user_id: string
        input_tokens: string
        output_tokens: string
        cache_read_tokens: string
        cost: string
        request_count: string
      }[]
      const userCountData = userCountRaw as { total_users: string }[]
      const sourceBreakdownData = sourceBreakdownDataRaw as {
        source: string
        input_tokens: string
        output_tokens: string
        cost: string
        request_count: string
      }[]
      const invocationBreakdownData = invocationBreakdownDataRaw as {
        source: string
        request_count: string
      }[]

      const totalUsers = parseInt(userCountData[0]?.total_users || '0', 10) || 0
      const totalPages = totalUsers > 0 ? Math.ceil(totalUsers / pageSize) : 1

      // Process summary - use cost_usd directly from logs
      const summary = summaryData[0] || {
        input_tokens: '0',
        output_tokens: '0',
        cache_read_tokens: '0',
        cost: '0',
        request_count: '0',
      }
      const totalInput = parseInt(summary.input_tokens) || 0
      const totalOutput = parseInt(summary.output_tokens) || 0
      const totalCacheRead = parseInt(summary.cache_read_tokens) || 0
      const totalCost = parseFloat(summary.cost) || 0
      const totalRequests = parseInt(summary.request_count) || 0

      // Process trend - cost comes directly from query
      const trend: TrendPoint[] = trendData.map(row => ({
        date: row.date,
        inputTokens: parseInt(row.input_tokens) || 0,
        outputTokens: parseInt(row.output_tokens) || 0,
        cost: Math.round((parseFloat(row.cost) || 0) * 100) / 100,
      }))

      // === Name Resolution (Zeude Identity SSOT) ===
      // Shared utility handles Supabase lookup + email fallback + error handling
      const supabase = createServerClient()
      const { getDisplayName } = await resolveUserNames(supabase, userData)

      // Process users - cost comes directly from query
      const byUser: UserUsage[] = userData.map(row => {
        const inputTokens = parseInt(row.input_tokens) || 0
        const cacheReadTokens = parseInt(row.cache_read_tokens) || 0
        const cacheRate = inputTokens > 0 ? cacheReadTokens / inputTokens : 0

        return {
          userId: row.user_id || row.user_email,
          userName: getDisplayName(row.user_id, row.user_email),
          team: '',
          inputTokens,
          outputTokens: parseInt(row.output_tokens) || 0,
          cacheReadTokens,
          cost: Math.round((parseFloat(row.cost) || 0) * 100) / 100,
          cacheHitRate: Math.round(cacheRate * 100) / 100,
          requestCount: parseInt(row.request_count) || 0,
        }
      })

      // Calculate cache hit rate
      const cacheHitRate = totalInput > 0 ? totalCacheRead / totalInput : 0

      // Process source breakdown: token data from token_usage_hourly, then merge
      // invocation counts from tool_invocations_daily (avoiding duplicates).
      const sourceBreakdown: SourceBreakdown[] = sourceBreakdownData.map(row => ({
        source: row.source || 'unknown',
        inputTokens: parseInt(row.input_tokens) || 0,
        outputTokens: parseInt(row.output_tokens) || 0,
        cost: Math.round((parseFloat(row.cost) || 0) * 100) / 100,
        requestCount: parseInt(row.request_count) || 0,
      }))
      // Merge invocation counts into existing sources or add invocation-only entries.
      for (const row of invocationBreakdownData) {
        const src = row.source || 'unknown'
        const invCount = parseInt(row.request_count) || 0
        const existing = sourceBreakdown.find(s => s.source === src)
        if (existing) {
          existing.requestCount += invCount
        } else {
          sourceBreakdown.push({
            source: src,
            inputTokens: 0,
            outputTokens: 0,
            cost: 0,
            requestCount: invCount,
          })
        }
      }

      const response: UsageResponse = {
        summary: {
          totalInputTokens: totalInput,
          totalOutputTokens: totalOutput,
          totalCost: Math.round(totalCost * 100) / 100,
          cacheHitRate: Math.round(cacheHitRate * 100) / 100,
          totalRequests,
        },
        byUser,
        trend,
        sourceBreakdown,
        pagination: {
          page,
          pageSize,
          totalUsers,
          totalPages,
          search,
        },
      }

      // Comparison mode: fetch per-source trend and per-user-per-source breakdowns
      if (compare) {
        // Get compare sources from query params (comma-separated), default to all
        const compareParam = searchParams.get('compareSources') || ''
        const compareSources = compareParam
          ? compareParam.split(',').filter(s => ['claude','codex','copilot','opencode'].includes(s))
          : ['claude', 'codex', 'copilot', 'opencode']

        // Build source filter for ClickHouse
        const sourceList = compareSources.map(s => `'${s}'`).join(',')

        // Token-based sources from token_usage_hourly
        const [trendBySourceResult, userBySourceResult] = await Promise.all([
          clickhouse.query({
            query: `
              SELECT
                formatDateTime(toDate(hour), '%Y-%m-%d') as date,
                source,
                sum(input_tokens) as input_tokens,
                sum(output_tokens) as output_tokens,
                sum(cost_usd) as cost
              FROM token_usage_hourly
              WHERE hour >= now() - INTERVAL ${days} DAY
                AND source IN (${sourceList})
              GROUP BY date, source
              ORDER BY date
            `,
            format: 'JSONEachRow',
          }),

          clickhouse.query({
            query: `
              SELECT
                user_id,
                any(user_email) as user_email,
                source,
                sum(input_tokens) as input_tokens,
                sum(output_tokens) as output_tokens,
                sum(cost_usd) as cost,
                sum(request_count) as request_count
              FROM token_usage_hourly
              WHERE hour >= now() - INTERVAL ${days} DAY
                AND source IN (${sourceList})
              GROUP BY user_id, source
              ORDER BY input_tokens DESC
            `,
            format: 'JSONEachRow',
          }),
        ])

        const [trendBySourceRaw, userBySourceRaw] = await Promise.all([
          trendBySourceResult.json(),
          userBySourceResult.json(),
        ])

        const trendBySourceData = trendBySourceRaw as {
          date: string; source: string; input_tokens: string; output_tokens: string; cost: string
        }[]

        const userBySourceData = userBySourceRaw as {
          user_id: string; user_email: string; source: string;
          input_tokens: string; output_tokens: string; cost: string; request_count: string
        }[]

        // Pivot trend data: dynamic source fields
        const trendByDateMap = new Map<string, SourceTrendPoint>()
        for (const row of trendBySourceData) {
          if (!trendByDateMap.has(row.date)) {
            const point: SourceTrendPoint = { date: row.date }
            for (const s of compareSources) {
              point[`${s}_inputTokens`] = 0
              point[`${s}_outputTokens`] = 0
              point[`${s}_cost`] = 0
              point[`${s}_requestCount`] = 0
            }
            trendByDateMap.set(row.date, point)
          }
          const point = trendByDateMap.get(row.date)!
          const src = row.source
          point[`${src}_inputTokens`] = parseInt(row.input_tokens) || 0
          point[`${src}_outputTokens`] = parseInt(row.output_tokens) || 0
          point[`${src}_cost`] = Math.round((parseFloat(row.cost) || 0) * 100) / 100
        }

        // Also fetch invocation data for copilot/opencode from tool_invocations_daily
        const invCompareSources = compareSources.filter(s => s === 'copilot' || s === 'opencode')
        if (invCompareSources.length > 0) {
          const invSourceList = invCompareSources.map(s => `'${s}'`).join(',')

          const [invTrendResult, invUserResult] = await Promise.all([
            clickhouse.query({
              query: `
                SELECT
                  date,
                  source,
                  sum(invocation_count) as invocation_count
                FROM tool_invocations_daily
                WHERE date >= today() - INTERVAL ${days} DAY
                  AND source IN (${invSourceList})
                GROUP BY date, source
                ORDER BY date
              `,
              format: 'JSONEachRow',
            }),
            clickhouse.query({
              query: `
                SELECT
                  user_id,
                  any(user_email) as user_email,
                  source,
                  sum(invocation_count) as invocation_count
                FROM tool_invocations_daily
                WHERE date >= today() - INTERVAL ${days} DAY
                  AND source IN (${invSourceList})
                GROUP BY user_id, source
                ORDER BY invocation_count DESC
              `,
              format: 'JSONEachRow',
            }),
          ])

          const [invTrendRaw, invUserRaw] = await Promise.all([
            invTrendResult.json(),
            invUserResult.json(),
          ])

          const invTrendData = invTrendRaw as { date: string; source: string; invocation_count: string }[]
          const invUserData = invUserRaw as { user_id: string; user_email: string; source: string; invocation_count: string }[]

          // Re-resolve names for compare data (overviewOnly=1 skips userData so the initial
          // resolveUserNames gets an empty array — re-run with the actual compare rows).
          const compareUserRows = [
            ...userBySourceData.map(r => ({ user_id: r.user_id, user_email: r.user_email })),
            ...invUserData.map(r => ({ user_id: r.user_id, user_email: r.user_email })),
          ]
          const { getDisplayName: getCompareName } = await resolveUserNames(supabase, compareUserRows)

          // Merge invocation trend data into trendByDateMap
          for (const row of invTrendData) {
            if (!trendByDateMap.has(row.date)) {
              const point: SourceTrendPoint = { date: row.date }
              for (const s of compareSources) {
                point[`${s}_inputTokens`] = 0
                point[`${s}_outputTokens`] = 0
                point[`${s}_cost`] = 0
                point[`${s}_requestCount`] = 0
              }
              trendByDateMap.set(row.date, point)
            }
            const point = trendByDateMap.get(row.date)!
            const src = row.source
            point[`${src}_requestCount`] = (point[`${src}_requestCount`] as number || 0) + (parseInt(row.invocation_count) || 0)
          }

          // Merge invocation user data into userBySourceMap
          const userBySourceMap2 = new Map<string, UserSourceUsage>()
          // First, populate from token data (will merge below)
          for (const row of userBySourceData) {
            const key = row.user_id || row.user_email
            if (!userBySourceMap2.has(key)) {
              const entry: UserSourceUsage = {
                userId: key,
                userName: getCompareName(row.user_id, row.user_email),
              }
              for (const s of compareSources) {
                entry[`${s}_inputTokens`] = 0
                entry[`${s}_outputTokens`] = 0
                entry[`${s}_cost`] = 0
                entry[`${s}_requestCount`] = 0
              }
              userBySourceMap2.set(key, entry)
            }
            const entry = userBySourceMap2.get(key)!
            const src = row.source
            entry[`${src}_inputTokens`] = parseInt(row.input_tokens) || 0
            entry[`${src}_outputTokens`] = parseInt(row.output_tokens) || 0
            entry[`${src}_cost`] = Math.round((parseFloat(row.cost) || 0) * 100) / 100
            entry[`${src}_requestCount`] = parseInt(row.request_count) || 0
          }

          for (const row of invUserData) {
            const key = row.user_id || row.user_email
            if (!userBySourceMap2.has(key)) {
              const entry: UserSourceUsage = {
                userId: key,
                userName: getCompareName(row.user_id, row.user_email),
              }
              for (const s of compareSources) {
                entry[`${s}_inputTokens`] = 0
                entry[`${s}_outputTokens`] = 0
                entry[`${s}_cost`] = 0
                entry[`${s}_requestCount`] = 0
              }
              userBySourceMap2.set(key, entry)
            }
            const entry = userBySourceMap2.get(key)!
            const src = row.source
            entry[`${src}_requestCount`] = (entry[`${src}_requestCount`] as number || 0) + (parseInt(row.invocation_count) || 0)
          }

          response.trendBySource = Array.from(trendByDateMap.values())
            .sort((a, b) => a.date.localeCompare(b.date))

          response.byUserBySource = Array.from(userBySourceMap2.values())
            .sort((a, b) => {
              const aTotal = compareSources.reduce((sum, s) => sum + ((a[`${s}_inputTokens`] as number) || 0) + ((a[`${s}_requestCount`] as number) || 0), 0)
              const bTotal = compareSources.reduce((sum, s) => sum + ((b[`${s}_inputTokens`] as number) || 0) + ((b[`${s}_requestCount`] as number) || 0), 0)
              return bTotal - aTotal
            })
        } else {
          // No invocation-only sources — use token data only
          response.trendBySource = Array.from(trendByDateMap.values())
            .sort((a, b) => a.date.localeCompare(b.date))

          const tokenUserRows = userBySourceData.map(r => ({ user_id: r.user_id, user_email: r.user_email }))
          const { getDisplayName: getCompareName2 } = await resolveUserNames(supabase, tokenUserRows)

          const userBySourceMap = new Map<string, UserSourceUsage>()
          for (const row of userBySourceData) {
            const key = row.user_id || row.user_email
            if (!userBySourceMap.has(key)) {
              const entry: UserSourceUsage = {
                userId: row.user_id || row.user_email,
                userName: getCompareName2(row.user_id, row.user_email),
              }
              for (const s of compareSources) {
                entry[`${s}_inputTokens`] = 0
                entry[`${s}_outputTokens`] = 0
                entry[`${s}_cost`] = 0
                entry[`${s}_requestCount`] = 0
              }
              userBySourceMap.set(key, entry)
            }
            const entry = userBySourceMap.get(key)!
            const src = row.source
            entry[`${src}_inputTokens`] = parseInt(row.input_tokens) || 0
            entry[`${src}_outputTokens`] = parseInt(row.output_tokens) || 0
            entry[`${src}_cost`] = Math.round((parseFloat(row.cost) || 0) * 100) / 100
            entry[`${src}_requestCount`] = parseInt(row.request_count) || 0
          }
          response.byUserBySource = Array.from(userBySourceMap.values())
            .sort((a, b) => {
              const aTotal = compareSources.reduce((sum, s) => sum + ((a[`${s}_inputTokens`] as number) || 0), 0)
              const bTotal = compareSources.reduce((sum, s) => sum + ((b[`${s}_inputTokens`] as number) || 0), 0)
              return bTotal - aTotal
            })
        }
      }

      return Response.json(response)
    } catch (chError) {
      console.error('ClickHouse query error:', chError)
      return Response.json(
        {
          error: 'Analytics query failed',
          message: 'Failed to query ClickHouse. Please check connection settings.',
        },
        { status: 503 }
      )
    }
  } catch (err) {
    console.error('Analytics usage error:', err)
    return Response.json({ error: 'Internal server error' }, { status: 500 })
  }
}
