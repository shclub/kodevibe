import { createServerClient } from '@/lib/supabase'
import { requireAdmin } from '@/lib/session'

export async function GET() {
  await requireAdmin()
  const supabase = createServerClient()

  const { data, error } = await supabase
    .from('zeude_settings')
    .select('key, value')

  if (error) return Response.json({ error: error.message }, { status: 500 })

  const settings: Record<string, string> = {}
  for (const row of data || []) settings[row.key] = row.value

  return Response.json(settings)
}

export async function PATCH(req: Request) {
  await requireAdmin()
  const body = await req.json()
  const supabase = createServerClient()

  const updates = Object.entries(body as Record<string, string>)
  for (const [key, value] of updates) {
    const { error } = await supabase
      .from('zeude_settings')
      .upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: 'key' })

    if (error) return Response.json({ error: error.message }, { status: 500 })
  }

  return Response.json({ ok: true })
}
