import * as vscode from 'vscode'
import * as path from 'path'
import { sendLogs, type LogEvent } from './telemetry'
import { getConfig, resolveEmail, resolveUserId, notifyEmailConfig, estimateTokens, extractInserted, type SessionInfo } from './session'
import { getWorkspaceStorageRoot, scanNewTurns, loadSeen, saveSeen, type ChatTurn } from './watcher'
import { installQuotaCapture, type QuotaInfo } from './quota'
import { randomUUID } from 'crypto'

let info: SessionInfo
let userEmail = 'unknown'
let pendingLogs: LogEvent[] = []
let flushTimer: NodeJS.Timeout | undefined

// ── Flush ─────────────────────────────────────────────────────────────────

function enqueue(ev: LogEvent) {
  if (!info?.enabled) return
  pendingLogs.push(ev)
}

function startFlushTimer(ctx: vscode.ExtensionContext) {
  flushTimer = setInterval(() => flush(), 5000)
  ctx.subscriptions.push({ dispose: () => { clearInterval(flushTimer); flush() } })
}

function flush() {
  if (!pendingLogs.length) return
  const batch = pendingLogs.splice(0)
  sendLogs(info.serverUrl, batch)
}

function resourceAttrs(): Record<string, string> {
  return {
    'service.name': 'copilot',
    'service.version': '0.1.0',
    'zeude.user.email': userEmail,
    'zeude.user.id': info.userId || '',
    'tool': 'vscode',
  }
}

// ── Session start ─────────────────────────────────────────────────────────

function sendSessionStart() {
  enqueue({
    timestamp: new Date().toISOString(),
    body: 'copilot.session_start',
    attributes: {
      'session.id': info.sessionId,
      'user.email': userEmail,
      'user.id': info.userId || '',
      'editor': 'vscode',
    },
    resourceAttributes: resourceAttrs(),
  })
}

// ── Chat turn (from local session JSON) → OTel ────────────────────────────

function onChatTurn(turn: ChatTurn) {
  const promptText = turn.prompt.slice(0, 8000)
  const responseText = turn.response.slice(0, 8000)

  // chat_request: token/model/billing metrics. session.id = VS Code chat session.
  enqueue({
    timestamp: turn.timestamp,
    body: 'copilot.chat_request',
    attributes: {
      'session.id': turn.sessionId,
      'prompt.id': turn.requestId,
      'user.email': userEmail,
      'user.id': info.userId || '',
      'input_tokens': String(turn.inputTokens),
      'output_tokens': String(turn.outputTokens),
      'cache_read_tokens': '0',
      'cache_creation_tokens': '0',
      'cost_usd': '0',
      'duration_ms': '0',
      'model': turn.model,
      'prompt_length': String(promptText.length),
      'query_source': 'copilot_chat',
      'billing_type': 'ai_credits',
      'prompt': promptText,
      ...(responseText ? { 'response': responseText } : {}),
      ...(turn.projectPath ? { 'project_path': turn.projectPath, 'working_directory': turn.projectPath } : {}),
      ...(turn.projectName ? { 'project_name': turn.projectName } : {}),
    },
    resourceAttributes: turnResourceAttrs(turn),
  })

  // user_prompt: so prompt-text dashboards pick it up
  enqueue({
    timestamp: turn.timestamp,
    body: 'copilot.user_prompt',
    attributes: {
      'session.id': turn.sessionId,
      'prompt.id': turn.requestId,
      'user.email': userEmail,
      'user.id': info.userId || '',
      'prompt': promptText,
      'prompt_length': String(promptText.length),
      'query_source': 'copilot_chat',
      ...(turn.projectPath ? { 'project_path': turn.projectPath, 'working_directory': turn.projectPath } : {}),
      ...(turn.projectName ? { 'project_name': turn.projectName } : {}),
    },
    resourceAttributes: turnResourceAttrs(turn),
  })
}

// Resource attrs for a turn — include project so dashboards group by real folder name
function turnResourceAttrs(turn: ChatTurn): Record<string, string> {
  const attrs = resourceAttrs()
  if (turn.projectPath) {
    attrs['zeude.project_path'] = turn.projectPath
    attrs['zeude.working_directory'] = turn.projectPath
  }
  return attrs
}

// ── Quota / AI credits → OTel ─────────────────────────────────────────────

let lastQuotaSig = ''

function onQuota(q: QuotaInfo) {
  // De-dupe: only emit when the snapshot actually changes
  const sig = `${q.plan}|${q.premiumRemaining}|${q.premiumEntitlement}`
  if (sig === lastQuotaSig) return
  lastQuotaSig = sig

  const used = (q.premiumEntitlement != null && q.premiumRemaining != null)
    ? Math.max(0, q.premiumEntitlement - q.premiumRemaining)
    : undefined

  enqueue({
    timestamp: new Date().toISOString(),
    body: 'copilot.quota',
    attributes: {
      'session.id': info.sessionId,
      'user.email': userEmail,
      'user.id': info.userId || '',
      'copilot_plan': q.plan,
      'billing_type': 'ai_credits',
      ...(q.premiumEntitlement != null ? { 'ai_credits_entitlement': String(q.premiumEntitlement) } : {}),
      ...(q.premiumRemaining != null ? { 'ai_credits_remaining': String(q.premiumRemaining) } : {}),
      ...(used != null ? { 'ai_credits_used': String(used), 'premium_requests': String(used) } : {}),
      ...(q.premiumPercentRemaining != null ? { 'ai_credits_percent_remaining': String(q.premiumPercentRemaining) } : {}),
    },
    resourceAttributes: resourceAttrs(),
  })
}

// ── Inline suggestion acceptance (Tab) ───────────────────────────────────

async function acceptAndTrack() {
  const editor = vscode.window.activeTextEditor
  if (!editor) {
    await vscode.commands.executeCommand('editor.action.inlineSuggest.commit')
    return
  }

  const docBefore = editor.document.getText()
  const tsBefore = Date.now()

  await vscode.commands.executeCommand('editor.action.inlineSuggest.commit')
  await new Promise(r => setTimeout(r, 50))

  const docAfter = editor.document.getText()
  const inserted = extractInserted(docBefore, docAfter)
  if (!inserted.trim()) return

  enqueue({
    timestamp: new Date().toISOString(),
    body: 'copilot.inline_accepted',
    attributes: {
      'session.id': info.sessionId,
      'prompt.id': randomUUID(),
      'user.email': userEmail,
      'user.id': info.userId || '',
      'input_tokens': '0',
      'output_tokens': String(estimateTokens(inserted)),
      'cache_read_tokens': '0',
      'cache_creation_tokens': '0',
      'cost_usd': '0',
      'duration_ms': String(Date.now() - tsBefore),
      'model': 'copilot-inline',
      'language': editor.document.languageId,
      'file_path': vscode.workspace.asRelativePath(editor.document.uri),
      'suggestion_chars': String(inserted.length),
      'suggestion_lines': String(inserted.split('\n').length),
    },
    resourceAttributes: resourceAttrs(),
  })
}

// ── Chat → Apply in editor detection ─────────────────────────────────────


// ── @kodevibe chat participant (optional) ─────────────────────────────────

function registerChatParticipant(ctx: vscode.ExtensionContext) {
  try {
    const participant = (vscode.chat as typeof vscode.chat).createChatParticipant(
      'kodevibe.copilot',
      async (request, _context, stream, token) => {
        const promptId = randomUUID()
        const tsBefore = Date.now()
        let outputText = ''

        try {
          const [model] = await vscode.lm.selectChatModels({ vendor: 'copilot', family: 'gpt-4o' })
          if (!model) { stream.markdown('*(Copilot 모델 없음)*'); return }
          const resp = await model.sendRequest(
            [vscode.LanguageModelChatMessage.User(request.prompt)], {}, token
          )
          for await (const chunk of resp.text) { outputText += chunk; stream.markdown(chunk) }
        } catch (err) { stream.markdown(`*(오류: ${err})*`) }

        enqueue({
          timestamp: new Date().toISOString(),
          body: 'copilot.chat_request',
          attributes: {
            'session.id': info.sessionId,
            'prompt.id': promptId,
            'user.email': userEmail,
            'user.id': info.userId || '',
            'input_tokens': String(estimateTokens(request.prompt)),
            'output_tokens': String(estimateTokens(outputText)),
            'cache_read_tokens': '0',
            'cache_creation_tokens': '0',
            'cost_usd': '0',
            'duration_ms': String(Date.now() - tsBefore),
            'model': 'copilot-chat',
            'prompt_length': String(request.prompt.length),
            'query_source': 'vscode_chat_participant',
            'billing_type': 'ai_credits',
          },
          resourceAttributes: resourceAttrs(),
        })
      }
    )
    ctx.subscriptions.push(participant)
  } catch { /* VS Code 버전 미지원 */ }
}

// ── Chat session watcher ──────────────────────────────────────────────────

function startChatSessionWatcher(ctx: vscode.ExtensionContext, debugLog: (m: string) => void) {
  const wsRoot = getWorkspaceStorageRoot(ctx.globalStorageUri.fsPath)
  const stateFile = path.join(ctx.globalStorageUri.fsPath, 'seen-requests.json')
  const seen = loadSeen(stateFile)
  let firstScan = true

  debugLog(`[watcher] chat session root: ${wsRoot}`)

  const scan = () => {
    if (!info.enabled) return
    try {
      const turns = scanNewTurns(wsRoot, seen)
      if (firstScan) {
        // On first run, mark existing turns as seen WITHOUT sending (avoid backfilling history)
        firstScan = false
        saveSeen(stateFile, seen)
        debugLog(`[watcher] baseline: ${seen.size} existing turns marked seen`)
        return
      }
      if (turns.length) {
        for (const t of turns) {
          onChatTurn(t)
          debugLog(`[watcher] turn session=${t.sessionId.slice(0, 8)} model=${t.model} promptLen=${t.prompt.length} respLen=${t.response.length}`)
        }
        saveSeen(stateFile, seen)
      }
    } catch (e) {
      debugLog(`[watcher] scan error: ${e}`)
    }
  }

  scan() // baseline immediately
  const timer = setInterval(scan, 5000)
  ctx.subscriptions.push({ dispose: () => clearInterval(timer) })
}

// ── Activation ────────────────────────────────────────────────────────────

export async function activate(ctx: vscode.ExtensionContext) {
  info = getConfig()
  if (!info.enabled) return

  const outputChannel = vscode.window.createOutputChannel('KodeVibe')
  ctx.subscriptions.push(outputChannel)
  const debugLogPath = require('path').join(ctx.globalStorageUri.fsPath, 'debug.log')
  try { require('fs').mkdirSync(ctx.globalStorageUri.fsPath, { recursive: true }) } catch {}
  const debugLog = (msg: string) => {
    outputChannel.appendLine(msg)
    try { require('fs').appendFileSync(debugLogPath, `${new Date().toISOString()} ${msg}\n`) } catch {}
  }

  userEmail = await resolveEmail(info)
  // Resolve KodeVibe UUID so telemetry unifies identity across all sources;
  // if no UUID is found, fall back to the email's local part (before @).
  const resolvedId = await resolveUserId(info, userEmail)
  if (resolvedId) {
    info.userId = resolvedId
  } else if (!info.userId && userEmail && userEmail !== 'unknown') {
    info.userId = userEmail.split('@')[0]
  }
  debugLog(`KodeVibe activated. user=${userEmail} userId=${info.userId || '(none)'}`)
  notifyEmailConfig(userEmail)

  // Watch VS Code's local chat session store for Copilot chat prompts/responses.
  // (Network interception is impossible: chat runs in VS Code core + TLS pinning.)
  startChatSessionWatcher(ctx, debugLog)

  // Capture Copilot quota / AI credits from copilot_internal/user responses
  installQuotaCapture(onQuota, debugLog)

  // Tab intercept
  ctx.subscriptions.push(
    vscode.commands.registerCommand('kodevibe.acceptSuggestion', acceptAndTrack)
  )

  // Optional @kodevibe participant
  registerChatParticipant(ctx)

  startFlushTimer(ctx)
  sendSessionStart()

  ctx.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('kodevibe')) {
        info = getConfig()
      }
    })
  )

  // Toggle command
  ctx.subscriptions.push(
    vscode.commands.registerCommand('kodevibe.toggle', async () => {
      const current = vscode.workspace.getConfiguration('kodevibe').get<boolean>('enabled', true)
      await vscode.workspace.getConfiguration('kodevibe').update('enabled', !current, vscode.ConfigurationTarget.Global)
      info = getConfig()
      updateBar()
      vscode.window.showInformationMessage(`KodeVibe 추적 ${!current ? '활성화' : '비활성화'} 됨`)
    })
  )

  const bar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)
  bar.command = 'kodevibe.toggle'

  function updateBar() {
    const on = info.enabled
    bar.text = on ? '$(pulse) KodeVibe' : '$(circle-slash) KodeVibe'
    bar.tooltip = [
      `KodeVibe ${on ? '추적 중 (클릭하여 끄기)' : '꺼짐 (클릭하여 켜기)'}`,
      `유저: ${userEmail}`,
      '방식: in-process hook',
    ].join('\n')
    bar.color = on ? undefined : new vscode.ThemeColor('statusBarItem.warningForeground')
  }

  updateBar()
  bar.show()

  ctx.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('kodevibe.enabled')) updateBar()
    })
  )
  ctx.subscriptions.push(bar)
}

export function deactivate() {
  flush()
}
