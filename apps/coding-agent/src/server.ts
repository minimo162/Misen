import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { loadConfig, type AgentConfig } from './config'
import { runAgentTurn, type AgentEvent, type AgentIO, type TextBackend } from './agent'
import { CopilotEdgeClient } from './copilot'
import type { ChatMessage } from './llm'
import { rollbackFileChange, type ToolContext } from './tools'
import { killAllManagedProcesses, listManagedProcesses, readManagedProcessLog, stopManagedProcess } from './processes'
import { clearApprovals, listApprovals, requestApproval, resolveApproval } from './approvals'

const PORT = Number(process.env.PORT ?? 3948)

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1] : undefined
}

const cfg: AgentConfig = loadConfig(argValue('--config'))
const workspaceArg = argValue('--workspace')
const workspace = workspaceArg ? path.resolve(workspaceArg) : process.cwd()
const ctx: ToolContext = { workspace, restrictToWorkspace: cfg.restrictToWorkspace ?? true }

const here = typeof __dirname !== 'undefined' ? __dirname : path.dirname(process.argv[1] ?? '.')
const indexCandidates = [
  process.env.INDEX_HTML,
  path.join(here, '..', 'public', 'index.html'),
  path.join(process.cwd(), 'public', 'index.html')
]
const indexHtmlPath = indexCandidates.find((p): p is string => typeof p === 'string' && fs.existsSync(p))
const distributionStatePath = path.join(process.env.LOCALAPPDATA ?? path.dirname(here), 'CompanyApps', 'state', 'coding-agent.json')
const persistencePath = path.join(process.env.APPDATA ?? process.env.LOCALAPPDATA ?? path.dirname(here), 'CompanyApps', 'coding-agent', 'state.json')

function readDistributionState(): Record<string, unknown> {
  try {
    if (!fs.existsSync(distributionStatePath)) return { phase: 'unknown', message: 'ランチャーの状態は未取得です', sharedVersion: null, localVersion: null, verified: false }
    return JSON.parse(fs.readFileSync(distributionStatePath, 'utf8')) as Record<string, unknown>
  } catch (err) {
    return { phase: 'failed', message: (err as Error).message, sharedVersion: null, localVersion: null, verified: false }
  }
}

const DEFAULT_SYSTEM_PROMPT =
  'あなたは社内コーディング支援エージェントです。提供されたツールでファイルの調査・編集・コマンド実行を行い、簡潔な日本語で回答してください。'

type RunPhase = 'request' | 'plan' | 'inspect' | 'edit' | 'execute' | 'verify' | 'finalize'
type RunStatus = 'queued' | 'planning' | 'running' | 'waiting_approval' | 'waiting_user' | 'paused' | 'canceling' | 'canceled' | 'failed' | 'applied_unverified' | 'verifying' | 'verified' | 'rolled_back'

interface RunChange {
  path: string
  changed: boolean
  status: 'no_op' | 'applied_unverified'
  beforeHash?: string
  afterHash?: string
  readBack?: boolean
  addedLines?: number
  removedLines?: number
}

interface RunEvent {
  sequence: number
  type: string
  at: number
  message: string
  tool?: string
  summary?: string
  output?: string
  approved?: boolean
  durationMs?: number
  metadata?: Record<string, unknown> | null
}

interface RunData {
  id: string
  sessionId: string
  title: string
  request: string
  mode: 'chat' | 'work'
  status: RunStatus
  phase: RunPhase
  currentStep: string
  nextAction: string
  startedAt: number
  updatedAt: number
  endedAt?: number
  completedSteps: number
  changedFiles: RunChange[]
  events: RunEvent[]
  cancelRequested: boolean
  error?: string
}

interface SessionData {
  id: string
  title: string
  messages: ChatMessage[]
  created: number
  runs: string[]
}

const systemMsg = (): ChatMessage => ({ role: 'system', content: cfg.systemPrompt ?? DEFAULT_SYSTEM_PROMPT })
const sessions = new Map<string, SessionData>()
const runs = new Map<string, RunData>()
let activeId = ''
let activeRunId: string | null = null
let copilotBackend: TextBackend | null = null
let lastLogSeen = 0
const logLines: string[] = []

function newSession(): SessionData {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
  const s: SessionData = { id, title: '新しいセッション', messages: [systemMsg()], created: Date.now(), runs: [] }
  sessions.set(id, s)
  activeId = id
  return s
}

function activeSession(): SessionData {
  return sessions.get(activeId) ?? newSession()
}

newSession()

function getBackend(): TextBackend | undefined {
  if (cfg.provider !== 'copilot-edge') return undefined
  if (!copilotBackend) copilotBackend = new CopilotEdgeClient(cfg)
  return copilotBackend
}

function makeRunId(): string {
  return `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

function createRun(session: SessionData, request: string, mode: 'chat' | 'work'): RunData {
  const now = Date.now()
  const run: RunData = {
    id: makeRunId(),
    sessionId: session.id,
    title: request.slice(0, 40) || '新しい実行',
    request,
    mode,
    status: 'queued',
    phase: 'request',
    currentStep: '依頼を受け付けました',
    nextAction: '計画を作成しています',
    startedAt: now,
    updatedAt: now,
    completedSteps: 0,
    changedFiles: [],
    events: [],
    cancelRequested: false
  }
  runs.set(run.id, run)
  session.runs.unshift(run.id)
  return run
}

function addRunEvent(run: RunData, event: Omit<RunEvent, 'sequence' | 'at'>): void {
  run.updatedAt = Date.now()
  run.events.push({ ...event, sequence: run.events.length + 1, at: run.updatedAt })
  if (run.events.length > 200) run.events.splice(0, run.events.length - 200)
  persistState()
}

function runSnapshot(run: RunData): RunData {
  return { ...run, events: run.events.slice(-100), changedFiles: run.changedFiles.map((change) => ({ ...change })) }
}

function phaseForTool(tool?: string): RunPhase {
  if (tool === 'read_file' || tool === 'list_files' || tool === 'search_files') return 'inspect'
  if (tool === 'write_file' || tool === 'edit_file') return 'edit'
  if (tool === 'start_process' || tool === 'read_process_log' || tool === 'stop_process' || tool === 'run_command') return 'execute'
  return 'plan'
}

function changeFromEvent(event: AgentEvent): RunChange | null {
  const metadata = event.metadata
  const pathValue = typeof metadata?.path === 'string' ? metadata.path : event.summary?.match(/:\s*(.+)$/)?.[1]
  if (!pathValue || (event.tool !== 'edit_file' && event.tool !== 'write_file')) return null
  return {
    path: pathValue,
    changed: metadata?.changed !== false,
    status: metadata?.status === 'no_op' ? 'no_op' : 'applied_unverified',
    beforeHash: typeof metadata?.beforeHash === 'string' ? metadata.beforeHash : undefined,
    afterHash: typeof metadata?.afterHash === 'string' ? metadata.afterHash : undefined,
    readBack: metadata?.readBack === true,
    addedLines: typeof metadata?.addedLines === 'number' ? metadata.addedLines : undefined,
    removedLines: typeof metadata?.removedLines === 'number' ? metadata.removedLines : undefined
  }
}

function updateRunFromEvent(run: RunData, event: AgentEvent): void {
  const summary = event.summary ?? event.tool ?? ''
  switch (event.type) {
    case 'tool.started':
      run.status = 'running'
      run.phase = phaseForTool(event.tool)
      run.currentStep = summary
      run.nextAction = '実行結果を確認しています'
      break
    case 'approval.requested':
      run.status = 'waiting_approval'
      run.phase = 'execute'
      run.currentStep = summary || '承認を待っています'
      run.nextAction = '承認または拒否を選択してください'
      break
    case 'approval.resolved':
      run.status = 'running'
      run.currentStep = summary
      run.nextAction = event.approved ? 'ツールを実行しています' : '拒否結果をAIへ返しています'
      break
    case 'tool.denied':
      run.status = 'running'
      run.currentStep = `${summary}（拒否）`
      run.nextAction = '代替手順を検討しています'
      break
    case 'tool.succeeded': {
      run.status = 'running'
      run.phase = phaseForTool(event.tool)
      run.completedSteps++
      run.currentStep = `${summary}（完了）`
      const change = changeFromEvent(event)
      if (change) {
        const existing = run.changedFiles.findIndex((entry) => entry.path === change.path)
        if (existing >= 0) run.changedFiles[existing] = change
        else run.changedFiles.push(change)
        if (change.changed) {
          run.status = 'applied_unverified'
          run.nextAction = '差分・再読込結果を確認し、検証を実行してください'
        } else {
          run.nextAction = '変更なし（no-op）を記録しました'
        }
      } else {
        run.nextAction = '次のステップを選んでいます'
      }
      break
    }
    case 'tool.failed':
      run.status = 'running'
      run.currentStep = `${summary}（失敗）`
      run.nextAction = '失敗結果をAIへ返し、復旧手順を検討しています'
      break
    case 'run.warning':
      run.status = 'failed'
      run.phase = 'finalize'
      run.error = event.error
      run.currentStep = '最大反復回数に達しました'
      run.nextAction = '完了済みの履歴から再試行してください'
      break
  }
  addRunEvent(run, {
    type: event.type,
    message: event.error ?? event.output?.slice(0, 800) ?? summary,
    tool: event.tool,
    summary,
    output: event.output,
    approved: event.approved,
    durationMs: event.durationMs,
    metadata: event.metadata
  })
}

function updateRunFromLog(run: RunData, text: string): void {
  if (text.startsWith('[error]')) {
    run.error = text.slice(7).trim()
    run.currentStep = '処理に失敗しました'
    run.nextAction = 'エラーを確認して再試行してください'
  } else if (text.startsWith('[warn]')) {
    run.currentStep = text.slice(6).trim()
  }
  addRunEvent(run, { type: 'log', message: text })
}

function finalizeRun(run: RunData, result: { reply: string; aborted: boolean }): void {
  run.endedAt = Date.now()
  run.phase = 'finalize'
  if (run.cancelRequested) {
    run.status = 'canceled'
    run.currentStep = 'キャンセルしました'
    run.nextAction = '新しい依頼を送信できます'
    addRunEvent(run, { type: 'run.canceled', message: 'ユーザーが実行をキャンセルしました' })
  } else if (result.aborted) {
    run.status = 'failed'
    run.currentStep = run.error ? 'エラーで終了しました' : '実行が中断されました'
    run.nextAction = '失敗箇所から再試行してください'
    addRunEvent(run, { type: 'run.failed', message: run.error ?? '実行が中断されました' })
  } else if (run.changedFiles.some((change) => change.changed)) {
    run.status = 'applied_unverified'
    run.currentStep = '変更を適用しました（未検証）'
    run.nextAction = '差分・プレビュー・検証結果を確認してください'
    addRunEvent(run, { type: 'run.applied_unverified', message: '変更は保存されましたが、検証は未完了です' })
  } else {
    run.status = 'verified'
    run.currentStep = '実行が完了しました'
    run.nextAction = '必要なら追加の修正指示を入力してください'
    addRunEvent(run, { type: 'run.completed', message: result.reply || '実行が完了しました' })
  }
}

function persistState(): void {
  try {
    const state = {
      activeId,
      sessions: [...sessions.values()],
      runs: [...runs.values()]
    }
    fs.mkdirSync(path.dirname(persistencePath), { recursive: true })
    fs.writeFileSync(persistencePath, JSON.stringify(state), 'utf8')
  } catch (err) {
    console.warn(`[state] 永続化をスキップしました: ${(err as Error).message}`)
  }
}

function restoreState(): void {
  try {
    if (!fs.existsSync(persistencePath)) return
    const raw = JSON.parse(fs.readFileSync(persistencePath, 'utf8')) as { activeId?: string; sessions?: SessionData[]; runs?: RunData[] }
    if (!Array.isArray(raw.sessions) || !raw.sessions.length) return
    sessions.clear()
    runs.clear()
    for (const session of raw.sessions) {
      if (!session.id || !Array.isArray(session.messages)) continue
      sessions.set(session.id, { ...session, runs: Array.isArray(session.runs) ? session.runs : [] })
    }
    for (const run of raw.runs ?? []) {
      if (!run.id || !run.sessionId) continue
      if (!run.endedAt && !['canceled', 'failed', 'verified', 'rolled_back'].includes(run.status)) {
        run.status = 'paused'
        run.currentStep = 'サーバー再起動後に一時停止しました'
        run.nextAction = 'このRunを確認して再試行してください'
        run.error = 'サーバーが再起動したため、実行は再開されていません'
        run.endedAt = Date.now()
        run.events = Array.isArray(run.events) ? run.events : []
        run.events.push({ sequence: run.events.length + 1, type: 'run.paused', at: Date.now(), message: run.error })
      }
      runs.set(run.id, run)
    }
    activeId = raw.activeId && sessions.has(raw.activeId) ? raw.activeId : [...sessions.keys()][0] ?? ''
  } catch (err) {
    console.warn(`[state] 復元をスキップしました: ${(err as Error).message}`)
  }
}
function makeRunIO(run: RunData): AgentIO {
  return {
    print: (t) => {
      logLines.push(t)
      console.log(t)
      updateRunFromLog(run, t)
    },
    askYesNo: async (question) => {
      run.status = 'waiting_approval'
      run.phase = 'execute'
      run.currentStep = question
      run.nextAction = '承認または拒否を選択してください'
      addRunEvent(run, { type: 'approval.requested', message: question })
      const approved = await requestApproval(question)
      addRunEvent(run, { type: 'approval.resolved', message: approved ? '承認しました' : '拒否しました', approved })
      if (!run.cancelRequested) run.status = 'running'
      return approved
    },
    event: (event) => updateRunFromEvent(run, event),
    isCanceled: () => run.cancelRequested
  }
}

restoreState()
if (!sessions.size) newSession()

function json(res: http.ServerResponse, status: number, obj: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(obj))
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let d = ''
    req.on('data', (c) => (d += c))
    req.on('end', () => resolve(d))
    req.on('error', reject)
  })
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')

  if (req.method === 'GET' && url.pathname === '/') {
    if (indexHtmlPath) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(fs.readFileSync(indexHtmlPath))
    } else {
      res.writeHead(500)
      res.end('public/index.html が見つかりません')
    }
    return
  }

  if (req.method === 'GET' && url.pathname === '/api/info') {
    json(res, 200, { model: cfg.model || (cfg.provider ?? ''), provider: cfg.provider ?? 'openai', workspace, project: path.basename(workspace), version: '0.10.2', distribution: readDistributionState() })
    return
  }

  if (req.method === 'GET' && url.pathname === '/api/distribution') {
    json(res, 200, readDistributionState())
    return
  }

  if (req.method === 'GET' && url.pathname === '/api/log') {
    const offset = Number(url.searchParams.get('offset') ?? 0)
    json(res, 200, { total: logLines.length, lines: logLines.slice(offset) })
    return
  }

  if (req.method === 'GET' && url.pathname === '/api/active-run') {
    const activeRun = activeRunId ? runs.get(activeRunId) : undefined
    json(res, 200, { run: activeRun ? runSnapshot(activeRun) : null })
    return
  }

  const verifyPath = url.pathname.match(/^\/api\/runs\/([^/]+)\/verify$/)
  if (req.method === 'POST' && verifyPath) {
    const run = runs.get(verifyPath[1])
    if (!run) { json(res, 404, { error: 'run not found' }); return }
    run.status = 'verifying'
    run.phase = 'verify'
    run.currentStep = '変更後のファイルを再読込して検証しています'
    run.nextAction = '検証結果を集計しています'
    addRunEvent(run, { type: 'verification.started', message: '変更後のファイルを再読込して検証しています' })
    const checks: Array<{ path: string; ok: boolean; reason: string }> = []
    for (const change of run.changedFiles.filter((entry) => entry.changed && entry.afterHash)) {
      try {
        const abs = path.resolve(workspace, change.path)
        const relative = path.relative(workspace, abs)
        if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('ワークスペース外')
        const current = fs.readFileSync(abs, 'utf8')
        const currentHash = crypto.createHash('sha256').update(current, 'utf8').digest('hex')
        const ok = currentHash === change.afterHash
        checks.push({ path: change.path, ok, reason: ok ? '再読込とハッシュが一致しました' : '変更後ハッシュが一致しません' })
      } catch (err) {
        checks.push({ path: change.path, ok: false, reason: (err as Error).message })
      }
    }
    const ok = checks.every((check) => check.ok)
    run.status = ok ? 'verified' : 'failed'
    run.phase = 'finalize'
    run.currentStep = ok ? '検証済み' : '検証に失敗しました'
    run.nextAction = ok ? '必要なら追加の修正指示を入力してください' : '差分を確認して再試行してください'
    run.endedAt = Date.now()
    addRunEvent(run, { type: 'verification.completed', message: ok ? '検証に合格しました' : '検証に失敗しました', metadata: { checks } })
    json(res, ok ? 200 : 409, { ok, checks, run: runSnapshot(run) })
    return
  }

  const rollbackPath = url.pathname.match(/^\/api\/runs\/([^/]+)\/rollback$/)
  if (req.method === 'POST' && rollbackPath) {
    const run = runs.get(rollbackPath[1])
    if (!run) { json(res, 404, { error: 'run not found' }); return }
    let requestedPath: string | undefined
    try {
      const body = JSON.parse(await readBody(req)) as { path?: string }
      requestedPath = body.path
    } catch {}
    const targets = run.changedFiles.filter((change) => change.changed && (!requestedPath || change.path === requestedPath))
    if (!targets.length) { json(res, 400, { error: 'ロールバック可能な変更がありません' }); return }
    const restored: Array<{ path: string; status: string; hash: string }> = []
    try {
      for (const change of targets) restored.push(await rollbackFileChange(change, ctx))
    } catch (err) {
      addRunEvent(run, { type: 'rollback.failed', message: (err as Error).message })
      json(res, 409, { error: (err as Error).message, run: runSnapshot(run) })
      return
    }
    for (const change of targets) change.status = 'no_op'
    run.status = 'rolled_back'
    run.phase = 'finalize'
    run.currentStep = '変更前の状態へ戻しました'
    run.nextAction = '必要なら再検証してください'
    run.endedAt = Date.now()
    addRunEvent(run, { type: 'rollback.completed', message: `${restored.length}件の変更をロールバックしました`, metadata: { restored } })
    json(res, 200, { ok: true, restored, run: runSnapshot(run) })
    return
  }

  const changesPath = url.pathname.match(/^\/api\/runs\/([^/]+)\/changes$/)
  if (req.method === 'GET' && changesPath) {
    const run = runs.get(changesPath[1])
    if (!run) { json(res, 404, { error: 'run not found' }); return }
    json(res, 200, { runId: run.id, changes: run.changedFiles, note: '差分本文はワークスペースの現在内容と変更前ハッシュを照合して確認してください' })
    return
  }

  const runPath = url.pathname.match(/^\/api\/runs\/([^/]+)(?:\/events)?$/)
  if (req.method === 'GET' && runPath) {
    const run = runs.get(runPath[1])
    if (!run) { json(res, 404, { error: 'run not found' }); return }
    if (url.pathname.endsWith('/events')) {
      const after = Math.max(0, Number(url.searchParams.get('after') ?? 0))
      json(res, 200, { runId: run.id, events: run.events.filter((event) => event.sequence > after) })
    } else {
      json(res, 200, { run: runSnapshot(run) })
    }
    return
  }

  const cancelPath = url.pathname.match(/^\/api\/runs\/([^/]+)\/cancel$/)
  if (req.method === 'POST' && cancelPath) {
    const run = runs.get(cancelPath[1])
    if (!run) { json(res, 404, { error: 'run not found' }); return }
    if (run.endedAt || ['canceled', 'failed', 'verified', 'rolled_back'].includes(run.status)) {
      json(res, 409, { error: 'この実行はすでに終了しています', run: runSnapshot(run) }); return
    }
    run.cancelRequested = true
    run.status = 'canceling'
    run.currentStep = 'キャンセルを要求しました'
    run.nextAction = '現在のツール呼び出しが終わるのを待っています'
    addRunEvent(run, { type: 'run.cancel_requested', message: 'キャンセルを要求しました' })
    clearApprovals()
    json(res, 200, { ok: true, run: runSnapshot(run) })
    return
  }

  if (req.method === 'GET' && url.pathname === '/api/approvals') {
    json(res, 200, { approvals: listApprovals() })
    return
  }

  if (req.method === 'POST' && url.pathname === '/api/approvals/resolve') {
    try {
      const b = JSON.parse(await readBody(req)) as { id?: string; approved?: boolean }
      const ok = resolveApproval(String(b.id ?? ''), Boolean(b.approved))
      if (!ok) { json(res, 404, { error: 'approval not found' }); return }
      json(res, 200, { ok: true })
    } catch (err) {
      json(res, 400, { error: (err as Error).message })
    }
    return
  }
  if (req.method === 'GET' && url.pathname === '/api/processes') {
    json(res, 200, { processes: listManagedProcesses() })
    return
  }

  if (req.method === 'GET' && url.pathname === '/api/processes/log') {
    const processId = url.searchParams.get('process_id') ?? ''
    const offset = Number(url.searchParams.get('offset') ?? 0)
    try {
      json(res, 200, readManagedProcessLog(processId, offset))
    } catch (err) {
      json(res, 404, { error: (err as Error).message })
    }
    return
  }

  if (req.method === 'POST' && url.pathname === '/api/processes/stop') {
    try {
      const b = JSON.parse(await readBody(req)) as { process_id?: string }
      const stopped = await stopManagedProcess(String(b.process_id ?? ''))
      json(res, 200, { process: stopped })
    } catch (err) {
      json(res, 404, { error: (err as Error).message })
    }
    return
  }
  if (req.method === 'GET' && url.pathname === '/api/sessions') {
    const list = [...sessions.values()].sort((a, b) => b.created - a.created).map((s) => {
      const latestRun = s.runs.map((id) => runs.get(id)).find((run): run is RunData => Boolean(run))
      return {
        id: s.id,
        title: s.title,
        created: s.created,
        runCount: s.runs.length,
        latestRun: latestRun ? {
          id: latestRun.id,
          status: latestRun.status,
          phase: latestRun.phase,
          changedFiles: latestRun.changedFiles.length,
          updatedAt: latestRun.updatedAt
        } : null
      }
    })
    json(res, 200, { active: activeId, activeRun: activeRunId ? runSnapshot(runs.get(activeRunId)!) : null, sessions: list })
    return
  }

  if (req.method === 'POST' && url.pathname === '/api/sessions') {
    const s = newSession()
    persistState()
    json(res, 200, { id: s.id, title: s.title })
    return
  }

  if (req.method === 'POST' && url.pathname === '/api/sessions/select') {
    const b = JSON.parse(await readBody(req)) as { id?: string }
    const s = b.id ? sessions.get(b.id) : undefined
    if (!s) { json(res, 404, { error: 'session not found' }); return }
    activeId = s.id
    persistState()
    json(res, 200, { ok: true })
    return
  }

  if (req.method === 'GET' && url.pathname === '/api/session') {
    const s = sessions.get(url.searchParams.get('id') ?? '')
    if (!s) { json(res, 404, { error: 'session not found' }); return }
    activeId = s.id
    json(res, 200, {
      id: s.id,
      title: s.title,
      messages: s.messages.filter((m) => m.role === 'user' || m.role === 'assistant').map((m) => ({ role: m.role, content: m.content ?? '' })),
      runs: s.runs.map((id) => runs.get(id)).filter((run): run is RunData => Boolean(run)).map(runSnapshot),
      activeRun: activeRunId ? runSnapshot(runs.get(activeRunId)!) : null
    })
    return
  }

  if (req.method === 'POST' && url.pathname === '/api/turn') {
    if (activeRunId) {
      const activeRun = runs.get(activeRunId)
      json(res, 409, {
        error: '別の実行が進行中です',
        activeRun: activeRun ? runSnapshot(activeRun) : null,
        nextAction: activeRun?.nextAction ?? '現在の実行を確認してください'
      })
      return
    }
    let input = ''
    let mode: 'chat' | 'work' = 'work'
    try {
      const b = JSON.parse(await readBody(req)) as { message?: string; mode?: string }
      input = String(b.message ?? '').trim()
      if (b.mode === 'chat') mode = 'chat'
    } catch {}
    if (!input) { json(res, 400, { error: 'message が空です' }); return }
    const startIdx = logLines.length
    const s = activeSession()
    if (s.title === '新しいセッション') s.title = input.slice(0, 30)
    const run = createRun(s, input, mode)
    activeRunId = run.id
    run.status = 'planning'
    run.phase = 'plan'
    run.currentStep = '作業計画を作成しています'
    run.nextAction = '最初の調査ステップを選んでいます'
    addRunEvent(run, { type: 'run.created', message: `実行を開始しました: ${run.title}` })
    const effCfg: AgentConfig = mode === 'chat' ? { ...cfg, copilot: { ...(cfg.copilot ?? {}), agentMode: false } } : cfg
    const runIO = makeRunIO(run)
    try {
      const backend = getBackend()
      const result = await runAgentTurn({ cfg: effCfg, messages: s.messages, userInput: input, ctx, io: runIO, backend })
      s.messages = result.messages
      finalizeRun(run, result)
      persistState()
      json(res, 200, {
        reply: result.reply || (result.aborted ? '(中断しました。履歴は保持されています)' : ''),
        aborted: result.aborted,
        logs: logLines.slice(startIdx),
        sessionId: s.id,
        run: runSnapshot(run)
      })
    } catch (err) {
      const message = (err as Error).message
      run.error = message
      run.status = run.cancelRequested ? 'canceled' : 'failed'
      run.phase = 'finalize'
      run.currentStep = '処理に失敗しました'
      run.nextAction = 'エラーを確認して再試行してください'
      addRunEvent(run, { type: 'run.failed', message })
      json(res, 500, { error: message, run: runSnapshot(run) })
    } finally {
      run.endedAt ??= Date.now()
      if (activeRunId === run.id) activeRunId = null
    }
    return
  }

  res.writeHead(404); res.end('not found')
})

lastLogSeen = logLines.length

process.on('exit', () => {
  clearApprovals()
  killAllManagedProcesses()
})
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    clearApprovals()
    killAllManagedProcesses()
    process.exit(0)
  })
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`coding-agent web UI: http://127.0.0.1:${PORT}  (workspace=${workspace})`)
})
