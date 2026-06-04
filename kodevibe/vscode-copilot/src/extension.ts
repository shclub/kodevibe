import * as vscode from 'vscode'
import * as http from 'http'
import { sendLogs, type LogEvent } from './telemetry'
import { getConfig, resolveEmail, estimateTokens, extractInserted, type SessionInfo } from './session'
import { startProxy, initCA, PROXY_PORT, setDebugLog, type ChatEvent } from './proxy'
import { randomUUID } from 'crypto'

let info: SessionInfo
let userEmail = 'unknown'
let pendingLogs: LogEvent[] = []
let flushTimer: NodeJS.Timeout | undefined
let proxyServer: http.Server | undefined

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

// ── Proxy chat event → OTel ───────────────────────────────────────────────

function onChatEvent(ev: ChatEvent) {
  enqueue({
    timestamp: new Date().toISOString(),
    body: 'copilot.chat_request',
    attributes: {
      'session.id': info.sessionId,
      'prompt.id': randomUUID(),
      'user.email': userEmail,
      'user.id': info.userId || '',
      'input_tokens': String(ev.inputTokens),
      'output_tokens': String(ev.outputTokens),
      'cache_read_tokens': '0',
      'cache_creation_tokens': '0',
      'cost_usd': '0',
      'duration_ms': String(ev.durationMs),
      'model': ev.model,
      'prompt_length': String(ev.promptLength),
      'query_source': 'copilot_chat',
      'billing_type': 'ai_credits',
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

let lastTypingTime = 0

function trackDocumentChanges(ctx: vscode.ExtensionContext) {
  ctx.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument(event => {
      for (const change of event.contentChanges) {
        const lines = (change.text.match(/\n/g) || []).length + 1
        const timeSinceTyping = Date.now() - lastTypingTime

        if (lines >= 3 && timeSinceTyping > 500 && change.text.trim().length > 0) {
          const outputTokens = estimateTokens(change.text)
          enqueue({
            timestamp: new Date().toISOString(),
            body: 'copilot.chat_applied',
            attributes: {
              'session.id': info.sessionId,
              'prompt.id': randomUUID(),
              'user.email': userEmail,
              'user.id': info.userId || '',
              'input_tokens': '0',
              'output_tokens': String(outputTokens),
              'cache_read_tokens': '0',
              'cache_creation_tokens': '0',
              'cost_usd': '0',
              'duration_ms': '0',
              'model': 'copilot-chat',
              'language': event.document.languageId,
              'file_path': vscode.workspace.asRelativePath(event.document.uri),
              'suggestion_chars': String(change.text.length),
              'suggestion_lines': String(lines),
            },
            resourceAttributes: resourceAttrs(),
          })
        } else if (change.text.length <= 10) {
          lastTypingTime = Date.now()
        }
      }
    })
  )
}

// ── Proxy setup & notification ────────────────────────────────────────────

function startProxyServer(storagePath: string) {
  try {
    initCA(storagePath)
    proxyServer = startProxy(storagePath, onChatEvent)
    proxyServer.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        vscode.window.showWarningMessage(`KodeVibe: 포트 ${PROXY_PORT}이 이미 사용 중입니다.`)
      }
    })
  } catch (err) {
    vscode.window.showErrorMessage(`KodeVibe: 프록시 시작 실패 — ${err}`)
  }
}

function checkProxyConfig() {
  const cfg = vscode.workspace.getConfiguration()
  const proxy = cfg.get<string>('http.proxy', '')
  const strictSSL = cfg.get<boolean>('http.proxyStrictSSL', true)

  const needsProxy = !proxy.includes(String(PROXY_PORT))
  const needsSSL = strictSSL !== false

  if (needsProxy || needsSSL) {
    vscode.window.showInformationMessage(
      `KodeVibe: Copilot Chat 완전 추적을 위해 VS Code settings.json에 다음을 추가하세요:`,
      '자동 설정',
      '나중에'
    ).then(choice => {
      if (choice === '자동 설정') {
        cfg.update('http.proxy', `http://localhost:${PROXY_PORT}`, vscode.ConfigurationTarget.Global)
        cfg.update('http.proxyStrictSSL', false, vscode.ConfigurationTarget.Global)
        vscode.window.showInformationMessage('KodeVibe: 프록시 설정 완료! VS Code를 재시작하세요.')
      }
    })
  }
}

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

// ── Activation ────────────────────────────────────────────────────────────

export async function activate(ctx: vscode.ExtensionContext) {
  info = getConfig()
  if (!info.enabled) return

  const outputChannel = vscode.window.createOutputChannel('KodeVibe')
  ctx.subscriptions.push(outputChannel)
  setDebugLog((msg: string) => outputChannel.appendLine(msg))

  userEmail = await resolveEmail(info)
  outputChannel.appendLine(`KodeVibe activated. user=${userEmail}`)

  // Start MITM proxy for mandatory chat tracking
  startProxyServer(ctx.globalStorageUri.fsPath)
  checkProxyConfig()

  // Tab intercept
  ctx.subscriptions.push(
    vscode.commands.registerCommand('kodevibe.acceptSuggestion', acceptAndTrack)
  )

  // Chat → Apply detection
  trackDocumentChanges(ctx)

  // Optional @kodevibe participant
  registerChatParticipant(ctx)

  startFlushTimer(ctx)
  sendSessionStart()

  ctx.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('kodevibe')) {
        info = { ...getConfig(), sessionId: info.sessionId }
      }
    })
  )

  // Toggle command
  ctx.subscriptions.push(
    vscode.commands.registerCommand('kodevibe.toggle', async () => {
      const current = vscode.workspace.getConfiguration('kodevibe').get<boolean>('enabled', true)
      await vscode.workspace.getConfiguration('kodevibe').update('enabled', !current, vscode.ConfigurationTarget.Global)
      info = { ...getConfig(), sessionId: info.sessionId }
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
      `프록시: localhost:${PROXY_PORT}`,
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
  proxyServer?.close()
  flush()
}
