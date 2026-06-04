import * as fs from 'fs'
import * as path from 'path'

export interface ChatTurn {
  sessionId: string
  requestId: string
  prompt: string
  response: string
  model: string
  timestamp: string  // ISO
  inputTokens: number
  outputTokens: number
  projectPath: string
  projectName: string
}

// Read the workspace folder for a session file:
//   <wsRoot>/<hash>/chatSessions/<id>.jsonl  →  <wsRoot>/<hash>/workspace.json { folder }
const projectCache = new Map<string, { projectPath: string; projectName: string }>()
function getProjectForSession(file: string): { projectPath: string; projectName: string } {
  const wsDir = path.dirname(path.dirname(file))
  if (projectCache.has(wsDir)) return projectCache.get(wsDir)!
  let result = { projectPath: '', projectName: '' }
  try {
    const wj = JSON.parse(fs.readFileSync(path.join(wsDir, 'workspace.json'), 'utf8'))
    const folder: string = wj.folder || wj.configPath || ''
    if (folder) {
      const p = decodeURIComponent(folder.replace(/^file:\/\//, ''))
      result = { projectPath: p, projectName: path.basename(p) }
    }
  } catch { /* no workspace.json (e.g. empty window) */ }
  projectCache.set(wsDir, result)
  return result
}

// Root of VS Code chat session JSON files:
//   <User>/workspaceStorage/<hash>/chatSessions/<uuid>.json
// Derived from the extension's globalStorage path:
//   <User>/globalStorage/<publisher.ext>
export function getWorkspaceStorageRoot(globalStoragePath: string): string {
  // globalStoragePath = <User>/globalStorage/kodevibe.kodevibe-copilot
  const userDir = path.dirname(path.dirname(globalStoragePath))
  return path.join(userDir, 'workspaceStorage')
}

function listSessionFiles(wsRoot: string): string[] {
  const out: string[] = []
  let dirs: string[] = []
  try { dirs = fs.readdirSync(wsRoot) } catch { return out }
  for (const d of dirs) {
    const cs = path.join(wsRoot, d, 'chatSessions')
    let files: string[] = []
    try { files = fs.readdirSync(cs) } catch { continue }
    for (const f of files) {
      if (f.endsWith('.json') || f.endsWith('.jsonl')) out.push(path.join(cs, f))
    }
  }
  return out
}

// Apply a JSON-path operation onto a state object (used by .jsonl reconstruction).
// kind 2 = append to array at path; otherwise = set value at path.
function applyOp(root: Record<string, unknown>, pathArr: unknown[], value: unknown, kind: number): void {
  let o: Record<string, unknown> | unknown[] = root
  for (let i = 0; i < pathArr.length - 1; i++) {
    const key = pathArr[i] as string | number
    const next = pathArr[i + 1]
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cur = (o as any)[key]
    if (cur == null) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (o as any)[key] = typeof next === 'number' ? [] : {}
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    o = (o as any)[key]
  }
  const last = pathArr[pathArr.length - 1] as string | number
  if (kind === 2) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const arr = (o as any)[last]
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(o as any)[last] = Array.isArray(arr) ? arr.concat(value) : (Array.isArray(value) ? value : [value])
  } else {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(o as any)[last] = value
  }
}

// Reconstruct full session state from a .jsonl incremental log.
function reconstructJsonl(text: string): Record<string, unknown> {
  let state: Record<string, unknown> = {}
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let op: { kind?: number; k?: unknown[]; v?: unknown }
    try { op = JSON.parse(line) } catch { continue }
    if (op.kind === 0) { state = (op.v as Record<string, unknown>) || {}; continue }
    if (Array.isArray(op.k)) applyOp(state, op.k, op.v, op.kind ?? 1)
  }
  return state
}

function parseSessionFile(file: string): Record<string, unknown> | null {
  let text: string
  try { text = fs.readFileSync(file, 'utf8') } catch { return null }
  if (file.endsWith('.jsonl')) {
    return reconstructJsonl(text)
  }
  try { return JSON.parse(text) } catch { return null }
}

// Kinds that are NOT the assistant's textual answer (reasoning, tool calls, etc.)
const NON_ANSWER_KINDS = new Set([
  'thinking', 'toolInvocationSerialized', 'mcpServersStarting',
  'prepareToolInvocation', 'codeblockUri', 'progressMessage',
  'progressTask', 'inlineReference', 'codeCitation',
])

function extractResponseText(response: unknown): string {
  if (!Array.isArray(response)) return ''
  const parts: string[] = []
  for (const p of response as Array<Record<string, unknown>>) {
    if (!p || typeof p !== 'object') continue
    if (typeof p.kind === 'string' && NON_ANSWER_KINDS.has(p.kind)) continue
    // Assistant answer: { kind:'markdownContent', content:{ value } } or plain { value }
    if (p.content && typeof (p.content as { value?: unknown }).value === 'string') {
      parts.push((p.content as { value: string }).value)
    } else if (typeof p.value === 'string') {
      parts.push(p.value)
    }
  }
  return parts.join('')
}

function est(text: string): number {
  return text ? Math.ceil(text.length / 4) : 0
}

/**
 * Scan all chat session files and yield turns whose requestId hasn't been seen.
 * Mutates `seen` with newly emitted requestIds.
 */
export function scanNewTurns(wsRoot: string, seen: Set<string>): ChatTurn[] {
  const turns: ChatTurn[] = []
  for (const file of listSessionFiles(wsRoot)) {
    const data = parseSessionFile(file)
    if (!data) continue

    const base = file.endsWith('.jsonl') ? '.jsonl' : '.json'
    const sessionId = String(data.sessionId || path.basename(file, base))
    const project = getProjectForSession(file)
    const requests = Array.isArray(data.requests) ? data.requests : []

    for (const r of requests as Array<Record<string, unknown>>) {
      const requestId = String(r.requestId || '')
      if (!requestId || seen.has(requestId)) continue

      const msg = r.message as { text?: string } | undefined
      const prompt = (msg?.text || '').trim()
      // A request without a finished response yet — skip for now, pick up next scan
      const hasResult = r.result !== undefined || r.completionTokens !== undefined
      if (!prompt || !hasResult) continue

      const response = extractResponseText(r.response)
      const model = String(r.modelId || 'copilot')
      const ts = typeof r.timestamp === 'number'
        ? new Date(r.timestamp).toISOString()
        : new Date().toISOString()

      const completionTokens = typeof r.completionTokens === 'number' ? r.completionTokens : 0

      turns.push({
        sessionId,
        requestId,
        prompt,
        response,
        model,
        timestamp: ts,
        inputTokens: est(prompt),
        outputTokens: completionTokens || est(response),
        projectPath: project.projectPath,
        projectName: project.projectName,
      })
      seen.add(requestId)
    }
  }
  // Sort chronologically so events arrive in order
  turns.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
  return turns
}

// ── Persisted "seen" set ────────────────────────────────────────────────────

export function loadSeen(stateFile: string): Set<string> {
  try {
    const arr = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
    if (Array.isArray(arr)) return new Set(arr.map(String))
  } catch { /* ignore */ }
  return new Set()
}

export function saveSeen(stateFile: string, seen: Set<string>): void {
  try {
    // Cap to last 5000 ids to keep file bounded
    const arr = [...seen].slice(-5000)
    fs.writeFileSync(stateFile, JSON.stringify(arr))
  } catch { /* ignore */ }
}
