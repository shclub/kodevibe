import { getSession } from '@/lib/session'
import { getSessionCompareData } from '@/lib/session-compare'

// GET /api/admin/sessions/<sessionId>/compare
// Returns turn-level + token breakdown for one session (Compare screen).
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getSession()
    if (!session) {
      return Response.json({ error: 'Not authenticated' }, { status: 401 })
    }
    if (session.user.role !== 'admin') {
      return Response.json({ error: 'Admin access required' }, { status: 403 })
    }

    const { id } = await params
    if (!id) {
      return Response.json({ error: 'session id required' }, { status: 400 })
    }

    const data = await getSessionCompareData(id)
    if (!data) {
      return Response.json({ error: 'Session not found' }, { status: 404 })
    }
    return Response.json({ data })
  } catch (err) {
    console.error('Session compare error:', err)
    return Response.json({ error: 'Internal server error' }, { status: 500 })
  }
}
