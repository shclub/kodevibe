import dynamic from 'next/dynamic'
import Link from 'next/link'
import { getUser } from '@/lib/session'
import {
  getUserFrustrationSummary,
  getUserFrustrationDaily,
  getUserFrustrationSessions,
  getUserFrustratingPrompts,
  type FrustrationSession,
  type FrustratingPrompt,
} from '@/lib/prompt-analytics'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'
import { ArrowLeft, Frown, TrendingDown, AlertTriangle, Activity } from 'lucide-react'
import { StatsCard } from '@/components/dashboard/stats-card'

const FrustrationChart = dynamic(
  () => import('./frustration-chart').then(m => ({ default: m.FrustrationChart })),
  { loading: () => <div className="h-[260px] bg-muted animate-pulse rounded-lg" /> }
)

const FRUSTRATION_LABELS: Record<number, { label: string; color: string }> = {
  1.0: { label: '높음', color: 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300' },
  0.8: { label: '중간', color: 'bg-orange-100 text-orange-700 dark:bg-orange-900 dark:text-orange-300' },
  0.6: { label: '보통', color: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-300' },
  0.4: { label: '낮음', color: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300' },
}

function frustrationLabel(weight: number) {
  const rounded = [1.0, 0.8, 0.6, 0.4].find(v => Math.abs(weight - v) < 0.05) ?? 0.4
  return FRUSTRATION_LABELS[rounded] ?? FRUSTRATION_LABELS[0.4]
}

function densityBar(density: number) {
  const pct = Math.min(Math.round(density * 100), 100)
  const color =
    pct >= 60 ? 'bg-red-500' :
    pct >= 30 ? 'bg-orange-400' :
    pct >= 10 ? 'bg-yellow-400' :
    'bg-emerald-400'
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-24 rounded-full bg-muted overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs tabular-nums">{pct}%</span>
    </div>
  )
}

function formatDate(d: string) {
  return new Date(d).toLocaleDateString('ko-KR', { month: 'short', day: 'numeric', timeZone: 'Asia/Seoul' })
}

function formatTime(ts: string) {
  return new Date(ts).toLocaleString('ko-KR', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Seoul',
  })
}

function truncate(text: string, max = 80) {
  return text.length > max ? text.slice(0, max) + '…' : text
}

export default async function FrustrationPage() {
  const user = await getUser()
  const userId = user.id

  let summary = { total_score: 0, avg_density: 0, high_frustration_sessions: 0, total_sessions: 0 }
  let daily: Awaited<ReturnType<typeof getUserFrustrationDaily>> = []
  let sessions: FrustrationSession[] = []
  let frustratingPrompts: FrustratingPrompt[] = []

  try {
    ;[summary, daily, sessions, frustratingPrompts] = await Promise.all([
      getUserFrustrationSummary(userId, 30),
      getUserFrustrationDaily(userId, 30),
      getUserFrustrationSessions(userId, 15),
      getUserFrustratingPrompts(userId, 20),
    ])
  } catch (err) {
    console.error('Failed to fetch frustration data:', err)
  }

  const noData = summary.total_sessions === 0

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Link
          href="/prompts"
          className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          Prompts
        </Link>
        <div className="flex-1">
          <h1 className="text-3xl font-bold">Frustration Analysis</h1>
          <p className="text-muted-foreground">
            재시도·부정 표현 패턴으로 감지한 사용자 좌절 신호 (최근 30일)
          </p>
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4 stagger-children">
        <StatsCard
          title="총 좌절 점수"
          value={summary.total_score.toFixed(1)}
          icon={Frown}
          description="높을수록 재시도가 많음"
        />
        <StatsCard
          title="평균 밀도"
          value={`${(summary.avg_density * 100).toFixed(1)}%`}
          icon={TrendingDown}
          description="세션당 좌절 비율"
        />
        <StatsCard
          title="고좌절 세션"
          value={summary.high_frustration_sessions}
          icon={AlertTriangle}
          description="점수 ≥ 1.0 세션"
        />
        <StatsCard
          title="분석된 세션"
          value={summary.total_sessions}
          icon={Activity}
          description="프롬프트가 있는 세션"
        />
      </div>

      {/* Chart */}
      <Card>
        <CardHeader>
          <CardTitle>일별 좌절 점수</CardTitle>
          <CardDescription>최근 30일 동안의 좌절 신호 추이</CardDescription>
        </CardHeader>
        <CardContent>
          {noData ? (
            <div className="h-[260px] flex items-center justify-center text-muted-foreground text-sm">
              데이터가 없습니다. Prompt Logger 훅을 활성화해주세요.
            </div>
          ) : (
            <FrustrationChart data={daily} />
          )}
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* High frustration sessions */}
        <Card>
          <CardHeader>
            <CardTitle>고좌절 세션</CardTitle>
            <CardDescription>좌절 점수가 높은 세션 (최근 30일)</CardDescription>
          </CardHeader>
          <CardContent>
            {sessions.length === 0 ? (
              <p className="text-center py-8 text-muted-foreground text-sm">좌절 신호가 감지된 세션이 없습니다.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>날짜</TableHead>
                    <TableHead>세션 ID</TableHead>
                    <TableHead>점수</TableHead>
                    <TableHead>밀도</TableHead>
                    <TableHead className="text-right">요청</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sessions.map((s) => (
                    <TableRow key={s.session_id}>
                      <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                        {formatDate(s.date)}
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {s.session_id.slice(0, 8)}…
                      </TableCell>
                      <TableCell>
                        <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                          s.frustration_score >= 2 ? 'bg-red-100 text-red-700' :
                          s.frustration_score >= 1 ? 'bg-orange-100 text-orange-700' :
                          'bg-yellow-100 text-yellow-700'
                        }`}>
                          {s.frustration_score.toFixed(1)}
                        </span>
                      </TableCell>
                      <TableCell>{densityBar(s.frustration_density)}</TableCell>
                      <TableCell className="text-right font-mono text-xs">{s.total_requests}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        {/* Frustrating prompts */}
        <Card>
          <CardHeader>
            <CardTitle>좌절 프롬프트</CardTitle>
            <CardDescription>재시도·부정 표현이 감지된 프롬프트 (최근 30일)</CardDescription>
          </CardHeader>
          <CardContent>
            {frustratingPrompts.length === 0 ? (
              <p className="text-center py-8 text-muted-foreground text-sm">좌절 프롬프트가 없습니다.</p>
            ) : (
              <div className="space-y-3">
                {frustratingPrompts.map((p) => {
                  const fl = frustrationLabel(p.frustration_weight)
                  return (
                    <div
                      key={p.prompt_id}
                      className="flex items-start gap-3 rounded-lg border p-3"
                    >
                      <Badge variant="secondary" className={`mt-0.5 shrink-0 text-xs ${fl.color}`}>
                        {fl.label}
                      </Badge>
                      <div className="min-w-0">
                        <p className="text-sm font-mono leading-snug text-foreground">
                          {truncate(p.prompt_text)}
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {formatTime(p.timestamp)}
                          {p.project_path && (
                            <> · {p.project_path.split('/').pop()}</>
                          )}
                        </p>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
