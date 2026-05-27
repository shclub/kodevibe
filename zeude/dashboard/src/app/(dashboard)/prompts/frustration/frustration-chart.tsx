'use client'

import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from 'recharts'
import type { FrustrationDaily } from '@/lib/prompt-analytics'

interface FrustrationChartProps {
  data: FrustrationDaily[]
}

function formatDate(d: string) {
  return new Date(d).toLocaleDateString('ko-KR', { month: 'short', day: 'numeric', timeZone: 'Asia/Seoul' })
}

function barColor(score: number): string {
  if (score >= 3) return '#ef4444'   // red-500
  if (score >= 1.5) return '#f97316' // orange-500
  if (score >= 0.5) return '#eab308' // yellow-500
  return '#22c55e'                   // green-500
}

export function FrustrationChart({ data }: FrustrationChartProps) {
  if (data.length === 0) {
    return (
      <div className="h-[260px] flex items-center justify-center text-muted-foreground text-sm">
        데이터가 없습니다.
      </div>
    )
  }

  return (
    <ResponsiveContainer width="100%" height={260}>
      <BarChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
        <XAxis
          dataKey="date"
          tickFormatter={formatDate}
          tick={{ fontSize: 11 }}
          className="fill-muted-foreground"
        />
        <YAxis
          tick={{ fontSize: 11 }}
          className="fill-muted-foreground"
          width={32}
        />
        <Tooltip
          formatter={(value) => [`${Number(value).toFixed(2)}`, '좌절 점수']}
          labelFormatter={formatDate}
          contentStyle={{ fontSize: 12 }}
        />
        <Bar dataKey="total_frustration_score" radius={[3, 3, 0, 0]}>
          {data.map((entry, idx) => (
            <Cell key={idx} fill={barColor(entry.total_frustration_score)} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}
