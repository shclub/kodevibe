import * as vscode from 'vscode'
import * as cp from 'child_process'

export interface SessionInfo {
  sessionId: string
  userEmail: string
  userId: string
  serverUrl: string
  enabled: boolean
}

export function getConfig(): SessionInfo {
  const cfg = vscode.workspace.getConfiguration('kodevibe')
  // vscode.env.sessionId can be UUID+timestamp format — normalize to standard UUID format
  const rawId = vscode.env.sessionId
  const uuidPart = rawId.length >= 36 ? rawId.slice(0, 36) : rawId
  return {
    sessionId: uuidPart,
    userEmail: cfg.get<string>('userEmail', ''),
    userId:    cfg.get<string>('userId', ''),
    serverUrl: cfg.get<string>('serverUrl', 'http://localhost:4318'),
    enabled:   cfg.get<boolean>('enabled', true),
  }
}

// Resolve the KodeVibe user UUID from email via the dashboard, so telemetry
// carries zeude.user.id and unifies identity across Claude/Codex/Copilot.
export async function resolveUserId(info: SessionInfo, email: string): Promise<string> {
  if (info.userId) return info.userId  // explicit config wins
  if (!email || email === 'unknown') return ''

  // dashboard base = serverUrl with the OTLP port swapped to the app port (3000),
  // or an explicit kodevibe.dashboardUrl if provided.
  const cfg = vscode.workspace.getConfiguration('kodevibe')
  let dashboardUrl = cfg.get<string>('dashboardUrl', '')
  if (!dashboardUrl) {
    try {
      const u = new URL(info.serverUrl)
      dashboardUrl = `${u.protocol}//${u.hostname}:3000`
    } catch { dashboardUrl = 'http://localhost:3000' }
  }

  return new Promise((resolve) => {
    try {
      const url = `${dashboardUrl.replace(/\/$/, '')}/api/user-lookup?email=${encodeURIComponent(email)}`
      const mod = url.startsWith('https') ? require('https') : require('http')
      const req = mod.get(url, (res: import('http').IncomingMessage) => {
        let data = ''
        res.on('data', (c: Buffer) => data += c)
        res.on('end', () => {
          try { resolve(JSON.parse(data).userId || '') } catch { resolve('') }
        })
      })
      req.on('error', () => resolve(''))
      req.setTimeout(3000, () => { req.destroy(); resolve('') })
    } catch { resolve('') }
  })
}

export async function resolveEmail(info: SessionInfo): Promise<string> {
  // 1. 설정값 최우선
  if (info.userEmail) return info.userEmail

  // 2. VS Code에 현재 로그인된 GitHub 계정 정보
  try {
    const session = await vscode.authentication.getSession(
      'github',
      ['user:email', 'read:user'],
      { silent: true }
    )
    if (session) {
      // GET /user — 현재 연결된 계정의 public email + login
      const user = await fetchGitHubUser(session.accessToken)
      if (user.email) return user.email

      // email이 비공개면 /user/emails 에서 기업 이메일 탐색
      const email = await fetchGitHubEmail(session.accessToken)
      if (email) return email

      // 최후 수단: GitHub 로그인명 사용
      if (user.login) return `${user.login}@github`
    }
  } catch {
    // GitHub auth not available
  }

  // 3. git config
  try {
    return await gitConfigEmail()
  } catch {
    return 'unknown'
  }
}

export async function notifyEmailConfig(email: string): Promise<void> {
  if (email === 'unknown' || email.endsWith('@github') || email.endsWith('@gmail.com')) {
    const action = await vscode.window.showWarningMessage(
      `KodeVibe: 이메일이 "${email}"로 감지됐어요. 기업 이메일로 변경하시겠어요?`,
      '설정 열기'
    )
    if (action === '설정 열기') {
      vscode.commands.executeCommand('workbench.action.openSettings', 'kodevibe.userEmail')
    }
  }
}

async function fetchGitHubUser(token: string): Promise<{ login: string; email: string }> {
  return new Promise((resolve) => {
    const req = require('https').get(
      'https://api.github.com/user',
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'User-Agent': 'kodevibe-copilot',
          'Accept': 'application/vnd.github+json',
        },
      },
      (res: import('http').IncomingMessage) => {
        let data = ''
        res.on('data', (c: Buffer) => data += c)
        res.on('end', () => {
          try {
            const u = JSON.parse(data)
            resolve({ login: u.login || '', email: u.email || '' })
          } catch {
            resolve({ login: '', email: '' })
          }
        })
      }
    )
    req.on('error', () => resolve({ login: '', email: '' }))
    req.setTimeout(3000, () => { req.destroy(); resolve({ login: '', email: '' }) })
  })
}

async function fetchGitHubEmail(token: string): Promise<string> {
  return new Promise((resolve) => {
    const req = require('https').get(
      'https://api.github.com/user/emails',
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'User-Agent': 'kodevibe-copilot',
          'Accept': 'application/vnd.github+json',
        },
      },
      (res: import('http').IncomingMessage) => {
        let data = ''
        res.on('data', (c: Buffer) => data += c)
        res.on('end', () => {
          try {
            const emails: Array<{ email: string; primary: boolean; verified: boolean }> = JSON.parse(data)
            const verified = emails.filter(e => e.verified)
            // Prefer corporate email (non gmail/hotmail/yahoo)
            const freeProviders = ['gmail.com', 'hotmail.com', 'yahoo.com', 'outlook.com', 'naver.com']
            const corporate = verified.find(e => !freeProviders.some(p => e.email.endsWith('@' + p)))
            if (corporate) { resolve(corporate.email); return }
            // Fallback: primary verified
            const primary = verified.find(e => e.primary)
            resolve(primary?.email || verified[0]?.email || '')
          } catch {
            resolve('')
          }
        })
      }
    )
    req.on('error', () => resolve(''))
    req.setTimeout(3000, () => { req.destroy(); resolve('') })
  })
}

function gitConfigEmail(): Promise<string> {
  return new Promise((resolve, reject) => {
    cp.exec('git config user.email', (err, stdout) => {
      if (err) reject(err)
      else resolve(stdout.trim())
    })
  })
}

export function estimateTokens(text: string): number {
  return Math.max(1, Math.round(text.length / 4))
}

export function extractInserted(before: string, after: string): string {
  if (after.length <= before.length) return ''
  let i = 0
  while (i < before.length && before[i] === after[i]) i++
  let j = 0
  while (j < before.length - i && before[before.length - 1 - j] === after[after.length - 1 - j]) j++
  return after.slice(i, after.length - j)
}
