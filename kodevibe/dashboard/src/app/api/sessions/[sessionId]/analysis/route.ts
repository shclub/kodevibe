import { getSession } from '@/lib/session'
import { createServerClient } from '@/lib/supabase'

// GET: fetch the saved AI analysis for a session (if any)
export async function GET(_req: Request, { params }: { params: Promise<{ sessionId: string }> }) {
  const session = await getSession()
  if (!session) return Response.json({ error: 'Not authenticated' }, { status: 401 })

  const { sessionId } = await params
  const db = createServerClient()
  const { data } = await db
    .from('ai_session_analysis')
    .select('content, model, updated_at')
    .eq('session_id', sessionId)
    .limit(1)

  const row = Array.isArray(data) && data.length > 0 ? data[0] : null
  return Response.json(row ?? { content: '' })
}

// PUT: upsert (overwrite) the saved analysis
export async function PUT(req: Request, { params }: { params: Promise<{ sessionId: string }> }) {
  const session = await getSession()
  if (!session) return Response.json({ error: 'Not authenticated' }, { status: 401 })

  const { sessionId } = await params
  const body = await req.json().catch(() => ({}))
  const content: string = (body.content || '').slice(0, 100_000)
  const model: string = body.model || ''
  if (!content) return Response.json({ error: 'content required' }, { status: 400 })

  const db = createServerClient()
  const { error } = await db
    .from('ai_session_analysis')
    .upsert({ session_id: sessionId, content, model, updated_at: new Date().toISOString() }, { onConflict: 'session_id' })

  if (error) return Response.json({ error: error.message }, { status: 500 })
  return Response.json({ ok: true })
}
