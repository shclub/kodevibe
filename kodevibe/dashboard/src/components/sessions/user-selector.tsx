'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { useEffect, useState } from 'react'

interface User {
  id: string
  email: string
  name?: string
}

export function SessionUserSelector({ currentEmail }: { currentEmail?: string }) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [users, setUsers] = useState<User[]>([])

  useEffect(() => {
    fetch('/api/admin/users')
      .then(r => r.ok ? r.json() : [])
      .then(data => setUsers(Array.isArray(data) ? data : data.users ?? []))
      .catch(() => {})
  }, [])

  if (users.length === 0) return null

  function onChange(email: string) {
    const params = new URLSearchParams(searchParams.toString())
    if (email === '__self__') {
      params.delete('viewUser')
    } else {
      params.set('viewUser', email)
    }
    router.push(`/sessions?${params.toString()}`)
  }

  const value = currentEmail ?? '__self__'

  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      className="h-9 rounded-md border border-input bg-background px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
    >
      <option value="__self__">내 세션</option>
      {users.map(u => (
        <option key={u.id} value={u.email}>
          {u.email}
        </option>
      ))}
    </select>
  )
}
