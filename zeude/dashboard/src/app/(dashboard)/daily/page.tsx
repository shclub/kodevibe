import dynamic from 'next/dynamic'
import { getUser } from '@/lib/session'
import { getDailyStats, getDailyInvocations, parseSourceParam, isInvocationOnlySource, type DailyInvocation } from '@/lib/clickhouse'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { SourceFilter as SourceFilterComponent } from '@/components/dashboard/source-filter'
import { Badge } from '@/components/ui/badge'

const CostChart = dynamic(
  () => import('@/components/charts/cost-chart').then(m => ({ default: m.CostChart })),
  { loading: () => <div className="h-[300px] bg-muted animate-pulse rounded-lg" /> }
)

const TokenChart = dynamic(
  () => import('@/components/charts/token-chart').then(m => ({ default: m.TokenChart })),
  { loading: () => <div className="h-[300px] bg-muted animate-pulse rounded-lg" /> }
)

interface DailyPageProps {
  searchParams: Promise<{ source?: string }>
}

function formatDate(date: string) {
  return new Date(date).toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  })
}

export default async function DailyPage({ searchParams }: DailyPageProps) {
  const user = await getUser()
  const params = await searchParams
  const source = parseSourceParam(params.source ?? null)
  const isInvocationOnly = isInvocationOnlySource(source)

  // Invocation-only tools (copilot, opencode) use tool_invocations_daily MV
  if (isInvocationOnly) {
    let invocations: DailyInvocation[] = []
    try {
      invocations = await getDailyInvocations(user.email, user.id, 30, source)
    } catch (error) {
      console.error('Failed to fetch invocation stats:', error)
    }

    // Aggregate totals
    const totalInvocations = invocations.reduce((sum, r) => sum + Number(r.invocation_count), 0)
    const uniqueModels = new Set(invocations.map(r => r.model_id).filter(Boolean)).size

    // Group by date for the table (sum invocations, collect models)
    const byDate = invocations.reduce<Record<string, { invocations: number; models: Set<string> }>>((acc, r) => {
      const key = r.date
      if (!acc[key]) acc[key] = { invocations: 0, models: new Set() }
      acc[key].invocations += Number(r.invocation_count)
      if (r.model_id) acc[key].models.add(r.model_id)
      return acc
    }, {})
    const dailyRows = Object.entries(byDate).sort(([a], [b]) => b.localeCompare(a))

    // Model breakdown (aggregate across all days)
    const byModel = invocations.reduce<Record<string, number>>((acc, r) => {
      const key = r.model_id || 'unknown'
      acc[key] = (acc[key] || 0) + Number(r.invocation_count)
      return acc
    }, {})
    const modelRows = Object.entries(byModel).sort(([, a], [, b]) => b - a)

    const toolLabel = source === 'copilot' ? 'GitHub Copilot' : 'OpenCode'

    return (
      <div className="space-y-8">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold">Daily Statistics</h1>
            <p className="text-muted-foreground">{toolLabel} invocations over the last 30 days</p>
          </div>
          <SourceFilterComponent useSearchParams />
        </div>

        <div className="grid gap-4 md:grid-cols-4 stagger-children">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">30-Day Invocations</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{totalInvocations}</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">Unique Models</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{uniqueModels}</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">Cost</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-muted-foreground">N/A</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">Tokens</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-muted-foreground">N/A</div>
            </CardContent>
          </Card>
        </div>

        <div className="grid gap-6 md:grid-cols-2">
          {/* Model Breakdown */}
          <Card>
            <CardHeader>
              <CardTitle>Model Usage</CardTitle>
              <CardDescription>Invocations per model (30 days)</CardDescription>
            </CardHeader>
            <CardContent>
              {modelRows.length === 0 ? (
                <p className="text-center py-8 text-muted-foreground">No data yet.</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Model</TableHead>
                      <TableHead className="text-right">Invocations</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {modelRows.map(([model, count]) => (
                      <TableRow key={model}>
                        <TableCell>
                          <Badge variant="outline" className="font-mono text-xs">{model}</Badge>
                        </TableCell>
                        <TableCell className="text-right font-mono">{count}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>

          {/* Daily Breakdown */}
          <Card>
            <CardHeader>
              <CardTitle>Daily Breakdown</CardTitle>
              <CardDescription>Invocations per day</CardDescription>
            </CardHeader>
            <CardContent>
              {dailyRows.length === 0 ? (
                <p className="text-center py-8 text-muted-foreground">No data yet. Start using {toolLabel} to see stats.</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Date</TableHead>
                      <TableHead>Invocations</TableHead>
                      <TableHead>Models</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {dailyRows.map(([date, row]) => (
                      <TableRow key={date}>
                        <TableCell className="font-medium">{formatDate(date)}</TableCell>
                        <TableCell>{row.invocations}</TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {[...row.models].join(', ') || '—'}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    )
  }

  // Token-based tools (claude, codex, all)
  let stats: Awaited<ReturnType<typeof getDailyStats>> = []

  try {
    stats = await getDailyStats(user.email, user.id, 30, source)
  } catch (error) {
    console.error('Failed to fetch daily stats:', error)
  }

  // Calculate totals (ClickHouse may return strings, so convert to numbers)
  const totals = stats.reduce(
    (acc, day) => ({
      sessions: acc.sessions + Number(day.sessions),
      cost: acc.cost + Number(day.cost),
      input_tokens: acc.input_tokens + Number(day.input_tokens),
      output_tokens: acc.output_tokens + Number(day.output_tokens),
    }),
    { sessions: 0, cost: 0, input_tokens: 0, output_tokens: 0 }
  )

  // Pre-process chart data server-side to minimize serialization payload
  const costData = stats.map(d => ({ date: d.date, cost: Number(d.cost) }))
  const tokenData = stats.map(d => ({ date: d.date, input: Number(d.input_tokens), output: Number(d.output_tokens) }))

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Daily Statistics</h1>
          <p className="text-muted-foreground">
            Usage trends over the last 30 days
          </p>
        </div>
        <SourceFilterComponent useSearchParams />
      </div>

      {/* Summary Cards */}
      <div className="grid gap-4 md:grid-cols-4 stagger-children">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">30-Day Sessions</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{totals.sessions}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">30-Day Cost</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">${totals.cost.toFixed(2)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Total Input Tokens</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{totals.input_tokens.toLocaleString()}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Total Output Tokens</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{totals.output_tokens.toLocaleString()}</div>
          </CardContent>
        </Card>
      </div>

      {/* Charts */}
      <div className="grid gap-6 md:grid-cols-2">
        <CostChart data={costData} />
        <TokenChart data={tokenData} />
      </div>

      {/* Daily Breakdown Table */}
      <Card>
        <CardHeader>
          <CardTitle>Daily Breakdown</CardTitle>
          <CardDescription>Detailed usage by day</CardDescription>
        </CardHeader>
        <CardContent>
          {stats.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              No usage data available. Start using Claude Code or Codex to see your daily stats.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Sessions</TableHead>
                  <TableHead>Input Tokens</TableHead>
                  <TableHead>Output Tokens</TableHead>
                  <TableHead className="text-right">Cost</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {stats.map((day) => (
                  <TableRow key={day.date}>
                    <TableCell className="font-medium">
                      {formatDate(day.date)}
                    </TableCell>
                    <TableCell>{Number(day.sessions)}</TableCell>
                    <TableCell>{Number(day.input_tokens).toLocaleString()}</TableCell>
                    <TableCell>{Number(day.output_tokens).toLocaleString()}</TableCell>
                    <TableCell className="text-right font-mono">
                      ${Number(day.cost).toFixed(4)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
