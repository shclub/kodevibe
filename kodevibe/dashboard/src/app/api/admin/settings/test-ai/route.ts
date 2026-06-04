import { requireAdmin } from '@/lib/session'
import { getOpenRouterKey, getOpenRouterModel } from '@/lib/ai-settings'
import { env } from '@/lib/env'

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions'

export async function POST(req: Request) {
  await requireAdmin()

  const body = await req.json().catch(() => ({}))
  // Use provided key (new key being tested) or fall back to stored key
  const apiKey: string | null = body.apiKey || await getOpenRouterKey()
  const model: string = body.model || await getOpenRouterModel()

  if (!apiKey) {
    return Response.json({ error: 'No API key provided' }, { status: 400 })
  }

  try {
    const res = await fetch(OPENROUTER_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': env.NEXT_PUBLIC_APP_URL,
        'X-Title': 'KodeVibe Dashboard',
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'Say "ok"' }],
        max_tokens: 5,
      }),
    })

    if (!res.ok) {
      const err = await res.text()
      return Response.json({ error: err }, { status: 400 })
    }

    return Response.json({ ok: true })
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 })
  }
}
