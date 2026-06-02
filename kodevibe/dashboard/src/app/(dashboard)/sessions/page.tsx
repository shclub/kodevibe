import { getUser } from '@/lib/session'
import {
  getSessionsToday,
  parseSourceParam,
  type SessionSummary,
} from '@/lib/clickhouse'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'
import { SourceFilter as SourceFilterComponent } from '@/components/dashboard/source-filter'
import { DateFilter } from '@/components/dashboard/date-filter'
import { ArrowLeft } from 'lucide-react'
import Link from 'next/link'
import TopDurationSessions from '@/components/dashboard/top-duration-sessions'

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

interface SessionsPageProps {
  searchParams: Promise<{ source?: string; from?: string; to?: string; viewUser?: string }>
}

export const dynamic = 'force-dynamic'

export default async function SessionsPage({ searchParams }: SessionsPageProps) {
  const user = await getUser()
  const params = await searchParams
  const source = parseSourceParam(params.source ?? null)
  const from = params.from
  const to = params.to
  const viewUser = params.viewUser

  // If viewUser is provided (from leaderboard click), query that user's sessions
  const queryEmail = viewUser ? '' : (user.email ?? '')
  const queryUserId = viewUser || user.id

  let sessions: SessionSummary[] = []

  try {
    sessions = await getSessionsToday(queryEmail, queryUserId, source, from, to)
  } catch (error) {
    console.error('Failed to fetch sessions:', error)
  }

  const showSourceColumn = source === 'all'
  const dateLabel = from && to ? `${from} ~ ${to}` : 'today'

  const viewUserParam = viewUser ? `&viewUser=${encodeURIComponent(viewUser)}` : ''

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <div>
          {viewUser && (
            <Link href="/leaderboard"
              className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground mb-2 transition-colors">
              <ArrowLeft className="h-4 w-4" />Back to Leaderboard
            </Link>
          )}
          <h1 className="text-3xl font-bold">Sessions</h1>
          <p className="text-muted-foreground">
            {viewUser ? `Sessions for user (${dateLabel})` : `Browse your coding sessions (${dateLabel})`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <DateFilter from={from} to={to} />
          <SourceFilterComponent useSearchParams />
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Sessions</CardTitle>
          <CardDescription>
            {sessions.length} session{sessions.length !== 1 ? 's' : ''} recorded
          </CardDescription>
        </CardHeader>
        <CardContent>
          {sessions.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              No sessions recorded for this period. Start using Claude Code or OpenCode to see your sessions here.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Session ID</TableHead>
                  <TableHead>User</TableHead>
                  {showSourceColumn && <TableHead>Source</TableHead>}
                  <TableHead>Started</TableHead>
                  <TableHead>Status</TableHead>
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
                        {viewUser ? viewUser.slice(0, 12) + '…' : (user.email ?? '')}
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
                        {session.is_closed ? (
                          <Badge variant="secondary" className="text-xs">Closed</Badge>
                        ) : (
                          <Badge className="text-xs bg-green-500">Running</Badge>
                        )}
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

      <TopDurationSessions />
    </div>
  )
}
