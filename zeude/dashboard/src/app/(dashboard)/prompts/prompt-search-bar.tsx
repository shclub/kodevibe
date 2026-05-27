'use client'

import { useRouter, usePathname } from 'next/navigation'
import { useTransition } from 'react'
import { Search } from 'lucide-react'
import { Input } from '@/components/ui/input'

interface PromptSearchBarProps {
  defaultValue?: string
}

export function PromptSearchBar({ defaultValue = '' }: PromptSearchBarProps) {
  const router = useRouter()
  const pathname = usePathname()
  const [, startTransition] = useTransition()

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const form = e.currentTarget
    const q = (form.elements.namedItem('q') as HTMLInputElement).value.trim()
    startTransition(() => {
      if (q) {
        router.push(`${pathname}?q=${encodeURIComponent(q)}`)
      } else {
        router.push(pathname)
      }
    })
  }

  return (
    <form onSubmit={handleSubmit} className="relative w-64">
      <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
      <Input
        name="q"
        defaultValue={defaultValue}
        placeholder="Search prompts…"
        className="pl-9 h-9 text-sm"
      />
    </form>
  )
}
