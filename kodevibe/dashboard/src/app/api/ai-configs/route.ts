import { getSession } from '@/lib/session'
import { createServerClient } from '@/lib/supabase'
import type { AiConfigPublic } from '@/lib/ai-config'

export async function GET() {
  const session = await getSession()
  if (!session) return Response.json({ error: 'Not authenticated' }, { status: 401 })

  const db = createServerClient()
  const { data, error } = await db
    .from('ai_configurations')
    .select('id, name, provider, model, is_default')
    .order('is_default', { ascending: false })
    .order('created_at')

  if (error) return Response.json({ error: error.message }, { status: 500 })
  return Response.json(data as AiConfigPublic[])
}
