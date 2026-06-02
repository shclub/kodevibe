'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { RefreshCw } from 'lucide-react'
import { useState, useCallback } from 'react'

export function DateFilter({ from: initialFrom, to: initialTo }: { from?: string; to?: string }) {
  const router = useRouter()
  const searchParams = useSearchParams()

  const today = new Date().toISOString().slice(0, 10)
  const [from, setFrom] = useState(initialFrom ?? today)
  const [to, setTo] = useState(initialTo ?? today)
  const [refreshing, setRefreshing] = useState(false)

  const apply = useCallback((newFrom: string, newTo: string) => {
    const params = new URLSearchParams(searchParams.toString())
    params.set('from', newFrom)
    params.set('to', newTo)
    router.push(`?${params.toString()}`)
  }, [router, searchParams])

  const handleRefresh = () => {
    setRefreshing(true)
    apply(from, to)
    setTimeout(() => setRefreshing(false), 500)
  }

  return (
    <div className="flex items-center gap-2">
      <div className="flex items-center gap-1.5 border rounded-lg px-2 py-1">
        <label className="text-xs text-muted-foreground">From</label>
        <input
          type="date"
          value={from}
          onChange={e => setFrom(e.target.value)}
          className="text-sm bg-transparent border-none outline-none w-[130px]"
        />
      </div>
      <span className="text-muted-foreground">~</span>
      <div className="flex items-center gap-1.5 border rounded-lg px-2 py-1">
        <label className="text-xs text-muted-foreground">To</label>
        <input
          type="date"
          value={to}
          onChange={e => setTo(e.target.value)}
          className="text-sm bg-transparent border-none outline-none w-[130px]"
        />
      </div>
      <button
        onClick={handleRefresh}
        className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg border hover:bg-muted transition-colors"
      >
        <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
      </button>
    </div>
  )
}
