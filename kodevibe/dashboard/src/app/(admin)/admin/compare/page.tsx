'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Search, X, Hash, Zap, Layers, User, Bot } from 'lucide-react'
import type { SessionCompareData } from '@/lib/session-compare'

export const dynamic = 'force-dynamic'

// ── Source badge (same palette as the sessions list) ────────────────────────
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
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${SOURCE_COLORS[source] ?? 'bg-gray-100 text-gray-800'}`}>
      {SOURCE_LABELS[source] ?? source}
    </span>
  )
}

function formatNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return n.toLocaleString()
}

interface SearchMatch {
  session_id: string
  source: string
  last_at: string
  prompts: number
}

// ── Session picker: type/search a session id, pick from results ─────────────
function SessionPicker({ onPick }: { onPick: (id: string) => void }) {
  const [q, setQ] = useState('')
  const [results, setResults] = useState<SearchMatch[]>([])
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const t = setTimeout(async () => {
      setLoading(true)
      try {
        const res = await fetch(`/api/admin/sessions/search?q=${encodeURIComponent(q)}`)
        const json = await res.json()
        setResults(json.results ?? [])
      } catch {
        setResults([])
      } finally {
        setLoading(false)
      }
    }, 250)
    return () => clearTimeout(t)
  }, [q])

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [])

  return (
    <div ref={boxRef} className="relative">
      <div className="flex items-center gap-2 rounded-lg border px-3 py-2">
        <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
        <input
          value={q}
          onChange={(e) => { setQ(e.target.value); setOpen(true) }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => { if (e.key === 'Enter' && q.trim()) { onPick(q.trim()); setOpen(false) } }}
          placeholder="세션 ID 입력 또는 검색…"
          className="w-full bg-transparent text-sm font-mono outline-none"
        />
        {q && (
          <button onClick={() => { setQ(''); setResults([]) }} className="text-muted-foreground hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
      {open && (results.length > 0 || loading) && (
        <div className="absolute z-20 mt-1 max-h-72 w-full overflow-auto rounded-lg border bg-popover shadow-md">
          {loading && <div className="px-3 py-2 text-xs text-muted-foreground">검색 중…</div>}
          {results.map((r) => (
            <button
              key={r.session_id}
              onClick={() => { onPick(r.session_id); setOpen(false); setQ(r.session_id) }}
              className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left hover:bg-muted"
            >
              <span className="truncate font-mono text-xs">{r.session_id}</span>
              <span className="flex shrink-0 items-center gap-2">
                <SourceBadge source={r.source} />
                <span className="text-[11px] text-muted-foreground">{r.prompts} turns</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ── One side of the comparison ──────────────────────────────────────────────
function SessionPanel({ side }: { side: 'left' | 'right' }) {
  const [sessionId, setSessionId] = useState('')
  const [data, setData] = useState<SessionCompareData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async (id: string) => {
    setSessionId(id)
    setData(null)
    setError('')
    setLoading(true)
    try {
      const res = await fetch(`/api/admin/sessions/${encodeURIComponent(id)}/compare`)
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        throw new Error(j.error || `HTTP ${res.status}`)
      }
      const json = await res.json()
      setData(json.data)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'load failed')
    } finally {
      setLoading(false)
    }
  }, [])

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <span className="text-xs font-semibold uppercase text-muted-foreground">{side === 'left' ? 'A' : 'B'}</span>
        <div className="flex-1"><SessionPicker onPick={load} /></div>
        {data && <SourceBadge source={data.source} />}
      </div>

      {loading && <div className="text-sm text-muted-foreground">불러오는 중…</div>}
      {error && <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

      {data && (
        <>
          {/* Totals */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <Hash className="h-4 w-4 text-muted-foreground" /> 전체 토큰
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-3 gap-3 text-center">
                <div>
                  <div className="text-xl font-bold">{formatNum(data.totalInput)}</div>
                  <div className="text-xs text-muted-foreground">Input</div>
                </div>
                <div>
                  <div className="text-xl font-bold">{formatNum(data.totalOutput)}</div>
                  <div className="text-xs text-muted-foreground">Output</div>
                </div>
                <div>
                  <div className="text-xl font-bold text-sky-600">{formatNum(data.totalCache)}</div>
                  <div className="text-xs text-muted-foreground">Cached</div>
                </div>
              </div>
              <div className="mt-3 flex justify-center gap-4 text-xs text-muted-foreground">
                <span>{data.apiCalls} API calls</span>
                <span>{data.turnCount} turns</span>
              </div>
            </CardContent>
          </Card>

          {/* Per-model */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <Layers className="h-4 w-4 text-muted-foreground" /> 모델별 토큰
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {data.byModel.length === 0 && <div className="text-xs text-muted-foreground">모델 정보 없음</div>}
              {data.byModel.map((m) => (
                <div key={m.model} className="flex items-center justify-between gap-2 text-xs">
                  <span className="truncate font-mono bg-muted px-1.5 py-0.5 rounded">{m.model}</span>
                  <span className="flex shrink-0 gap-3 text-muted-foreground">
                    <span>↑ {formatNum(m.input)}</span>
                    <span>↓ {formatNum(m.output)}</span>
                    {m.cache > 0 && <span className="text-sky-600">⚡ {formatNum(m.cache)}</span>}
                    <span>{m.count}×</span>
                  </span>
                </div>
              ))}
            </CardContent>
          </Card>

          {/* Turns: prompt + tokens */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <Zap className="h-4 w-4 text-muted-foreground" /> Prompt별 토큰
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {data.turns.map((t) => (
                <div key={t.index} className="rounded-lg border p-2">
                  <div className="flex items-start gap-2">
                    <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-blue-500 text-[10px] text-white">
                      <User className="h-3 w-3" />
                    </span>
                    <p className="flex-1 text-xs break-words whitespace-pre-wrap line-clamp-3">
                      {t.promptText || <span className="italic text-muted-foreground">({t.promptLength.toLocaleString()} chars, content not recorded)</span>}
                    </p>
                  </div>
                  <div className="mt-1 flex items-center gap-2 pl-7 text-[11px] text-muted-foreground">
                    <Bot className="h-3 w-3 text-emerald-500" />
                    {t.model && <span className="font-mono bg-muted px-1 rounded">{t.model}</span>}
                    <span>↑ {formatNum(t.inputTokens)}</span>
                    <span>↓ {formatNum(t.outputTokens)}</span>
                    {t.cacheReadTokens > 0 && <span className="text-sky-600">⚡ {formatNum(t.cacheReadTokens)}</span>}
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        </>
      )}

      {!data && !loading && !error && (
        <div className="rounded-lg border border-dashed py-12 text-center text-sm text-muted-foreground">
          세션을 선택하면 여기에 비교 내용이 표시됩니다
        </div>
      )}
    </div>
  )
}

export default function ComparePage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Compare</h1>
        <p className="text-sm text-muted-foreground">두 세션을 나란히 비교합니다 — source · 전체/모델별 토큰 · prompt별 토큰</p>
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <SessionPanel side="left" />
        <SessionPanel side="right" />
      </div>
    </div>
  )
}
