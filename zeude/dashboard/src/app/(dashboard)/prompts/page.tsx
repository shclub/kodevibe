import Link from 'next/link'
import { getUser } from '@/lib/session'
import {
  getUserPrompts,
  getUserPromptStats,
  getUserPromptTypeStats,
  searchPrompts,
  type PromptRecord,
} from '@/lib/prompt-analytics'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'
import { MessageSquare, Hash, FolderOpen, Layers, AlertTriangle } from 'lucide-react'
import { StatsCard } from '@/components/dashboard/stats-card'
import { PromptSearchBar } from './prompt-search-bar'

const PROMPT_TYPE_COLORS: Record<string, string> = {
  natural:  'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
  skill:    'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300',
  command:  'bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300',
  agent:    'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300',
  mcp_tool: 'bg-orange-100 text-orange-700 dark:bg-orange-900 dark:text-orange-300',
}

const PROMPT_TYPE_LABELS: Record<string, string> = {
  natural:  'Natural',
  skill:    'Skill',
  command:  'Command',
  agent:    'Agent',
  mcp_tool: 'MCP Tool',
}

function formatTime(ts: string) {
  return new Date(ts).toLocaleString('ko-KR', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Seoul',
  })
}

function truncate(text: string, max: number = 90) {
  return text.length > max ? text.slice(0, max) + '…' : text
}

function basename(path: string) {
  return path.split('/').filter(Boolean).pop() ?? path
}

interface PromptsPageProps {
  searchParams: Promise<{ q?: string }>
}

export default async function PromptsPage({ searchParams }: PromptsPageProps) {
  const user = await getUser()
  const params = await searchParams
  const keyword = (params.q ?? '').trim()

  const identifier = { userId: user.id, userEmail: user.email }

  let prompts: PromptRecord[] = []
  let stats = { total_prompts: 0, avg_length: 0, unique_sessions: 0, top_projects: [] as { project: string; count: number }[] }
  let typeStats: { prompt_type: string; count: number; percentage: number }[] = []

  try {
    const [p, s, t] = await Promise.all([
      keyword
        ? searchPrompts(identifier, keyword, 50)
        : getUserPrompts(identifier, 50),
      getUserPromptStats(identifier, 30),
      getUserPromptTypeStats(identifier, 30),
    ])
    prompts = p
    stats = s
    typeStats = t
  } catch (err) {
    console.error('Failed to fetch prompts:', err)
  }

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Prompts</h1>
          <p className="text-muted-foreground">
            Your recent prompts — last 30 days
          </p>
        </div>
        <Link
          href="/prompts/frustration"
          className="flex items-center gap-2 rounded-lg border px-4 py-2 text-sm text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
        >
          <AlertTriangle className="h-4 w-4 text-yellow-500" />
          Frustration Analysis
        </Link>
      </div>

      {/* Stats cards */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4 stagger-children">
        <StatsCard
          title="Total Prompts"
          value={Number(stats.total_prompts)}
          icon={MessageSquare}
          description="Last 30 days"
        />
        <StatsCard
          title="Avg Length"
          value={`${Math.round(Number(stats.avg_length))} chars`}
          icon={Hash}
          description="Characters per prompt"
        />
        <StatsCard
          title="Sessions"
          value={Number(stats.unique_sessions)}
          icon={Layers}
          description="Unique sessions"
        />
        <StatsCard
          title="Top Project"
          value={stats.top_projects[0] ? basename(stats.top_projects[0].project) : '—'}
          icon={FolderOpen}
          description={stats.top_projects[0] ? `${stats.top_projects[0].count} prompts` : 'No data yet'}
        />
      </div>

      {/* Prompt type distribution */}
      {typeStats.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {typeStats.map(t => (
            <span
              key={t.prompt_type}
              className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium ${PROMPT_TYPE_COLORS[t.prompt_type] ?? PROMPT_TYPE_COLORS.natural}`}
            >
              {PROMPT_TYPE_LABELS[t.prompt_type] ?? t.prompt_type}
              <span className="opacity-70">{t.count} ({t.percentage}%)</span>
            </span>
          ))}
        </div>
      )}

      {/* Search + List */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-4">
            <div>
              <CardTitle>{keyword ? `Search: "${keyword}"` : 'Recent Prompts'}</CardTitle>
              <CardDescription>
                {keyword
                  ? `${prompts.length} result${prompts.length !== 1 ? 's' : ''} found`
                  : `Showing latest ${prompts.length} prompts`}
              </CardDescription>
            </div>
            <PromptSearchBar defaultValue={keyword} />
          </div>
        </CardHeader>
        <CardContent>
          {prompts.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              {keyword
                ? 'No prompts match your search.'
                : 'No prompts yet. Enable the Prompt Logger hook to start collecting prompts.'}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-36">Time</TableHead>
                  <TableHead>Prompt</TableHead>
                  <TableHead className="w-28">Type</TableHead>
                  <TableHead className="w-20 text-right">Length</TableHead>
                  <TableHead className="w-36">Project</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {prompts.map((p) => (
                  <TableRow key={p.prompt_id}>
                    <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                      {formatTime(p.timestamp)}
                    </TableCell>
                    <TableCell className="max-w-sm">
                      <span className="text-sm font-mono leading-relaxed">
                        {truncate(p.prompt_text)}
                      </span>
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant="secondary"
                        className={`text-xs ${PROMPT_TYPE_COLORS[p.prompt_type ?? 'natural'] ?? ''}`}
                      >
                        {PROMPT_TYPE_LABELS[p.prompt_type ?? 'natural'] ?? 'Natural'}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs text-muted-foreground">
                      {Number(p.prompt_length).toLocaleString()}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground truncate max-w-[9rem]">
                      {p.project_path ? basename(p.project_path) : '—'}
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
