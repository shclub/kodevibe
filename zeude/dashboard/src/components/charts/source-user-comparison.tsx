'use client'

import { useState, memo } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'
import type { UserSourceUsage } from '@/lib/source-types'

const SOURCE_COLORS: Record<string, string> = {
  claude: '#3b82f6', codex: '#10b981', copilot: '#8b5cf6', opencode: '#f97316',
}
const SOURCE_LABELS: Record<string, string> = {
  claude: 'Claude Code', codex: 'Codex', copilot: 'Copilot', opencode: 'OpenCode',
}

function formatNumber(num: number): string {
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}M`
  if (num >= 1_000) return `${(num / 1_000).toFixed(1)}K`
  if (num % 1 !== 0) return num.toFixed(1)
  return num.toString()
}

function formatCurrency(num: number): string {
  return `$${num.toFixed(2)}`
}

// Detect which sources have data
function detectSources(data: UserSourceUsage[]): string[] {
  const sources = new Set<string>()
  for (const u of data) {
    for (const key of Object.keys(u)) {
      if (key.endsWith('_inputTokens') && (u[key] as number) > 0) {
        sources.add(key.replace('_inputTokens', ''))
      }
    }
  }
  return [...sources].sort()
}

type SortField = 'userName' | 'total' | 'cost' | string

export const SourceUserComparison = memo(function SourceUserComparison({ data }: SourceUserComparisonProps) {
  const sources = detectSources(data)
  const [sortField, setSortField] = useState<SortField>('total')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')

  function getSourceTotal(u: UserSourceUsage, s: string): number {
    return ((u[`${s}_inputTokens`] as number) || 0) + ((u[`${s}_outputTokens`] as number) || 0)
  }
  function getTotal(u: UserSourceUsage): number {
    return sources.reduce((sum, s) => sum + getSourceTotal(u, s), 0)
  }
  function getTotalCost(u: UserSourceUsage): number {
    return sources.reduce((sum, s) => sum + ((u[`${s}_cost`] as number) || 0), 0)
  }

  function toggleSort(field: SortField) {
    if (sortField === field) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    } else {
      setSortField(field)
      setSortDir('desc')
    }
  }

  const sorted = [...data].sort((a, b) => {
    let aVal: number | string, bVal: number | string
    if (sortField === 'userName') {
      aVal = a.userName; bVal = b.userName
      return sortDir === 'asc' ? (aVal as string).localeCompare(bVal as string) : (bVal as string).localeCompare(aVal as string)
    }
    if (sortField === 'total') {
      aVal = getTotal(a); bVal = getTotal(b)
    } else if (sortField === 'cost') {
      aVal = getTotalCost(a); bVal = getTotalCost(b)
    } else {
      aVal = getSourceTotal(a, sortField); bVal = getSourceTotal(b, sortField)
    }
    return sortDir === 'asc' ? (aVal as number) - (bVal as number) : (bVal as number) - (aVal as number)
  })

  const activeUsers = sorted.filter(u => getTotal(u) > 0)
  const multiUsers = activeUsers.filter(u => sources.filter(s => getSourceTotal(u, s) > 0).length > 1)

  function SortHeader({ field, children }: { field: SortField; children: React.ReactNode }) {
    const isActive = sortField === field
    return (
      <TableHead className="cursor-pointer hover:bg-muted/50 select-none text-center" onClick={() => toggleSort(field)}>
        <div className="flex items-center justify-center gap-1">
          {children}
          {isActive && <span className="text-xs">{sortDir === 'asc' ? '↑' : '↓'}</span>}
        </div>
      </TableHead>
    )
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-lg">Per-User Source Comparison</CardTitle>
            <p className="text-sm text-muted-foreground">
              Side-by-side view of each developer&apos;s usage across {sources.map(s => SOURCE_LABELS[s]).join(', ')}
            </p>
          </div>
          {multiUsers.length > 0 && (
            <Badge variant="outline" className="text-xs">
              {multiUsers.length} multi-tool {multiUsers.length === 1 ? 'user' : 'users'}
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {activeUsers.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">No comparison data available</div>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <SortHeader field="userName">User</SortHeader>
                  {sources.map(s => (
                    <TableHead key={s} colSpan={3} className="text-center border-l" style={{ backgroundColor: `${SOURCE_COLORS[s]}10` }}>
                      <span className="inline-block w-2 h-2 rounded-full mr-1" style={{ backgroundColor: SOURCE_COLORS[s] }} />
                      {SOURCE_LABELS[s]}
                    </TableHead>
                  ))}
                  <SortHeader field="cost">Total Cost</SortHeader>
                </TableRow>
                <TableRow>
                  <TableHead />
                  {sources.map(s => (
                    <Fragment key={s}>
                      <SortHeader field={s}>Tokens</SortHeader>
                      <TableHead className="text-center text-xs">Reqs</TableHead>
                      <TableHead className="text-center text-xs">Cost</TableHead>
                    </Fragment>
                  ))}
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {activeUsers.slice(0, 20).map(user => {
                  const isMulti = sources.filter(s => getSourceTotal(user, s) > 0).length > 1
                  return (
                    <TableRow key={user.userId} className={isMulti ? 'bg-purple-500/5' : ''}>
                      <TableCell className="font-medium max-w-[150px] truncate" title={user.userName}>
                        <div className="flex items-center gap-1.5">
                          {isMulti && <span className="inline-block w-1.5 h-1.5 rounded-full bg-purple-500" title="Uses multiple tools" />}
                          {user.userName.length > 16 ? `${user.userName.slice(0, 16)}...` : user.userName}
                        </div>
                      </TableCell>
                      {sources.map(s => {
                        const total = getSourceTotal(user, s)
                        const reqs = (user[`${s}_requestCount`] as number) || 0
                        const cost = (user[`${s}_cost`] as number) || 0
                        return (
                          <Fragment key={s}>
                            <TableCell className="text-center font-mono text-sm border-l">
                              {total > 0 ? <span style={{ color: SOURCE_COLORS[s] }}>{formatNumber(total)}</span> : <span className="text-muted-foreground">-</span>}
                            </TableCell>
                            <TableCell className="text-center font-mono text-sm">
                              {reqs > 0 ? reqs.toLocaleString() : '-'}
                            </TableCell>
                            <TableCell className="text-center font-mono text-sm">
                              {cost > 0 ? formatCurrency(cost) : '-'}
                            </TableCell>
                          </Fragment>
                        )
                      })}
                      <TableCell className="text-center font-mono text-sm font-semibold">
                        {formatCurrency(getTotalCost(user))}
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  )
})

function Fragment({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
