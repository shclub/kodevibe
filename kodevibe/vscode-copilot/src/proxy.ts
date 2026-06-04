import * as net from 'net'
import * as tls from 'tls'
import * as http from 'http'
import * as fs from 'fs'
import * as path from 'path'
import * as cp from 'child_process'
import * as os from 'os'

function opensslPath(): string {
  if (os.platform() === 'win32') {
    const candidates = [
      'openssl',
      'C:\\Program Files\\Git\\usr\\bin\\openssl.exe',
      'C:\\Windows\\System32\\openssl.exe',
    ]
    for (const c of candidates) {
      try { cp.execSync(`"${c}" version`, { stdio: 'ignore' }); return c } catch { /* try next */ }
    }
    throw new Error('openssl not found. Install Git for Windows or OpenSSL.')
  }
  return 'openssl'
}

const OPENSSL = opensslPath()

export const PROXY_PORT = 7878

// Copilot API hosts to intercept
const COPILOT_HOSTS = new Set([
  'api.githubcopilot.com',
  'api.enterprise.githubcopilot.com',
  'copilot-proxy.githubusercontent.com',
  'proxy.individual.githubcopilot.com',
  'proxy.business.githubcopilot.com',
  'proxy.enterprise.githubcopilot.com',
])

function isCopilotHost(hostname: string): boolean {
  return hostname.endsWith('.githubcopilot.com') ||
         hostname.endsWith('.copilot.github.com') ||
         hostname === 'copilot-proxy.githubusercontent.com'
}

interface CertCache {
  key: Buffer
  cert: Buffer
}

let caKey: Buffer
let caCert: Buffer
const certCache = new Map<string, CertCache>()

export function initCA(storagePath: string): void {
  fs.mkdirSync(storagePath, { recursive: true })
  const caKeyPath = path.join(storagePath, 'ca.key.pem')
  const caCertPath = path.join(storagePath, 'ca.cert.pem')

  if (!fs.existsSync(caKeyPath)) {
    cp.execSync(`"${OPENSSL}" genrsa -out "${caKeyPath}" 2048`, { stdio: 'ignore' })
    cp.execSync(
      `"${OPENSSL}" req -new -x509 -key "${caKeyPath}" -out "${caCertPath}" -days 3650 -subj "/CN=KodeVibe CA/O=KodeVibe"`,
      { stdio: 'ignore' }
    )
  }

  caKey = fs.readFileSync(caKeyPath)
  caCert = fs.readFileSync(caCertPath)
}

function getCert(hostname: string, storagePath: string): CertCache {
  if (certCache.has(hostname)) return certCache.get(hostname)!

  const keyPath  = path.join(storagePath, `${hostname}.key.pem`)
  const csrPath  = path.join(storagePath, `${hostname}.csr.pem`)
  const certPath = path.join(storagePath, `${hostname}.cert.pem`)
  const caKeyPath  = path.join(storagePath, 'ca.key.pem')
  const caCertPath = path.join(storagePath, 'ca.cert.pem')
  const extPath  = path.join(storagePath, `${hostname}.ext`)

  if (!fs.existsSync(keyPath)) {
    fs.writeFileSync(extPath, `subjectAltName=DNS:${hostname}`)
    cp.execSync(`"${OPENSSL}" genrsa -out "${keyPath}" 2048`, { stdio: 'ignore' })
    cp.execSync(
      `"${OPENSSL}" req -new -key "${keyPath}" -out "${csrPath}" -subj "/CN=${hostname}"`,
      { stdio: 'ignore' }
    )
    cp.execSync(
      `"${OPENSSL}" x509 -req -in "${csrPath}" -CA "${caCertPath}" -CAkey "${caKeyPath}" -CAcreateserial -out "${certPath}" -days 365 -extfile "${extPath}"`,
      { stdio: 'ignore' }
    )
  }

  const cert: CertCache = {
    key: fs.readFileSync(keyPath),
    cert: fs.readFileSync(certPath),
  }
  certCache.set(hostname, cert)
  return cert
}

export let debugLog: (msg: string) => void = () => {}
export function setDebugLog(fn: (msg: string) => void) { debugLog = fn }

export type ChatEvent = {
  model: string
  inputTokens: number
  outputTokens: number
  durationMs: number
  promptLength: number
  messages: Array<{ role: string; content: string }>
}

let _storagePath = ''

export function startProxy(
  storagePath: string,
  onChatEvent: (ev: ChatEvent) => void
): http.Server {
  _storagePath = storagePath
  const server = http.createServer()

  // Log all incoming HTTP requests (non-CONNECT)
  server.on('request', (req) => {
    debugLog(`[HTTP] ${req.method} ${req.url}`)
  })

  // Log raw connections to see what's actually coming in
  server.on('connection', (socket) => {
    let logged = false
    socket.once('data', (chunk) => {
      if (!logged) {
        logged = true
        debugLog(`[RAW] ${chunk.slice(0, 200).toString().split('\r\n')[0]}`)
      }
    })
  })

  server.on('connect', (req, clientStream, head) => {
    const clientSocket = clientStream as unknown as net.Socket
    const [hostname, portStr] = (req.url || '').split(':')
    const port = parseInt(portStr || '443', 10)

    const isCopilot = COPILOT_HOSTS.has(hostname) || isCopilotHost(hostname)
    debugLog(`[CONNECT] ${hostname}:${port} → ${isCopilot ? 'track' : 'passthrough'}`)

    const serverSocket = net.connect(port, hostname, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) serverSocket.write(head)

      if (isCopilot) {
        // Byte-counting passthrough: no TLS decryption, debounce per response burst
        let reqBytes = 0
        let resBytes = 0
        let reqStart = 0
        let debounce: NodeJS.Timeout | undefined

        clientSocket.on('data', (chunk: Buffer) => {
          reqBytes += chunk.length
          serverSocket.write(chunk)
          if (!reqStart) reqStart = Date.now()
        })

        serverSocket.on('data', (chunk: Buffer) => {
          resBytes += chunk.length
          clientSocket.write(chunk)

          // Debounce: emit event 1s after last server data (= end of one response)
          clearTimeout(debounce)
          debounce = setTimeout(() => {
            if (resBytes < 200) { resBytes = 0; reqBytes = 0; reqStart = 0; return }
            const durationMs = Date.now() - (reqStart || Date.now())
            const outTokens = Math.round(resBytes / 16)
            const inTokens  = Math.round(reqBytes  / 16)
            debugLog(`[track] ${hostname} req=${reqBytes}B res=${resBytes}B dur=${durationMs}ms out≈${outTokens}tok`)
            onChatEvent({
              model: 'copilot-enterprise',
              inputTokens: inTokens,
              outputTokens: outTokens,
              durationMs,
              promptLength: reqBytes,
              messages: [],
            })
            // Reset for next request on same persistent connection
            reqBytes = 0; resBytes = 0; reqStart = 0
          }, 1000)
        })

        clientSocket.on('error', () => { clearTimeout(debounce); serverSocket.destroy() })
        serverSocket.on('error', () => { clearTimeout(debounce); clientSocket.destroy() })
      } else {
        serverSocket.pipe(clientSocket)
        clientSocket.pipe(serverSocket)
        serverSocket.on('error', () => clientSocket.destroy())
        clientSocket.on('error', () => serverSocket.destroy())
      }
    })

    serverSocket.on('error', () => clientSocket.destroy())
  })

  server.listen(PROXY_PORT)
  return server
}

function handleMitm(
  hostname: string,
  port: number,
  clientSocket: net.Socket,
  head: Buffer,
  onChatEvent: (ev: ChatEvent) => void
): void {
  clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')

  let cert: CertCache
  try {
    cert = getCert(hostname, _storagePath)
  } catch {
    // Cert generation failed — passthrough without interception
    const srv = net.connect(port, hostname, () => {
      if (head.length) srv.write(head)
      clientSocket.pipe(srv)
      srv.pipe(clientSocket)
    })
    srv.on('error', () => clientSocket.destroy())
    return
  }

  // TLS server-side socket (VS Code → us)
  const tlsServer = new tls.TLSSocket(clientSocket, {
    isServer: true,
    key: cert.key,
    cert: cert.cert,
    rejectUnauthorized: false,
  })

  // TLS client-side socket (us → real Copilot)
  const tlsClient = tls.connect({
    host: hostname,
    port,
    servername: hostname,
    rejectUnauthorized: false,
  })

  tlsClient.on('error', () => { try { tlsServer.destroy() } catch {} })
  tlsServer.on('error', () => { try { tlsClient.destroy() } catch {} })

  // ── Request interception ─────────────────────────────────────────────
  let reqHeadersDone = false
  let isChatRequest = false
  let reqBody = ''
  let reqStart = 0
  let reqHeaderBuf = ''

  tlsServer.on('data', (chunk: Buffer) => {
    tlsClient.write(chunk)
    const text = chunk.toString()

    if (!reqHeadersDone) {
      reqHeaderBuf += text
      const sep = reqHeaderBuf.indexOf('\r\n\r\n')
      if (sep !== -1) {
        reqHeadersDone = true
        const headers = reqHeaderBuf.slice(0, sep)
        const firstLine = headers.split('\r\n')[0]
        debugLog(`[proxy:${hostname}] ${firstLine}`)
        // Match any POST to any path (log all, filter for completions)
        isChatRequest = headers.startsWith('POST')
        if (isChatRequest) {
          debugLog(`[proxy] POST captured: ${hostname} ${firstLine}`)
        }
        if (isChatRequest) {
          debugLog(`[proxy] chat captured: ${hostname} ${firstLine}`)
          reqBody = reqHeaderBuf.slice(sep + 4)
          reqStart = Date.now()
        }
        reqHeaderBuf = ''
      }
    } else if (isChatRequest) {
      reqBody += text
    }
  })

  // ── Response interception ────────────────────────────────────────────
  let resHeadersDone = false
  let resHeaderBuf = ''
  let isStreaming = false
  // SSE streaming: accumulate token counts across chunks
  let sseOutputTokens = 0
  let sseInputTokens = 0
  let sseModel = 'copilot-chat'
  let resBuf = ''

  tlsClient.on('data', (chunk: Buffer) => {
    tlsServer.write(chunk)
    if (!isChatRequest) return

    const text = chunk.toString()

    if (!resHeadersDone) {
      resHeaderBuf += text
      const sep = resHeaderBuf.indexOf('\r\n\r\n')
      if (sep === -1) return
      resHeadersDone = true
      isStreaming = resHeaderBuf.includes('text/event-stream') ||
                   resHeaderBuf.includes('Transfer-Encoding: chunked')
      resBuf = resHeaderBuf.slice(sep + 4)
      resHeaderBuf = ''
    } else {
      resBuf += text
    }

    if (isStreaming) {
      // Parse SSE lines: "data: {...}"
      const lines = resBuf.split('\n')
      resBuf = lines.pop() ?? ''  // keep incomplete line

      for (const line of lines) {
        const trimmed = line.trim()
        if (trimmed === 'data: [DONE]') {
          // Stream finished — emit event
          if (sseOutputTokens > 0 || sseInputTokens > 0) {
            emitChatEvent()
          }
          resetState()
          return
        }
        if (!trimmed.startsWith('data: ')) continue
        try {
          const json = JSON.parse(trimmed.slice(6))
          if (json.model) sseModel = json.model
          // usage in final chunk (some providers send it)
          if (json.usage) {
            sseInputTokens = json.usage.prompt_tokens || sseInputTokens
            sseOutputTokens = json.usage.completion_tokens || sseOutputTokens
          }
          // count output tokens from delta content
          const content = json.choices?.[0]?.delta?.content
          if (content) sseOutputTokens += Math.ceil(content.length / 4)
        } catch { /* skip */ }
      }
    } else {
      // Non-streaming: wait for complete response body
      if (!resBuf.includes('"choices"')) return
      try {
        const json = JSON.parse(resBuf)
        sseModel = json.model || 'copilot-chat'
        sseInputTokens = json.usage?.prompt_tokens || 0
        sseOutputTokens = json.usage?.completion_tokens || 0
        emitChatEvent()
        resetState()
      } catch { /* incomplete body, wait for more data */ }
    }
  })

  function emitChatEvent() {
    try {
      const reqJson = JSON.parse(reqBody)
      // Only emit if this is actually a chat/completions request
      if (!reqJson.messages) return
      sseModel = sseModel || reqJson.model || 'copilot-chat'
      debugLog(`[proxy] emit chat: model=${sseModel} in=${sseInputTokens} out=${sseOutputTokens}`)
      onChatEvent({
        model: sseModel,
        inputTokens: sseInputTokens || Math.ceil(JSON.stringify(reqJson.messages).length / 4),
        outputTokens: sseOutputTokens,
        durationMs: Date.now() - reqStart,
        promptLength: JSON.stringify(reqJson.messages).length,
        messages: reqJson.messages.slice(-2),
      })
    } catch (e) {
      debugLog(`[proxy] emitChatEvent error: ${e}`)
    }
  }

  function resetState() {
    reqHeadersDone = false; isChatRequest = false; reqBody = ''; reqStart = 0; reqHeaderBuf = ''
    resHeadersDone = false; resHeaderBuf = ''; isStreaming = false
    sseOutputTokens = 0; sseInputTokens = 0; sseModel = 'copilot-chat'; resBuf = ''
  }

  if (head.length) tlsClient.write(head)
}
