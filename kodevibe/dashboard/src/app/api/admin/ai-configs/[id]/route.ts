import { requireAdmin } from '@/lib/session'
import { createServerClient } from '@/lib/supabase'
import { maskApiKey, type AiConfiguration } from '@/lib/ai-config'

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  await requireAdmin()
  const { id } = await params
  const body = await req.json()
  const db = createServerClient()

  const updates: Partial<AiConfiguration> & { updated_at?: string } = {
    updated_at: new Date().toISOString(),
  }
  if (body.name !== undefined) updates.name = body.name
  if (body.provider !== undefined) updates.provider = body.provider
  if (body.base_url !== undefined) updates.base_url = body.base_url
  if (body.model !== undefined) updates.model = body.model
  if (body.is_default !== undefined) updates.is_default = body.is_default
  // Only update api_key if a non-masked value is provided
  if (body.api_key !== undefined && !body.api_key.includes('****')) {
    updates.api_key = body.api_key
  }

  if (updates.is_default) {
    await db.from('ai_configurations').update({ is_default: false }).neq('id', id)
  }

  const { data, error } = await db
    .from('ai_configurations')
    .update(updates)
    .eq('id', id)
    .select('*')
    .single()

  if (error) return Response.json({ error: error.message }, { status: 500 })
  return Response.json({ ...(data as AiConfiguration), api_key: maskApiKey((data as AiConfiguration).api_key) })
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  await requireAdmin()
  const { id } = await params
  const db = createServerClient()
  const { error } = await db.from('ai_configurations').delete().eq('id', id)
  if (error) return Response.json({ error: error.message }, { status: 500 })
  return Response.json({ ok: true })
}
