import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { basename, dirname, join } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { liveAgent, liveBrainIdentity, livePlanProvider, type ApprovalMode, type BlockedCheckpoint, type LiveAgentOptions } from '../runtime/live.js'
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
  type StoredRunUi,
  type StoredPlan,
  type StoredPlanStep,
  type StoredCheckpoint,
} from './sessions.js'
import { appendAudit, defaultAuditPath } from './audit.js'
import { AttachmentImportError, importAttachment, readAttachmentRequest } from './attachments.js'
import { defaultProjectStatePath, ProjectSelectionError, ProjectStore } from './projects.js'
import { additionalOperationStep, createStoredPlan, matchingPendingStep, planShouldBeVisible, type PlanProvider } from './planning.js'

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
  | { type: 'tool'; sessionId?: string; phase: 'start' | 'end'; id: string; name: string; target?: string; status?: 'success' | 'error'; cached?: boolean; detail?: string }
  | { type: 'plan'; sessionId?: string; plan: StoredPlan }
  | { type: 'step'; sessionId?: string; planId: string; stepId: string; status: 'pending' | 'running' | 'completed' }
  | { type: 'checkpoint_request'; sessionId?: string; checkpoint: { id: string; verb: string; target: string; risk: '低' | '中' | '高'; reason: string } }
  | { type: 'checkpoint_response'; sessionId?: string; id: string; decision: 'approved' | 'rejected'; approveSimilar?: boolean }
  | { type: 'status'; sessionId?: string; status: 'running' | 'COMPLETED' | 'FAIL' | 'CANCELLED'; error?: string }

export interface DemoRunContext {
  emit: (event: DemoEvent) => void
  setCancel: (cancel: () => void) => void
  approvalMode?: ApprovalMode
  requestCheckpoint?: (checkpoint: BlockedCheckpoint) => Promise<{ approved: boolean; approveSimilar?: boolean }>
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
  document_read: 'Read Word document',
  presentation_read: 'Read PowerPoint',
  office_get: 'Inspect Office content',
  office_query: 'Query Office content',
  office_inspect: 'Validate Office file',
  office_create_output: 'Create Office output',
  office_set: 'Set Office properties',
  office_add: 'Add Office content',
  office_remove: 'Remove Office content',
  office_move: 'Move Office content',
  office_swap: 'Swap Office content',
  office_batch: 'Update Office file',
  office_import: 'Import tabular data',
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

export function safeToolTarget(name: string, args: unknown): string | undefined {
  if (!args || typeof args !== 'object') return undefined
  const record = args as Record<string, unknown>
  const candidate = name === 'office_create_output'
    ? record.output
    : name.startsWith('office_')
      ? record.file ?? record.source
    : name === 'spreadsheet_read'
      ? record.workbook
      : name === 'document_read'
        ? record.document
        : name === 'presentation_read'
          ? record.presentation
      : record.path
  if (typeof candidate !== 'string' || candidate.length === 0 || candidate.length > 512) return undefined
  const normalized = candidate.replace(/\\/gu, '/')
  if (normalized.startsWith('/') || /^[A-Za-z]:/u.test(normalized) || normalized.split('/').some(part => part === '..')) return undefined
  return normalized
}

/**
 * Short, user-facing reason for a failed tool call. Tool errors are Misen's own messages
 * (boundary, denylist, OfficeCLI exit) and never carry credentials; still cap and flatten them.
 */
function toolErrorDetail(result: unknown): string | undefined {
  const content = result && typeof result === 'object' ? (result as { content?: unknown }).content : undefined
  const texts = Array.isArray(content) ? content.map(part => (part && typeof part === 'object' && (part as { type?: unknown }).type === 'text' ? String((part as { text?: unknown }).text ?? '') : '')).filter(Boolean) : []
  const flat = texts.join(' ').replace(/\s+/gu, ' ').trim()
  if (!flat) return undefined
  return flat.length > 240 ? flat.slice(0, 240) + '…' : flat
}

function forwardAgentEvent(event: AgentEvent, context: DemoRunContext, tools: string[]): void {
  if (event.type === 'tool_execution_start') {
    tools.push(event.toolName)
    context.emit({ type: 'tool', phase: 'start', id: event.toolCallId, name: event.toolName, target: safeToolTarget(event.toolName, event.args) })
    return
  }
  if (event.type === 'tool_execution_end') {
    const details = event.result?.details
    const cached = Boolean(details && typeof details === 'object' && !Array.isArray(details) && (details as Record<string, unknown>).cached === true)
    const detail = event.isError ? toolErrorDetail(event.result) : undefined
    context.emit({ type: 'tool', phase: 'end', id: event.toolCallId, name: event.toolName, status: event.isError ? 'error' : 'success', ...(cached ? { cached: true } : {}), ...(detail ? { detail } : {}) })
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
export type AgentFactory = (root: string, options?: LiveAgentOptions) => Promise<BoundedAgent>

/** Generic Pi route: the host does not classify the prompt or prescribe a workflow. */
export function createAgentRunner(agentFactory: AgentFactory): AgentRunner {
  return async (root, prompt, context) => {
    const agent = await agentFactory(root, { approvalMode: context?.approvalMode, requestCheckpoint: context?.requestCheckpoint })
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
  runUi?: StoredRunUi
  error?: string
}

const MAX_BODY = 8192
const RUN_ID_RE = /^[A-Za-z0-9_-]{1,80}$/u
const ARTIFACT_ID_RE = /^[A-Za-z0-9_-]{24}$/u

export interface DemoServerOptions {
  sessionDirectory?: string
  now?: () => Date
  projectStatePath?: string
  auditPath?: string
  pickFolder?: (initialPath: string) => Promise<string | undefined>
  openFolder?: (path: string) => void | Promise<void>
  brainIdentity?: () => Promise<{ provider: string; model: string }>
  planProvider?: PlanProvider
}

const execFileAsync = promisify(execFile)

async function defaultPickFolder(initialPath: string): Promise<string | undefined> {
  const quoted = initialPath.replace(/'/gu, "''")
  const script = `Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description = '作業フォルダーを選んでください'; $d.SelectedPath = '${quoted}'; if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::OutputEncoding = [Text.Encoding]::UTF8; $d.SelectedPath }`
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-STA', '-EncodedCommand', encoded], { windowsHide: true, encoding: 'utf8' })
  return stdout.trim() || undefined
}

function defaultOpenFolder(path: string): void {
  spawn('explorer.exe', [path], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
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
  let boundary = new WorkspaceBoundary(root)
  const sessions = new LocalSessionStore(options.sessionDirectory, options.now)
  const stateBase = options.sessionDirectory ? dirname(options.sessionDirectory) : undefined
  const projects = new ProjectStore(options.projectStatePath ?? (stateBase ? join(stateBase, 'projects.json') : defaultProjectStatePath()), root)
  const auditPath = options.auditPath ?? (stateBase ? join(stateBase, 'audit.jsonl') : defaultAuditPath())
  const planProvider = options.planProvider ?? (runner === liveAgentRunner ? livePlanProvider : async () => undefined)
  let approvalMode: ApprovalMode = 'confirm'
  const artifactResources = new Map<string, { filename: string; bytes: Uint8Array }>()
  const usedRunIds = new Set<string>()
  let state: UiState = { status: 'idle', tools: [], axes: [], artifacts: [] }
  let active = false
  let activeCancel: (() => void) | undefined
  let pendingCheckpoint: { id: string; sessionId: string; verb: string; respond: (decision: 'approved' | 'rejected', approveSimilar: boolean) => Promise<void> } | undefined
  const approvedCheckpointVerbs = new Set<string>()
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
      await projects.initialize()

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
        // A new chat is a new approval session; automatic approval never carries over.
        approvalMode = 'confirm'
        approvedCheckpointVerbs.clear()
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
      if (request.method === 'GET' && url.pathname === '/project') {
        const identity = await (options.brainIdentity ?? (async () => { const value = await liveBrainIdentity(); return { provider: value.provider, model: value.model } }))().catch(() => ({ provider: '未設定', model: '未設定' }))
        response.setHeader('content-type', 'application/json; charset=utf-8')
        return response.end(JSON.stringify({ ...projects.snapshot(), running: active, approvalMode, provider: identity.provider, model: identity.model }))
      }
      if (request.method === 'POST' && url.pathname === '/project/select') {
        if (request.headers.origin !== `http://${host}`) throw new Error('origin')
        if (active) { response.statusCode = 409; return response.end(JSON.stringify({ error: '処理が終わってから切り替えてください。' })) }
        const body = JSON.parse(await readBody(request)) as { path?: unknown }
        if (typeof body.path !== 'string') throw new ProjectSelectionError('作業フォルダーを選べませんでした。')
        const selected = await projects.selectRemembered(body.path)
        boundary = new WorkspaceBoundary(selected)
        artifactResources.clear(); state = { status: 'idle', tools: [], axes: [], artifacts: [] }; emitState()
        await appendAudit(auditPath, { event: 'project.switched', folder: basename(selected) }, options.now)
        response.setHeader('content-type', 'application/json; charset=utf-8')
        return response.end(JSON.stringify(projects.snapshot()))
      }
      if (request.method === 'POST' && url.pathname === '/project/pick') {
        if (request.headers.origin !== `http://${host}`) throw new Error('origin')
        if (active) { response.statusCode = 409; return response.end(JSON.stringify({ error: '処理が終わってから切り替えてください。' })) }
        const picked = await (options.pickFolder ?? defaultPickFolder)(projects.currentRoot)
        if (!picked) { response.statusCode = 204; return response.end() }
        const selected = await projects.selectPicked(picked)
        boundary = new WorkspaceBoundary(selected)
        artifactResources.clear(); state = { status: 'idle', tools: [], axes: [], artifacts: [] }; emitState()
        await appendAudit(auditPath, { event: 'project.switched', folder: basename(selected) }, options.now)
        response.setHeader('content-type', 'application/json; charset=utf-8')
        return response.end(JSON.stringify(projects.snapshot()))
      }
      if (request.method === 'POST' && url.pathname === '/project/open') {
        if (request.headers.origin !== `http://${host}`) throw new Error('origin')
        await (options.openFolder ?? defaultOpenFolder)(projects.currentRoot)
        response.statusCode = 204
        return response.end()
      }
      if (request.method === 'POST' && url.pathname === '/approval') {
        if (request.headers.origin !== `http://${host}`) throw new Error('origin')
        const body = JSON.parse(await readBody(request)) as { mode?: unknown }
        if (body.mode !== 'confirm' && body.mode !== 'session-auto') throw new Error('approval')
        approvalMode = body.mode
        await appendAudit(auditPath, { event: 'approval.changed', mode: approvalMode }, options.now)
        response.setHeader('content-type', 'application/json; charset=utf-8')
        return response.end(JSON.stringify({ mode: approvalMode }))
      }
      if (request.method === 'POST' && url.pathname === '/checkpoints/respond') {
        if (request.headers.origin !== `http://${host}`) throw new Error('origin')
        const body = JSON.parse(await readBody(request)) as { id?: unknown; decision?: unknown; approveSimilar?: unknown }
        if (typeof body.id !== 'string' || (body.decision !== 'approved' && body.decision !== 'rejected') || (body.approveSimilar !== undefined && typeof body.approveSimilar !== 'boolean')) throw new Error('checkpoint')
        if (!pendingCheckpoint || pendingCheckpoint.id !== body.id) {
          response.statusCode = 409
          response.setHeader('content-type', 'application/json; charset=utf-8')
          return response.end(JSON.stringify({ error: 'この確認はすでに終了しています。' }))
        }
        await pendingCheckpoint.respond(body.decision, body.approveSimilar === true)
        response.statusCode = 204
        return response.end()
      }
      if (request.method === 'POST' && url.pathname === '/attachments') {
        if (request.headers.origin !== `http://${host}` || active) throw new Error('origin')
        const header = request.headers['x-misen-filename']
        if (typeof header !== 'string') throw new AttachmentImportError(400, 'ファイル名を読み取れませんでした。')
        let requestedName: string
        try { requestedName = decodeURIComponent(header) } catch { throw new AttachmentImportError(400, 'ファイル名を読み取れませんでした。') }
        const imported = await importAttachment(boundary, requestedName, await readAttachmentRequest(request))
        await appendAudit(auditPath, { event: 'file.imported', filename: imported.name, size: imported.size, sha256: imported.sha256 }, options.now)
        response.statusCode = 201
        response.setHeader('content-type', 'application/json; charset=utf-8')
        return response.end(JSON.stringify(imported))
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
          if (pendingCheckpoint) void pendingCheckpoint.respond('rejected', false)
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
          let importedPaths: string[] = []
          try {
            const candidate = JSON.parse(params.get('imports') ?? '[]') as unknown
            if (!Array.isArray(candidate) || candidate.length > 20 || candidate.some(path => typeof path !== 'string' || !/^input\/[\p{L}\p{N} ._()/-]+\.(?:xlsx|docx|pptx|csv|md|txt)$/iu.test(path))) throw new Error('imports')
            importedPaths = candidate
            for (const path of importedPaths) await boundary.resolveFile(path)
          } catch {
            response.statusCode = 400
            return response.end('Request failed')
          }
          const clientId = params.get('clientId') ?? `server-${++nextRunId}`
          const sessionId = params.get('sessionId') ?? ''
          const existingSession = await sessions.get(sessionId)
          if (prompt.trim().length === 0 || !RUN_ID_RE.test(clientId) || usedRunIds.has(clientId) || !existingSession || existingSession.status !== 'NEW' || existingSession.messages.length !== 0) {
            response.statusCode = 400
            return response.end('Request failed')
          }
          usedRunIds.add(clientId)
          let proposedPlan
          try { proposedPlan = await planProvider(projects.currentRoot, prompt, importedPaths) } catch (error) {
            // Diagnostic only; never includes the prompt, the credential, or provider payloads.
            console.error('[plan] 計画作成に失敗したため計画を表示しません:', error instanceof Error ? error.message : String(error))
            proposedPlan = undefined
          }
          const plan: StoredPlan = createStoredPlan(clientId, proposedPlan)
          const runUi: StoredRunUi = { runId: clientId, plan, checkpoints: [] }
          const startedAt = sessions.timestamp()
          const userMessage: StoredMessage = { id: clientId, role: 'user', text: prompt, timestamp: startedAt }
          let session = await persist(existingSession, {
            title: titleFromFirstUserMessage(prompt),
            status: 'RUNNING',
            messages: [userMessage],
            runUi: [...existingSession.runUi, runUi],
          })
          state = { status: 'running', runId: clientId, sessionId, tools: [], axes: [], artifacts: [], runUi }
          emit({ type: 'status', sessionId, status: 'running' }); emit({ type: 'user', sessionId, id: clientId, text: prompt }); emit({ type: 'plan', sessionId, plan }); emitState()
          let planDifferencesRecorded = false
          const recordUnexecutedPlan = async () => {
            if (planDifferencesRecorded || plan.fallback) return
            planDifferencesRecorded = true
            for (const step of plan.steps.filter(item => !item.unplanned && item.status !== 'completed')) {
              await appendAudit(auditPath, { event: 'plan.unexecuted_step', planId: plan.id, stepId: step.id, tool: step.tool, target: step.target }, options.now)
            }
          }
          try {
            const outputBefore = await artifactObserver.snapshot(boundary)
            if (cancelRequested) {
              const text = '処理を停止しました。'
              await recordUnexecutedPlan()
              session = await persist(session, { status: 'CANCELLED', messages: [...session.messages, { id: `assistant-${clientId}`, role: 'assistant', text, timestamp: sessions.timestamp() }] })
              state = { ...state, status: 'CANCELLED' }
              emit({ type: 'assistant', sessionId, text, done: true })
              emit({ type: 'status', sessionId, status: 'CANCELLED' }); emitState()
            } else {
              let hasVisibleAssistantText = false
              let visibleAssistantText = ''
              const storedTools = new Map<string, StoredToolEvent>()
              const stepByToolCall = new Map<string, string>()
              let toolAudit = Promise.resolve()
              const runEmit = (event: DemoEvent) => {
                if (event.type === 'assistant' && event.text.trim().length > 0) {
                  hasVisibleAssistantText = true
                  visibleAssistantText = event.text
                }
                if (event.type === 'tool') {
                  if (event.phase === 'start') {
                    storedTools.set(event.id, { id: event.id, runId: clientId, name: event.name, target: event.target, status: 'success' })
                    if (!plan.fallback) {
                      const matched = matchingPendingStep(plan, event.name, event.target)
                      const step = matched ?? additionalOperationStep(plan, event.name, event.target)
                      if (!matched) {
                        plan.steps.push(step)
                        plan.visible = planShouldBeVisible(plan.steps)
                        runEmit({ type: 'plan', plan })
                        toolAudit = toolAudit.then(() => appendAudit(auditPath, { event: 'plan.unplanned_tool', planId: plan.id, tool: event.name, target: event.target ?? '' }, options.now))
                      }
                      stepByToolCall.set(event.id, step.id)
                      setStep(step.id, 'running')
                    }
                  }
                  else {
                    storedTools.set(event.id, { id: event.id, runId: clientId, name: event.name, target: storedTools.get(event.id)?.target, status: event.status === 'error' ? 'error' : 'success', ...(event.cached ? { cached: true } : {}), ...(event.detail ? { detail: event.detail } : {}) })
                    toolAudit = toolAudit.then(() => appendAudit(auditPath, { event: 'tool.completed', tool: event.name, cached: event.cached === true }, options.now))
                    const stepId = stepByToolCall.get(event.id)
                    if (stepId) setStep(stepId, 'completed')
                  }
                }
                emit({ ...event, sessionId })
              }
              const setStep = (stepId: string, status: StoredPlanStep['status']) => {
                const step = plan.steps.find(item => item.id === stepId)
                if (step) step.status = status
                runEmit({ type: 'step', planId: plan.id, stepId, status })
              }
              if (plan.fallback) { setStep('review', 'completed'); setStep('work', 'running') }
              const agentPrompt = importedPaths.length === 0 ? prompt : `${prompt}\n\n持ち込んだファイル（作業フォルダーからの相対パス）:\n${importedPaths.map(path => `- ${path}`).join('\n')}`
              const result = await runner(projects.currentRoot, agentPrompt, {
                emit: runEmit,
                setCancel: cancel => {
                  runnerCancel = cancel
                  if (cancelRequested) cancel()
                },
                approvalMode,
                requestCheckpoint: async checkpoint => {
                  const id = `checkpoint-${randomBytes(12).toString('base64url')}`
                  const card: StoredCheckpoint = { id, ...checkpoint, status: 'pending' }
                  runUi.checkpoints.push(card)
                  runEmit({ type: 'checkpoint_request', checkpoint: { id, ...checkpoint } })
                  await appendAudit(auditPath, { event: 'checkpoint.requested', id, ...checkpoint }, options.now)
                  session = await persist(session, { runUi: session.runUi })
                  if (approvedCheckpointVerbs.has(checkpoint.verb)) {
                    card.status = 'approved'
                    card.approveSimilar = true
                    runEmit({ type: 'checkpoint_response', id, decision: 'approved', approveSimilar: true })
                    await appendAudit(auditPath, { event: 'checkpoint.responded', id, verb: checkpoint.verb, decision: 'approved', approveSimilar: true, automatic: true }, options.now)
                    session = await persist(session, { runUi: session.runUi })
                    return { approved: true, approveSimilar: true }
                  }
                  return await new Promise(resolve => {
                    let answered = false
                    pendingCheckpoint = {
                      id,
                      sessionId,
                      verb: checkpoint.verb,
                      respond: async (decision, approveSimilar) => {
                        if (answered) return
                        answered = true
                        card.status = decision
                        if (decision === 'approved' && approveSimilar) { card.approveSimilar = true; approvedCheckpointVerbs.add(checkpoint.verb) }
                        runEmit({ type: 'checkpoint_response', id, decision, ...(approveSimilar ? { approveSimilar: true } : {}) })
                        await appendAudit(auditPath, { event: 'checkpoint.responded', id, verb: checkpoint.verb, decision, approveSimilar }, options.now)
                        session = await persist(session, { runUi: session.runUi })
                        pendingCheckpoint = undefined
                        resolve({ approved: decision === 'approved', ...(approveSimilar ? { approveSimilar: true } : {}) })
                      },
                    }
                  })
                },
              })
              await toolAudit
              if (plan.fallback) { setStep('work', 'completed'); setStep('verify', 'running') }
              const runnerStatus = cancelRequested ? 'CANCELLED' : result.status
              const discovered = runnerStatus === 'COMPLETED'
                ? await artifactObserver.discover(boundary, outputBefore, MAX_SESSION_ARTIFACTS - artifactResources.size)
                : []
              // Discovery is host work while the run is still visibly active.
              // Honor a Stop accepted during that await and publish nothing.
              const status = cancelRequested ? 'CANCELLED' : runnerStatus
              const terminalStatus: Exclude<UiState['status'], 'idle' | 'running'> = status
              const artifacts = status === 'COMPLETED' ? registerArtifacts(discovered, clientId) : []
              if (plan.fallback) setStep('verify', 'completed')
              await recordUnexecutedPlan()
              plan.completed = status === 'COMPLETED'
              runEmit({ type: 'plan', plan })
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
                runUi: session.runUi,
              })
              state = { status: terminalStatus, runId: clientId, sessionId, tools: result.tools.slice(0, 20), axes: [], artifacts, runUi }
              if (status !== 'COMPLETED' || !hasVisibleAssistantText) {
                emit({ type: 'assistant', sessionId, text: fallbackText, done: true })
              }
              emit({ type: 'status', sessionId, status: terminalStatus }); emitState()
            }
          } catch {
            // Keep provider/transport details out of the browser-facing state;
            // diagnostic evidence belongs to the server-side acceptance layer.
            const text = '処理に失敗しました。'
            await recordUnexecutedPlan()
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
    } catch (error) {
      response.setHeader('content-type', 'application/json; charset=utf-8')
      if (error instanceof AttachmentImportError) { response.statusCode = error.status; return response.end(JSON.stringify({ error: error.message })) }
      if (error instanceof ProjectSelectionError) { response.statusCode = 400; return response.end(JSON.stringify({ error: error.message })) }
      response.statusCode = 400
      return response.end(JSON.stringify({ error: '要求を処理できませんでした。' }))
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
