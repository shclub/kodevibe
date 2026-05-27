import { getUser } from '@/lib/session'
import {
  getSessionsToday,
  getDailyInvocations,
  parseSourceParam,
  isInvocationOnlySource,
  type DailyInvocation,
} from '@/lib/clickhouse'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'
import { SourceFilter as SourceFilterComponent } from '@/components/dashboard/source-filter'
import Link from 'next/link'

const SOURCE_COLORS: Record<string, string> = {
  claude: 'bg-blue-100 text-blue-800',
  codex: 'bg-emerald-100 text-emerald-800',
  opencode: 'bg-orange-100 text-orange-800',
  copilot: 'bg-purple-100 text-purple-800',
}
const SOURCE_LABELS: Record<string, string> = {
  claude: 'Claude',
  codex: 'Codex',
  opencode: 'OpenCode',
  copilot: 'Copilot',
}

function SourceBadge({ source }: { source: string }) {
  const colors = SOURCE_COLORS[source] ?? 'bg-gray-100 text-gray-800'
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${colors}`}>
      {SOURCE_LABELS[source] ?? source}
    </span>
  )
}

function formatDuration(startedAt: string, endedAt: string): string {
  const start = new Date(startedAt)
  const end = new Date(endedAt)
  const durationMs = end.getTime() - start.getTime()

  if (durationMs < 60000) {
    return `${Math.round(durationMs / 1000)}s`
  } else if (durationMs < 3600000) {
    return `${Math.round(durationMs / 60000)}m`
  } else {
    const hours = Math.floor(durationMs / 3600000)
    const mins = Math.round((durationMs % 3600000) / 60000)
    return `${hours}h ${mins}m`
  }
}

function formatTime(timestamp: string): string {
  return new Date(timestamp).toLocaleTimeString('ko-KR', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZone: 'Asia/Seoul',
  })
}

function formatDate(date: string): string {
  return new Date(date).toLocaleDateString('ko-KR', {
    month: 'short',
    day: 'numeric',
    timeZone: 'Asia/Seoul',
  })
}

interface SessionsPageProps {
  searchParams: Promise<{ source?: string }>
}

export default async function SessionsPage({ searchParams }: SessionsPageProps) {
  const user = await getUser()
  const userEmail = user.email ?? ''
  const params = await searchParams
  const source = parseSourceParam(params.source ?? null)
  const isInvocationOnly = isInvocationOnlySource(source)

  // ── Invocation-only sources (copilot, opencode) ──────────────────────────
  if (isInvocationOnly) {
    let invocations: DailyInvocation[] = []
    try {
      invocations = await getDailyInvocations(user.email, user.id, 30, source)
    } catch (error) {
      console.error('Failed to fetch invocations:', error)
    }

    const totalInvocations = invocations.reduce((s, r) => s + Number(r.invocation_count), 0)
    const toolLabel = source === 'copilot' ? 'GitHub Copilot' : 'OpenCode'

    // Group by date + model
    const grouped = invocations.reduce<Record<string, { models: Set<string>; count: number }>>((acc, r) => {
      if (!acc[r.date]) acc[r.date] = { models: new Set(), count: 0 }
      acc[r.date].count += Number(r.invocation_count)
      if (r.model_id) acc[r.date].models.add(r.model_id)
      return acc
    }, {})
    const rows = Object.entries(grouped).sort(([a], [b]) => b.localeCompare(a))

    return (
      <div className="space-y-8">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold">Sessions</h1>
            <p className="text-muted-foreground">{toolLabel} — last 30 days</p>
          </div>
          <SourceFilterComponent useSearchParams />
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">Total Invocations (30d)</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{totalInvocations}</div>
              <p className="text-xs text-muted-foreground mt-1">Cost &amp; tokens not tracked</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">Active Days</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{rows.length}</div>
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>{toolLabel} Invocations</CardTitle>
            <CardDescription>Daily breakdown for the last 30 days</CardDescription>
          </CardHeader>
          <CardContent>
            {rows.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                No invocations yet. Start using {toolLabel} to see data here.
              </div>
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
                  {rows.map(([date, row]) => (
                    <TableRow key={date}>
                      <TableCell className="font-medium">{formatDate(date)}</TableCell>
                      <TableCell>{row.count}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {[...row.models].map(m => (
                          <Badge key={m} variant="outline" className="mr-1 font-mono text-xs">{m}</Badge>
                        ))}
                        {row.models.size === 0 && '—'}
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

  // ── Token-based sources (claude, codex, all) ─────────────────────────────
  let sessions: Awaited<ReturnType<typeof getSessionsToday>> = []

  try {
    sessions = await getSessionsToday(user.email, user.id, source)
  } catch (error) {
    console.error('Failed to fetch sessions:', error)
  }

  const showSourceColumn = source === 'all'

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Sessions</h1>
          <p className="text-muted-foreground">Browse your coding sessions</p>
        </div>
        <SourceFilterComponent useSearchParams />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Today&apos;s Sessions</CardTitle>
          <CardDescription>
            {sessions.length} session{sessions.length !== 1 ? 's' : ''} recorded today
          </CardDescription>
        </CardHeader>
        <CardContent>
          {sessions.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              No sessions recorded today. Start using Claude Code or OpenCode to see your sessions here.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Session ID</TableHead>
                  <TableHead>User</TableHead>
                  {showSourceColumn && <TableHead>Source</TableHead>}
                  <TableHead>Started</TableHead>
                  <TableHead>Duration</TableHead>
                  <TableHead>Events</TableHead>
                  <TableHead>Input Tokens</TableHead>
                  <TableHead>Output Tokens</TableHead>
                  <TableHead>Premium Req</TableHead>
                  <TableHead className="text-right">Cost</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sessions.map((session) => {
                  const href = `/sessions/${session.session_id}${source !== 'all' ? `?source=${source}` : ''}`
                  return (
                    <TableRow key={session.session_id} className="cursor-pointer hover:bg-muted/50">
                      <TableCell className="font-mono text-xs">
                        <Link href={href} className="hover:underline text-blue-600">
                          {session.session_id.slice(0, 8)}…
                        </Link>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {userEmail}
                      </TableCell>
                      {showSourceColumn && (
                        <TableCell>
                          <SourceBadge source={session.source} />
                        </TableCell>
                      )}
                      <TableCell>
                        <Link href={href} className="block">
                          {formatTime(session.started_at)}
                        </Link>
                      </TableCell>
                      <TableCell>
                        <Badge variant="secondary">
                          {formatDuration(session.started_at, session.ended_at)}
                        </Badge>
                      </TableCell>
                      <TableCell>{Number(session.event_count)}</TableCell>
                      <TableCell>{Number(session.input_tokens).toLocaleString()}</TableCell>
                      <TableCell>{Number(session.output_tokens).toLocaleString()}</TableCell>
                      <TableCell>{Number(session.premium_requests) > 0 ? Number(session.premium_requests) : '—'}</TableCell>
                      <TableCell className="text-right font-mono">
                        ${Number(session.total_cost || 0).toFixed(4)}
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
