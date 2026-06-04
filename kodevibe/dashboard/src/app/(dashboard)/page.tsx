import { getUser } from '@/lib/session'
import {
  getOverviewStats,
  getTodayStatsBySource,
  getTopModelsByUsage,
  parseSourceParam,
  type OverviewStats,
  type SourceStat,
  type ModelUsageStat,
} from '@/lib/clickhouse'
import { getTopPromptsByCount, type TopPromptStat } from '@/lib/prompt-analytics'
import { StatsCard } from '@/components/dashboard/stats-card'
import { SourceFilter as SourceFilterComponent } from '@/components/dashboard/source-filter'
import { OverviewClient } from '@/components/dashboard/overview-client'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Activity, DollarSign, Hash, Zap, Trophy, Medal, Cpu, MessageSquare } from 'lucide-react'

interface OverviewPageProps {
  searchParams: Promise<{ source?: string; from?: string; to?: string }>
}

const PROMPT_TYPE_COLORS: Record<string, string> = {
  natural:  'bg-slate-100 text-slate-700',
  skill:    'bg-blue-100 text-blue-700',
  command:  'bg-purple-100 text-purple-700',
  agent:    'bg-green-100 text-green-700',
  mcp_tool: 'bg-orange-100 text-orange-700',
}

const PROMPT_TYPE_LABELS: Record<string, string> = {
  natural:  '자연어',
  skill:    'Skill',
  command:  'Command',
  agent:    'Agent',
  mcp_tool: 'MCP Tool',
}

const SOURCE_COLORS: Record<string, string> = {
  claude:    'border-blue-200 bg-blue-50',
  codex:     'border-emerald-200 bg-emerald-50',
  opencode:  'border-orange-200 bg-orange-50',
  copilot:   'border-purple-200 bg-purple-50',
}
const SOURCE_DOT: Record<string, string> = {
  claude:   'bg-blue-500',
  codex:    'bg-emerald-500',
  opencode: 'bg-orange-500',
  copilot:  'bg-purple-500',
}
const SOURCE_LABELS: Record<string, string> = {
  claude:   'Claude Code',
  codex:    'Codex',
  opencode: 'OpenCode',
  copilot:  'GitHub Copilot',
}

function formatNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return n.toString()
}

function getRankIcon(rank: number) {
  if (rank === 1) return <Trophy className="h-5 w-5 text-yellow-500 shrink-0" />
  if (rank === 2) return <Medal className="h-5 w-5 text-gray-400 shrink-0" />
  if (rank === 3) return <Medal className="h-5 w-5 text-amber-600 shrink-0" />
  return <span className="w-5 text-center text-sm text-muted-foreground font-mono shrink-0">{rank}</span>
}

function getRankBg(rank: number) {
  if (rank === 1) return 'bg-yellow-500/10 border-yellow-500/20'
  if (rank === 2) return 'bg-gray-500/10 border-gray-500/20'
  if (rank === 3) return 'bg-amber-500/10 border-amber-500/20'
  return 'bg-muted/50'
}

function SourceBreakdown({ stats }: { stats: SourceStat[] }) {
  const visible = stats.filter(s => s.sessions > 0 || s.invocations > 0 || s.input_tokens > 0)
  if (visible.length === 0) return null

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {visible.map((s) => {
        const colors = SOURCE_COLORS[s.source] ?? 'border-gray-200 bg-gray-50'
        const dot = SOURCE_DOT[s.source] ?? 'bg-gray-400'
        const label = SOURCE_LABELS[s.source] ?? s.source
        const isInvOnly = s.invocations > 0 && s.input_tokens === 0 && s.output_tokens === 0

        return (
          <div key={s.source} className={`rounded-xl border p-4 space-y-2 ${colors}`}>
            <div className="flex items-center gap-2">
              <span className={`w-2.5 h-2.5 rounded-full ${dot}`} />
              <span className="text-sm font-semibold">{label}</span>
            </div>
            {isInvOnly ? (
              <div>
                <p className="text-2xl font-bold">{s.invocations}</p>
                <p className="text-xs text-muted-foreground">invocations (no token data yet)</p>
              </div>
            ) : (
              <div className="space-y-1">
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>Sessions</span><span className="font-mono font-medium text-foreground">{s.sessions}</span>
                </div>
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>Input</span><span className="font-mono font-medium text-foreground">{formatNum(s.input_tokens)}</span>
                </div>
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>Output</span><span className="font-mono font-medium text-foreground">{formatNum(s.output_tokens)}</span>
                </div>
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>Cost</span><span className="font-mono font-medium text-foreground">${s.cost.toFixed(3)}</span>
                </div>
                {s.invocations > 0 && (
                  <div className="flex justify-between text-xs text-muted-foreground">
                    <span>Invocations</span><span className="font-mono font-medium text-foreground">{s.invocations}</span>
                  </div>
                )}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

export const dynamic = 'force-dynamic'

export default async function OverviewPage({ searchParams }: OverviewPageProps) {
  const user = await getUser()
  const params = await searchParams
  const source = parseSourceParam(params.source ?? null)
  const from = params.from
  const to = params.to

  let todayStats: OverviewStats = {
    total_sessions: 0,
    total_cost: 0,
    total_input_tokens: 0,
    total_output_tokens: 0,
  }
  let sourceStats: SourceStat[] = []
  let topModels: ModelUsageStat[] = []
  let topPrompts: TopPromptStat[] = []

  // Admin sees org-wide stats; regular users see only their own.
  const isAdmin = user.role === 'admin'
  const qEmail = isAdmin ? '' : user.email
  const qUserId = isAdmin ? '' : user.id

  try {
    const fetches = await Promise.all([
      getOverviewStats(qEmail, qUserId, source, from, to),
      source === 'all' ? getTodayStatsBySource(qEmail, qUserId, from, to) : Promise.resolve([]),
      getTopModelsByUsage(qEmail, qUserId, source, from, to),
      getTopPromptsByCount({ userId: qUserId, userEmail: qEmail }, from, to, source),
    ])
    todayStats = fetches[0]
    sourceStats = fetches[1]
    topModels = fetches[2]
    topPrompts = fetches[3]
  } catch (error) {
    console.error('Failed to fetch ClickHouse data:', error)
  }

  const dateLabel = from && to
    ? `${from} ~ ${to}`
    : from ? `from ${from}`
    : to ? `until ${to}`
    : 'today'

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Overview</h1>
          <p className="text-muted-foreground">
            Your AI coding tool usage ({dateLabel})
          </p>
        </div>
        <div className="flex items-center gap-2">
          <OverviewClient from={from} to={to} />
          <SourceFilterComponent useSearchParams />
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4 stagger-children">
        <StatsCard
          title="Sessions"
          value={Number(todayStats.total_sessions)}
          icon={Activity}
          description="Active coding sessions"
        />
        <StatsCard
          title="Cost"
          value={`$${Number(todayStats.total_cost).toFixed(4)}`}
          icon={DollarSign}
          description="API usage cost"
        />
        <StatsCard
          title="Input Tokens"
          value={Number(todayStats.total_input_tokens).toLocaleString()}
          icon={Hash}
          description="Prompts and context"
        />
        <StatsCard
          title="Output Tokens"
          value={Number(todayStats.total_output_tokens).toLocaleString()}
          icon={Zap}
          description="Generated responses"
        />
      </div>

      {/* Source Breakdown (only when 'all' is selected) */}
      {source === 'all' && <SourceBreakdown stats={sourceStats} />}

      {/* Model Usage Top 10 */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-lg">
            <Cpu className="h-5 w-5 text-blue-500" />
            Model Usage Top 10
          </CardTitle>
          <p className="text-sm text-muted-foreground">{dateLabel}</p>
        </CardHeader>
        <CardContent>
          {topModels.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground text-sm">No model usage data for this period.</div>
          ) : (
            <div className="space-y-2">
              {topModels.map((m, i) => (
                <div
                  key={m.model}
                  className={`flex items-center justify-between p-3 rounded-lg border ${getRankBg(i + 1)}`}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    {getRankIcon(i + 1)}
                    <span className="font-medium font-mono text-sm truncate">{m.model}</span>
                  </div>
                  <div className="flex items-center gap-4 shrink-0 ml-3">
                    <span className="text-xs text-muted-foreground hidden md:block">
                      {formatNum(m.input_tokens)} in · {formatNum(m.output_tokens)} out
                    </span>
                    <span className="font-mono text-sm text-muted-foreground">
                      {m.call_count.toLocaleString()} calls
                    </span>
                    <span className="font-mono text-sm font-semibold text-blue-600">
                      ${m.total_cost.toFixed(4)}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Prompt Top 10 */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-lg">
            <MessageSquare className="h-5 w-5 text-violet-500" />
            Prompt Top 10
          </CardTitle>
          <p className="text-sm text-muted-foreground">{dateLabel}</p>
        </CardHeader>
        <CardContent>
          {topPrompts.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground text-sm">No prompt data for this period.</div>
          ) : (
            <div className="space-y-2">
              {topPrompts.map((p, i) => {
                const display = p.invoked_name || p.prompt_text
                const truncated = display.length > 70 ? display.slice(0, 70) + '…' : display
                return (
                  <div
                    key={p.prompt_text}
                    className={`flex items-center justify-between p-3 rounded-lg border ${getRankBg(i + 1)}`}
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      {getRankIcon(i + 1)}
                      <span className="font-mono text-sm truncate" title={display}>{truncated}</span>
                    </div>
                    <div className="flex items-center gap-3 shrink-0 ml-3">
                      <Badge
                        variant="secondary"
                        className={`text-xs ${PROMPT_TYPE_COLORS[p.prompt_type] ?? PROMPT_TYPE_COLORS.natural}`}
                      >
                        {PROMPT_TYPE_LABELS[p.prompt_type] ?? '자연어'}
                      </Badge>
                      <span className="font-mono text-sm font-semibold text-violet-600">
                        {p.count}×
                      </span>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
