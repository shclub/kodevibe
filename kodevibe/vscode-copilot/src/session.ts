import * as vscode from 'vscode'
import * as cp from 'child_process'
import { newSessionId } from './telemetry'

export interface SessionInfo {
  sessionId: string
  userEmail: string
  userId: string
  serverUrl: string
  enabled: boolean
}

export function getConfig(): SessionInfo {
  const cfg = vscode.workspace.getConfiguration('kodevibe')
  return {
    sessionId: newSessionId(),
    userEmail: cfg.get<string>('userEmail', ''),
    userId:    cfg.get<string>('userId', ''),
    serverUrl: cfg.get<string>('serverUrl', 'http://localhost:4318'),
    enabled:   cfg.get<boolean>('enabled', true),
  }
}

export async function resolveEmail(info: SessionInfo): Promise<string> {
  // 1. Settings 우선
  if (info.userEmail) return info.userEmail

  // 2. VS Code GitHub 인증 (Copilot Enterprise 계정)
  try {
    const session = await vscode.authentication.getSession(
      'github',
      ['user:email', 'read:user'],
      { silent: true }
    )
    if (session?.account?.label) {
      // label is usually "username" — try to get email from GitHub API
      const email = await fetchGitHubEmail(session.accessToken)
      if (email) return email
      // fallback: use GitHub username as identifier
      return session.account.label + '@github'
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

async function fetchGitHubEmail(token: string): Promise<string> {
  return new Promise((resolve, reject) => {
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
            const primary = emails.find(e => e.primary && e.verified)
            resolve(primary?.email || '')
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
