import { getSession } from '@/lib/session'
import { searchSessionsForCompare } from '@/lib/clickhouse'

// GET /api/admin/sessions/search?q=<partial session id>
// Returns recent sessions matching the query for the Compare picker.
export async function GET(req: Request) {
  try {
    const session = await getSession()
    if (!session) {
      return Response.json({ error: 'Not authenticated' }, { status: 401 })
    }

    const url = new URL(req.url)
    const q = (url.searchParams.get('q') ?? '').trim()
    const results = await searchSessionsForCompare(q, 15)
    return Response.json({ results })
  } catch (err) {
    console.error('Session search error:', err)
    return Response.json({ error: 'Internal server error' }, { status: 500 })
  }
}
