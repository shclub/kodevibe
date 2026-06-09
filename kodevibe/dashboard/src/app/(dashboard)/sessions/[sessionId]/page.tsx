import { getUser } from '@/lib/session'
import { getSessionDetails, getSessionSource, type SessionEvent } from '@/lib/clickhouse'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { ArrowLeft, Clock, DollarSign, Hash, Zap, User, Bot, Wrench, Terminal } from 'lucide-react'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { SessionAiAnalysis } from '@/components/session-ai-analysis'

interface SessionDetailPageProps {
  params: Promise<{ sessionId: string }>
  searchParams: Promise<{ source?: string; viewUser?: string }>
}

// ── Formatting helpers ──────────────────────────────────────────────────────

function formatTime(ts: string) {
  return new Date(ts).toLocaleTimeString('ko-KR', {
    hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'Asia/Seoul',
  })
}

function formatDateTime(ts: string) {
  return new Date(ts).toLocaleString('ko-KR', {
    month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    timeZone: 'Asia/Seoul',
  })
}

function formatDuration(a: string, b: string) {
  const ms = new Date(b).getTime() - new Date(a).getTime()
  if (ms < 60000) return `${Math.round(ms / 1000)}s`
  if (ms < 3600000) return `${Math.round(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`
  return `${Math.floor(ms / 3600000)}h ${Math.round((ms % 3600000) / 60000)}m`
}

function formatMs(ms: number) {
  if (!ms) return ''
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}

function formatNum(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return n.toLocaleString()
}

// Copilot/Codex report input_tokens including cache_read; subtract it to get the
// real (non-cached) input — Claude already reports them separately.
function realInput(ev: SessionEvent, cacheInclusive: boolean): number {
  const input = Number(ev.input_tokens)
  return cacheInclusive ? Math.max(0, input - Number(ev.cache_read_tokens)) : input
}

// ── Event name helpers (support both prefixed and bare names) ───────────────

function isUserPromptEvent(name: string)  { return name === 'claude_code.user_prompt' || name === 'copilot.user_prompt' }
function isApiRequestEvent(name: string)  { return name === 'claude_code.api_request' || name === 'api_request' || name === 'copilot.chat_request' }
function isToolDecisionEvent(name: string){ return name === 'claude_code.tool_decision' }
function isCompactionEvent(name: string)  { return name === 'claude_code.compaction' }

const NOISE_EVENTS = new Set([
  'claude_code.hook_execution_start', 'claude_code.hook_execution_complete',
  'claude_code.hook_registered', 'claude_code.plugin_loaded',
  'claude_code.mcp_server_connection', 'llm runtime selected',
  'loop', 'exiting loop', 'bootstrapping', 'creating instance',
  'claude_code.tool_result',
])

// ── Turn grouping ───────────────────────────────────────────────────────────

interface Turn {
  promptId: string
  turnIndex: number
  promptLength: number
  promptText: string       // actual text (available for opencode, REDACTED for claude)
  promptTimestamp: string
  commandName: string
  apiRequests: SessionEvent[]
  toolDecisions: SessionEvent[]
}

interface SessionStructure {
  turns: Turn[]
  hasNoTurns: boolean
}

function groupIntoTurns(events: SessionEvent[]): SessionStructure {
  const turnMap = new Map<string, Turn>()
  let turnCounter = 0

  for (const ev of events) {
    if (NOISE_EVENTS.has(ev.event_name)) continue
    if (!ev.prompt_id) continue

    if (!turnMap.has(ev.prompt_id)) {
      turnMap.set(ev.prompt_id, {
        promptId: ev.prompt_id,
        turnIndex: ++turnCounter,
        promptLength: 0,
        promptText: '',
        promptTimestamp: ev.timestamp,
        commandName: '',
        apiRequests: [],
        toolDecisions: [],
      })
    }
    const turn = turnMap.get(ev.prompt_id)!

    if (isUserPromptEvent(ev.event_name)) {
      turn.promptLength = Number(ev.prompt_length)
      turn.promptTimestamp = ev.timestamp
      if (ev.command_name) turn.commandName = ev.command_name
      // prompt text from attributes (available for opencode)
      if (ev.attributes?.prompt && ev.attributes.prompt !== '<REDACTED>') {
        turn.promptText = ev.attributes.prompt
      }
    } else if (isApiRequestEvent(ev.event_name)) {
      // opencode sends prompt in api_request attributes
      if (!turn.promptText && ev.attributes?.prompt && ev.attributes.prompt !== '<REDACTED>') {
        turn.promptText = ev.attributes.prompt
      }
      if (Number(ev.prompt_length) > 0 && turn.promptLength === 0) {
        turn.promptLength = Number(ev.prompt_length)
      }
      turn.apiRequests.push(ev)
    } else if (isToolDecisionEvent(ev.event_name)) {
      turn.toolDecisions.push(ev)
    }
  }

  const turns = [...turnMap.values()].sort(
    (a, b) => new Date(a.promptTimestamp).getTime() - new Date(b.promptTimestamp).getTime()
  )
  return { turns, hasNoTurns: turns.length === 0 }
}

// ── Components ──────────────────────────────────────────────────────────────

function SummaryCards({ events, startedAt, endedAt, cacheInclusive }: {
  events: SessionEvent[], startedAt: string, endedAt: string, cacheInclusive: boolean
}) {
  const apiEvents = events.filter(e => isApiRequestEvent(e.event_name))
  const totalCost = apiEvents.reduce((s, e) => s + Number(e.cost_usd), 0)
  const totalInput = apiEvents.reduce((s, e) => s + realInput(e, cacheInclusive), 0)
  const totalOutput = apiEvents.reduce((s, e) => s + Number(e.output_tokens), 0)
  const totalCache = apiEvents.reduce((s, e) => s + Number(e.cache_read_tokens), 0)
  const userTurns = events.filter(e => isUserPromptEvent(e.event_name) || (isApiRequestEvent(e.event_name) && e.prompt_id)).length

  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
      {[
        { icon: Clock, title: 'Duration', value: formatDuration(startedAt, endedAt),
          sub: `${apiEvents.length} API calls` },
        { icon: DollarSign, title: 'Total Cost', value: `$${totalCost.toFixed(4)}`, sub: 'API usage cost' },
        { icon: Hash, title: 'Input Tokens', value: formatNum(totalInput),
          sub: totalCache > 0 ? `+${formatNum(totalCache)} cached` : 'Prompts & context' },
        { icon: Zap, title: 'Output Tokens', value: formatNum(totalOutput), sub: 'Generated responses' },
      ].map(({ icon: Icon, title, value, sub }) => (
        <Card key={title}>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Icon className="h-4 w-4 text-muted-foreground" />{title}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{value}</div>
            <p className="text-xs text-muted-foreground mt-1">{sub}</p>
          </CardContent>
        </Card>
      ))}
    </div>
  )
}

function ModelBreakdown({ events, cacheInclusive }: { events: SessionEvent[], cacheInclusive: boolean }) {
  const byModel: Record<string, { input: number; output: number; cache: number; cost: number; count: number }> = {}
  for (const e of events.filter(e => isApiRequestEvent(e.event_name))) {
    if (!e.model) continue
    if (!byModel[e.model]) byModel[e.model] = { input: 0, output: 0, cache: 0, cost: 0, count: 0 }
    byModel[e.model].input += realInput(e, cacheInclusive)
    byModel[e.model].output += Number(e.output_tokens)
    byModel[e.model].cache += Number(e.cache_read_tokens)
    byModel[e.model].cost += Number(e.cost_usd)
    byModel[e.model].count++
  }
  const models = Object.entries(byModel)
  if (!models.length) return null

  return (
    <Card>
      <CardHeader className="pb-3"><CardTitle className="text-base">Model Usage</CardTitle></CardHeader>
      <CardContent>
        <div className="space-y-3">
          {models.map(([model, s]) => (
            <div key={model} className="flex items-center justify-between text-sm">
              <div className="flex items-center gap-2">
                <span className="font-mono text-xs bg-muted px-1.5 py-0.5 rounded">{model}</span>
                <span className="text-muted-foreground text-xs">{s.count}×</span>
              </div>
              <div className="flex gap-4 text-xs text-muted-foreground">
                <span>↑ {formatNum(s.input)}</span>
                <span>↓ {formatNum(s.output)}</span>
                <span className="font-mono font-medium text-foreground">${s.cost.toFixed(4)}</span>
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}

function CommandSummary({ turns }: { turns: Turn[] }) {
  const commands = turns.filter(t => t.commandName)
  if (!commands.length) return null

  const counts: Record<string, number> = {}
  for (const t of commands) {
    const name = t.commandName
    counts[name] = (counts[name] || 0) + 1
  }
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1])

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Terminal className="h-4 w-4 text-muted-foreground" />
          Commands Used
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap gap-2">
          {sorted.map(([name, count]) => (
            <Badge key={name} variant="outline" className="font-mono text-xs">
              /{name}{count > 1 ? ` ×${count}` : ''}
            </Badge>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}

const TOOL_COLORS: Record<string, string> = {
  Bash: 'bg-amber-100 text-amber-800 border-amber-200',
  Read: 'bg-sky-100 text-sky-800 border-sky-200',
  Write: 'bg-green-100 text-green-800 border-green-200',
  Edit: 'bg-green-100 text-green-800 border-green-200',
  WebSearch: 'bg-violet-100 text-violet-800 border-violet-200',
  WebFetch: 'bg-violet-100 text-violet-800 border-violet-200',
  Agent: 'bg-pink-100 text-pink-800 border-pink-200',
}

const QUERY_SOURCE_LABEL: Record<string, string> = {
  repl_main_thread: 'main', away_summary: 'away', background: 'bg',
}

function TurnCard({ turn, cacheInclusive }: { turn: Turn, cacheInclusive: boolean }) {
  const totalCost = turn.apiRequests.reduce((s, e) => s + Number(e.cost_usd), 0)
  const totalOutput = turn.apiRequests.reduce((s, e) => s + Number(e.output_tokens), 0)

  return (
    <div className="rounded-xl border bg-card overflow-hidden">
      {/* User prompt row */}
      <div className="flex items-start gap-3 px-4 py-3 bg-muted/40 border-b">
        <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-blue-500 text-white">
          <User className="h-3.5 w-3.5" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold">Turn {turn.turnIndex}</span>
            {turn.commandName && (
              <Badge variant="outline" className="font-mono text-xs">/{turn.commandName}</Badge>
            )}
            <span className="text-xs text-muted-foreground">{formatTime(turn.promptTimestamp)}</span>
          </div>
          {/* Show actual prompt text if available, otherwise show length */}
          {turn.promptText ? (
            <p className="text-sm mt-1 text-foreground/80 break-words whitespace-pre-wrap line-clamp-4">
              {turn.promptText}
            </p>
          ) : turn.promptLength > 0 ? (
            <p className="text-xs text-muted-foreground mt-0.5 italic">
              Prompt · {turn.promptLength.toLocaleString()} chars (content not recorded)
            </p>
          ) : null}
        </div>
        {totalCost > 0 && (
          <span className="shrink-0 font-mono text-xs text-muted-foreground pt-1">
            ${totalCost.toFixed(4)}
          </span>
        )}
      </div>

      {/* API request rows */}
      {turn.apiRequests.map((req, i) => (
        <div key={i} className="flex items-start gap-3 px-4 py-2.5 border-b last-of-type:border-0 hover:bg-muted/20">
          <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-emerald-500 text-white">
            <Bot className="h-3.5 w-3.5" />
          </div>
          <div className="flex-1 min-w-0 space-y-1">
            <div className="flex items-center gap-2 flex-wrap text-xs">
              {req.model && (
                <span className="font-mono bg-muted px-1.5 py-0.5 rounded">{req.model}</span>
              )}
              {req.query_source && (
                <span className="text-muted-foreground">
                  {QUERY_SOURCE_LABEL[req.query_source] ?? req.query_source}
                </span>
              )}
              {Number(req.duration_ms) > 0 && (
                <span className="text-muted-foreground">{formatMs(Number(req.duration_ms))}</span>
              )}
            </div>
            <div className="flex gap-3 text-xs text-muted-foreground flex-wrap">
              {realInput(req, cacheInclusive) > 0 && <span>↑ {formatNum(realInput(req, cacheInclusive))} in</span>}
              {Number(req.output_tokens) > 0 && <span>↓ {formatNum(Number(req.output_tokens))} out</span>}
              {Number(req.cache_read_tokens) > 0 && (
                <span className="text-sky-600">⚡ {formatNum(Number(req.cache_read_tokens))} cached</span>
              )}
              {Number(req.cache_creation_tokens) > 0 && (
                <span className="text-amber-600">💾 {formatNum(Number(req.cache_creation_tokens))} stored</span>
              )}
            </div>
            {/* Assistant response text (available for opencode/copilot) */}
            {req.attributes?.response && (
              <p className="text-sm text-foreground/80 break-words whitespace-pre-wrap line-clamp-6 pt-0.5">
                {req.attributes.response}
              </p>
            )}
          </div>
          {Number(req.cost_usd) > 0 && (
            <span className="shrink-0 font-mono text-xs text-muted-foreground">
              ${Number(req.cost_usd).toFixed(4)}
            </span>
          )}
        </div>
      ))}

      {/* Tool calls row */}
      {turn.toolDecisions.length > 0 && (
        <div className="flex items-center gap-2 px-4 py-2 border-t flex-wrap bg-muted/10">
          <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-amber-500 text-white">
            <Wrench className="h-3 w-3" />
          </div>
          <div className="flex gap-1.5 flex-wrap">
            {turn.toolDecisions.map((tc, i) => {
              const colors = TOOL_COLORS[tc.tool_name] ?? 'bg-gray-100 text-gray-700 border-gray-200'
              const rejected = tc.tool_decision === 'reject'
              return (
                <span key={i}
                  className={`inline-flex items-center rounded border px-1.5 py-0.5 text-xs font-medium ${colors}
                    ${rejected ? 'opacity-50 line-through' : ''}`}>
                  {tc.tool_name || '?'}
                </span>
              )
            })}
          </div>
          <span className="text-xs text-muted-foreground ml-auto">
            {turn.toolDecisions.length} tool calls
          </span>
        </div>
      )}
    </div>
  )
}

/** Flat event list — fallback for sessions with no prompt.id grouping (old format, opencode pre-shim) */
function FlatEventList({ events, cacheInclusive }: { events: SessionEvent[], cacheInclusive: boolean }) {
  // Priority: api_request, user_prompt, session_start, compaction first
  // Fallback: show all non-empty events (e.g. opencode internal events) so the page is never blank
  const priority = events.filter(e =>
    !NOISE_EVENTS.has(e.event_name) &&
    (isApiRequestEvent(e.event_name) || isUserPromptEvent(e.event_name) ||
     e.event_name === 'session_start' || isCompactionEvent(e.event_name))
  )
  const interesting = priority.length > 0
    ? priority
    : events.filter(e => !NOISE_EVENTS.has(e.event_name))

  if (!interesting.length) return (
    <Card>
      <CardContent className="py-8 text-center text-muted-foreground text-sm">
        No events recorded for this session.
        <p className="mt-1 text-xs">Run opencode with the latest shim to record conversation data.</p>
      </CardContent>
    </Card>
  )

  return (
    <Card>
      <CardHeader className="pb-3"><CardTitle className="text-base">Events</CardTitle></CardHeader>
      <CardContent className="p-0">
        <div className="divide-y">
          {interesting.map((ev, i) => (
            <div key={i} className="flex gap-4 px-5 py-2.5 hover:bg-muted/20">
              <span className="w-20 shrink-0 text-xs font-mono text-muted-foreground pt-0.5">
                {formatTime(ev.timestamp)}
              </span>
              <div className="flex-1 space-y-0.5">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium">{ev.event_name}</span>
                  {ev.model && <span className="font-mono text-xs bg-muted px-1 rounded">{ev.model}</span>}
                </div>
                {(realInput(ev, cacheInclusive) > 0 || Number(ev.output_tokens) > 0) && (
                  <div className="text-xs text-muted-foreground flex gap-2">
                    <span>↑ {formatNum(realInput(ev, cacheInclusive))}</span>
                    <span>↓ {formatNum(Number(ev.output_tokens))}</span>
                  </div>
                )}
              </div>
              {Number(ev.cost_usd) > 0 && (
                <span className="font-mono text-xs text-muted-foreground">
                  ${Number(ev.cost_usd).toFixed(4)}
                </span>
              )}
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}

// ── Page ────────────────────────────────────────────────────────────────────

export default async function SessionDetailPage({ params, searchParams }: SessionDetailPageProps) {
  const user = await getUser()
  const { sessionId } = await params
  const sp = await searchParams
  const viewUser = sp.viewUser

  const backParams: string[] = []
  if (sp.source) backParams.push(`source=${sp.source}`)
  if (viewUser) backParams.push(`viewUser=${encodeURIComponent(viewUser)}`)
  const backQuery = backParams.length ? `?${backParams.join('&')}` : ''

  const isAdmin = user.role === 'admin'
  const queryEmail = viewUser ? '' : (user.email ?? '')
  const queryUserId = viewUser || user.id

  let events: SessionEvent[] = []
  try {
    events = await getSessionDetails(queryEmail, queryUserId, sessionId, isAdmin)
  } catch (err) {
    console.error('Failed to fetch session details:', err)
  }

  if (!events.length) notFound()

  const startedAt = events[0].timestamp
  const endedAt = events[events.length - 1].timestamp
  const { turns, hasNoTurns } = groupIntoTurns(events)
  const compactionCount = events.filter(e => isCompactionEvent(e.event_name)).length

  // Copilot/Codex report input including cache_read; flag so the UI shows real input.
  const source = await getSessionSource(sessionId)
  const cacheInclusive = source === 'copilot' || source === 'codex'

  // Actual session owner (not the logged-in viewer) from event attributes
  const sessionEmail =
    events.find(e => e.attributes?.['user.email'])?.attributes['user.email'] ||
    (viewUser ? viewUser : (user.email ?? ''))

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <Link href={`/sessions${backQuery}`}
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground mb-4 transition-colors">
          <ArrowLeft className="h-4 w-4" />Back to Sessions
        </Link>
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-3xl font-bold">Session Detail</h1>
            <div className="flex items-center gap-3 mt-1 text-muted-foreground flex-wrap">
              <span className="font-mono text-sm">{sessionId}</span>
              <span className="inline-flex items-center gap-1 rounded-full border border-blue-200 bg-blue-50 px-2.5 py-0.5 text-xs font-medium text-blue-700">
                <User className="h-3 w-3" />
                {sessionEmail}
              </span>
              <span className="text-xs">{formatDateTime(startedAt)} → {formatTime(endedAt)}</span>
            </div>
          </div>
          <div className="flex gap-2 mt-1">
            {!hasNoTurns && <Badge variant="outline" className="text-xs">{turns.length} turns</Badge>}
            <Badge variant="outline" className="text-xs">{events.length} events</Badge>
          </div>
        </div>
      </div>

      <SummaryCards events={events} startedAt={startedAt} endedAt={endedAt} cacheInclusive={cacheInclusive} />
      <ModelBreakdown events={events} cacheInclusive={cacheInclusive} />
      {!hasNoTurns && <CommandSummary turns={turns} />}
      <SessionAiAnalysis sessionId={sessionId} viewUser={viewUser} />

      {compactionCount > 0 && (
        <div className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-800">
          ⚡ Context compacted {compactionCount} time{compactionCount > 1 ? 's' : ''} during this session
        </div>
      )}

      {hasNoTurns ? (
        // Fallback for sessions without prompt.id (old format or opencode pre-shim)
        <FlatEventList events={events} cacheInclusive={cacheInclusive} />
      ) : (
        <div className="space-y-3">
          <h2 className="text-lg font-semibold">Conversation Turns</h2>
          {turns.map(turn => <TurnCard key={turn.promptId} turn={turn} cacheInclusive={cacheInclusive} />)}
        </div>
      )}
    </div>
  )
}
