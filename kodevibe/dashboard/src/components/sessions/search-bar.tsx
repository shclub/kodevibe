'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { useState, useEffect } from 'react'
import { Search, X } from 'lucide-react'
import { Input } from '@/components/ui/input'

export function SessionSearchBar() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [sessionId, setSessionId] = useState(searchParams.get('searchSessionId') ?? '')
  const [userSearch, setUserSearch] = useState(searchParams.get('searchUser') ?? '')

  useEffect(() => {
    setSessionId(searchParams.get('searchSessionId') ?? '')
    setUserSearch(searchParams.get('searchUser') ?? '')
  }, [searchParams])

  function apply() {
    const params = new URLSearchParams(searchParams.toString())
    if (sessionId.trim()) params.set('searchSessionId', sessionId.trim())
    else params.delete('searchSessionId')
    if (userSearch.trim()) params.set('searchUser', userSearch.trim())
    else params.delete('searchUser')
    router.push(`/sessions?${params.toString()}`)
  }

  function clear() {
    const params = new URLSearchParams(searchParams.toString())
    params.delete('searchSessionId')
    params.delete('searchUser')
    setSessionId('')
    setUserSearch('')
    router.push(`/sessions?${params.toString()}`)
  }

  const hasSearch = !!(sessionId.trim() || userSearch.trim())

  return (
    <div className="flex items-center gap-2">
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
        <Input
          placeholder="Session ID..."
          value={sessionId}
          onChange={e => setSessionId(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && apply()}
          className="pl-8 h-9 w-44 text-sm font-mono"
        />
      </div>
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
        <Input
          placeholder="User (email)..."
          value={userSearch}
          onChange={e => setUserSearch(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && apply()}
          className="pl-8 h-9 w-44 text-sm"
        />
      </div>
      <button
        onClick={apply}
        className="h-9 px-3 rounded-md bg-primary text-primary-foreground text-sm hover:bg-primary/90 transition-colors"
      >
        검색
      </button>
      {hasSearch && (
        <button
          onClick={clear}
          className="h-9 px-2 rounded-md border text-muted-foreground hover:text-foreground transition-colors"
          title="검색 초기화"
        >
          <X className="h-4 w-4" />
        </button>
      )}
    </div>
  )
}
