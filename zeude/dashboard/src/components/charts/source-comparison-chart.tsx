'use client'

import { Fragment, memo } from 'react'
import {
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from 'recharts'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import type { SourceTrendPoint } from '@/lib/source-types'

const SOURCE_COLORS: Record<string, { main: string; light: string }> = {
  claude:   { main: '#3b82f6', light: '#93c5fd' },
  codex:    { main: '#10b981', light: '#6ee7b7' },
  copilot:  { main: '#8b5cf6', light: '#c4b5fd' },
  opencode: { main: '#f97316', light: '#fdba74' },
}
const SOURCE_LABELS: Record<string, string> = {
  claude: 'Claude Code', codex: 'Codex', copilot: 'Copilot', opencode: 'OpenCode',
}

// Detect which sources have data in the trend points (tokens or invocations)
function detectSources(data: SourceTrendPoint[]): string[] {
  const sources = new Set<string>()
  for (const d of data) {
    for (const key of Object.keys(d)) {
      if ((key.endsWith('_inputTokens') || key.endsWith('_requestCount')) && (d[key] as number) > 0) {
        const src = key.endsWith('_requestCount') ? key.replace('_requestCount', '') : key.replace('_inputTokens', '')
        sources.add(src)
      }
    }
  }
  return [...sources].sort()
}

// Check if a source is invocation-only (no token data)
function isInvocationOnly(data: SourceTrendPoint[], source: string): boolean {
  const hasTokens = data.some(d => (d[`${source}_inputTokens`] as number || 0) > 0 || (d[`${source}_outputTokens`] as number || 0) > 0)
  const hasInvocations = data.some(d => (d[`${source}_requestCount`] as number || 0) > 0)
  return !hasTokens && hasInvocations
}

function formatNumber(num: number): string {
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}M`
  if (num >= 1_000) return `${(num / 1_000).toFixed(0)}K`
  return num.toString()
}

// --- Comparison Chart (tokens or cost) ---

interface SourceComparisonChartProps {
  data: SourceTrendPoint[]
  metric: 'tokens' | 'cost'
}

export const SourceComparisonChart = memo(function SourceComparisonChart({ data, metric }: SourceComparisonChartProps) {
  const allSources = detectSources(data)
  if (allSources.length === 0) return null

  const chartData = data.map(d => ({ ...d, date: d.date.slice(5) }))

  // Split sources: token-based vs invocation-only
  const tokenSources = allSources.filter(s => !isInvocationOnly(data, s))
  const invOnlySources = allSources.filter(s => isInvocationOnly(data, s))

  if (metric === 'cost') {
    if (tokenSources.length === 0) return null
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Cost Comparison (Overlay)</CardTitle>
          <div className="flex gap-2 flex-wrap">
            {tokenSources.map(s => (
              <span key={s} className="text-xs">
                <span className="inline-block w-2 h-2 rounded-full mr-1" style={{ backgroundColor: SOURCE_COLORS[s]?.main }} />
                <span className="font-medium" style={{ color: SOURCE_COLORS[s]?.main }}>{SOURCE_LABELS[s] ?? s}</span>
              </span>
            ))}
          </div>
        </CardHeader>
        <CardContent>
          <div className="h-[280px]">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                <XAxis dataKey="date" tick={{ fontSize: 10 }} tickLine={false} axisLine={false} />
                <YAxis tick={{ fontSize: 10 }} tickLine={false} axisLine={false} tickFormatter={v => `$${v.toFixed(2)}`} />
                <Tooltip
                  contentStyle={{ background: 'hsl(var(--background))', border: '1px solid hsl(var(--border))' }}
                  formatter={(value, name) => [`$${Number(value).toFixed(4)}`, SOURCE_LABELS[String(name).replace('_cost', '')] ?? String(name)]}
                  labelFormatter={label => `Date: ${label}`}
                />
                <Legend formatter={value => SOURCE_LABELS[String(value).replace('_cost', '')] ?? String(value)} />
                {tokenSources.map(s => (
                  <Line key={s} type="monotone" dataKey={`${s}_cost`} stroke={SOURCE_COLORS[s]?.main ?? '#888'} strokeWidth={2} dot={{ r: 2 }} activeDot={{ r: 4 }} />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
        </CardContent>
      </Card>
    )
  }

  // Tokens: grouped bar chart per source (only token-based sources)
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">{invOnlySources.length > 0 ? 'Token Usage Comparison' : 'Token Usage Comparison (Overlay)'}</CardTitle>
        <div className="flex gap-2 flex-wrap">
          {allSources.map(s => (
            <span key={s} className="text-xs">
              <span className="inline-block w-2 h-2 rounded-full mr-1" style={{ backgroundColor: SOURCE_COLORS[s]?.main }} />
              <span className="font-medium" style={{ color: SOURCE_COLORS[s]?.main }}>
                {SOURCE_LABELS[s] ?? s}
                {isInvocationOnly(data, s) && ' (invocations)'}
              </span>
            </span>
          ))}
        </div>
      </CardHeader>
      <CardContent>
        <div className="h-[280px]">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
              <XAxis dataKey="date" tick={{ fontSize: 10 }} tickLine={false} axisLine={false} />
              <YAxis tick={{ fontSize: 10 }} tickLine={false} axisLine={false} tickFormatter={formatNumber} />
              <Tooltip
                contentStyle={{ background: 'hsl(var(--background))', border: '1px solid hsl(var(--border))' }}
                formatter={(value, name) => {
                  const src = String(name).startsWith('bar_') ? String(name).replace('bar_', '') : String(name)
                  return [formatNumber(Number(value)), SOURCE_LABELS[src] ?? src]
                }}
              />
              {tokenSources.map(s => (
                <Bar key={s} dataKey={`bar_${s}`} name={`bar_${s}`} fill={SOURCE_COLORS[s]?.main ?? '#888'} radius={[4, 4, 0, 0]}
                  data={chartData.map(d => ({ ...d, [`bar_${s}`]: (d[`${s}_inputTokens`] as number || 0) + (d[`${s}_outputTokens`] as number || 0) }))}
                />
              ))}
              {invOnlySources.map(s => (
                <Bar key={s} dataKey={`bar_${s}`} name={`bar_${s}`} fill={SOURCE_COLORS[s]?.main ?? '#888'} radius={[4, 4, 0, 0]} strokeDasharray="5 5"
                  data={chartData.map(d => ({ ...d, [`bar_${s}`]: d[`${s}_requestCount`] as number || 0 }))}
                />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  )
})

// --- Summary comparison cards ---

interface SourceSummaryComparisonProps {
  data: SourceTrendPoint[]
}

export const SourceSummaryComparison = memo(function SourceSummaryComparison({ data }: SourceSummaryComparisonProps) {
  const sources = detectSources(data)
  if (sources.length === 0) return null

  const totals: Record<string, { tokens: number; cost: number; invocations: number }> = {}
  for (const s of sources) totals[s] = { tokens: 0, cost: 0, invocations: 0 }

  for (const d of data) {
    for (const s of sources) {
      totals[s].tokens += (d[`${s}_inputTokens`] as number || 0) + (d[`${s}_outputTokens`] as number || 0)
      totals[s].cost += (d[`${s}_cost`] as number || 0)
      totals[s].invocations += (d[`${s}_requestCount`] as number || 0)
    }
  }

  const metrics = [
    { label: 'Total Tokens', getValue: (s: string) => isInvocationOnly(data, s) ? '-' : formatNumber(totals[s].tokens) },
    { label: 'Total Cost', getValue: (s: string) => isInvocationOnly(data, s) ? '-' : `$${totals[s].cost.toFixed(2)}` },
    { label: 'Invocations', getValue: (s: string) => totals[s].invocations > 0 ? totals[s].invocations.toLocaleString() : '-' },
    { label: 'Avg Daily Tokens', getValue: (s: string) => isInvocationOnly(data, s) ? '-' : (data.length > 0 ? formatNumber(Math.round(totals[s].tokens / data.length)) : '0') },
    { label: 'Avg Daily Cost', getValue: (s: string) => isInvocationOnly(data, s) ? '-' : (data.length > 0 ? `$${(totals[s].cost / data.length).toFixed(2)}` : '$0.00') },
  ]

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Summary Comparison</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid gap-x-4 gap-y-3" style={{ gridTemplateColumns: `1fr repeat(${sources.length}, minmax(80px, 1fr))` }}>
          {/* Header row */}
          <div className="text-xs font-medium text-muted-foreground" />
          {sources.map(s => (
            <div key={s} className="text-xs font-medium text-center">
              <span className="inline-block w-2 h-2 rounded-full mr-1" style={{ backgroundColor: SOURCE_COLORS[s]?.main }} />
              {SOURCE_LABELS[s] ?? s}
            </div>
          ))}
          {/* Data rows */}
          {metrics.map(m => (
            <Fragment key={m.label}>
              <div className="text-sm text-muted-foreground">{m.label}</div>
              {sources.map(s => (
                <div key={s} className="text-sm font-mono text-center font-semibold" style={{ color: SOURCE_COLORS[s]?.main }}>
                  {m.getValue(s)}
                </div>
              ))}
            </Fragment>
          ))}
        </div>
      </CardContent>
    </Card>
  )
})
