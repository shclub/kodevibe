import { getUser } from '@/lib/session'
import { ShieldAlert } from 'lucide-react'
import { CompareClient } from './compare-client'

export const dynamic = 'force-dynamic'

// Compare is linked from the main nav for everyone, but only admins can use it.
// Non-admins see an access-required notice instead of the comparison UI.
export default async function ComparePage() {
  const user = await getUser()

  if (user.role !== 'admin') {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <ShieldAlert className="mb-3 h-10 w-10 text-muted-foreground" />
        <h1 className="text-xl font-semibold">관리자 전용</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Compare는 관리자 권한이 있어야 사용할 수 있습니다.
        </p>
      </div>
    )
  }

  return <CompareClient />
}
