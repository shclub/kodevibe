import { createServerClient } from './supabase'
import { env } from './env'

async function getSetting(key: string): Promise<string | null> {
  try {
    const supabase = createServerClient()
    const { data, error } = await supabase
      .from('zeude_settings')
      .select('value')
      .eq('key', key)
      .limit(1)
    if (error || !data || !Array.isArray(data) || data.length === 0) return null
    return (data[0] as { value: string }).value || null
  } catch {
    return null
  }
}

export async function getOpenRouterKey(): Promise<string | null> {
  const dbKey = await getSetting('openrouter_api_key')
  if (dbKey) return dbKey
  return env.OPENROUTER_API_KEY ?? null
}

export async function getOpenRouterModel(): Promise<string> {
  const dbModel = await getSetting('openrouter_model')
  return dbModel || env.OPENROUTER_MODEL
}

export async function isAiConfigured(): Promise<boolean> {
  const key = await getOpenRouterKey()
  return !!key
}

export function maskApiKey(key: string): string {
  if (key.length <= 8) return '****'
  return `${key.slice(0, 8)}****${key.slice(-4)}`
}
