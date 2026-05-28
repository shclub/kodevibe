import { getUser } from '@/lib/session'
import {
  getOverviewStats,
  getTodayStatsBySource,
  parseSourceParam,
  type OverviewStats,
  type SourceStat,
} from '@/lib/clickhouse'
import { StatsCard } from '@/components/dashboard/stats-card'
import { SourceFilter as SourceFilterComponent } from '@/components/dashboard/source-filter'
import { OverviewClient } from '@/components/dashboard/overview-client'
import { Activity, DollarSign, Hash, Zap } from 'lucide-react'

interface OverviewPageProps {
  searchParams: Promise<{ source?: string; from?: string; to?: string }>
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

  try {
    const fetches = await Promise.all([
      getOverviewStats(user.email, user.id, source, from, to),
      source === 'all' ? getTodayStatsBySource(user.email, user.id, from, to) : Promise.resolve([]),
    ])
    todayStats = fetches[0]
    sourceStats = fetches[1]
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
    </div>
  )
}
