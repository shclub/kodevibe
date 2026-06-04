import { requireAdmin } from '@/lib/session'
import { createServerClient } from '@/lib/supabase'
import { maskApiKey, type AiConfiguration } from '@/lib/ai-config'

export async function GET() {
  await requireAdmin()
  const db = createServerClient()
  const { data, error } = await db.from('ai_configurations').select('*').order('created_at')
  if (error) return Response.json({ error: error.message }, { status: 500 })

  const masked = (data as AiConfiguration[]).map(c => ({
    ...c,
    api_key: maskApiKey(c.api_key),
  }))
  return Response.json(masked)
}

export async function POST(req: Request) {
  await requireAdmin()
  const body = await req.json()
  const { name, provider, base_url, api_key, model, is_default } = body

  if (!name || !provider || !model) {
    return Response.json({ error: 'name, provider, model are required' }, { status: 400 })
  }

  const db = createServerClient()

  if (is_default) {
    await db.from('ai_configurations').update({ is_default: false }).neq('id', '00000000-0000-0000-0000-000000000000')
  }

  const { data, error } = await db.from('ai_configurations').insert({
    name, provider, base_url: base_url || '', api_key: api_key || '', model,
    is_default: !!is_default,
  }).select('*').single()

  if (error) return Response.json({ error: error.message }, { status: 500 })

  return Response.json({ ...(data as AiConfiguration), api_key: maskApiKey((data as AiConfiguration).api_key) }, { status: 201 })
}
