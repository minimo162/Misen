import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { basename, join } from 'node:path'
import { PROMPTS } from '../../demo/enterprise-excel/fixtures.js'
import { SYNTHETIC_MONTHS } from '../../demo/enterprise-excel/fixtures.js'
import { liveAgent } from '../runtime/live.js'
import { WorkspaceBoundary } from '../workspace/boundary.js'
import type { AgentEvent } from '@earendil-works/pi-agent-core'
import { snapshotOutputScope, validateReport } from '../acceptance/validator.js'

export interface DemoResult {
  output: string
  tools: string[]
  axes: string[]
  status?: 'PASS' | 'FAIL' | 'CANCELLED'
}

/**
 * UI-safe event data. Provider payloads, raw assistant messages, and reasoning
 * parts never cross this boundary; only the visible answer and allowlisted
 * process labels are emitted.
 */
export type DemoEvent =
  | { type: 'user'; id: string; text: string }
  | { type: 'assistant'; text: string; done?: boolean }
  | { type: 'tool'; phase: 'start' | 'end'; id: string; name: string; detail?: string; status?: 'success' | 'error' }
  | { type: 'status'; status: 'running' | 'PASS' | 'FAIL' | 'CANCELLED'; error?: string }

export interface DemoRunContext {
  emit: (event: DemoEvent) => void
  setCancel: (cancel: () => void) => void
}

export type DemoRunner = (root: string, month: '7月' | '8月', prompt: string, context?: DemoRunContext) => Promise<DemoResult>

const TOOL_LABELS: Record<string, string> = {
  workspace_list_files: 'List workspace files',
  workspace_read_text: 'Read handoff',
  spreadsheet_read: 'Read spreadsheet',
  spreadsheet_create_output: 'Create workbook',
  spreadsheet_update: 'Update spreadsheet',
}

function textFromAssistantMessage(message: unknown): string {
  if (!message || typeof message !== 'object') return ''
  const content = (message as { content?: unknown }).content
  if (!Array.isArray(content)) return ''
  return content
    .filter((part): part is { type: 'text'; text: string } => Boolean(part && typeof part === 'object' && (part as any).type === 'text' && typeof (part as any).text === 'string'))
    .map(part => part.text)
    .join('')
}

function safeToolDetail(name: string, args: unknown): string | undefined {
  if (!args || typeof args !== 'object') return undefined
  const record = args as Record<string, unknown>
  const candidate = name === 'spreadsheet_create_output'
    ? record.output
    : name === 'spreadsheet_update' || name === 'spreadsheet_read'
      ? record.workbook
      : record.path
  if (typeof candidate !== 'string' || candidate.length === 0 || candidate.length > 260) return undefined
  const normalized = candidate.replace(/\\/gu, '/').split('/').filter(Boolean).at(-1)
  return normalized && !normalized.includes('..') ? normalized : undefined
}

function forwardAgentEvent(event: AgentEvent, context: DemoRunContext, tools: string[]): void {
  if (event.type === 'tool_execution_start') {
    tools.push(event.toolName)
    context.emit({ type: 'tool', phase: 'start', id: event.toolCallId, name: event.toolName, detail: safeToolDetail(event.toolName, event.args) })
    return
  }
  if (event.type === 'tool_execution_end') {
    context.emit({ type: 'tool', phase: 'end', id: event.toolCallId, name: event.toolName, detail: safeToolDetail(event.toolName, undefined), status: event.isError ? 'error' : 'success' })
    return
  }
  if (event.type === 'message_update' || event.type === 'message_end') {
    // Only visible text parts are exposed. Reasoning and raw provider metadata
    // remain inside Pi's process and are intentionally omitted from SSE.
    const text = textFromAssistantMessage(event.message)
    if (text) context.emit({ type: 'assistant', text })
  }
}

/** Live Pi route. Existing deterministic runners can continue to use two args. */
export const liveDemoRunner: DemoRunner = async (root, month, prompt, context) => {
  const scenario = SYNTHETIC_MONTHS.find(item => item.month === month)
  if (!scenario) throw new Error('scenario unavailable')
  const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
  const inputs = ['master.xlsx', '月次管理レポート_template.xlsx', ...scenario.companies.map(company => `${month}/${company.company}.xlsx`)]
  const before = new Map(await Promise.all(inputs.map(async path => [path, hash(await readFile(join(root, path)))] as const)))
  const outputBefore = await snapshotOutputScope(root)
  const agent = liveAgent(root)
  const tools: string[] = []
  context?.setCancel(() => agent.abort())
  const unsubscribe = agent.subscribe(event => { if (context) forwardAgentEvent(event, context, tools) })
  try {
    await agent.prompt(prompt)
    if (agent.state.errorMessage) {
      const latest = agent.state.messages.at(-1) as any
      const cancelled = latest?.role === 'assistant' && latest?.stopReason === 'aborted'
      return { output: `output/${month}-月次管理レポート.xlsx`, tools, axes: [], status: cancelled ? 'CANCELLED' : 'FAIL' }
    }
    const validation = await validateReport(root, scenario, before, outputBefore)
    return { output: validation.output, tools, axes: ['SHEET', 'MONTH', 'ROWS', 'PROFIT_FORMULAS', 'STATUS', 'TOTAL', 'FOOTER', 'FORMAT'], status: 'PASS' }
  } finally {
    unsubscribe()
  }
}

type UiState = {
  status: 'idle' | 'running' | 'PASS' | 'FAIL' | 'CANCELLED'
  runId?: string
  tools: string[]
  axes: string[]
  output?: string
  error?: string
}

const MAX_BODY = 8192
const RUN_ID_RE = /^[A-Za-z0-9_-]{1,80}$/u

function writeEvent(response: ServerResponse, event: DemoEvent | { type: 'state'; state: UiState }): void {
  response.write(`event: ${event.type}\ndata: ${JSON.stringify(event.type === 'state' ? event.state : event)}\n\n`)
}

function hostIsLoopback(value: string): boolean { return /^((127\.0\.0\.1)|(localhost)):\d+$/u.test(value) }

/** RFC 5987 attr-char encoding for a UTF-8 Content-Disposition filename*. */
export function encodeRfc5987Value(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/gu, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)
}

async function readBody(request: IncomingMessage): Promise<string> {
  let body = ''
  for await (const chunk of request) {
    body += Buffer.from(chunk).toString('utf8')
    if (body.length > MAX_BODY) throw new Error('body')
  }
  return body
}

function clientAssetPath(name: string): URL {
  // dist/src/web/server.js -> dist/web/assets/<name>
  return new URL(`../../web/assets/${name}`, import.meta.url)
}

export function createDemoServer(root: string, runner: DemoRunner = liveDemoRunner) {
  const boundary = new WorkspaceBoundary(root)
  let state: UiState = { status: 'idle', tools: [], axes: [] }
  let active = false
  let activeCancel: (() => void) | undefined
  let nextRunId = 0
  const listeners = new Set<ServerResponse>()
  const emit = (event: DemoEvent) => { for (const response of listeners) writeEvent(response, event) }
  const emitState = () => { for (const response of listeners) writeEvent(response, { type: 'state', state }) }

  return createServer(async (request, response) => {
    try {
      const host = request.headers.host ?? ''
      if (!hostIsLoopback(host)) throw new Error('host')
      const url = new URL(request.url ?? '/', `http://${host}`)

      if (request.method === 'GET' && url.pathname === '/') {
        response.setHeader('content-type', 'text/html; charset=utf-8')
        return response.end(`<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Misen</title><link rel="stylesheet" href="/assets/client.css"></head><body><div id="root"></div><script type="module" src="/assets/client.js"></script></body></html>`)
      }
      if (request.method === 'GET' && (url.pathname === '/assets/client.js' || url.pathname === '/assets/client.css')) {
        const name = url.pathname.endsWith('.css') ? 'client.css' : 'client.js'
        const bytes = await readFile(clientAssetPath(name))
        response.setHeader('content-type', name.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8')
        return response.end(bytes)
      }
      if (request.method === 'GET' && url.pathname === '/events') {
        response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive' })
        listeners.add(response)
        writeEvent(response, { type: 'state', state })
        request.on('close', () => listeners.delete(response))
        return
      }
      if (request.method === 'GET' && url.pathname === '/state') {
        response.setHeader('content-type', 'application/json; charset=utf-8')
        return response.end(JSON.stringify(state))
      }
      if (request.method === 'POST' && url.pathname === '/run') {
        if (request.headers.origin !== `http://${host}`) throw new Error('origin')
        if (active) throw new Error('active')
        const params = new URLSearchParams(await readBody(request))
        const prompt = params.get('prompt') ?? ''
        const clientId = params.get('clientId') ?? `server-${++nextRunId}`
        const month = Object.entries(PROMPTS).find(([, value]) => value === prompt)?.[0] as '7月' | '8月' | undefined
        if (!month || !RUN_ID_RE.test(clientId)) throw new Error('prompt')
        active = true
        state = { status: 'running', runId: clientId, tools: [], axes: [] }
        emit({ type: 'status', status: 'running' }); emit({ type: 'user', id: clientId, text: prompt }); emitState()
        try {
          let hasVisibleAssistantText = false
          const runEmit = (event: DemoEvent) => {
            if (event.type === 'assistant' && event.text.trim().length > 0) hasVisibleAssistantText = true
            emit(event)
          }
          const result = await runner(root, month, prompt, { emit: runEmit, setCancel: cancel => { activeCancel = cancel } })
          const status = result.status ?? 'PASS'
          const terminalStatus: Exclude<UiState['status'], 'idle' | 'running'> = status
          state = { status: terminalStatus, runId: clientId, tools: result.tools.slice(0, 20), axes: result.axes, output: status === 'PASS' ? result.output : undefined }
          if (status !== 'PASS' || !hasVisibleAssistantText) {
            emit({ type: 'assistant', text: status === 'PASS' ? '月次管理レポートを作成しました。' : status === 'CANCELLED' ? '処理を停止しました。' : '処理を完了できませんでした。', done: true })
          }
          emit({ type: 'status', status: terminalStatus }); emitState()
        } catch (error) {
          // Keep provider/transport details out of the browser-facing state;
          // diagnostic evidence belongs to the server-side acceptance layer.
          state = { ...state, status: 'FAIL', error: '処理に失敗しました。' }
          emit({ type: 'status', status: 'FAIL', error: '処理に失敗しました。' }); emitState()
          response.statusCode = 500
          return response.end('Run failed')
        } finally {
          active = false
          activeCancel = undefined
        }
        response.statusCode = 303
        response.setHeader('location', '/')
        return response.end()
      }
      if (request.method === 'POST' && url.pathname === '/cancel') {
        if (request.headers.origin !== `http://${host}`) throw new Error('origin')
        if (!active || !activeCancel) { response.statusCode = 204; return response.end() }
        activeCancel()
        response.statusCode = 202
        return response.end()
      }
      if (request.method === 'GET' && url.pathname === '/download') {
        if (!state.output) throw new Error('output')
        const file = await boundary.readOutputFileBytes(state.output)
        response.setHeader('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        const filename = basename(state.output.replace(/\\/gu, '/'))
        response.setHeader('content-disposition', `attachment; filename="monthly-report.xlsx"; filename*=UTF-8''${encodeRfc5987Value(filename)}`)
        return response.end(file.bytes)
      }
      response.statusCode = 404
      return response.end()
    } catch {
      state = { ...state, status: 'FAIL', error: 'Request failed' }
      emit({ type: 'status', status: 'FAIL', error: 'Request failed' }); emitState()
      response.statusCode = 400
      return response.end('Request failed')
    }
  })
}

export function startDemoServer(root: string, port = 8787, runner: DemoRunner = liveDemoRunner) {
  const server = createDemoServer(root, runner)
  server.listen(port, '127.0.0.1')
  return server
}

if (process.argv[1]?.endsWith('server.js')) {
  const root = process.argv[2]
  if (!root) throw new Error('usage: demo <absolute-workspace>')
  startDemoServer(root)
}
