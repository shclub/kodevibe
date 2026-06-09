// Server-side data shaping for the admin Compare screen. Reuses
// getSessionDetails and groups raw OTel events into turns + token totals,
// mirroring the logic of the session detail page.
import { getSessionDetails, getSessionSource, type SessionEvent } from './clickhouse'

// ── Event name helpers (must match session detail page) ─────────────────────
function isUserPromptEvent(n: string) {
  return n === 'claude_code.user_prompt' || n === 'copilot.user_prompt'
}
function isApiRequestEvent(n: string) {
  return n === 'claude_code.api_request' || n === 'api_request' || n === 'copilot.chat_request'
}
const NOISE_EVENTS = new Set([
  'claude_code.hook_execution_start', 'claude_code.hook_execution_complete',
  'claude_code.hook_registered', 'claude_code.plugin_loaded',
  'claude_code.mcp_server_connection', 'llm runtime selected',
  'loop', 'exiting loop', 'bootstrapping', 'creating instance',
  'claude_code.tool_result',
])

export interface CompareTurn {
  index: number
  promptText: string // available for opencode/copilot, empty (redacted) for claude
  promptLength: number
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  timestamp: string
}

export interface CompareModelStat {
  model: string
  input: number
  output: number
  cache: number
  count: number
}

export interface SessionCompareData {
  sessionId: string
  source: string
  startedAt: string
  endedAt: string
  totalInput: number
  totalOutput: number
  totalCache: number
  apiCalls: number
  turnCount: number
  byModel: CompareModelStat[]
  turns: CompareTurn[]
}

// Build the comparison payload for one session. Returns null when the session
// has no usable events (unknown id or noise-only).
export async function getSessionCompareData(sessionId: string): Promise<SessionCompareData | null> {
  const events = await getSessionDetails('', '', sessionId, true) // admin: no user filter
  if (!events.length) return null

  const source = await getSessionSource(sessionId)
  // Codex/Copilot report input_tokens including cache_read; subtract it to get
  // the real input (Claude already reports them separately).
  const cacheInclusive = source === 'copilot' || source === 'codex'

  // Group events into turns keyed by prompt_id, same as the detail page.
  const turnMap = new Map<string, CompareTurn & { _ts: number }>()
  let turnCounter = 0
  const byModel = new Map<string, CompareModelStat>()
  let totalInput = 0
  let totalOutput = 0
  let totalCache = 0
  let apiCalls = 0
  let startedAt = events[0].timestamp
  let endedAt = events[0].timestamp

  for (const ev of events) {
    if (NOISE_EVENTS.has(ev.event_name)) continue
    if (ev.timestamp < startedAt) startedAt = ev.timestamp
    if (ev.timestamp > endedAt) endedAt = ev.timestamp
    if (!ev.prompt_id) continue

    if (!turnMap.has(ev.prompt_id)) {
      turnMap.set(ev.prompt_id, {
        index: ++turnCounter,
        promptText: '',
        promptLength: 0,
        model: '',
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        timestamp: ev.timestamp,
        _ts: new Date(ev.timestamp).getTime(),
      })
    }
    const turn = turnMap.get(ev.prompt_id)!

    if (isUserPromptEvent(ev.event_name)) {
      turn.promptLength = Number(ev.prompt_length) || turn.promptLength
      turn.timestamp = ev.timestamp
      turn._ts = new Date(ev.timestamp).getTime()
      if (ev.attributes?.prompt && ev.attributes.prompt !== '<REDACTED>') {
        turn.promptText = ev.attributes.prompt
      }
    } else if (isApiRequestEvent(ev.event_name)) {
      apiCalls++
      if (!turn.promptText && ev.attributes?.prompt && ev.attributes.prompt !== '<REDACTED>') {
        turn.promptText = ev.attributes.prompt
      }
      if (Number(ev.prompt_length) > 0 && turn.promptLength === 0) {
        turn.promptLength = Number(ev.prompt_length)
      }
      const cache = Number(ev.cache_read_tokens)
      const input = cacheInclusive ? Math.max(0, Number(ev.input_tokens) - cache) : Number(ev.input_tokens)
      const output = Number(ev.output_tokens)
      turn.inputTokens += input
      turn.outputTokens += output
      turn.cacheReadTokens += cache
      if (!turn.model && ev.model) turn.model = ev.model
      totalInput += input
      totalOutput += output
      totalCache += cache
      if (ev.model) {
        const m = byModel.get(ev.model) ?? { model: ev.model, input: 0, output: 0, cache: 0, count: 0 }
        m.input += input
        m.output += output
        m.cache += cache
        m.count++
        byModel.set(ev.model, m)
      }
    }
  }

  const turns: CompareTurn[] = [...turnMap.values()]
    .sort((a, b) => a._ts - b._ts)
    .map((t, i) => ({
      index: i + 1,
      promptText: t.promptText,
      promptLength: t.promptLength,
      model: t.model,
      inputTokens: t.inputTokens,
      outputTokens: t.outputTokens,
      cacheReadTokens: t.cacheReadTokens,
      timestamp: t.timestamp,
    }))

  return {
    sessionId,
    source,
    startedAt,
    endedAt,
    totalInput,
    totalOutput,
    totalCache,
    apiCalls,
    turnCount: turns.length,
    byModel: [...byModel.values()].sort((a, b) => b.input + b.output - (a.input + a.output)),
    turns,
  }
}
