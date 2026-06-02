import { getSession } from '@/lib/session'
import { getTopSessionsByDuration } from '@/lib/clickhouse'

export async function GET(request: Request) {
  const session = await getSession()
  if (!session) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const { searchParams } = new URL(request.url)
  const today = new Date().toISOString().slice(0, 10)
  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10)
  const from = searchParams.get('from') ?? weekAgo
  const to = searchParams.get('to') ?? today

  try {
    const data = await getTopSessionsByDuration(from, to)
    return Response.json(data)
  } catch (error) {
    console.error('Failed to fetch top duration sessions:', error)
    return Response.json({ error: 'Query failed' }, { status: 500 })
  }
}
