import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { createHash, randomBytes } from 'node:crypto'
import { liveAgent } from '../runtime/live.js'
import { WorkspaceBoundary } from '../workspace/boundary.js'
import type { AgentEvent } from '@earendil-works/pi-agent-core'
import {
  discoverOutputArtifacts,
  MAX_ARTIFACT_BYTES,
  MAX_SESSION_ARTIFACTS,
  snapshotOutputArtifacts,
  type DiscoveredArtifact,
  type OutputScopeSnapshot,
} from './artifacts.js'
import {
  LocalSessionStore,
  SESSION_ID_RE,
  titleFromFirstUserMessage,
  type StoredArtifact,
  type StoredMessage,
  type StoredSession,
  type StoredToolEvent,
} from './sessions.js'

export interface AgentRunResult {
  tools: string[]
  status: 'COMPLETED' | 'FAIL' | 'CANCELLED'
}

/**
 * UI-safe event data. Provider payloads, raw assistant messages, and reasoning
 * parts never cross this boundary; only the visible answer and allowlisted
 * process labels are emitted.
 */
export type DemoEvent =
  | { type: 'user'; sessionId?: string; id: string; text: string }
  | { type: 'assistant'; sessionId?: string; text: string; done?: boolean }
  | { type: 'tool'; sessionId?: string; phase: 'start' | 'end'; id: string; name: string; detail?: string; status?: 'success' | 'error' }
  | { type: 'status'; sessionId?: string; status: 'running' | 'COMPLETED' | 'FAIL' | 'CANCELLED'; error?: string }

export interface DemoRunContext {
  emit: (event: DemoEvent) => void
  setCancel: (cancel: () => void) => void
}

export type UiArtifact = {
  id: string
  runId: string
  filename: string
  available: boolean
}

export type UiSession = Omit<StoredSession, 'artifacts'> & { artifacts: UiArtifact[] }

export type AgentRunner = (root: string, prompt: string, context?: DemoRunContext) => Promise<AgentRunResult>

export interface ArtifactObserver {
  snapshot: (boundary: WorkspaceBoundary) => Promise<OutputScopeSnapshot>
  discover: (boundary: WorkspaceBoundary, before: OutputScopeSnapshot, maximumArtifacts: number) => Promise<DiscoveredArtifact[]>
}

const defaultArtifactObserver: ArtifactObserver = {
  snapshot: snapshotOutputArtifacts,
  discover: discoverOutputArtifacts,
}

const TOOL_LABELS: Record<string, string> = {
  workspace_list_files: 'List workspace files',
  workspace_read_text: 'Read workspace guidance',
  spreadsheet_read: 'Read spreadsheet',
  spreadsheet_create_output: 'Create workbook',
  spreadsheet_update: 'Update spreadsheet',
  document_read: 'Read Word document',
  document_create_output: 'Create Word document',
  document_update: 'Update Word document',
  presentation_read: 'Read PowerPoint',
  presentation_create_output: 'Create PowerPoint',
  presentation_update: 'Update PowerPoint',
}

export function textFromAssistantMessage(message: unknown): string {
  if (!message || typeof message !== 'object') return ''
  const candidate = message as { role?: unknown; content?: unknown }
  if (candidate.role !== 'assistant') return ''
  const content = candidate.content
  if (!Array.isArray(content)) return ''
  return content
    .filter((part): part is { type: 'text'; text: string } => Boolean(part && typeof part === 'object' && (part as any).type === 'text' && typeof (part as any).text === 'string'))
    .map(part => part.text)
    .join('')
}

function safeToolDetail(name: string, args: unknown): string | undefined {
  if (!args || typeof args !== 'object') return undefined
  const record = args as Record<string, unknown>
  const candidate = name === 'spreadsheet_create_output' || name === 'document_create_output' || name === 'presentation_create_output'
    ? record.output
    : name === 'spreadsheet_update' || name === 'spreadsheet_read'
      ? record.workbook
      : name === 'document_update' || name === 'document_read'
        ? record.document
        : name === 'presentation_update' || name === 'presentation_read'
          ? record.presentation
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

type BoundedAgent = Pick<Awaited<ReturnType<typeof liveAgent>>, 'abort' | 'prompt' | 'state' | 'subscribe'>
export type AgentFactory = (root: string) => Promise<BoundedAgent>

/** Generic Pi route: the host does not classify the prompt or prescribe a workflow. */
export function createAgentRunner(agentFactory: AgentFactory): AgentRunner {
  return async (root, prompt, context) => {
    const agent = await agentFactory(root)
    const tools: string[] = []
    context?.setCancel(() => agent.abort())
    const unsubscribe = agent.subscribe(event => { if (context) forwardAgentEvent(event, context, tools) })
    try {
      await agent.prompt(prompt)
      if (agent.state.errorMessage) {
        const latest = agent.state.messages.at(-1) as any
        const cancelled = latest?.role === 'assistant' && latest?.stopReason === 'aborted'
        return { tools, status: cancelled ? 'CANCELLED' : 'FAIL' }
      }
      return { tools, status: 'COMPLETED' }
    } finally {
      unsubscribe()
    }
  }
}

export const liveAgentRunner = createAgentRunner(liveAgent)

type UiState = {
  status: 'idle' | 'running' | 'COMPLETED' | 'FAIL' | 'CANCELLED'
  runId?: string
  sessionId?: string
  tools: string[]
  axes: string[]
  artifacts: UiArtifact[]
  error?: string
}

const MAX_BODY = 8192
const RUN_ID_RE = /^[A-Za-z0-9_-]{1,80}$/u
const ARTIFACT_ID_RE = /^[A-Za-z0-9_-]{24}$/u

export interface DemoServerOptions {
  sessionDirectory?: string
  now?: () => Date
}

function writeEvent(response: ServerResponse, event: DemoEvent | { type: 'state'; state: UiState }): void {
  response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
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

export function createDemoServer(
  root: string,
  runner: AgentRunner = liveAgentRunner,
  artifactObserver: ArtifactObserver = defaultArtifactObserver,
  options: DemoServerOptions = {},
) {
  const boundary = new WorkspaceBoundary(root)
  const sessions = new LocalSessionStore(options.sessionDirectory, options.now)
  const artifactResources = new Map<string, { filename: string; bytes: Uint8Array }>()
  const usedRunIds = new Set<string>()
  let state: UiState = { status: 'idle', tools: [], axes: [], artifacts: [] }
  let active = false
  let activeCancel: (() => void) | undefined
  let nextRunId = 0
  const listeners = new Set<ServerResponse>()
  const emit = (event: DemoEvent) => { for (const response of listeners) writeEvent(response, event) }
  const emitState = () => { for (const response of listeners) writeEvent(response, { type: 'state', state }) }
  const registerArtifacts = (artifacts: readonly DiscoveredArtifact[], runId: string): UiArtifact[] => {
    if (artifactResources.size + artifacts.length > MAX_SESSION_ARTIFACTS) throw new Error('artifact capacity')
    return artifacts.map(artifact => {
      let id = randomBytes(18).toString('base64url')
      while (artifactResources.has(id)) id = randomBytes(18).toString('base64url')
      artifactResources.set(id, { filename: artifact.filename, bytes: artifact.bytes })
      return { id, runId, filename: artifact.filename, available: true }
    })
  }
  const projectSession = async (session: StoredSession): Promise<UiSession> => {
    artifactResources.clear()
    const artifacts: UiArtifact[] = []
    for (const artifact of session.artifacts.slice(0, MAX_SESSION_ARTIFACTS)) {
      try {
        const resource = await boundary.readOutputFileBytes(artifact.path, MAX_ARTIFACT_BYTES)
        const sha256 = createHash('sha256').update(resource.bytes).digest('hex')
        if (sha256 !== artifact.sha256) throw new Error('artifact changed')
        artifacts.push(registerArtifacts([{ path: artifact.path, filename: artifact.filename, bytes: resource.bytes }], artifact.runId)[0])
      } catch {
        artifacts.push({ id: '', runId: artifact.runId, filename: artifact.filename, available: false })
      }
    }
    return { ...session, artifacts }
  }
  const persist = async (session: StoredSession, update: Partial<StoredSession>): Promise<StoredSession> => {
    const next = { ...session, ...update, updatedAt: sessions.timestamp() }
    await sessions.save(next)
    return next
  }

  return createServer(async (request, response) => {
    try {
      const host = request.headers.host ?? ''
      if (!hostIsLoopback(host)) throw new Error('host')
      const url = new URL(request.url ?? '/', `http://${host}`)

      if (request.method === 'GET' && url.pathname === '/') {
        response.setHeader('content-type', 'text/html; charset=utf-8')
        return response.end(`<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"><title>Misen</title><link rel="stylesheet" href="/assets/client.css"></head><body><div id="root"></div><script type="module" src="/assets/client.js"></script></body></html>`)
      }
      if (request.method === 'GET' && (url.pathname === '/assets/client.js' || url.pathname === '/assets/client.css')) {
        const name = url.pathname.endsWith('.css') ? 'client.css' : 'client.js'
        const bytes = await readFile(clientAssetPath(name))
        response.setHeader('content-type', name.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8')
        return response.end(bytes)
      }
      if (request.method === 'GET' && url.pathname === '/sessions') {
        response.setHeader('content-type', 'application/json; charset=utf-8')
        return response.end(JSON.stringify(await sessions.list()))
      }
      if (request.method === 'POST' && url.pathname === '/sessions') {
        if (request.headers.origin !== `http://${host}` || active) throw new Error('origin')
        const session = await sessions.create()
        response.statusCode = 201
        response.setHeader('content-type', 'application/json; charset=utf-8')
        return response.end(JSON.stringify(await projectSession(session)))
      }
      if (request.method === 'GET' && url.pathname.startsWith('/sessions/')) {
        const id = url.pathname.slice('/sessions/'.length)
        if (!SESSION_ID_RE.test(id)) { response.statusCode = 404; return response.end('Not found') }
        const session = await sessions.get(id)
        if (!session) { response.statusCode = 404; return response.end('Not found') }
        response.setHeader('content-type', 'application/json; charset=utf-8')
        return response.end(JSON.stringify(await projectSession(session)))
      }
      if (request.method === 'DELETE' && url.pathname.startsWith('/sessions/')) {
        if (request.headers.origin !== `http://${host}`) throw new Error('origin')
        if (active) { response.statusCode = 409; return response.end('Request failed') }
        const id = url.pathname.slice('/sessions/'.length)
        if (!SESSION_ID_RE.test(id) || !await sessions.delete(id)) { response.statusCode = 404; return response.end('Not found') }
        if (state.sessionId === id) {
          artifactResources.clear()
          state = { status: 'idle', tools: [], axes: [], artifacts: [] }
          emitState()
        }
        response.statusCode = 204
        return response.end()
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
        if (request.headers.origin !== `http://${host}` || active) {
          response.statusCode = 400
          return response.end('Request failed')
        }

        // Reserve before reading the body so two interleaved requests cannot
        // both pass admission. Cancellation records intent until the Agent has
        // registered its concrete abort callback.
        active = true
        let cancelRequested = false
        let runnerCancel: (() => void) | undefined
        activeCancel = () => {
          cancelRequested = true
          runnerCancel?.()
        }
        try {
          let params: URLSearchParams
          try {
            params = new URLSearchParams(await readBody(request))
          } catch {
            response.statusCode = 400
            return response.end('Request failed')
          }
          const prompt = params.get('prompt') ?? ''
          const clientId = params.get('clientId') ?? `server-${++nextRunId}`
          const sessionId = params.get('sessionId') ?? ''
          const existingSession = await sessions.get(sessionId)
          if (prompt.trim().length === 0 || !RUN_ID_RE.test(clientId) || usedRunIds.has(clientId) || !existingSession || existingSession.status !== 'NEW' || existingSession.messages.length !== 0) {
            response.statusCode = 400
            return response.end('Request failed')
          }
          usedRunIds.add(clientId)
          const startedAt = sessions.timestamp()
          const userMessage: StoredMessage = { id: clientId, role: 'user', text: prompt, timestamp: startedAt }
          let session = await persist(existingSession, {
            title: titleFromFirstUserMessage(prompt),
            status: 'RUNNING',
            messages: [userMessage],
          })
          state = { status: 'running', runId: clientId, sessionId, tools: [], axes: [], artifacts: [] }
          emit({ type: 'status', sessionId, status: 'running' }); emit({ type: 'user', sessionId, id: clientId, text: prompt }); emitState()
          try {
            const outputBefore = await artifactObserver.snapshot(boundary)
            if (cancelRequested) {
              const text = '処理を停止しました。'
              session = await persist(session, { status: 'CANCELLED', messages: [...session.messages, { id: `assistant-${clientId}`, role: 'assistant', text, timestamp: sessions.timestamp() }] })
              state = { ...state, status: 'CANCELLED' }
              emit({ type: 'assistant', sessionId, text, done: true })
              emit({ type: 'status', sessionId, status: 'CANCELLED' }); emitState()
            } else {
              let hasVisibleAssistantText = false
              let visibleAssistantText = ''
              const storedTools = new Map<string, StoredToolEvent>()
              const runEmit = (event: DemoEvent) => {
                if (event.type === 'assistant' && event.text.trim().length > 0) {
                  hasVisibleAssistantText = true
                  visibleAssistantText = event.text
                }
                if (event.type === 'tool') {
                  if (event.phase === 'start') storedTools.set(event.id, { id: event.id, runId: clientId, name: event.name, detail: event.detail, status: 'success' })
                  else storedTools.set(event.id, { id: event.id, runId: clientId, name: event.name, detail: storedTools.get(event.id)?.detail, status: event.status === 'error' ? 'error' : 'success' })
                }
                emit({ ...event, sessionId })
              }
              const result = await runner(root, prompt, {
                emit: runEmit,
                setCancel: cancel => {
                  runnerCancel = cancel
                  if (cancelRequested) cancel()
                },
              })
              const runnerStatus = cancelRequested ? 'CANCELLED' : result.status
              const discovered = runnerStatus === 'COMPLETED'
                ? await artifactObserver.discover(boundary, outputBefore, MAX_SESSION_ARTIFACTS - artifactResources.size)
                : []
              // Discovery is host work while the run is still visibly active.
              // Honor a Stop accepted during that await and publish nothing.
              const status = cancelRequested ? 'CANCELLED' : runnerStatus
              const terminalStatus: Exclude<UiState['status'], 'idle' | 'running'> = status
              const artifacts = status === 'COMPLETED' ? registerArtifacts(discovered, clientId) : []
              const fallbackText = status === 'COMPLETED' ? '処理が完了しました。' : status === 'CANCELLED' ? '処理を停止しました。' : '処理を完了できませんでした。'
              const assistantText = hasVisibleAssistantText ? visibleAssistantText : fallbackText
              const storedArtifacts: StoredArtifact[] = status === 'COMPLETED' ? discovered.map(artifact => ({
                runId: clientId,
                path: artifact.path,
                filename: artifact.filename,
                sha256: createHash('sha256').update(artifact.bytes).digest('hex'),
              })) : []
              session = await persist(session, {
                status: terminalStatus,
                messages: [...session.messages, { id: `assistant-${clientId}`, role: 'assistant', text: assistantText, timestamp: sessions.timestamp() }],
                tools: [...storedTools.values()],
                artifacts: storedArtifacts,
              })
              state = { status: terminalStatus, runId: clientId, sessionId, tools: result.tools.slice(0, 20), axes: [], artifacts }
              if (status !== 'COMPLETED' || !hasVisibleAssistantText) {
                emit({ type: 'assistant', sessionId, text: fallbackText, done: true })
              }
              emit({ type: 'status', sessionId, status: terminalStatus }); emitState()
            }
          } catch {
            // Keep provider/transport details out of the browser-facing state;
            // diagnostic evidence belongs to the server-side acceptance layer.
            const text = '処理に失敗しました。'
            session = await persist(session, { status: 'FAIL', messages: [...session.messages, { id: `assistant-${clientId}`, role: 'assistant', text, timestamp: sessions.timestamp() }] })
            state = { ...state, status: 'FAIL', error: text }
            emit({ type: 'status', sessionId, status: 'FAIL', error: text }); emitState()
            response.statusCode = 500
            return response.end('Run failed')
          }
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
      if (request.method === 'GET' && url.pathname.startsWith('/download/')) {
        const id = url.pathname.slice('/download/'.length)
        if (!ARTIFACT_ID_RE.test(id)) { response.statusCode = 404; return response.end('Not found') }
        const artifact = artifactResources.get(id)
        if (!artifact) { response.statusCode = 404; return response.end('Not found') }
        const extension = /\.(xlsx|docx|pptx)$/iu.exec(artifact.filename)?.[1]?.toLowerCase() ?? 'bin'
        const fallback = extension === 'xlsx' ? 'spreadsheet.xlsx' : extension === 'docx' ? 'document.docx' : extension === 'pptx' ? 'presentation.pptx' : 'office-output.bin'
        const contentType = extension === 'xlsx'
          ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
          : extension === 'docx'
            ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
            : extension === 'pptx'
              ? 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
              : 'application/octet-stream'
        response.setHeader('content-type', contentType)
        response.setHeader('content-disposition', `attachment; filename="${fallback}"; filename*=UTF-8''${encodeRfc5987Value(artifact.filename)}`)
        return response.end(artifact.bytes)
      }
      response.statusCode = 404
      return response.end()
    } catch {
      response.statusCode = 400
      return response.end('Request failed')
    }
  })
}

export function startDemoServer(root: string, port = 8787, runner: AgentRunner = liveAgentRunner) {
  const server = createDemoServer(root, runner)
  server.listen(port, '127.0.0.1')
  return server
}

if (process.argv[1]?.endsWith('server.js')) {
  const root = process.argv[2]
  if (!root) throw new Error('usage: demo <absolute-workspace>')
  startDemoServer(root)
}
