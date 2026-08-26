import http from 'node:http'
import crypto from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import util from 'node:util'
import fs from 'node:fs'
import path from 'node:path'
import { capabilityPolicy, loadConfig, type AgentConfig, type CapabilityPolicy, type TurnMode } from './config'
import type { AgentEvent, AgentIO, ResearchBundle, TextBackend } from './agent'
import { runConfiguredAgentTurn } from './agent-loop'
import { CopilotEdgeClient } from './copilot'
import type { ChatMessage } from './llm'
import { bareToolName, getFileSnapshot, rollbackFileChange, type ToolContext } from './tools'
import { killAllManagedProcesses, listManagedProcesses, readManagedProcessLog, stopManagedProcess } from './processes'
import { clearApprovals, getApprovalResolution, listApprovals, requestApproval, resolveApproval, type ApprovalBinding, type ApprovalRisk } from './approvals'

const PORT = Number(process.env.PORT ?? 3948)
const execFileAsync = util.promisify(execFile)

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1] : undefined
}

const cfg: AgentConfig = loadConfig(argValue('--config'))
const workspaceArg = argValue('--workspace')
const workspace = workspaceArg ? path.resolve(workspaceArg) : process.cwd()
const ctx: ToolContext = { workspace, restrictToWorkspace: cfg.restrictToWorkspace ?? true, safeCommandOnly: cfg.safeCommandOnly === true, weatherDefaultLocation: cfg.weather?.defaultLocation }

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
type VerificationStatus = 'pending' | 'running' | 'pass' | 'fail' | 'todo' | 'skipped'

interface PlanStep {
  id: string
  title: string
  status: 'pending' | 'in_progress' | 'completed' | 'failed'
  startedAt?: number
  completedAt?: number
}

interface DiffLine {
  kind: 'context' | 'add' | 'remove'
  oldLine?: number
  newLine?: number
  text: string
}

interface RunChange {
  changeId: string
  path: string
  changed: boolean
  status: 'no_op' | 'applied_unverified'
  existedBefore?: boolean
  beforeHash?: string
  afterHash?: string
  readBack?: boolean
  addedLines?: number
  removedLines?: number
  beforeContent?: string
  afterContent?: string
  diff: DiffLine[]
}

interface RunArtifact {
  id: string
  type: 'preview' | 'process-log' | 'diagnostic'
  name: string
  url?: string
  processId?: string
  createdAt: number
  metadata?: Record<string, unknown>
}

interface VerificationCheck {
  id: string
  label: string
  status: VerificationStatus
  evidence?: string
  startedAt?: number
  completedAt?: number
}

interface RunVerification {
  profile: 'auto' | 'html' | 'typescript' | 'powershell' | 'generic'
  checks: VerificationCheck[]
  machinePassed: boolean
  userConfirmed: boolean
  startedAt?: number
  completedAt?: number
}

interface RunCheckpoint {
  createdAt: number
  reason: string
  messages: ChatMessage[]
  steps: string[]
}

interface RunApproval {
  id?: string
  question: string
  runId: string
  stepId: string
  toolName?: string
  risk: ApprovalRisk
  scope: string
  binding?: ApprovalBinding
  expiresAt: number
  approved?: boolean
  reason?: string
}

interface RunEvent {
  eventId?: string
  runId?: string
  stepId?: string
  toolEventId?: string
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
  origin?: 'host' | 'orchestrator' | 'copilot'
  namespace?: 'app' | 'native' | 'none'
  authority?: 'authoritative' | 'observed' | 'claimed' | 'derived'
  callId?: string
}

interface RunData {
  id: string
  sessionId: string
  parentRunId?: string
  title: string
  request: string
  mode: TurnMode
  capabilities: { hostTools: boolean; nativeSearch: boolean; nativeOffice: boolean }
  policy: CapabilityPolicy
  budget: { modelDecisions: number; hostExecutions: number; writeExecutions: number; commandExecutions: number }
  research?: ResearchBundle
  status: RunStatus
  phase: RunPhase
  currentStep: string
  nextAction: string
  startedAt: number
  updatedAt: number
  endedAt?: number
  completedSteps: number
  plan: PlanStep[]
  changedFiles: RunChange[]
  artifacts: RunArtifact[]
  events: RunEvent[]
  auditEvents?: RunEvent[]
  nextSequence?: number
  auditEventCount?: number
  verification: RunVerification
  checkpoint?: RunCheckpoint
  cancelRequested: boolean
  pauseRequested: boolean
  resumeCount: number
  approval?: RunApproval
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
let recoveredRunId: string | null = null
const runControllers = new Map<string, AbortController>()
const copilotBackends = new Map<TurnMode, TextBackend>()
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

function getBackend(mode: TurnMode): TextBackend | undefined {
  if ((cfg.agentLoop ?? 'v1') === 'v2') return undefined
  if (cfg.provider !== 'copilot-edge') return undefined
  const existing = copilotBackends.get(mode)
  if (existing) return existing
  const backend = new CopilotEdgeClient({
    ...cfg,
    copilot: { ...(cfg.copilot ?? {}), profileName: 'mode-' + mode }
  })
  copilotBackends.set(mode, backend)
  return backend
}

function makeRunId(): string {
  return `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

const DEFAULT_PLAN: PlanStep[] = [
  { id: 'inspect', title: '現状の状態表示と構造を調査', status: 'pending' },
  { id: 'plan', title: '作業計画と検証条件を作成', status: 'pending' },
  { id: 'edit', title: '対象ファイルを編集', status: 'pending' },
  { id: 'execute', title: 'ツールとプレビューを実行', status: 'pending' },
  { id: 'verify', title: '差分・構文・テストを検証', status: 'pending' },
  { id: 'confirm', title: '実機確認と完了を確定', status: 'pending' }
]

function createRun(session: SessionData, request: string, mode: TurnMode, parentRunId?: string): RunData {
  const now = Date.now()
  const run: RunData = {
    id: makeRunId(),
    sessionId: session.id,
    ...(parentRunId ? { parentRunId } : {}),
    title: request.slice(0, 40) || '新しい実行',
    request,
    mode,
    capabilities: {
      hostTools: mode === 'work',
      nativeSearch: mode === 'research',
      nativeOffice: false
    },
    policy: capabilityPolicy(cfg, mode),
    budget: { modelDecisions: 0, hostExecutions: 0, writeExecutions: 0, commandExecutions: 0 },
    status: 'queued',
    phase: 'request',
    currentStep: '依頼を受け付けました',
    nextAction: '計画を作成しています',
    startedAt: now,
    updatedAt: now,
    completedSteps: 0,
    plan: DEFAULT_PLAN.map((step) => ({ ...step })),
    changedFiles: [],
    artifacts: [],
    events: [],
    auditEvents: [],
    nextSequence: 1,
    verification: {
      profile: 'auto',
      checks: [
        { id: 'file-readback', label: '変更後ファイルの再読込', status: 'pending' },
        { id: 'syntax-tests', label: '構文・テスト', status: 'pending' },
        { id: 'user-confirmation', label: '実機操作・読み上げ確認', status: 'todo' }
      ],
      machinePassed: false,
      userConfirmed: false
    },
    cancelRequested: false,
    pauseRequested: false,
    resumeCount: 0
  }
  runs.set(run.id, run)
  session.runs.unshift(run.id)
  return run
}

function addRunEvent(run: RunData, event: Omit<RunEvent, 'sequence' | 'at'>): void {
  run.updatedAt = Date.now()
  const sequence = run.nextSequence ?? ((run.auditEvents ?? run.events).reduce((max, entry) => Math.max(max, entry.sequence), 0) + 1)
  run.nextSequence = sequence + 1
  const eventId = `${run.id}-event-${sequence}`
  const nextEvent: RunEvent = { ...event, origin: event.origin ?? 'orchestrator', namespace: event.namespace ?? 'none', authority: event.authority ?? 'derived', eventId, runId: run.id, stepId: run.phase, toolEventId: eventId, sequence, at: run.updatedAt }
  run.auditEvents ??= []
  run.auditEvents.push(nextEvent)
  run.events.push(nextEvent)
  if (run.events.length > 200) run.events.splice(0, run.events.length - 200)
  persistState()
}

function runSnapshot(run: RunData): RunData {
  const { auditEvents: _auditEvents, nextSequence: _nextSequence, ...publicRun } = run
  return {
    ...publicRun,
    auditEventCount: run.auditEvents?.length ?? run.events.length,
    plan: run.plan.map((step) => ({ ...step })),
    events: run.events.slice(-120).map((event) => ({ ...event })),
    changedFiles: run.changedFiles.map((change) => ({ ...change, diff: change.diff.map((line) => ({ ...line })) })),
    artifacts: run.artifacts.map((artifact) => ({ ...artifact })),
    verification: { ...run.verification, checks: run.verification.checks.map((check) => ({ ...check })) },
    ...(run.checkpoint ? { checkpoint: { ...run.checkpoint, messages: run.checkpoint.messages.map((message) => ({ ...message })), steps: [...run.checkpoint.steps] } } : {})
  }
}

function phaseForTool(tool?: string): RunPhase {
  const bare = bareToolName(tool ?? '')
  if (bare === 'read_file' || bare === 'list_files' || bare === 'search_files' || bare === 'get_weather') return 'inspect'
  if (bare === 'write_file' || bare === 'edit_file') return 'edit'
  if (bare === 'start_process' || bare === 'read_process_log' || bare === 'stop_process' || bare === 'run_command' || bare === 'list_processes') return 'execute'
  return 'plan'
}
function buildDiff(before: string, after: string, maxLines = 600): DiffLine[] {
  const b = before.split(/\r?\n/)
  const a = after.split(/\r?\n/)
  let prefix = 0
  while (prefix < b.length && prefix < a.length && b[prefix] === a[prefix]) prefix++
  let suffix = 0
  while (suffix < b.length - prefix && suffix < a.length - prefix && b[b.length - suffix - 1] === a[a.length - suffix - 1]) suffix++
  const lines: DiffLine[] = []
  const context = 2
  for (let i = Math.max(0, prefix - context); i < prefix; i++) lines.push({ kind: 'context', oldLine: i + 1, newLine: i + 1, text: b[i] })
  for (let i = prefix; i < b.length - suffix && lines.length < maxLines; i++) lines.push({ kind: 'remove', oldLine: i + 1, text: b[i] })
  for (let i = prefix; i < a.length - suffix && lines.length < maxLines; i++) lines.push({ kind: 'add', newLine: i + 1, text: a[i] })
  for (let i = Math.max(prefix, b.length - suffix); i < b.length && lines.length < maxLines; i++) {
    const j = i - (b.length - a.length)
    if (j >= 0 && j < a.length) lines.push({ kind: 'context', oldLine: i + 1, newLine: j + 1, text: b[i] })
  }
  return lines
}

function changeFromEvent(run: RunData, event: AgentEvent): RunChange | null {
  const metadata = event.metadata
  const bare = bareToolName(event.tool ?? '')
  const pathValue = typeof metadata?.path === 'string' ? metadata.path : event.summary?.match(/:\s*(.+)$/)?.[1]
  if (!pathValue || (bare !== 'edit_file' && bare !== 'write_file')) return null
  const snapshot = getFileSnapshot(pathValue, { ...ctx, runId: run.id })
  const before = snapshot?.before ?? ''
  const after = snapshot?.after ?? ''
  const changed = metadata?.changed !== false
  const previous = run.changedFiles.find((entry) => entry.path === pathValue)
  return {
    changeId: previous?.changeId ?? `${run.id}-change-${run.changedFiles.length + 1}`,
    path: pathValue,
    changed,
    status: metadata?.status === 'no_op' ? 'no_op' : 'applied_unverified',
    existedBefore: snapshot?.existedBefore ?? previous?.existedBefore ?? metadata?.existedBefore === true,
    beforeHash: previous?.beforeHash ?? (typeof metadata?.beforeHash === 'string' ? metadata.beforeHash : (before ? crypto.createHash('sha256').update(before, 'utf8').digest('hex') : undefined)),
    afterHash: typeof metadata?.afterHash === 'string' ? metadata.afterHash : snapshot?.afterHash,
    readBack: metadata?.readBack === true,
    addedLines: typeof metadata?.addedLines === 'number' ? metadata.addedLines : undefined,
    removedLines: typeof metadata?.removedLines === 'number' ? metadata.removedLines : undefined,
    beforeContent: previous?.beforeContent ?? before,
    afterContent: after,
    diff: buildDiff(previous?.beforeContent ?? before, after)
  }
}
function updateRunFromEvent(run: RunData, event: AgentEvent): void {
  run.budget ??= { modelDecisions: 0, hostExecutions: 0, writeExecutions: 0, commandExecutions: 0 }
  if (event.type === 'model.decision') run.budget.modelDecisions++
  if (event.type === 'tool.started' && event.origin === 'host') {
    run.budget.hostExecutions++
    const tool = bareToolName(event.tool ?? '')
    if (tool === 'write_file' || tool === 'edit_file') run.budget.writeExecutions++
    if (tool === 'run_command' || tool === 'start_process' || tool === 'read_process_log' || tool === 'stop_process') run.budget.commandExecutions++
  }
  const summary = event.summary ?? event.tool ?? ''
  switch (event.type) {
    case 'plan.created':
      run.status = 'planning'
      run.phase = 'plan'
      run.plan[1].status = 'in_progress'
      run.currentStep = '作業計画と検証条件を作成しました'
      run.nextAction = '対象ファイルを調査しています'
      break
    case 'step.started': {
      const phase = phaseForTool(event.tool)
      const step = run.plan.find((entry) => entry.id === phase) ?? run.plan[0]
      step.status = 'in_progress'
      step.startedAt = Date.now()
      run.status = 'running'
      run.phase = phase
      run.currentStep = summary
      run.nextAction = 'ツールの結果を確認しています'
      break
    }
    case 'step.completed': {
      const phase = phaseForTool(event.tool)
      const step = run.plan.find((entry) => entry.id === phase) ?? run.plan[0]
      step.status = 'completed'
      step.completedAt = Date.now()
      run.completedSteps = run.plan.filter((entry) => entry.status === 'completed').length
      break
    }
    case 'step.failed': {
      const phase = phaseForTool(event.tool)
      const step = run.plan.find((entry) => entry.id === phase) ?? run.plan[0]
      step.status = 'failed'
      step.completedAt = Date.now()
      run.currentStep = `${summary}（失敗）`
      run.nextAction = '失敗結果を確認して再試行または代替手順を選択してください'
      break
    }
    case 'tool.requested':
      run.status = 'running'
      run.phase = phaseForTool(event.tool)
      run.currentStep = summary
      run.nextAction = '承認が必要か確認しています'
      break
    case 'tool.approved':
      run.status = 'running'
      run.phase = phaseForTool(event.tool)
      run.currentStep = summary
      run.nextAction = 'ツールを実行しています'
      break
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
      run.currentStep = `${summary}（完了）`
      run.completedSteps = run.plan.filter((entry) => entry.status === 'completed').length
      const change = changeFromEvent(run, event)
      if (change) {
        const existing = run.changedFiles.findIndex((entry) => entry.path === change.path)
        if (existing >= 0) run.changedFiles[existing] = change
        else run.changedFiles.push(change)
        addRunEvent(run, { type: 'file.before_captured', message: `${change.path} の変更前スナップショットを保存しました`, metadata: { path: change.path, beforeHash: change.beforeHash, changeId: change.changeId } })
        addRunEvent(run, { type: 'snapshot.created', message: `${change.path} のロールバック用スナップショットを作成しました`, metadata: { path: change.path, beforeHash: change.beforeHash, changeId: change.changeId } })
        if (change.changed) {
          addRunEvent(run, { type: 'file.changed', message: `${change.path} を適用しました（未検証）`, metadata: { path: change.path, changeId: change.changeId, beforeHash: change.beforeHash, afterHash: change.afterHash } })
          addRunEvent(run, { type: 'diff.ready', message: `${change.path} の差分を生成しました`, metadata: { path: change.path, changeId: change.changeId, addedLines: change.addedLines, removedLines: change.removedLines } })
          if (change.readBack) addRunEvent(run, { type: 'file.read_back', message: `${change.path} を再読込しました`, metadata: { path: change.path, changeId: change.changeId, afterHash: change.afterHash } })
          run.status = 'applied_unverified'
          run.phase = 'verify'
          run.nextAction = '差分・再読込結果を確認し、検証を実行してください'
          const readback = run.verification.checks.find((check) => check.id === 'file-readback')
          if (readback) { readback.status = change.readBack ? 'pass' : 'fail'; readback.evidence = change.readBack ? '変更後の内容を再読込しハッシュを記録しました' : 'read-backが確認できません' }
        } else {
          run.nextAction = '変更なし（no-op）を記録しました'
        }
      } else if (bareToolName(event.tool ?? '') === 'start_process') {
        try {
          const process = JSON.parse(event.output ?? '') as { id?: string; url?: string; label?: string }
          const artifact: RunArtifact = {
            id: `${run.id}-artifact-${run.artifacts.length + 1}`,
            type: process.url ? 'preview' : 'process-log',
            name: process.label || event.summary || '実行プロセス',
            ...(process.url ? { url: process.url } : {}),
            ...(process.id ? { processId: process.id } : {}),
            createdAt: Date.now()
          }
          run.artifacts.push(artifact)
          addRunEvent(run, { type: process.url ? 'preview.ready' : 'artifact.created', message: artifact.name, metadata: { artifact } })
        } catch {}
        run.nextAction = '生成物とログを確認してください'
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
      run.currentStep = `安全上限で停止しました: ${event.error ?? '実行予算または進展条件を満たしませんでした'}`
      run.nextAction = '差分・実行履歴を確認し、必要なら条件を変えて再試行またはロールバックしてください'
      run.checkpoint = { createdAt: Date.now(), reason: event.error ?? '反復上限', messages: [], steps: [] }
      addRunEvent(run, { type: 'checkpoint.created', message: '反復上限時点のチェックポイントを保存しました', metadata: { checkpointAt: run.checkpoint.createdAt } })
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
    metadata: event.metadata,
    origin: event.origin,
    namespace: event.namespace,
    authority: event.authority,
    callId: event.callId
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

function finalizeRun(run: RunData, result: { reply: string; aborted: boolean; paused?: boolean; checkpoint?: string[]; messages?: ChatMessage[] }): void {
  run.endedAt = Date.now()
  run.phase = 'finalize'
  if (run.pauseRequested || result.paused) {
    run.status = 'paused'
    run.currentStep = 'チェックポイントを保存して一時停止しました'
    run.nextAction = '再開または失敗箇所から再試行してください'
    run.checkpoint = {
      createdAt: Date.now(),
      reason: '利用者が一時停止しました',
      messages: result.messages ?? [],
      steps: result.checkpoint ?? []
    }
    addRunEvent(run, { type: 'run.paused', message: 'チェックポイントを保存しました', metadata: { checkpointAt: run.checkpoint.createdAt } })
    addRunEvent(run, { type: 'checkpoint.created', message: '一時停止用チェックポイントを作成しました', metadata: { checkpointAt: run.checkpoint.createdAt, reason: run.checkpoint.reason } })
  } else if (run.cancelRequested) {
    run.status = 'canceled'
    run.currentStep = 'キャンセルしました'
    run.nextAction = '新しい依頼を送信できます'
    addRunEvent(run, { type: 'run.canceled', message: 'ユーザーが実行をキャンセルしました' })
  } else if (result.aborted) {
    run.status = 'failed'
    run.currentStep = run.error ? `停止理由: ${run.error}` : '実行が中断されました'
    run.nextAction = run.error ? '差分・実行履歴を確認し、必要なら条件を変えて再試行またはロールバックしてください' : '失敗箇所から再試行してください'
    run.checkpoint = { createdAt: run.checkpoint?.createdAt ?? Date.now(), reason: run.checkpoint?.reason ?? (run.error ?? '実行が中断されました'), messages: result.messages ?? run.checkpoint?.messages ?? [], steps: result.checkpoint ?? run.checkpoint?.steps ?? [] }
    addRunEvent(run, { type: 'run.failed', message: run.error ?? '実行が中断されました', metadata: { checkpointAt: run.checkpoint.createdAt } })
    addRunEvent(run, { type: 'checkpoint.created', message: '失敗時点のチェックポイントを保存しました', metadata: { checkpointAt: run.checkpoint.createdAt, reason: run.checkpoint.reason } })
  } else if (run.changedFiles.some((change) => change.changed)) {
    run.status = 'applied_unverified'
    run.phase = 'verify'
    run.currentStep = '変更を適用しました（未検証）'
    run.nextAction = '差分・プレビュー・検証結果を確認してください'
    const verifyStep = run.plan.find((step) => step.id === 'verify')
    if (verifyStep) verifyStep.status = 'in_progress'
    addRunEvent(run, { type: 'run.applied_unverified', message: '変更は保存されましたが、検証は未完了です' })
  } else {
    run.status = 'verified'
    run.currentStep = '実行が完了しました'
    run.nextAction = '必要なら追加の修正指示を入力してください'
    run.verification.machinePassed = true
    run.verification.userConfirmed = true
    addRunEvent(run, { type: 'run.completed', message: result.reply || '実行が完了しました' })
  }
}

function persistState(): void {
  try {
    const state = {
      activeId,
      activeRunId,
      recoveredRunId,
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
    const raw = JSON.parse(fs.readFileSync(persistencePath, 'utf8')) as { activeId?: string; activeRunId?: string | null; recoveredRunId?: string | null; sessions?: SessionData[]; runs?: RunData[] }
    if (!Array.isArray(raw.sessions) || !raw.sessions.length) return
    sessions.clear()
    runs.clear()
    for (const session of raw.sessions) {
      if (!session.id || !Array.isArray(session.messages)) continue
      sessions.set(session.id, { ...session, runs: Array.isArray(session.runs) ? session.runs : [] })
    }
    for (const rawRun of raw.runs ?? []) {
      const run = rawRun as RunData
      if (!run.id || !run.sessionId) continue
      run.mode = run.mode === 'chat' || run.mode === 'research' || run.mode === 'work' ? run.mode : 'work'
      run.capabilities = run.capabilities ?? { hostTools: run.mode === 'work', nativeSearch: run.mode === 'research', nativeOffice: false }
      run.policy = run.policy ?? capabilityPolicy(cfg, run.mode)
      run.budget = run.budget ?? { modelDecisions: 0, hostExecutions: 0, writeExecutions: 0, commandExecutions: 0 }
      run.plan = Array.isArray(run.plan) ? run.plan : DEFAULT_PLAN.map((step) => ({ ...step }))
      run.changedFiles = Array.isArray(run.changedFiles) ? run.changedFiles.map((change) => ({ ...change, changeId: change.changeId ?? `${run.id}-change-${Math.random().toString(36).slice(2, 7)}`, diff: Array.isArray(change.diff) ? change.diff : [] })) : []
      run.artifacts = Array.isArray(run.artifacts) ? run.artifacts : []
      run.events = Array.isArray(run.events) ? run.events : []
      run.auditEvents = Array.isArray(run.auditEvents) ? run.auditEvents : run.events.map((event) => ({ ...event }))
      const maxSequence = (run.auditEvents ?? []).reduce((max, event) => Math.max(max, Number(event.sequence) || 0), 0)
      run.nextSequence = Math.max(Number(run.nextSequence ?? 0), maxSequence + 1, 1)
      if (!run.verification || !Array.isArray(run.verification.checks) || run.verification.checks.length === 0) run.verification = { profile: 'auto', checks: [{ id: 'file-readback', label: '変更後ファイルの再読込', status: 'pending' }, { id: 'syntax-tests', label: '構文・テスト', status: 'pending' }, { id: 'user-confirmation', label: '実機操作・読み上げ確認', status: 'todo' }], machinePassed: false, userConfirmed: false }
      run.pauseRequested = run.pauseRequested === true
      run.resumeCount = Number(run.resumeCount ?? 0)
      if (!run.endedAt && !['canceled', 'failed', 'verified', 'rolled_back'].includes(run.status)) {
        run.status = 'paused'
        run.currentStep = 'サーバー再起動後に一時停止しました'
        run.nextAction = 'このRunを確認して再試行してください'
        run.error = 'サーバーが再起動したため、実行は再開されていません'
        run.endedAt = Date.now()
        run.events = Array.isArray(run.events) ? run.events : []
        const sequence = run.nextSequence ?? ((run.auditEvents ?? run.events).reduce((max, entry) => Math.max(max, entry.sequence), 0) + 1)
        const event: RunEvent = { sequence, type: 'run.paused', at: Date.now(), message: run.error, eventId: `${run.id}-event-${sequence}`, runId: run.id, stepId: 'finalize', toolEventId: `${run.id}-event-${sequence}`, origin: 'orchestrator', namespace: 'none', authority: 'derived' }
        run.nextSequence = sequence + 1
        run.auditEvents ??= []
        run.auditEvents.push(event)
        run.events.push(event)
        recoveredRunId = run.id
      }
      runs.set(run.id, run)
    }
    activeId = raw.activeId && sessions.has(raw.activeId) ? raw.activeId : [...sessions.keys()][0] ?? ''
    if (!recoveredRunId && raw.recoveredRunId && runs.has(raw.recoveredRunId)) recoveredRunId = raw.recoveredRunId
    activeRunId = raw.activeRunId && runs.has(raw.activeRunId) && !runs.get(raw.activeRunId)?.endedAt ? raw.activeRunId : null
  } catch (err) {
    console.warn(`[state] 復元をスキップしました: ${(err as Error).message}`)
  }
}
function makeRunIO(run: RunData, controller: AbortController): AgentIO {
  return {
    print: (t) => {
      logLines.push(t)
      console.log(t)
      updateRunFromLog(run, t)
    },
    askYesNo: async (question, binding) => {
      const stepId = `${run.phase}-${Math.max(1, run.completedSteps + 1)}`
      const approvalRequest = {
        question,
        runId: run.id,
        stepId,
        toolName: binding?.toolName ?? run.currentStep.split(':')[0],
        risk: 'medium' as ApprovalRisk,
        scope: ctx.workspace,
        expiresAt: Date.now() + 10 * 60 * 1000,
        binding: { ...binding, runId: run.id }
      }
      const pending = requestApproval(approvalRequest)
      const snapshot = listApprovals().find((entry) => entry.runId === run.id && entry.question === question)
      run.approval = { ...approvalRequest, ...(snapshot ? { id: snapshot.id } : {}) }
      run.status = 'waiting_approval'
      run.phase = 'execute'
      run.currentStep = question
      run.nextAction = '承認または拒否を選択してください'
      addRunEvent(run, { type: 'approval.requested', message: question, metadata: { approval: run.approval } })
      const approved = await pending
      const resolution = run.approval?.id ? getApprovalResolution(run.approval.id) : undefined
      run.approval = { ...run.approval, approved, ...(resolution ? { reason: resolution.reason } : {}) }
      if (resolution?.reason === '承認期限切れ') addRunEvent(run, { type: 'approval.expired', message: resolution.reason, approved: false, metadata: { approval: run.approval } })
      addRunEvent(run, { type: 'approval.resolved', message: resolution?.reason ?? (approved ? '承認しました' : '拒否しました'), approved, metadata: { approval: run.approval } })
      if (!run.cancelRequested) run.status = 'running'
      return approved
    },
    event: (event) => updateRunFromEvent(run, event),
    isCanceled: () => run.cancelRequested,
    isPaused: () => run.pauseRequested,
    signal: controller.signal
  }
}

async function executeRun(run: RunData, session: SessionData, input: string, mode: TurnMode): Promise<{ reply: string; aborted: boolean; paused?: boolean; logs: string[]; research?: ResearchBundle }> {
  const startIdx = logLines.length
  const controller = new AbortController()
  runControllers.set(run.id, controller)
  activeRunId = run.id
  run.status = 'planning'
  run.phase = 'plan'
  run.currentStep = '作業計画を作成しています'
  run.nextAction = '最初の調査ステップを選んでいます'
  addRunEvent(run, { type: 'run.started', message: 'Runを実行しています' })
  const effCfg: AgentConfig = { ...cfg, turnMode: mode, copilot: { ...(cfg.copilot ?? {}), agentMode: mode === 'work' && (cfg.copilot?.agentMode ?? true) } }
  try {
    const backend = getBackend(mode)
    const result = await runConfiguredAgentTurn({
      cfg: effCfg,
      messages: session.messages,
      userInput: input,
      ctx: { ...ctx, runId: run.id, signal: controller.signal },
      io: makeRunIO(run, controller),
      backend
    })
    session.messages = result.messages
    if (result.research) run.research = result.research
    finalizeRun(run, result)
    persistState()
    return { reply: result.reply, aborted: result.aborted, ...(result.paused ? { paused: true } : {}), ...(result.research ? { research: result.research } : {}), logs: logLines.slice(startIdx) }
  } catch (err) {
    const message = (err as Error).message
    run.error = message
    if (run.pauseRequested) {
      run.status = 'paused'
      run.currentStep = '一時停止要求を受けてチェックポイントを保存しました'
      run.nextAction = '再開または再試行してください'
      run.checkpoint = { createdAt: Date.now(), reason: '一時停止要求', messages: session.messages, steps: [] }
      addRunEvent(run, { type: 'run.paused', message: run.currentStep })
    } else {
      run.status = run.cancelRequested || controller.signal.aborted ? 'canceled' : 'failed'
      run.currentStep = run.status === 'canceled' ? 'キャンセルしました' : '処理に失敗しました'
      run.nextAction = run.status === 'canceled' ? '新しい依頼を送信できます' : 'エラーを確認して再試行してください'
      addRunEvent(run, { type: run.status === 'canceled' ? 'run.canceled' : 'run.failed', message })
    }
    run.endedAt = Date.now()
    persistState()
    return { reply: '', aborted: true, ...(run.status === 'paused' ? { paused: true } : {}), logs: logLines.slice(startIdx) }
  } finally {
    runControllers.delete(run.id)
    if (activeRunId === run.id) activeRunId = null
    persistState()
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
    json(res, 200, { model: cfg.model || (cfg.provider ?? ''), provider: cfg.provider ?? 'openai', workspace, project: path.basename(workspace), version: '0.10.8', distribution: readDistributionState() })
    return
  }

  if (url.pathname === '/api/copilot/visible-session') {
    const backend = getBackend('work')
    if (!(backend instanceof CopilotEdgeClient)) {
      json(res, 409, { error: 'copilot-edge provider is required' })
      return
    }
    try {
      if (req.method === 'POST') {
        if (activeRunId) {
          json(res, 409, { error: '実行中は表示セッションを切り替えられません' })
          return
        }
        const body = JSON.parse(await readBody(req)) as { sessionId?: string }
        const sessionId = String(body.sessionId ?? '')
        if (!sessions.has(sessionId)) {
          json(res, 404, { error: 'session not found' })
          return
        }
        activeId = sessionId
        const state = await backend.prepareVisibleSession(sessionId)
        persistState()
        json(res, 200, state)
        return
      }
      if (req.method === 'GET') {
        const sessionId = String(url.searchParams.get('sessionId') ?? '')
        if (!sessions.has(sessionId)) {
          json(res, 404, { error: 'session not found' })
          return
        }
        json(res, 200, await backend.inspectVisibleSession(sessionId))
        return
      }
    } catch (err) {
      json(res, 500, { error: (err as Error).message })
      return
    }
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

  if (req.method === 'POST' && url.pathname === '/api/runs') {
    if (activeRunId) { json(res, 409, { error: '別の実行が進行中です', activeRun: runSnapshot(runs.get(activeRunId)!) }); return }
    let body: { message?: string; mode?: string; sessionId?: string } = {}
    try { body = JSON.parse(await readBody(req)) as typeof body } catch {}
    const input = String(body.message ?? '').trim()
    if (!input) { json(res, 400, { error: 'message が空です' }); return }
    const session = body.sessionId ? sessions.get(body.sessionId) : activeSession()
    if (!session) { json(res, 404, { error: 'session not found' }); return }
    const mode: TurnMode = body.mode === 'chat' || body.mode === 'research' || body.mode === 'work' ? body.mode : 'work'
    const run = createRun(session, input, mode)
    addRunEvent(run, { type: 'run.created', message: `Runをキューへ追加しました: ${run.title}` })
    persistState()
    json(res, 201, { run: runSnapshot(run) })
    return
  }

  const sessionRunsPath = url.pathname.match(/^\/api\/sessions\/([^/]+)\/runs$/)
  if (req.method === 'GET' && sessionRunsPath) {
    const session = sessions.get(sessionRunsPath[1])
    if (!session) { json(res, 404, { error: 'session not found' }); return }
    json(res, 200, { sessionId: session.id, runs: session.runs.map((id) => runs.get(id)).filter((run): run is RunData => Boolean(run)).map(runSnapshot) })
    return
  }

  if (req.method === 'GET' && url.pathname === '/api/active-run') {
    const activeRun = activeRunId ? runs.get(activeRunId) : (recoveredRunId ? runs.get(recoveredRunId) : undefined)
    json(res, 200, { run: activeRun ? runSnapshot(activeRun) : null, active: Boolean(activeRunId), recoverable: Boolean(recoveredRunId) })
    return
  }

  const verifyPath = url.pathname.match(/^\/api\/runs\/([^/]+)\/verify$/)
  if (req.method === 'POST' && verifyPath) {
    const run = runs.get(verifyPath[1])
    if (!run) { json(res, 404, { error: 'run not found' }); return }
    let body: { profile?: string } = {}
    try { body = JSON.parse(await readBody(req)) as typeof body } catch {}
    run.status = 'verifying'
    run.phase = 'verify'
    run.currentStep = '変更後のファイルを再読込して検証しています'
    run.nextAction = '構文・テスト・実機確認を集計しています'
    run.endedAt = undefined
    addRunEvent(run, { type: 'verification.started', message: '変更後のファイルを再読込して検証しています', metadata: { profile: body.profile ?? 'auto' } })
    addRunEvent(run, { type: 'verification.profile_selected', message: `検証プロファイル: ${body.profile ?? 'auto'}`, metadata: { profile: body.profile ?? 'auto' } })
    run.verification = await performVerification(run, body.profile)
    for (const check of run.verification.checks) addRunEvent(run, { type: check.status === 'pass' ? 'verification.check_passed' : check.status === 'fail' ? 'verification.check_failed' : 'verification.check_todo', message: `${check.label}: ${check.evidence ?? check.status}`, metadata: { check } })
    run.status = run.verification.machinePassed ? 'waiting_user' : 'failed'
    run.phase = 'verify'
    run.currentStep = run.verification.machinePassed ? '機械検証に合格しました' : '検証に失敗しました'
    run.nextAction = run.verification.machinePassed ? '実機確認後に「確認済みで完了」を押してください' : '差分と検証結果を確認して再試行してください'
    run.endedAt = Date.now()
    const verifyStep = run.plan.find((step) => step.id === 'verify')
    if (verifyStep) verifyStep.status = run.verification.machinePassed ? 'completed' : 'failed'
    addRunEvent(run, { type: 'verification.completed', message: run.currentStep, metadata: { verification: run.verification } })
    persistState()
    json(res, run.verification.machinePassed ? 200 : 409, { ok: run.verification.machinePassed, verification: run.verification, run: runSnapshot(run) })
    return
  }

  const confirmPath = url.pathname.match(/^\/api\/runs\/([^/]+)\/confirm$/)
  if (req.method === 'POST' && confirmPath) {
    const run = runs.get(confirmPath[1])
    if (!run) { json(res, 404, { error: 'run not found' }); return }
    if (!run.verification.machinePassed) { json(res, 409, { error: '機械検証が完了していません', run: runSnapshot(run) }); return }
    run.verification.userConfirmed = true
    const userCheck = run.verification.checks.find((check) => check.id === 'user-confirmation')
    if (userCheck) { userCheck.status = 'pass'; userCheck.evidence = '利用者が実機操作・読み上げ確認を完了しました'; userCheck.completedAt = Date.now() }
    run.status = 'verified'
    run.phase = 'finalize'
    run.currentStep = '検証済み・利用者確認済み'
    run.nextAction = '必要なら追加の修正指示を入力してください'
    run.endedAt = Date.now()
    const confirmStep = run.plan.find((step) => step.id === 'confirm')
    if (confirmStep) { confirmStep.status = 'completed'; confirmStep.completedAt = Date.now() }
    addRunEvent(run, { type: 'verification.user_confirmed', message: '利用者確認が完了しました' })
    persistState()
    json(res, 200, { ok: true, run: runSnapshot(run) })
    return
  }

  const artifactsPath = url.pathname.match(/^\/api\/runs\/([^/]+)\/artifacts$/)
  if (req.method === 'GET' && artifactsPath) {
    const run = runs.get(artifactsPath[1])
    if (!run) { json(res, 404, { error: 'run not found' }); return }
    json(res, 200, { runId: run.id, artifacts: run.artifacts })
    return
  }

  const diagnosticPath = url.pathname.match(/^\/api\/runs\/([^/]+)\/diagnostic$/)
  if (req.method === 'GET' && diagnosticPath) {
    const run = runs.get(diagnosticPath[1])
    if (!run) { json(res, 404, { error: 'run not found' }); return }
    json(res, 200, diagnosticForRun(run))
    return
  }

  const diffPath = url.pathname.match(/^\/api\/changes\/([^/]+)\/diff$/)
  if (req.method === 'GET' && diffPath) {
    const run = url.searchParams.get('runId') ? runs.get(url.searchParams.get('runId')!) : [...runs.values()].find((candidate) => candidate.changedFiles.some((change) => change.changeId === diffPath[1]))
    const change = run?.changedFiles.find((entry) => entry.changeId === diffPath[1])
    if (!run || !change) { json(res, 404, { error: 'change not found' }); return }
    const offset = Math.max(0, Number(url.searchParams.get('offset') ?? 0))
    const limit = Math.min(600, Math.max(1, Number(url.searchParams.get('limit') ?? 200)))
    const diff = change.diff.slice(offset, offset + limit)
    json(res, 200, { runId: run.id, change: { ...change, diff }, offset, limit, total: change.diff.length, hasMore: offset + diff.length < change.diff.length })
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
    addRunEvent(run, { type: 'rollback.started', message: `${targets.length}件の変更をロールバックします`, metadata: { paths: targets.map((change) => change.path) } })
    try {
      for (const change of targets) restored.push(await rollbackFileChange(change, { ...ctx, runId: run.id }))
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
    run.verification = { ...run.verification, machinePassed: false, userConfirmed: false, checks: run.verification.checks.map((check) => ({ ...check, status: 'pending' as VerificationStatus, evidence: 'ロールバック後に再検証が必要です' })) }
    run.endedAt = Date.now()
    addRunEvent(run, { type: 'rollback.completed', message: `${restored.length}件の変更をロールバックしました`, metadata: { restored } })
    persistState()
    json(res, 200, { ok: true, restored, run: runSnapshot(run) })
    return
  }

  const changesPath = url.pathname.match(/^\/api\/runs\/([^/]+)\/changes$/)
  if (req.method === 'GET' && changesPath) {
    const run = runs.get(changesPath[1])
    if (!run) { json(res, 404, { error: 'run not found' }); return }
    json(res, 200, { runId: run.id, changes: run.changedFiles, note: 'before/after本文と行番号付きdiffを含みます。大きなファイルは最大600行まで表示します。' })
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

  const pausePath = url.pathname.match(/^\/api\/runs\/([^/]+)\/pause$/)
  if (req.method === 'POST' && pausePath) {
    const run = runs.get(pausePath[1])
    if (!run) { json(res, 404, { error: 'run not found' }); return }
    if (run.endedAt || ['canceled', 'failed', 'verified', 'rolled_back'].includes(run.status)) { json(res, 409, { error: 'このRunは一時停止できません', run: runSnapshot(run) }); return }
    run.pauseRequested = true
    run.status = 'paused'
    run.currentStep = '一時停止を要求しました'
    run.nextAction = '現在のステップ完了後にチェックポイントを保存します'
    addRunEvent(run, { type: 'run.pause_requested', message: '一時停止を要求しました' })
    persistState()
    json(res, 200, { ok: true, run: runSnapshot(run) })
    return
  }

  const resumePath = url.pathname.match(/^\/api\/runs\/([^/]+)\/resume$/)
  if (req.method === 'POST' && resumePath) {
    const base = runs.get(resumePath[1])
    if (!base) { json(res, 404, { error: 'run not found' }); return }
    if (activeRunId) { json(res, 409, { error: '別の実行が進行中です', activeRun: runSnapshot(runs.get(activeRunId)!) }); return }
    if (base.status !== 'paused') { json(res, 409, { error: '一時停止中のRunではありません', run: runSnapshot(base) }); return }
    const session = sessions.get(base.sessionId)
    if (!session) { json(res, 404, { error: 'session not found' }); return }
    const run = createRun(session, base.request, base.mode, base.id)
    run.resumeCount = base.resumeCount + 1
    run.checkpoint = base.checkpoint
    addRunEvent(run, { type: 'run.resumed', message: `Run ${base.id} のチェックポイントから再開しました`, metadata: { parentRunId: base.id } })
    const result = await executeRun(run, session, base.request, run.mode)
    json(res, 200, { reply: result.reply, aborted: result.aborted, resumedFrom: base.id, run: runSnapshot(run) })
    return
  }

  const retryPath = url.pathname.match(/^\/api\/runs\/([^/]+)\/retry$/)
  if (req.method === 'POST' && retryPath) {
    const base = runs.get(retryPath[1])
    if (!base) { json(res, 404, { error: 'run not found' }); return }
    if (activeRunId) { json(res, 409, { error: '別の実行が進行中です', activeRun: runSnapshot(runs.get(activeRunId)!) }); return }
    if (!['failed', 'canceled', 'paused', 'applied_unverified', 'waiting_user'].includes(base.status)) { json(res, 409, { error: '再試行できない状態です', run: runSnapshot(base) }); return }
    let body: { message?: string } = {}
    try { body = JSON.parse(await readBody(req)) as typeof body } catch {}
    const session = sessions.get(base.sessionId)
    if (!session) { json(res, 404, { error: 'session not found' }); return }
    const input = String(body.message ?? base.request).trim()
    const run = createRun(session, input, base.mode, base.id)
    run.resumeCount = base.resumeCount + 1
    run.checkpoint = base.checkpoint
    addRunEvent(run, { type: 'run.retried', message: `Run ${base.id} を再試行しました`, metadata: { parentRunId: base.id } })
    const result = await executeRun(run, session, input, run.mode)
    json(res, 200, { reply: result.reply, aborted: result.aborted, retriedFrom: base.id, run: runSnapshot(run) })
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
    if (run.approval?.id) resolveApproval(run.approval.id, false, '実行キャンセルにより拒否されました')
    runControllers.get(run.id)?.abort()
    for (const artifact of run.artifacts.filter((entry) => entry.processId)) { try { await stopManagedProcess(artifact.processId!) } catch {} }
    json(res, 200, { ok: true, run: runSnapshot(run) })
    return
  }

  if (req.method === 'GET' && url.pathname === '/api/approvals') {
    json(res, 200, { approvals: listApprovals() })
    return
  }

  if (req.method === 'POST' && url.pathname === '/api/approvals/resolve') {
    try {
      const b = JSON.parse(await readBody(req)) as { id?: string; approved?: boolean; reason?: string }
      const ok = resolveApproval(String(b.id ?? ''), Boolean(b.approved), b.reason)
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
          artifactCount: latestRun.artifacts.length,
          verification: latestRun.verification,
          parentRunId: latestRun.parentRunId,
          updatedAt: latestRun.updatedAt
        } : null
      }
    })
    const visibleActive = activeRunId ? runs.get(activeRunId) : (recoveredRunId ? runs.get(recoveredRunId) : undefined)
    json(res, 200, { active: activeId, activeRun: visibleActive ? runSnapshot(visibleActive) : null, activeExecution: Boolean(activeRunId), sessions: list })
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
      activeRun: (activeRunId ? runs.get(activeRunId) : (recoveredRunId ? runs.get(recoveredRunId) : undefined)) ? runSnapshot((activeRunId ? runs.get(activeRunId) : runs.get(recoveredRunId!))!) : null
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
    let mode: TurnMode = 'work'
    let requestedParentRunId: string | undefined
    let requestedSessionId: string | undefined
    try {
      const b = JSON.parse(await readBody(req)) as { message?: string; mode?: string; parentRunId?: string; sessionId?: string }
      input = String(b.message ?? '').trim()
      if (b.mode === 'chat' || b.mode === 'research' || b.mode === 'work') mode = b.mode
      requestedParentRunId = typeof b.parentRunId === 'string' ? b.parentRunId : undefined
      requestedSessionId = typeof b.sessionId === 'string' ? b.sessionId : undefined
    } catch {}
    if (!input) { json(res, 400, { error: 'message が空です' }); return }
    const s = requestedSessionId ? sessions.get(requestedSessionId) : activeSession()
    if (!s) { json(res, 404, { error: 'session not found' }); return }
    activeId = s.id
    if (s.title === '新しいセッション') s.title = input.slice(0, 30)
    let parentRunId: string | undefined
    if (requestedParentRunId) {
      const parent = runs.get(requestedParentRunId)
      if (!parent || parent.sessionId !== s.id) { json(res, 409, { error: '親Runが見つからないか、別セッションです' }); return }
      parentRunId = parent.id
    }
    const run = createRun(s, input, mode, parentRunId)
    addRunEvent(run, { type: 'run.created', message: `実行を開始しました: ${run.title}` })
    if (parentRunId) addRunEvent(run, { type: 'followup.created', message: `Run ${parentRunId} への修正指示として開始しました`, metadata: { parentRunId } })
    const result = await executeRun(run, s, input, run.mode)
    json(res, 200, {
      reply: result.reply || (result.aborted ? '(中断しました。履歴は保持されています)' : ''),
      aborted: result.aborted,
      paused: result.paused === true,
      logs: result.logs,
      sessionId: s.id,
      run: runSnapshot(run)
    })
    return
  }

  res.writeHead(404); res.end('not found')
})

lastLogSeen = logLines.length

function verificationProfileFor(run: RunData, requested?: string): RunVerification['profile'] {
  if (requested === 'html' || requested === 'typescript' || requested === 'powershell' || requested === 'generic') return requested
  const paths = run.changedFiles.map((change) => change.path.toLowerCase())
  if (paths.some((p) => p.endsWith('.html'))) return 'html'
  if (paths.some((p) => p.endsWith('.ts') || p.endsWith('.tsx'))) return 'typescript'
  if (paths.some((p) => p.endsWith('.ps1'))) return 'powershell'
  return 'generic'
}

function realPathWithMissingTail(abs: string): string {
  let cursor = abs
  const tail: string[] = []
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor)
    if (parent === cursor) return abs
    tail.unshift(path.basename(cursor))
    cursor = parent
  }
  return path.resolve(fs.realpathSync.native(cursor), ...tail)
}

function safeChangedPath(change: RunChange): string {
  const rootReal = realPathWithMissingTail(path.resolve(workspace))
  const abs = path.resolve(workspace, change.path)
  const candidateReal = realPathWithMissingTail(abs)
  const relative = path.relative(rootReal, candidateReal)
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('ワークスペース外の変更です')
  return abs
}

async function performVerification(run: RunData, requested?: string): Promise<RunVerification> {
  const profile = verificationProfileFor(run, requested)
  const checks: VerificationCheck[] = [
    { id: 'file-readback', label: '変更後ファイルの再読込・ハッシュ', status: 'running', startedAt: Date.now() },
    { id: 'syntax-tests', label: '構文・テスト', status: 'running', startedAt: Date.now() },
    { id: 'user-confirmation', label: '実機操作・読み上げ確認', status: 'todo', evidence: '利用者が確認して完了を確定してください' }
  ]
  for (const change of run.changedFiles.filter((entry) => entry.changed)) {
    const check = checks[0]
    try {
      const abs = safeChangedPath(change)
      const current = fs.readFileSync(abs, 'utf8')
      const currentHash = crypto.createHash('sha256').update(current, 'utf8').digest('hex')
      if (!change.afterHash || currentHash !== change.afterHash) {
        check.status = 'fail'
        check.evidence = `${change.path}: 変更後ハッシュが一致しません`
        break
      }
      check.evidence = `${change.path}: read-backと変更後ハッシュが一致しました`
    } catch (err) {
      check.status = 'fail'
      check.evidence = (err as Error).message
      break
    }
  }
  if (checks[0].status === 'running') {
    checks[0].status = 'pass'
    checks[0].completedAt = Date.now()
  } else {
    checks[0].completedAt = Date.now()
  }

  const syntax = checks[1]
  const candidates = run.changedFiles.filter((change) => change.changed)
  try {
    for (const change of candidates) {
      const abs = safeChangedPath(change)
      const lower = change.path.toLowerCase()
      if (lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.cjs')) {
        await execFileAsync(process.execPath, ['--check', abs], { timeout: 15_000, windowsHide: true })
      } else if (lower.endsWith('.json')) {
        JSON.parse(fs.readFileSync(abs, 'utf8'))
      } else if (lower.endsWith('.html')) {
        const text = fs.readFileSync(abs, 'utf8')
        if (!/<html[\s>]/i.test(text) || !/<\/html>/i.test(text)) throw new Error(`${change.path}: htmlのルート要素が不完全です`)
      } else if (lower.endsWith('.ts') || lower.endsWith('.tsx')) {
        const tsc = path.join(workspace, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc')
        if (fs.existsSync(tsc)) await execFileAsync(tsc, ['--noEmit', '--pretty', 'false'], { cwd: workspace, timeout: 60_000, windowsHide: true })
        else throw new Error('TypeScriptコンパイラがワークスペースにありません')
      } else if (lower.endsWith('.ps1')) {
        syntax.status = 'todo'
        syntax.evidence = 'PowerShell Parserの実行を利用者確認プロファイルへ委譲しました'
        break
      }
    }
    if (syntax.status === 'running') {
      syntax.status = 'pass'
      syntax.evidence = candidates.length ? '対象ファイルの構文検査が完了しました' : '検証対象の変更はありません'
    }
  } catch (err) {
    syntax.status = 'fail'
    syntax.evidence = (err as Error).message
  }
  syntax.completedAt = Date.now()
  const machinePassed = checks[0].status === 'pass' && (checks[1].status === 'pass' || checks[1].status === 'skipped')
  return { profile, checks, machinePassed, userConfirmed: false, startedAt: Date.now(), completedAt: Date.now() }
}

function diagnosticForRun(run: RunData): Record<string, unknown> {
  const replaceWorkspace = (value: string): string => value.replaceAll(workspace, '<workspace>')
  return {
    generatedAt: new Date().toISOString(),
    version: '0.10.8',
    workspace: '<workspace>',
    distribution: readDistributionState(),
    run: {
      id: run.id,
      sessionId: run.sessionId,
      parentRunId: run.parentRunId,
      status: run.status,
      phase: run.phase,
      mode: run.mode,
      capabilities: run.capabilities,
      policy: run.policy,
      budget: run.budget,
      research: run.research ? { researchId: run.research.researchId, question: run.research.question, sources: run.research.sources, retrievedAt: run.research.retrievedAt, contentHash: run.research.contentHash, claimsCount: run.research.claims.length } : undefined,
      startedAt: run.startedAt,
      updatedAt: run.updatedAt,
      endedAt: run.endedAt,
      error: run.error ? replaceWorkspace(run.error) : undefined,
      changedFiles: run.changedFiles.map((change) => ({ changeId: change.changeId, path: replaceWorkspace(change.path), status: change.status, addedLines: change.addedLines, removedLines: change.removedLines })),
      verification: run.verification,
      auditEventCount: run.auditEvents?.length ?? run.events.length,
      events: (run.auditEvents ?? run.events).map((event) => ({ sequence: event.sequence, type: event.type, at: event.at, tool: event.tool, summary: event.summary, message: replaceWorkspace(event.message).slice(0, 1000), durationMs: event.durationMs, origin: event.origin, namespace: event.namespace, authority: event.authority, callId: event.callId }))
    }
  }
}

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
  const url = `http://127.0.0.1:${PORT}`
  console.log(`coding-agent web UI: ${url}  (workspace=${workspace})`)
  // Opening is convenience-only. Arguments are fixed and no shell is used.
  const open = process.platform === 'win32'
    ? spawn('explorer.exe', [url], { detached: true, stdio: 'ignore', windowsHide: true })
    : process.platform === 'darwin'
      ? spawn('open', [url], { detached: true, stdio: 'ignore' })
      : spawn('xdg-open', [url], { detached: true, stdio: 'ignore' })
  open.once('error', (err) => console.warn(`[warn] ブラウザを開けませんでした。${url} を開いてください: ${err.message}`))
  open.unref()
})
