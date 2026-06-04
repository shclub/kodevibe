import { requireAdmin } from '@/lib/session'
import { createServerClient } from '@/lib/supabase'
import { callAiConfig, getProvider, providerNeedsApiKey, type AiConfiguration } from '@/lib/ai-config'

export async function POST(req: Request) {
  await requireAdmin()
  const body = await req.json()

  // Always use form values for url/model; only fall back to DB for the api_key when masked
  let apiKey: string = body.api_key || ''

  if (!apiKey && body.id) {
    const db = createServerClient()
    const { data } = await db
      .from('ai_configurations')
      .select('api_key')
      .eq('id', body.id)
      .single()
    apiKey = (data as { api_key: string } | null)?.api_key || ''
  }

  if (!apiKey && providerNeedsApiKey(body.provider)) {
    return Response.json({ error: 'API key is required' }, { status: 400 })
  }

  const config: AiConfiguration = {
    id: 'test',
    name: 'test',
    provider: body.provider,
    base_url: body.base_url || getProvider(body.provider)?.baseUrl || '',
    api_key: apiKey,
    model: body.model,
    is_default: false,
    created_at: '',
    updated_at: '',
  }

  try {
    const res = await callAiConfig(
      config,
      [{ role: 'user', content: 'Say "ok"' }],
      { maxTokens: 10, temperature: 0 }
    )

    if (!res.ok) {
      const err = await res.text()
      return Response.json({ error: `Provider error ${res.status}: ${err.slice(0, 200)}` }, { status: 400 })
    }

    return Response.json({ ok: true })
  } catch (err) {
    const msg = String(err)
    const isNetworkErr = msg.includes('fetch failed') || msg.includes('ECONNREFUSED') || msg.includes('ENOTFOUND')
    const hint = isNetworkErr
      ? ` — 대시보드는 Docker 내부에서 실행됩니다. localhost 대신 host.docker.internal을 사용하세요 (예: http://host.docker.internal:4000)`
      : ''
    return Response.json({ error: msg + hint }, { status: 500 })
  }
}
