'use client'

import { useState, useRef, useEffect } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Sparkles, ChevronDown, ChevronUp, AlertCircle, Settings, Download } from 'lucide-react'
import type { AiConfigPublic } from '@/lib/ai-config'
import Link from 'next/link'

interface SessionAiAnalysisProps {
  sessionId: string
  viewUser?: string
}

export function SessionAiAnalysis({ sessionId, viewUser }: SessionAiAnalysisProps) {
  const [configs, setConfigs] = useState<AiConfigPublic[]>([])
  const [selectedId, setSelectedId] = useState<string>('')
  const [state, setState] = useState<'idle' | 'loading' | 'done' | 'error'>('idle')
  const [text, setText] = useState('')
  const [collapsed, setCollapsed] = useState(false)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    fetch('/api/ai-configs')
      .then(r => r.ok ? r.json() : [])
      .then((list: AiConfigPublic[]) => {
        setConfigs(list)
        const def = list.find(c => c.is_default) ?? list[0]
        if (def) setSelectedId(def.id)
      })
      .catch(() => {})

    // Load any previously-saved analysis for this session
    fetch(`/api/sessions/${sessionId}/analysis`)
      .then(r => r.ok ? r.json() : null)
      .then((row: { content?: string } | null) => {
        if (row?.content) {
          setText(row.content)
          setState('done')
          setCollapsed(false)  // show saved analysis expanded
        }
      })
      .catch(() => {})
  }, [sessionId])

  async function analyze() {
    setState('loading')
    setText('')
    setCollapsed(false)

    abortRef.current = new AbortController()

    try {
      const res = await fetch(`/api/sessions/${sessionId}/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ viewUser, configId: selectedId || undefined }),
        signal: abortRef.current.signal,
      })

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Unknown error' }))
        setText(err.error || 'Analysis failed')
        setState('error')
        return
      }

      const reader = res.body!.getReader()
      const decoder = new TextDecoder()
      setState('done')

      let full = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        const chunk = decoder.decode(value, { stream: true })
        full += chunk
        setText(prev => prev + chunk)
      }

      // Persist (overwrite) the completed analysis
      if (full.trim()) {
        const model = configs.find(c => c.id === selectedId)?.model
        fetch(`/api/sessions/${sessionId}/analysis`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: full, model }),
        }).catch(() => {})
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') return
      setText('분석 중 오류가 발생했습니다.')
      setState('error')
    }
  }

  function download() {
    const blob = new Blob([text], { type: 'text/markdown; charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `ai-analysis-${sessionId.slice(0, 8)}.md`
    a.click()
    URL.revokeObjectURL(url)
  }

  function cancel() {
    abortRef.current?.abort()
    setState('idle')
    setText('')
  }

  const selectedConfig = configs.find(c => c.id === selectedId)
  const hasConfigs = configs.length > 0

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <CardTitle className="text-base flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-violet-500" />
            AI 토큰 최적화 분석
          </CardTitle>

          <div className="flex items-center gap-2">
            {/* Config selector */}
            {hasConfigs && configs.length > 1 && state === 'idle' && (
              <select
                value={selectedId}
                onChange={e => setSelectedId(e.target.value)}
                className="h-8 rounded-md border border-input bg-background px-2 text-xs shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                {configs.map(c => (
                  <option key={c.id} value={c.id}>
                    {c.name} ({c.provider})
                  </option>
                ))}
              </select>
            )}
            {hasConfigs && configs.length === 1 && state === 'idle' && selectedConfig && (
              <span className="text-xs text-muted-foreground bg-muted px-2 py-1 rounded">
                {selectedConfig.name}
              </span>
            )}

            {/* Action buttons */}
            {state === 'idle' && (
              hasConfigs ? (
                <button
                  onClick={analyze}
                  className="inline-flex items-center gap-1.5 rounded-md bg-violet-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-violet-700 transition-colors"
                >
                  <Sparkles className="h-3 w-3" />
                  분석 시작
                </button>
              ) : (
                <Link
                  href="/admin/settings"
                  className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  <Settings className="h-3 w-3" />
                  AI 설정
                </Link>
              )
            )}
            {state === 'loading' && (
              <button
                onClick={cancel}
                className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
              >
                취소
              </button>
            )}
            {(state === 'done' || state === 'error') && (
              <>
                {state === 'done' && text && (
                  <button
                    onClick={download}
                    className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
                    title="Markdown으로 다운로드"
                  >
                    <Download className="h-3 w-3" />MD
                  </button>
                )}
                <button
                  onClick={analyze}
                  className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
                >
                  재분석
                </button>
                <button
                  onClick={() => setCollapsed(c => !c)}
                  className="p-1 text-muted-foreground hover:text-foreground transition-colors"
                >
                  {collapsed ? <ChevronDown className="h-4 w-4" /> : <ChevronUp className="h-4 w-4" />}
                </button>
              </>
            )}
          </div>
        </div>
      </CardHeader>

      {state !== 'idle' && !collapsed && (
        <CardContent>
          {state === 'loading' && !text && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
              <span className="animate-pulse">●</span>
              <span className="animate-pulse" style={{ animationDelay: '0.2s' }}>●</span>
              <span className="animate-pulse" style={{ animationDelay: '0.4s' }}>●</span>
              <span className="ml-1">세션 데이터 분석 중...</span>
            </div>
          )}
          {state === 'error' && (
            <div className="flex items-start gap-2 text-sm text-red-600 rounded-md bg-red-50 border border-red-200 p-3">
              <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
              <span>{text}</span>
            </div>
          )}
          {(state === 'done' || (state === 'loading' && text)) && (
            <MarkdownResult text={text} streaming={state === 'loading'} />
          )}
        </CardContent>
      )}
    </Card>
  )
}

function MarkdownResult({ text, streaming }: { text: string; streaming: boolean }) {
  const lines = text.split('\n')
  return (
    <div className="text-sm space-y-1 leading-relaxed">
      {lines.map((line, i) => {
        if (line.startsWith('## ')) {
          return <h3 key={i} className="font-semibold text-sm mt-4 mb-1 first:mt-0">{line.slice(3)}</h3>
        }
        if (line.startsWith('### ')) {
          return <h4 key={i} className="font-medium text-xs mt-3 mb-0.5 text-muted-foreground uppercase tracking-wide">{line.slice(4)}</h4>
        }
        if (line.startsWith('- ') || line.startsWith('* ')) {
          return (
            <div key={i} className="flex gap-2 pl-2">
              <span className="text-muted-foreground shrink-0">·</span>
              <InlineMarkdown text={line.slice(2)} />
            </div>
          )
        }
        if (/^\d+\./.test(line)) {
          return (
            <div key={i} className="flex gap-2 pl-2">
              <span className="text-muted-foreground shrink-0 font-mono text-xs">{line.match(/^\d+/)?.[0]}.</span>
              <InlineMarkdown text={line.replace(/^\d+\.\s*/, '')} />
            </div>
          )
        }
        if (!line.trim()) return <div key={i} className="h-1" />
        return <p key={i}><InlineMarkdown text={line} /></p>
      })}
      {streaming && (
        <span className="inline-block w-1.5 h-3.5 bg-violet-500 animate-pulse rounded-sm ml-0.5" />
      )}
    </div>
  )
}

function InlineMarkdown({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/)
  return (
    <>
      {parts.map((part, i) => {
        if (part.startsWith('**') && part.endsWith('**')) {
          return <strong key={i}>{part.slice(2, -2)}</strong>
        }
        if (part.startsWith('`') && part.endsWith('`')) {
          return <code key={i} className="bg-muted px-1 py-0.5 rounded text-xs font-mono">{part.slice(1, -1)}</code>
        }
        return <span key={i}>{part}</span>
      })}
    </>
  )
}
