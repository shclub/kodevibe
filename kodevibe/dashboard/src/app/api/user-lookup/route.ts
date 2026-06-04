import { createServerClient } from '@/lib/supabase'
import { rateLimit } from '@/lib/rate-limit'

// Resolves an email to the KodeVibe (Supabase) user UUID so external tools
// (e.g. the VS Code Copilot extension) can stamp zeude.user.id on telemetry.
// This unifies a developer's identity across Claude/Codex/Copilot sources.
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const email = (searchParams.get('email') || '').trim().toLowerCase()

  if (!email || !email.includes('@')) {
    return Response.json({ error: 'valid email required' }, { status: 400 })
  }

  const rl = rateLimit(`user-lookup:${email}`, { limit: 30, windowMs: 60_000 })
  if (!rl.success) {
    return Response.json({ error: 'rate limited' }, { status: 429 })
  }

  try {
    const db = createServerClient()
    const { data, error } = await db
      .from('zeude_users')
      .select('id, email')
      .eq('email', email)
      .limit(1)

    if (error) return Response.json({ error: error.message }, { status: 500 })
    const row = Array.isArray(data) && data.length > 0 ? (data[0] as { id: string }) : null
    if (!row) return Response.json({ userId: '' })  // unknown user — empty, not an error
    return Response.json({ userId: row.id })
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 })
  }
}
