export interface AiConfiguration {
  id: string
  name: string
  provider: string
  base_url: string
  api_key: string
  model: string
  is_default: boolean
  created_at: string
  updated_at: string
}

export interface AiConfigPublic {
  id: string
  name: string
  provider: string
  model: string
  is_default: boolean
}

export interface Provider {
  id: string
  label: string
  baseUrl: string
  apiFormat: 'openai' | 'anthropic'
  defaultModel: string
  models: string[]
  requiresBaseUrl: boolean
}

export const PROVIDERS: Provider[] = [
  {
    id: 'litellm',
    label: 'LiteLLM',
    baseUrl: 'http://host.docker.internal:4000',
    apiFormat: 'openai',
    defaultModel: 'Qwen3.5-122B-A10B-FP8',
    models: [],
    requiresBaseUrl: true,
  },
  {
    id: 'zhipu',
    label: 'Zhipu (Z.ai Coding Plan)',
    baseUrl: 'https://api.z.ai/api/coding/paas/v4',
    apiFormat: 'openai',
    defaultModel: 'glm-4.6',
    models: ['glm-5.1', 'glm-4.7', 'glm-4.6', 'glm-4.5', 'glm-4.5-air'],
    requiresBaseUrl: false,
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    baseUrl: 'https://api.anthropic.com',
    apiFormat: 'anthropic',
    defaultModel: 'claude-sonnet-4-6',
    models: [
      'claude-opus-4-8',
      'claude-sonnet-4-6',
      'claude-haiku-4-5-20251001',
      'claude-3-5-sonnet-20241022',
      'claude-3-5-haiku-20241022',
      'claude-3-opus-20240229',
    ],
    requiresBaseUrl: false,
  },
  {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    apiFormat: 'openai',
    defaultModel: 'gpt-4o',
    models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-3.5-turbo', 'o1', 'o1-mini'],
    requiresBaseUrl: false,
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiFormat: 'openai',
    defaultModel: 'anthropic/claude-sonnet-4-6',
    models: [
      'anthropic/claude-sonnet-4-6',
      'anthropic/claude-opus-4-8',
      'anthropic/claude-3.5-sonnet',
      'openai/gpt-4o',
      'openai/gpt-4o-mini',
      'google/gemini-flash-1.5',
      'meta-llama/llama-3.1-8b-instruct:free',
    ],
    requiresBaseUrl: false,
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    apiFormat: 'openai',
    defaultModel: 'deepseek-chat',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    requiresBaseUrl: false,
  },
  {
    id: 'groq',
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    apiFormat: 'openai',
    defaultModel: 'llama-3.1-70b-versatile',
    models: [
      'llama-3.1-70b-versatile',
      'llama-3.1-8b-instant',
      'mixtral-8x7b-32768',
      'gemma2-9b-it',
    ],
    requiresBaseUrl: false,
  },
  {
    id: 'mistral',
    label: 'Mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    apiFormat: 'openai',
    defaultModel: 'mistral-large-latest',
    models: ['mistral-large-latest', 'mistral-medium-latest', 'mistral-small-latest', 'open-mistral-7b'],
    requiresBaseUrl: false,
  },
  {
    id: 'google',
    label: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    apiFormat: 'openai',
    defaultModel: 'gemini-2.0-flash',
    models: ['gemini-2.0-flash', 'gemini-1.5-pro', 'gemini-1.5-flash'],
    requiresBaseUrl: false,
  },
  {
    id: 'together',
    label: 'Together AI',
    baseUrl: 'https://api.together.xyz/v1',
    apiFormat: 'openai',
    defaultModel: 'meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo',
    models: [
      'meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo',
      'mistralai/Mixtral-8x7B-Instruct-v0.1',
    ],
    requiresBaseUrl: false,
  },
  {
    id: 'azure',
    label: 'Azure OpenAI',
    baseUrl: '',
    apiFormat: 'openai',
    defaultModel: 'gpt-4o',
    models: ['gpt-4o', 'gpt-4-turbo', 'gpt-35-turbo'],
    requiresBaseUrl: true,
  },
  {
    id: 'ollama',
    label: 'Ollama (Local)',
    baseUrl: 'http://localhost:11434/v1',
    apiFormat: 'openai',
    defaultModel: 'llama3.2',
    // Locally-installed models vary per machine → free-form text input
    models: [],
    requiresBaseUrl: true,
  },
  {
    id: 'lmstudio',
    label: 'LM Studio (Local)',
    baseUrl: 'http://localhost:1234/v1',
    apiFormat: 'openai',
    defaultModel: 'local-model',
    // Locally-loaded model varies → free-form text input
    models: [],
    requiresBaseUrl: true,
  },
  {
    id: 'custom',
    label: 'Custom (OpenAI-compatible)',
    baseUrl: '',
    apiFormat: 'openai',
    defaultModel: '',
    models: [],
    requiresBaseUrl: true,
  },
]

export function getProvider(id: string): Provider | undefined {
  return PROVIDERS.find(p => p.id === id)
}

// Local providers run without authentication.
const NO_KEY_PROVIDERS = new Set(['ollama', 'lmstudio'])
export function providerNeedsApiKey(id: string): boolean {
  return !NO_KEY_PROVIDERS.has(id)
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export async function callAiConfig(
  config: AiConfiguration,
  messages: ChatMessage[],
  options?: { maxTokens?: number; temperature?: number; stream?: boolean }
): Promise<Response> {
  const provider = getProvider(config.provider)
  const format = provider?.apiFormat ?? 'openai'

  if (format === 'anthropic') {
    return callAnthropic(config, messages, options)
  }
  return callOpenAiCompat(config, messages, options)
}

async function callOpenAiCompat(
  config: AiConfiguration,
  messages: ChatMessage[],
  options?: { maxTokens?: number; temperature?: number; stream?: boolean }
): Promise<Response> {
  const baseUrl = config.base_url.replace(/\/$/, '')
  return fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // Local providers (ollama/lmstudio) need no auth; omit empty Bearer
      ...(config.api_key ? { 'Authorization': `Bearer ${config.api_key}` } : {}),
    },
    body: JSON.stringify({
      model: config.model,
      messages,
      max_tokens: options?.maxTokens ?? 1500,
      temperature: options?.temperature ?? 0.4,
      stream: options?.stream ?? false,
    }),
  })
}

async function callAnthropic(
  config: AiConfiguration,
  messages: ChatMessage[],
  options?: { maxTokens?: number; temperature?: number; stream?: boolean }
): Promise<Response> {
  const baseUrl = config.base_url.replace(/\/$/, '')
  const systemMsg = messages.find(m => m.role === 'system')?.content
  const userMessages = messages.filter(m => m.role !== 'system')

  return fetch(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'x-api-key': config.api_key,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: config.model,
      max_tokens: options?.maxTokens ?? 1500,
      temperature: options?.temperature ?? 0.4,
      ...(systemMsg ? { system: systemMsg } : {}),
      messages: userMessages,
      stream: options?.stream ?? false,
    }),
  })
}

export function maskApiKey(key: string): string {
  if (!key) return ''
  if (key.length <= 8) return '****'
  return `${key.slice(0, 8)}****${key.slice(-4)}`
}

/** Extract text chunks from an SSE stream, handling both OpenAI and Anthropic formats */
export function extractStreamText(line: string, format: 'openai' | 'anthropic'): string {
  if (!line.startsWith('data: ')) return ''
  const data = line.slice(6).trim()
  if (data === '[DONE]') return ''
  try {
    const json = JSON.parse(data)
    if (format === 'anthropic') {
      return json.delta?.text ?? ''
    }
    return json.choices?.[0]?.delta?.content ?? ''
  } catch {
    return ''
  }
}
