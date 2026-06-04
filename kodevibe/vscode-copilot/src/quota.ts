// Captures GitHub Copilot quota/credit info by intercepting the
// `copilot_internal/user` / token endpoints via the extension-host fetch.
// (These run in the extension host as node fetch — unlike chat completions.)

export interface QuotaInfo {
  plan: string
  premiumRemaining?: number
  premiumEntitlement?: number
  premiumPercentRemaining?: number
  raw: string
}

let onQuota: (q: QuotaInfo) => void = () => {}
let log: (m: string) => void = () => {}

export function installQuotaCapture(cb: (q: QuotaInfo) => void, logger: (m: string) => void): void {
  onQuota = cb
  log = logger
  const g = globalThis as unknown as { fetch?: typeof fetch; __kvQuotaPatched?: boolean }
  if (!g.fetch || g.__kvQuotaPatched) return
  g.__kvQuotaPatched = true
  const orig = g.fetch.bind(globalThis)

  const wrapped = async function (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> {
    const res = await orig(input, init)
    let url = ''
    try { url = typeof input === 'string' ? input : (input instanceof URL ? input.href : (input as Request).url) } catch { /* ignore */ }

    if (url && (url.includes('copilot_internal') || url.includes('/copilot/') || url.includes('quota'))) {
      try {
        res.clone().text().then(text => {
          if (text.includes('quota') || text.includes('premium') || text.includes('copilot_plan') || text.includes('entitlement')) {
            log(`[quota] ${url} -> ${text.slice(0, 600)}`)
            parseAndEmit(text)
          }
        }).catch(() => {})
      } catch { /* ignore */ }
    }
    return res
  } as typeof fetch

  try { g.fetch = wrapped }
  catch { Object.defineProperty(g, 'fetch', { value: wrapped, writable: true, configurable: true }) }
  log('[quota] capture installed')
}

function parseAndEmit(text: string): void {
  try {
    const j = JSON.parse(text)
    const plan = j.copilot_plan || j.access_type_sku || j.plan || ''
    // quota_snapshots.premium_interactions is the AI-credits bucket
    const snaps = j.quota_snapshots || j.quotaSnapshots || {}
    const premium = snaps.premium_interactions || snaps.premiumInteractions || snaps.premium || {}

    const q: QuotaInfo = {
      plan: String(plan),
      premiumRemaining: numOrUndef(premium.remaining),
      premiumEntitlement: numOrUndef(premium.entitlement),
      premiumPercentRemaining: numOrUndef(premium.percent_remaining ?? premium.percentRemaining),
      raw: text.slice(0, 2000),
    }
    onQuota(q)
  } catch (e) {
    log(`[quota] parse error: ${e}`)
  }
}

function numOrUndef(v: unknown): number | undefined {
  return typeof v === 'number' ? v : undefined
}
