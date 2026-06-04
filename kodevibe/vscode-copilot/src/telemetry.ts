import * as https from 'https'
import * as http from 'http'
import { randomUUID } from 'crypto'
// newSessionId kept for backward compatibility but vscode.env.sessionId is preferred


export interface LogEvent {
  timestamp: string   // ISO
  body: string        // event name
  attributes: Record<string, string>
  resourceAttributes: Record<string, string>
}

export function sendLogs(serverUrl: string, events: LogEvent[]): void {
  if (!events.length) return

  const now = Date.now()

  const payload = {
    resourceLogs: [{
      resource: {
        attributes: buildAttrs(events[0].resourceAttributes),
      },
      scopeLogs: [{
        scope: { name: 'kodevibe-copilot', version: '0.1.0' },
        logRecords: events.map(ev => ({
          timeUnixNano: String(new Date(ev.timestamp).getTime() * 1_000_000),
          observedTimeUnixNano: String(now * 1_000_000),
          severityNumber: 9,
          severityText: 'INFO',
          body: { stringValue: ev.body },
          attributes: buildAttrs(ev.attributes),
          traceId: '',
          spanId: '',
          flags: 0,
        })),
      }],
    }],
  }

  const body = JSON.stringify(payload)
  const url = new URL('/v1/logs', serverUrl)
  const mod = url.protocol === 'https:' ? https : http

  const req = mod.request({
    hostname: url.hostname,
    port: url.port || (url.protocol === 'https:' ? 443 : 80),
    path: url.pathname,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    },
  })

  req.on('error', () => { /* silently ignore — telemetry must not disrupt dev work */ })
  req.write(body)
  req.end()
}

function buildAttrs(obj: Record<string, string>) {
  return Object.entries(obj).map(([key, value]) => ({
    key,
    value: { stringValue: String(value) },
  }))
}

export function newSessionId(): string {
  return randomUUID()
}
