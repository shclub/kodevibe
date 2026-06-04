import { createServerClient } from '@/lib/supabase'
import { requireAdmin } from '@/lib/session'
import { maskApiKey } from '@/lib/ai-settings'

const SENSITIVE_KEYS = new Set(['openrouter_api_key'])

export async function GET() {
  await requireAdmin()
  const supabase = createServerClient()

  const { data, error } = await supabase
    .from('zeude_settings')
    .select('key, value')

  if (error) return Response.json({ error: error.message }, { status: 500 })

  const settings: Record<string, string> = {}
  for (const row of (data || []) as { key: string; value: string }[]) {
    if (SENSITIVE_KEYS.has(row.key)) {
      settings[row.key] = row.value ? maskApiKey(row.value) : ''
    } else {
      settings[row.key] = row.value
    }
  }

  return Response.json(settings)
}

export async function PATCH(req: Request) {
  await requireAdmin()
  const body = await req.json()
  const supabase = createServerClient()

  const updates = Object.entries(body as Record<string, string>)
  for (const [key, value] of updates) {
    // Skip if client sends back a masked value unchanged
    if (SENSITIVE_KEYS.has(key) && value.includes('****')) continue

    const { error } = await supabase
      .from('zeude_settings')
      .upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: 'key' })

    if (error) return Response.json({ error: error.message }, { status: 500 })
  }

  return Response.json({ ok: true })
}
