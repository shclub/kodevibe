'use client'

import { useState, useEffect, useCallback } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'
import { Clock, RefreshCw, Trophy } from 'lucide-react'
import Link from 'next/link'

const SOURCE_COLORS: Record<string, string> = {
  claude: 'bg-blue-100 text-blue-800',
  codex: 'bg-emerald-100 text-emerald-800',
  opencode: 'bg-orange-100 text-orange-800',
  copilot: 'bg-purple-100 text-purple-800',
}

interface TopSession {
  session_id: string
  user_email: string
  source: string
  started_at: string
  ended_at: string
  duration_seconds: number
  event_count: number
  input_tokens: number
  output_tokens: number
  total_cost: number
  is_closed: number
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  return `${h}h ${m}m`
}

function formatNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return n.toLocaleString()
}

function kstDate(d: Date): string {
  return new Date(d.getTime() + 9 * 3600000).toISOString().slice(0, 10)
}

function getRankStyle(rank: number) {
  if (rank === 1) return 'text-yellow-500'
  if (rank === 2) return 'text-gray-400'
  if (rank === 3) return 'text-amber-600'
  return 'text-muted-foreground'
}

export default function TopDurationSessions() {
  const today = kstDate(new Date())
  const weekAgo = kstDate(new Date(Date.now() - 7 * 86400000))

  const [from, setFrom] = useState(weekAgo)
  const [to, setTo] = useState(today)
  const [data, setData] = useState<TopSession[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch(`/api/sessions/top-duration?from=${from}&to=${to}`)
      if (res.ok) {
        const json = await res.json()
        setData(json)
      }
    } catch {
      // ignore
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [from, to])

  useEffect(() => { fetchData() }, [fetchData])

  const handleRefresh = () => {
    setRefreshing(true)
    fetchData()
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg flex items-center gap-2">
            <Trophy className="h-5 w-5 text-yellow-500" />
            Top 10 Sessions by Duration ( {from} ~ {to} )
          </CardTitle>
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1.5 border rounded-lg px-2 py-1">
              <label className="text-xs text-muted-foreground">From</label>
              <input type="date" value={from} onChange={e => setFrom(e.target.value)}
                className="text-sm bg-transparent border-none outline-none w-[120px]" />
            </div>
            <span className="text-muted-foreground">~</span>
            <div className="flex items-center gap-1.5 border rounded-lg px-2 py-1">
              <label className="text-xs text-muted-foreground">To</label>
              <input type="date" value={to} onChange={e => setTo(e.target.value)}
                className="text-sm bg-transparent border-none outline-none w-[120px]" />
            </div>
            <button onClick={handleRefresh}
              className="flex items-center gap-1.5 px-2.5 py-1.5 text-sm rounded-lg border hover:bg-muted transition-colors">
              <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="space-y-2">
            {[...Array(5)].map((_, i) => (
              <div key={i} className="h-12 bg-muted animate-pulse rounded-lg" />
            ))}
          </div>
        ) : data.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            No sessions found for this period.
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10 text-center">#</TableHead>
                <TableHead className="w-24">Session</TableHead>
                <TableHead>User</TableHead>
                <TableHead>Source</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Duration</TableHead>
                <TableHead className="text-right">Total Tokens</TableHead>
                <TableHead className="text-right">Input Tokens</TableHead>
                <TableHead className="text-right">Output Tokens</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((s, i) => {
                const rank = i + 1
                return (
                  <TableRow key={s.session_id} className="cursor-pointer hover:bg-muted/50">
                    <TableCell className={`text-center font-bold ${getRankStyle(rank)}`}>
                      {rank}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      <Link href={`/sessions/${s.session_id}`} className="hover:underline text-blue-600">
                        {s.session_id.slice(0, 8)}
                      </Link>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground truncate max-w-[100px]" title={s.user_email}>
                      {s.user_email ? s.user_email.split('@')[0] : '—'}
                    </TableCell>
                    <TableCell>
                      <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${SOURCE_COLORS[s.source] ?? 'bg-gray-100 text-gray-800'}`}>
                        {s.source}
                      </span>
                    </TableCell>
                    <TableCell>
                      {s.is_closed ? (
                        <Badge variant="secondary" className="text-xs">Closed</Badge>
                      ) : (
                        <Badge className="text-xs bg-green-500">Running</Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary" className="font-mono">
                        <Clock className="h-3 w-3 mr-1" />
                        {formatDuration(s.duration_seconds)}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs">
                      {formatNum(Number(s.input_tokens) + Number(s.output_tokens))}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs">
                      {formatNum(s.input_tokens)}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs">
                      {formatNum(s.output_tokens)}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  )
}
