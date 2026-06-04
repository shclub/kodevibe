import { getSession } from '@/lib/session'
import { getSessionDetails, type SessionEvent } from '@/lib/clickhouse'
import { createServerClient } from '@/lib/supabase'
import { callAiConfig, getProvider, extractStreamText, type AiConfiguration } from '@/lib/ai-config'

const DEFAULT_SYSTEM_PROMPT = `You are an AI efficiency consultant specializing in token optimization for Claude Code sessions.
Analyze the session metrics and provide specific, actionable recommendations in Korean.

Structure your response with these sections:
## 📊 세션 요약
Brief summary of overall token usage and cost.

## ⚡ 캐시 효율 분석
Cache hit rate analysis and recommendations.

## 📈 토큰 사용 패턴
Turn-by-turn token growth patterns. Flag any turns with unusually large context growth.

## 🛠️ Tool 사용 최적화
Analyze tool call patterns and suggest improvements.

## 💡 최적화 제안
3-5 specific, prioritized recommendations with expected savings.

## 📝 프롬프트 품질 (if prompt samples provided)
Specific improvements to prompt wording.

Keep each section concise. Use specific numbers from the data.`

async function getSystemPrompt(db: ReturnType<typeof createServerClient>): Promise<string> {
  const { data } = await db
    .from('zeude_settings')
    .select('value')
    .eq('key', 'ai_analysis_system_prompt')
    .limit(1)
  const value = (Array.isArray(data) && data.length > 0) ? (data[0] as { value: string }).value : ''
  return value.trim() || DEFAULT_SYSTEM_PROMPT
}

function isApiRequest(name: string) {
  return name === 'claude_code.api_request' || name === 'api_request'
}
function isUserPrompt(name: string) {
  return name === 'claude_code.user_prompt'
}
function isToolDecision(name: string) {
  return name === 'claude_code.tool_decision'
}
function isCompaction(name: string) {
  return name === 'claude_code.compaction'
}

function buildSessionSummary(events: SessionEvent[]): string {
  const apiEvents = events.filter(e => isApiRequest(e.event_name))
  const promptEvents = events.filter(e => isUserPrompt(e.event_name))
  const compactionCount = events.filter(e => isCompaction(e.event_name)).length

  const totalInput = apiEvents.reduce((s, e) => s + Number(e.input_tokens), 0)
  const totalOutput = apiEvents.reduce((s, e) => s + Number(e.output_tokens), 0)
  const totalCache = apiEvents.reduce((s, e) => s + Number(e.cache_read_tokens), 0)
  const totalCacheCreation = apiEvents.reduce((s, e) => s + Number(e.cache_creation_tokens), 0)
  const totalCost = apiEvents.reduce((s, e) => s + Number(e.cost_usd), 0)
  const cacheHitRate = totalInput > 0 ? ((totalCache / (totalInput + totalCache)) * 100).toFixed(1) : '0'

  const startedAt = events[0].timestamp
  const endedAt = events[events.length - 1].timestamp
  const durationMs = new Date(endedAt).getTime() - new Date(startedAt).getTime()
  const durationMin = (durationMs / 60000).toFixed(1)

  // Model breakdown
  const byModel: Record<string, { input: number; output: number; cache: number; cost: number; count: number }> = {}
  for (const e of apiEvents) {
    if (!e.model) continue
    if (!byModel[e.model]) byModel[e.model] = { input: 0, output: 0, cache: 0, cost: 0, count: 0 }
    byModel[e.model].input += Number(e.input_tokens)
    byModel[e.model].output += Number(e.output_tokens)
    byModel[e.model].cache += Number(e.cache_read_tokens)
    byModel[e.model].cost += Number(e.cost_usd)
    byModel[e.model].count++
  }

  // Turn-by-turn breakdown
  const turnMap = new Map<string, {
    index: number
    timestamp: string
    input: number
    output: number
    cache: number
    cost: number
    tools: string[]
    promptText: string
    commandName: string
  }>()
  let turnCounter = 0

  for (const ev of events) {
    if (!ev.prompt_id) continue
    if (!turnMap.has(ev.prompt_id)) {
      turnMap.set(ev.prompt_id, {
        index: ++turnCounter,
        timestamp: ev.timestamp,
        input: 0, output: 0, cache: 0, cost: 0,
        tools: [], promptText: '', commandName: '',
      })
    }
    const t = turnMap.get(ev.prompt_id)!
    if (isUserPrompt(ev.event_name)) {
      if (ev.command_name) t.commandName = ev.command_name
      if (ev.attributes?.prompt && ev.attributes.prompt !== '<REDACTED>') {
        t.promptText = ev.attributes.prompt
      }
    } else if (isApiRequest(ev.event_name)) {
      t.input += Number(ev.input_tokens)
      t.output += Number(ev.output_tokens)
      t.cache += Number(ev.cache_read_tokens)
      t.cost += Number(ev.cost_usd)
      if (!t.promptText && ev.attributes?.prompt && ev.attributes.prompt !== '<REDACTED>') {
        t.promptText = ev.attributes.prompt
      }
    } else if (isToolDecision(ev.event_name) && ev.tool_name) {
      if (!t.tools.includes(ev.tool_name)) t.tools.push(ev.tool_name)
    }
  }

  const turns = [...turnMap.values()].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  )

  const hasPromptText = turns.some(t => t.promptText)

  let summary = `Session Analysis Data
=====================
Duration: ${durationMin} minutes
Total Turns: ${turns.length}
Total API Calls: ${apiEvents.length}
Total Cost: $${totalCost.toFixed(4)}
Compactions: ${compactionCount}

Token Summary:
- Input Tokens: ${totalInput.toLocaleString()}
- Output Tokens: ${totalOutput.toLocaleString()}
- Cache Read Tokens: ${totalCache.toLocaleString()} (${cacheHitRate}% hit rate)
- Cache Creation Tokens: ${totalCacheCreation.toLocaleString()}

Model Usage:
${Object.entries(byModel).map(([model, s]) =>
  `- ${model}: ${s.count} calls, ${s.input.toLocaleString()} in, ${s.output.toLocaleString()} out, $${s.cost.toFixed(4)}`
).join('\n') || '- (no model data)'}

Turn-by-Turn Breakdown:
${turns.map(t => {
  const toolStr = t.tools.length ? ` [${t.tools.join(', ')}]` : ''
  const cmdStr = t.commandName ? ` /${t.commandName}` : ''
  const promptStr = t.promptText ? `\n    Prompt: "${t.promptText.slice(0, 120)}${t.promptText.length > 120 ? '...' : ''}"` : ''
  return `Turn ${t.index}${cmdStr}: in=${t.input.toLocaleString()} out=${t.output.toLocaleString()} cache=${t.cache.toLocaleString()} cost=$${t.cost.toFixed(4)}${toolStr}${promptStr}`
}).join('\n')}
`

  if (hasPromptText) {
    summary += `\nNote: Actual prompt text is available for some turns (shown above). Please analyze prompt quality as well.`
  } else {
    summary += `\nNote: Prompt content is redacted (Claude Code privacy). Analysis is based on token metrics only.`
  }

  return summary
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const session = await getSession()
  if (!session) return Response.json({ error: 'Not authenticated' }, { status: 401 })

  const [{ sessionId }, body] = await Promise.all([params, req.json().catch(() => ({}))])

  // Resolve AI configuration
  const db = createServerClient()
  let aiConfig: AiConfiguration | null = null

  if (body.configId) {
    const { data } = await db.from('ai_configurations').select('*').eq('id', body.configId).single()
    aiConfig = (data as AiConfiguration) ?? null
  }

  if (!aiConfig) {
    // Fall back to default config
    const { data } = await db
      .from('ai_configurations')
      .select('*')
      .eq('is_default', true)
      .limit(1)
    aiConfig = (Array.isArray(data) && data.length > 0) ? (data[0] as AiConfiguration) : null
  }

  if (!aiConfig) {
    // Fall back to first config
    const { data } = await db
      .from('ai_configurations')
      .select('*')
      .order('created_at')
      .limit(1)
    aiConfig = (Array.isArray(data) && data.length > 0) ? (data[0] as AiConfiguration) : null
  }

  if (!aiConfig || !aiConfig.api_key) {
    return Response.json(
      { error: 'Admin > Settings에서 AI Configuration을 먼저 설정하세요.' },
      { status: 503 }
    )
  }

  const viewUser: string | undefined = body.viewUser
  const queryEmail = viewUser ? '' : (session.user.email ?? '')
  const queryUserId = viewUser || session.user.id

  let events: SessionEvent[]
  try {
    events = await getSessionDetails(queryEmail, queryUserId, sessionId)
  } catch {
    return Response.json({ error: 'Failed to fetch session data' }, { status: 500 })
  }

  if (!events.length) return Response.json({ error: 'Session not found' }, { status: 404 })

  const [summaryText, systemPrompt] = [buildSessionSummary(events), await getSystemPrompt(db)]
  const providerFormat = getProvider(aiConfig.provider)?.apiFormat ?? 'openai'

  const upstreamRes = await callAiConfig(
    aiConfig,
    [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: summaryText },
    ],
    { maxTokens: 1500, temperature: 0.4, stream: true }
  )

  if (!upstreamRes.ok) {
    const err = await upstreamRes.text()
    return Response.json({ error: `AI API error (${aiConfig.provider}): ${err.slice(0, 300)}` }, { status: 502 })
  }

  const decoder = new TextDecoder()
  const encoder = new TextEncoder()

  const stream = new ReadableStream({
    async start(controller) {
      const reader = upstreamRes.body!.getReader()
      let buffer = ''
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''
          for (const line of lines) {
            const text = extractStreamText(line, providerFormat)
            if (text) controller.enqueue(encoder.encode(text))
          }
        }
      } finally {
        controller.close()
      }
    },
  })

  return new Response(stream, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
}
