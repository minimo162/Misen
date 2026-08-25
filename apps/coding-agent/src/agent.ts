import crypto from 'node:crypto'
import path from 'node:path'
import { jsonrepair } from '../vendor/npm/node_modules/jsonrepair'
export interface ParsedReply {
  tool?: string
  args?: Record<string, unknown>
  answer?: string
}

interface Candidate {
  text: string
  start: number
  end: number
}

function scanCandidates(text: string): Candidate[] {
  const candidates: Candidate[] = []
  let depth = 0
  let start = -1
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') {
      if (depth === 0) start = i
      depth++
    } else if (ch === '}') {
      if (depth > 0) {
        depth--
        if (depth === 0 && start >= 0) candidates.push({ text: text.slice(start, i + 1), start, end: i + 1 })
      }
    }
  }
  return candidates
}

function unwrapProtocolText(text: string): string {
  return text
    .replace(/```(?:json)?/gi, '')
    .replace(/```/g, '')
    .replace(/AGENT_END/g, '')
    .trim()
}

function validateProtocolObject(parsedValue: unknown): ParsedReply | null {
  if (!parsedValue || typeof parsedValue !== 'object' || Array.isArray(parsedValue)) return null
  const obj = parsedValue as Record<string, unknown>
  const keys = Object.keys(obj)
  if (Object.prototype.hasOwnProperty.call(obj, 'AGENT_END') && obj.AGENT_END !== true) return null
  const hasToolKey = Object.prototype.hasOwnProperty.call(obj, 'tool')
  const hasAnswerKey = Object.prototype.hasOwnProperty.call(obj, 'answer')
  const hasTool = typeof obj.tool === 'string'
  const hasAnswer = typeof obj.answer === 'string'
  if (hasToolKey !== hasTool || hasAnswerKey !== hasAnswer) return null
  if (hasTool === hasAnswer) return null
  if (hasAnswer) {
    if (keys.some((key) => key !== 'answer' && key !== 'AGENT_END')) return null
    return { answer: obj.answer as string }
  }
  if (Object.prototype.hasOwnProperty.call(obj, 'args')) {
    if (keys.some((key) => key !== 'tool' && key !== 'args' && key !== 'AGENT_END')) return null
    if (typeof obj.args !== 'object' || obj.args === null || Array.isArray(obj.args)) return null
    return { tool: obj.tool as string, args: obj.args as Record<string, unknown> }
  }
  return {
    tool: obj.tool as string,
    args: Object.fromEntries(Object.entries(obj).filter(([key]) => key !== 'tool' && key !== 'AGENT_END'))
  }
}

function repairObservedWriteContent(candidateText: string): unknown | null {
  const contentMarker = /"content"\s*:\s*"/i.exec(candidateText)
  const endMarker = /"\s*,\s*"AGENT_END"\s*:\s*true\s*}\s*$/i.exec(candidateText)
  if (!contentMarker || !endMarker || endMarker.index < contentMarker.index + contentMarker[0].length) return null
  const contentStart = contentMarker.index + contentMarker[0].length
  const rawContent = candidateText.slice(contentStart, endMarker.index)
  const repaired = [
    candidateText.slice(0, contentStart - 1),
    JSON.stringify(rawContent),
    candidateText.slice(endMarker.index + 1)
  ].join('')
  try {
    return JSON.parse(repaired) as unknown
  } catch {
    return null
  }
}

function parseStrictCandidate(candidate: Candidate): ParsedReply | null {
  let parsedValue: unknown
  try {
    parsedValue = JSON.parse(candidate.text)
  } catch {
    // Copilot has been observed leaving quotes inside inline write_file content
    // unescaped. Repair only that one known shape; all other malformed commands
    // remain rejected, and the repaired value still passes the full protocol gate.
    if (!/"tool"\s*:\s*"(?:host\.)?write_file"/i.test(candidate.text)) return null
    const observedRepair = repairObservedWriteContent(candidate.text)
    if (observedRepair === null) return null
    // jsonrepair is advisory only after the exact observed envelope has passed.
    // Never let its general-purpose repairs broaden the accepted protocol.
    try {
      const libraryRepair = JSON.parse(jsonrepair(candidate.text)) as unknown
      parsedValue = JSON.stringify(libraryRepair) === JSON.stringify(observedRepair) ? libraryRepair : observedRepair
    } catch {
      parsedValue = observedRepair
    }
  }
  return validateProtocolObject(parsedValue)
}
export function extractReplyAndEnd(raw: string): { parsed: ParsedReply; end: number } | null {
  const text = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
  const allCandidates = scanCandidates(text)
  if (allCandidates.length === 0) return null
  const candidate = allCandidates[0]
  const parsed = parseStrictCandidate(candidate)
  if (!parsed) return null
  if (allCandidates.length !== 1 && !(bareToolName(parsed.tool ?? '') === 'write_file' && /(?:CONTENT|内容)\s*[:：]|```/i.test(text.slice(candidate.end)))) return null
  const before = unwrapProtocolText(text.slice(0, candidate.start))
  const rawAfter = text.slice(candidate.end).trim()
  const after = unwrapProtocolText(rawAfter)
  // The only permitted non-JSON payload is an explicit write_file content block.
  if (before) return null
  if (rawAfter) {
    const markerOnly = /^(?:```\s*)?AGENT_END$/i.test(rawAfter) || /^```$/i.test(rawAfter)
    const explicitWritePayload = bareToolName(parsed.tool ?? '') === 'write_file' && typeof parsed.args?.content !== 'string' && (
      /^(?:CONTENT|内容)\s*[:：]\s*[\s\S]+?(?:\s*AGENT_END)?$/i.test(rawAfter) ||
      /^```[\w+-]*[ \t]*\r?\n?[\s\S]*?```(?:\s*AGENT_END)?$/i.test(rawAfter)
    )
    if (!markerOnly && !explicitWritePayload) return null
  } else if (after) {
    return null
  }
  return { parsed, end: candidate.end }
}

export function extractJsonReply(raw: string): ParsedReply | null {
  return extractReplyAndEnd(raw)?.parsed ?? null
}
function attachFenceContent(raw: string, end: number, parsed: ParsedReply): void {
  if (bareToolName(parsed.tool ?? '') !== 'write_file' || typeof parsed.args?.content === 'string') return
  const normalized = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
  const rest = normalized.slice(end)
  const cm = rest.match(/^\s*(?:CONTENT|内容)\s*[:：]\s*\r?\n?([\s\S]+)$/i)
  if (cm) {
    const body = cm[1].split(END_MARKER)[0].replace(/\s+$/, '').replace(/＜/g, '<').replace(/＞/g, '>').replace(/｀/g, String.fromCharCode(96)).replace(/¶/g, '\n')
    parsed.args = { ...(parsed.args ?? {}), content: body }
    return
  }
  const fm = rest.match(/```[\w+-]*[ \t]*\r?\n?([\s\S]*?)```/)
  if (fm) {
    parsed.args = { ...(parsed.args ?? {}), content: fm[1].replace(/^\r?\n/, '').trim() }
  }
}
import type { ApprovalBinding } from './approvals'
import { capabilityPolicy, type AgentConfig, type TurnMode } from './config'
import { chat, type ChatMessage, type ToolCall } from './llm'
import { bareToolName, findHostTool, getFilePrecondition, openAITools, parseToolResultMeta, qualifiedToolName, TOOL_DEFS, validateToolArgs, type ToolContext } from './tools'

export type AgentEvent = {
  type: 'model.decision' | 'copilot.native.observed' | 'plan.created' | 'step.started' | 'step.completed' | 'step.failed' | 'tool.requested' | 'tool.approved' | 'tool.started' | 'tool.succeeded' | 'tool.failed' | 'tool.denied' | 'approval.requested' | 'approval.resolved' | 'artifact.created' | 'preview.ready' | 'run.warning'
  tool?: string
  summary?: string
  output?: string
  error?: string
  approved?: boolean
  durationMs?: number
  metadata?: Record<string, unknown> | null
  origin?: 'host' | 'orchestrator' | 'copilot'
  namespace?: 'app' | 'native' | 'none'
  authority?: 'authoritative' | 'observed' | 'claimed' | 'derived'
  callId?: string
}

export interface Citation {
  url: string
  title?: string
  retrievedAt: string
}

export interface ResearchBundle {
  researchId: string
  question: string
  summary: string
  claims: Array<{ text: string; citations: Citation[] }>
  sources: Citation[]
  retrievedAt: string
  contentHash: string
}

export function buildResearchBundle(question: string, summary: string, retrievedAt = new Date().toISOString()): ResearchBundle {
  const urls = [...summary.matchAll(/https?:\/\/[^\s<>()\[\]"'（）【】、。]+/g)].map((match) => match[0].replace(/[.,;:!?、。]+$/, ''))
  const uniqueUrls = [...new Set(urls)]
  const sources = uniqueUrls.map((url) => ({ url, retrievedAt }))
  const claims = summary.split(/\r?\n+/).map((text) => text.trim()).filter(Boolean).map((text) => ({ text, citations: sources }))
  const contentHash = crypto.createHash('sha256').update(summary, 'utf8').digest('hex')
  return { researchId: `research-${contentHash.slice(0, 16)}`, question, summary, claims, sources, retrievedAt, contentHash }
}

export interface AgentIO {
  print(text: string): void
  askYesNo(question: string, binding?: ApprovalBinding): Promise<boolean>
  event?(event: AgentEvent): void
  isCanceled?(): boolean
  isPaused?(): boolean
  waitIfPaused?(): Promise<void>
  signal?: AbortSignal
}

export interface AgentTurnResult {
  reply: string
  messages: ChatMessage[]
  aborted: boolean
  paused?: boolean
  checkpoint?: string[]
  research?: ResearchBundle
}

export interface TextBackend {
  readonly name: string
  complete(prompt: string, signal?: AbortSignal): Promise<string>
  close?(): void
}

const END_MARKER = 'AGENT_END'

function shouldCancel(io: AgentIO): boolean {
  return io.signal?.aborted === true || io.isCanceled?.() === true
}

function pausedResult(messages: ChatMessage[], userInput: string, steps: string[]): AgentTurnResult {
  return {
    reply: '',
    messages: [...messages, { role: 'user', content: userInput }, { role: 'assistant', content: '[一時停止] チェックポイントを保存しました。再開すると続きから確認します。' }],
    aborted: true,
    paused: true,
    checkpoint: steps.slice(-20)
  }
}

function buildProtocolRules(mode: TurnMode = 'work', allowArbitraryCommands = false, autoApproveCommand = false): string {
  const toolDocs = TOOL_DEFS.filter((t) => allowArbitraryCommands || t.name !== 'run_command').map((t) => {
    const req = ((t.parameters as { required?: string[] }).required ?? [])
    const props = Object.keys((t.parameters as { properties?: Record<string, unknown> }).properties ?? {})
    return `- ${qualifiedToolName(t.name)}(${props.join(', ')}):${req.length ? ` 必須=${req.join(',')};` : ''} ${t.description}`
  }).join('\n')
  const commandRule = allowArbitraryCommands
    ? autoApproveCommand
      ? '明示設定により任意のhostコマンド実行は自動承認済みです。承認を求めるanswerを返さず、必要なhost.run_commandを直ちに要求してください。'
      : '明示設定により任意のhostコマンド実行が許可されています。実行前に承認を取得してください。'
    : '任意のコマンド実行はこのRunでは無効です。既知の検証手順や管理プロセスを使い、コマンド実行を要求しないでください。'
  if (mode !== 'work') {
    const label = mode === 'research' ? '調査' : '通常回答'
    return [
      `あなたは社内エージェントの${label}モードです。`,
      'このモードではローカルホストツール、ファイル操作、コマンド実行を要求してはいけません。',
      mode === 'research' ? '必要ならCopilot内蔵の検索を使い、回答に参照先と取得時刻を含めてください。' : '通常の回答だけを返してください。',
      'この回答はアプリのホスト実行結果ではありません。ローカル変更や実行成功を主張しないでください。'
    ].join('\n')
  }
  return [
    'あなたは社内コーディング支援エージェントです。workモードでは、アプリが管理するhost.*ツールだけを使えます。',
    'Copilot内蔵のWeb検索、Excel、Word、PowerPoint、その他のnative機能をアプリのツールとして要求・報告してはいけません。',
    'あなたの応答は実行結果ではなく、ホストブリッジが解釈する「次の1手」です。',
    'ホストブリッジは host.* のJSONだけを検証して1回ずつ実行し、結果を次の入力にhost_resultとして渡します。',
    'ローカル操作が不要ならanswerを返します。先回りのlist_filesや、同じ操作の繰り返しは禁止です。',
    allowArbitraryCommands ? '天気・気温・降水量はhost.get_weatherを使い、任意コマンドで外部天気サイトを呼んではいけません。' : '天気・気温・降水量はhost.get_weatherを使ってください。',
    'ツールが拒否された、または情報が不足している場合は、次の操作を推測せずanswerで利用者に確認してください。',
    '',
    '選択できるhostアクション:',
    toolDocs,
    commandRule,
    allowArbitraryCommands ? '長時間のローカル開発サーバーはhost.start_process→host.read_process_log→host.stop_processの順で管理する。' : '長時間のローカル開発サーバーはhost.start_process→host.read_process_log→host.stop_processの順で管理し、任意コマンドは使わない。',
    '',
    '第0ターンのTOOL_RESULTと、その後のhost_resultだけを実際のホスト結果として扱います。結果を想像せず、受け取った内容だけを根拠に次の1手を選びます。',
    '',
    '出力ルール(厳守): 毎回、次のどちらかのJSONオブジェクト1つだけを出力する。',
    '  {"tool":"host.<アクション名>","args":{...}}',
    '  {"answer":"<ユーザーへの最終回答(日本語)>"}',
    'JSON以外の説明文、見出し、挨拶、複数JSONは出力しない。',
    'write_fileの本文が長い場合だけ、JSONの直後にCONTENT:と本文を続け、最後にAGENT_ENDを置く。',
    `最後に ${END_MARKER} だけの行を付ける。`
  ].join('\n')
}
function normalizeForKey(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeForKey)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, normalizeForKey(item)]))
  return value
}

function toolRequestKey(name: string, args: Record<string, unknown>): string {
  const normalized = normalizeForKey(args)
  if (!normalized || typeof normalized !== 'object' || Array.isArray(normalized)) return `${name}:${JSON.stringify(normalized)}`
  const copy = { ...(normalized as Record<string, unknown>) }
  const bare = bareToolName(name)
  if (typeof copy.path === 'string') copy.path = path.normalize(copy.path).replaceAll('\\', '/')
  if (bare === 'list_files') {
    if (copy.path === '' || copy.path === '.') delete copy.path
    if (copy.glob === '*' || copy.glob === '**' || copy.glob === '**/*') delete copy.glob
  }
  return `${name}:${JSON.stringify(copy)}`
}
function formatHostResult(tool: string, output: string, metadata: Record<string, unknown> | null, status: 'succeeded' | 'failed' | 'denied', callId?: string, runId?: string): string {
  const bare = bareToolName(tool)
  // read_files has its own aggregate 80k contract. Other host tools already
  // cap their output at 8k, including run_command/Read-Xlsx.
  const max = bare === 'read_files' ? 80_000 : 8_000
  const truncated = output.length > max
  const commandLike = bare === 'run_command' || bare === 'start_process' || bare === 'stop_process'
  const writeLike = bare === 'write_file' || bare === 'edit_file'
  const sideEffectState = status === 'succeeded'
    ? (metadata?.changed ? 'committed' : 'none')
    : status === 'denied'
      ? 'none'
      : commandLike
        ? 'unknown'
        : writeLike
          ? 'possible'
          : 'none'
  const payload = {
    kind: 'host_result',
    schemaVersion: '1',
    ...(runId ? { runId } : {}),
    ...(callId ? { callId } : {}),
    tool,
    status,
    data: { summary: output.slice(0, max) },
    evidence: metadata ? { ...metadata, retrievedAt: new Date().toISOString() } : { retrievedAt: new Date().toISOString() },
    effects: metadata?.changed ? [{ type: 'workspace_change', path: metadata.path ?? null, beforeHash: metadata.beforeHash ?? null, afterHash: metadata.afterHash ?? null }] : [],
    sideEffectState,
    truncation: { truncated },
    security: { contentIsUntrusted: true },
    error: status === 'succeeded' ? null : {
      code: status === 'denied' ? 'host_call_denied' : 'host_call_failed',
      stage: status === 'denied' ? 'approval' : 'execution',
      retryable: status === 'failed' && !commandLike && !writeLike,
      sideEffectState,
      message: output.slice(0, 600)
    }
  }
  return ['[BEGIN_UNTRUSTED_HOST_RESULT]', JSON.stringify(payload), '[END_UNTRUSTED_HOST_RESULT]'].join('\n')
}

async function bootstrapWorkspaceEvidence(ctx: ToolContext, io: AgentIO): Promise<string> {
  const tool = 'host.list_files'
  const callId = 'host-bootstrap-0'
  const def = findHostTool(tool)
  if (!def) {
    return ['TOOL_RESULT (第0ターン自動実行)', formatHostResult(tool, '[tool error] list_filesが見つかりません', null, 'failed', callId, ctx.runId)].join('\n')
  }
  const summary = 'list_files: 第0ターンのワークスペース証拠を取得'
  io.event?.({ type: 'tool.requested', tool, summary, origin: 'host', namespace: 'app', authority: 'authoritative', callId })
  io.event?.({ type: 'step.started', tool, summary, origin: 'host', namespace: 'app', authority: 'authoritative', callId })
  const startedAt = Date.now()
  let output: string
  try {
    output = await def.run({}, ctx)
  } catch (err) {
    output = `[tool error] ${(err as Error).message}`
  }
  const failed = output.startsWith('[tool error]')
  const durationMs = Date.now() - startedAt
  io.event?.({ type: failed ? 'tool.failed' : 'tool.succeeded', tool, summary, output: output.slice(0, 1200), durationMs, origin: 'host', namespace: 'app', authority: 'authoritative', callId })
  io.event?.({ type: failed ? 'step.failed' : 'step.completed', tool, summary, output: output.slice(0, 800), durationMs, origin: 'host', namespace: 'app', authority: 'authoritative', callId })
  return [
    'TOOL_RESULT (第0ターン自動実行。モデル判断回数・host実行予算には不算入)',
    formatHostResult(tool, output, null, failed ? 'failed' : 'succeeded', callId, ctx.runId)
  ].join('\n')
}
async function captureFileBinding(def: { kind: string }, args: Record<string, unknown>, ctx: ToolContext): Promise<Pick<ApprovalBinding, 'path' | 'beforeHash' | 'existedBefore'>> {
  if (def.kind !== 'write' || typeof args.path !== 'string') return {}
  const state = await getFilePrecondition(args.path, ctx)
  return { path: args.path, ...state }
}

async function approvalPreconditionChanged(binding: ApprovalBinding, ctx: ToolContext): Promise<boolean> {
  if (!binding.path || binding.existedBefore === undefined) return false
  const state = await getFilePrecondition(binding.path, ctx)
  return state.existedBefore !== binding.existedBefore || state.beforeHash !== binding.beforeHash
}

function composeCopilotPrompt(mode: TurnMode, userInput: string, steps: string[], budget = 120000, history: { role: string; content: string }[] = [], allowArbitraryCommands = false, autoApproveCommand = false, systemInstructions = ''): string {
  const histBlock = history.length > 0
    ? ['', '[これまでのやりとり]', ...history.map((h) => `${h.role}: ${h.content.replace(/\r?\n+/g, ' ')}`)]
    : []
  const systemBlock = systemInstructions.trim() ? ['', '[業務固有指示]', systemInstructions.trim()] : []
  const head = [buildProtocolRules(mode, allowArbitraryCommands, autoApproveCommand), ...systemBlock, ...histBlock, '', '[依頼]', userInput]
  const tail = [
    '',
    '[指示]',
    '上記の状況を踏まえて、次に取るべきアクションを指定の JSON 形式のみで返してください。',
    `回答の最後には ${END_MARKER} だけの行を付けてください。`
  ]
  let keep = steps
  const build = (list: string[], omitted: boolean): string =>
    [...head, ...(omitted ? ['(※ 古い経過は省略しました)'] : []), ...list, ...tail].join('\n')
  let text = build(keep, false)
  while (text.length > budget && keep.length > 1) {
    keep = keep.slice(1)
    text = build(keep, true)
  }
  return text
}


async function runCopilotTurn(opts: {
  cfg: AgentConfig
  messages: ChatMessage[]
  backend: TextBackend
  userInput: string
  ctx: ToolContext
  io: AgentIO
}): Promise<AgentTurnResult> {
  const { cfg, ctx, io, backend } = opts
  const mode = cfg.turnMode ?? (cfg.copilot?.agentMode === true ? 'work' : 'chat')
  const policy = capabilityPolicy(cfg, mode)
  const history = opts.messages
    .filter((m: ChatMessage) => m.role !== 'system')
    .map((m) => ({ role: m.role === 'assistant' ? 'アシスタント' : 'ユーザー', content: String(m.content ?? '').slice(0, 400) }))
    .slice(-12)
  const systemInstructions = opts.messages
    .filter((m: ChatMessage) => m.role === 'system')
    .map((m) => String(m.content ?? ''))
    .filter((content) => content.trim())
    .join('\n\n') || cfg.systemPrompt || ''
  const turnMessages = (assistantContent: string): ChatMessage[] => [
    ...opts.messages,
    { role: 'user', content: opts.userInput },
    { role: 'assistant', content: assistantContent }
  ]
  const canceled = (): AgentTurnResult => ({ reply: '', messages: turnMessages('[中断] ユーザーがキャンセルしました'), aborted: true })
  const stopRequested = (): boolean => shouldCancel(io) || io.isPaused?.() === true

  if (mode !== 'work') {
    const modePrompt = buildProtocolRules(mode)
    const prompt = [cfg.systemPrompt, modePrompt, opts.userInput].filter((s) => s && s.trim()).join('\n\n')
    try {
      const text = (await backend.complete(prompt, io.signal)).trim()
      io.event?.({ type: 'model.decision', summary: 'Copilotの回答を受信しました', origin: 'copilot', namespace: 'native', authority: 'claimed' })
      io.event?.({ type: 'plan.created', summary: mode === 'research' ? 'Copilot調査モードを開始しました' : '通常回答モードを開始しました', origin: 'orchestrator', namespace: 'none', authority: 'derived' })
      if (mode === 'research') {
        const research = buildResearchBundle(opts.userInput, text)
        if (research.sources.length === 0) {
          const message = '調査結果を確定できませんでした。出典URL付きで再試行してください。'
          io.print(`[warn] ${message}`)
          io.event?.({ type: 'run.warning', error: message, origin: 'orchestrator', namespace: 'none', authority: 'authoritative' })
          return { reply: '', messages: turnMessages(`[中断] ${message}`), aborted: true }
        }
        io.event?.({ type: 'step.completed', summary: `Copilot調査の回答を受け取りました（出典${research.sources.length}件）`, origin: 'copilot', namespace: 'native', authority: 'claimed' })
        return { reply: text, messages: turnMessages(text), aborted: false, research }
      }
      io.event?.({ type: 'step.completed', summary: '回答を受け取りました', origin: 'copilot', namespace: 'native', authority: 'claimed' })
      return { reply: text, messages: turnMessages(text), aborted: false }
    } catch (err) {
      const msg = (err as Error).message
      io.print(`[error] ${msg}`)
      return { reply: '', messages: turnMessages(`[error] ${msg}`), aborted: true }
    }
  }

  const steps: string[] = []
  io.event?.({ type: 'plan.created', summary: 'Runの計画と検証プロファイルを作成しました', origin: 'orchestrator', namespace: 'none', authority: 'derived' })
  steps.push(await bootstrapWorkspaceEvidence(ctx, io))
  let parseRetried = false
  let invalidDecisions = 0
  const actionCounts = new Map<string, number>()
  const requestHistory: string[] = []
  const maxIter = policy.maxModelDecisions
  const maxExecutions = policy.maxHostExecutions
  const maxWrites = policy.maxWriteExecutions
  const maxCommands = policy.maxCommandExecutions
  const maxNoProgress = policy.maxNoProgress
  let executions = 0
  let writes = 0
  let commands = 0
  let noProgress = 0
  let lastResultKey = ''

  const stopWithWarning = (message: string): AgentTurnResult => {
    io.print(`[warn] ${message}`)
    io.event?.({ type: 'run.warning', error: message, origin: 'orchestrator', namespace: 'none', authority: 'authoritative' })
    return { reply: '', messages: turnMessages(`[中断] ${message}`), aborted: true, checkpoint: steps.slice(-20) }
  }

  for (let i = 0; i < maxIter; i++) {
    if (shouldCancel(io)) return canceled()
    if (io.isPaused?.()) return { reply: '', messages: turnMessages('[一時停止] チェックポイントを保存しました'), aborted: true, paused: true, checkpoint: steps.slice(-20) }
    let raw: string
    try {
      raw = await backend.complete(composeCopilotPrompt('work', opts.userInput, steps, cfg.copilot?.maxPromptChars ?? 120000, history, policy.allowArbitraryCommands, policy.autoApproveCommand, systemInstructions), io.signal)
      raw = raw.replace(/＜/g, '<').replace(/＞/g, '>').replace(/｀/g, String.fromCharCode(96))
      io.event?.({ type: 'model.decision', summary: 'Copilotの次の1手を受信しました', origin: 'copilot', namespace: 'native', authority: 'claimed' })
    } catch (err) {
      const msg = (err as Error).message
      io.print(`[error] ${msg}`)
      return { reply: '', messages: turnMessages(`[error] ${msg}`), aborted: true }
    }
    const pe = extractReplyAndEnd(raw)
    let parsed = pe?.parsed ?? null
    if (parsed && bareToolName(parsed.tool ?? '') === 'write_file') attachFenceContent(raw, pe!.end, parsed)
    if (!parsed) {
      if (!parseRetried) {
        parseRetried = true
        steps.push('SYSTEM: 直前の応答は厳格な単一JSON契約に違反しました。JSONオブジェクト1つだけを返してください。')
        continue
      }
      return stopWithWarning('Copilotの応答形式を検証できないため、安全のため停止しました')
    }
    if (parsed.answer !== undefined) {
      const reply = parsed.answer.trim()
      steps.push('assistant: {"answer":"..."}')
      return { reply, messages: turnMessages(reply), aborted: false }
    }
    const requestedTool = parsed.tool ?? ''
    const normalizedTool = requestedTool.startsWith('host.') ? requestedTool : qualifiedToolName(requestedTool)
    const def = findHostTool(normalizedTool)
    if (!requestedTool || !def) {
      io.event?.({ type: 'copilot.native.observed', tool: parsed.tool, summary: 'Copilot内蔵/nativeツール要求を観測しました（実行していません）', origin: 'copilot', namespace: 'native', authority: 'observed' })
      invalidDecisions++
      steps.push(`SYSTEM: 許可されている既知のhostツールだけを実行できます。受信したtool=${parsed.tool ?? '(なし)'}`)
      if (invalidDecisions >= 2) return stopWithWarning('許可されていないCopilot内蔵ツールまたは不明なツールが要求されたため停止しました')
      continue
    }
    parsed.tool = normalizedTool
    if (bareToolName(def.name) === 'run_command' && !policy.allowArbitraryCommands) return stopWithWarning('任意コマンド実行は設定で明示的に有効化されていないため停止しました')
    const args = parsed.args ?? {}
    const argError = validateToolArgs(def, args)
    if (argError) {
      invalidDecisions++
      steps.push(`host_result(${parsed.tool}): [validation_error] ${argError}`)
      if (invalidDecisions >= 2) return stopWithWarning(`hostツールの引数を検証できないため停止しました: ${argError}`)
      continue
    }
    invalidDecisions = 0
    const requestKey = toolRequestKey(parsed.tool, args)
    const previousCount = actionCounts.get(requestKey) ?? 0
    requestHistory.push(requestKey)
    if (requestHistory.length >= 4) {
      const n = requestHistory.length
      if (requestHistory[n - 4] === requestHistory[n - 2] && requestHistory[n - 3] === requestHistory[n - 1]) return stopWithWarning('同じhost操作の循環が検出されたため停止しました')
    }
    if (previousCount > 0) {
      if (previousCount >= 2) return stopWithWarning('同じhost操作が繰り返されたため停止しました')
      actionCounts.set(requestKey, previousCount + 1)
      steps.push(`SYSTEM: ${parsed.tool} は直前に実行済みです。前回のhost_resultを使い、別の操作が必要な場合だけ選んでください。`)
      continue
    }
    actionCounts.set(requestKey, 1)
    if (executions >= maxExecutions) return stopWithWarning(`hostツール実行上限(${maxExecutions}回)に達したため停止しました`)
    if (def.kind === 'write' && writes >= maxWrites) return stopWithWarning(`書き込み実行上限(${maxWrites}回)に達したため停止しました`)
    if (def.kind === 'command' && commands >= maxCommands) return stopWithWarning(`コマンド実行上限(${maxCommands}回)に達したため停止しました`)
    if (stopRequested()) return canceled()
    const qualified = qualifiedToolName(def.name)
    const callId = `host-call-${executions + 1}`
    const summary = summarize(qualified, args)
    io.event?.({ type: 'tool.requested', tool: qualified, summary, origin: 'host', namespace: 'app', authority: 'authoritative', callId })
    io.event?.({ type: 'step.started', tool: qualified, summary, origin: 'host', namespace: 'app', authority: 'authoritative', callId })
    if (def.kind !== 'read') {
      const auto = def.kind === 'write' ? policy.autoApproveWrite : policy.autoApproveCommand
      const fileBinding = await captureFileBinding(def, args, ctx)
      const approvalBinding: ApprovalBinding = { ...fileBinding, toolName: qualified, argsHash: JSON.stringify(normalizeForKey(args)), command: typeof args.command === 'string' ? args.command : undefined, network: def.kind === 'command', callId }

      if (!auto) {
        const ok = await io.askYesNo(`実行を許可しますか？\n${summary}`, approvalBinding)
        if (ok) io.event?.({ type: 'tool.approved', tool: qualified, summary, approved: true, origin: 'host', namespace: 'app', authority: 'authoritative', callId })
        if (ok && await approvalPreconditionChanged(approvalBinding, ctx)) {
          io.event?.({ type: 'tool.denied', tool: qualified, summary, approved: false, error: '承認後に対象ファイルが変更されたため承認を無効化しました', origin: 'host', namespace: 'app', authority: 'authoritative', callId })
          steps.push(formatHostResult(qualified, '承認後に対象ファイルが変更されたため実行しませんでした', null, 'denied', callId, ctx.runId))
          continue
        }
        if (!ok) {
          io.event?.({ type: 'tool.denied', tool: qualified, summary, origin: 'host', namespace: 'app', authority: 'authoritative', callId })
          steps.push(formatHostResult(qualified, 'ユーザーが拒否しました', null, 'denied', callId, ctx.runId))
          continue
        }
      } else {
        io.event?.({ type: 'tool.approved', tool: qualified, summary, approved: true, metadata: { automatic: true }, origin: 'host', namespace: 'app', authority: 'authoritative', callId })
      }
    }
    executions++
    if (def.kind === 'write') writes++
    if (def.kind === 'command') commands++
    io.event?.({ type: 'tool.started', tool: qualified, summary, origin: 'host', namespace: 'app', authority: 'authoritative', callId })
    io.print(`[tool] ${summary}`)
    if (stopRequested()) return canceled()
    const startedAt = Date.now()
    let output: string
    try {
      output = await def.run(args, ctx)
    } catch (err) {
      output = `[tool error] ${(err as Error).message}`
    }
    const failed = output.startsWith('[tool error]')
    const durationMs = Date.now() - startedAt
    const metadata = parseToolResultMeta(output) as unknown as Record<string, unknown> | null
    const resultKey = `${qualified}:${metadata?.afterHash ?? output.slice(0, 1600)}`
    noProgress = failed || resultKey === lastResultKey ? noProgress + 1 : 0
    lastResultKey = resultKey
    io.event?.({ type: failed ? 'tool.failed' : 'tool.succeeded', tool: qualified, summary, output: output.slice(0, 1200), durationMs, metadata, origin: 'host', namespace: 'app', authority: 'authoritative', callId })
    io.event?.({ type: failed ? 'step.failed' : 'step.completed', tool: qualified, summary, output: output.slice(0, 800), durationMs, metadata, origin: 'host', namespace: 'app', authority: 'authoritative', callId })
    steps.push(formatHostResult(qualified, output, metadata, failed ? 'failed' : 'succeeded', callId, ctx.runId))
    steps.push(`SYSTEM: ${qualified} は実行済みです。結果を根拠に次の1手を判断してください。`)
    if (noProgress >= maxNoProgress) return stopWithWarning(`hostツール結果に進展がないため停止しました（${maxNoProgress}回連続）`)
  }
  return stopWithWarning('最大反復回数に達しました')
}
export async function runAgentTurn(opts: {
  cfg: AgentConfig
  messages: ChatMessage[]
  userInput: string
  ctx: ToolContext
  io: AgentIO
  backend?: TextBackend
}): Promise<AgentTurnResult> {
  if (opts.backend || opts.cfg.provider === 'copilot-edge') {
    const backend = opts.backend
    if (!backend) throw new Error('provider=copilot-edge には backend が必要です')
    return runCopilotTurn({ cfg: opts.cfg, messages: opts.messages, backend, userInput: opts.userInput, ctx: opts.ctx, io: opts.io })
  }
  if ((opts.cfg.turnMode ?? 'work') !== 'work') return runPlainOpenAITurn(opts)
  return runOpenAITurn(opts)
}

async function runPlainOpenAITurn(opts: {
  cfg: AgentConfig
  messages: ChatMessage[]
  userInput: string
  ctx: ToolContext
  io: AgentIO
}): Promise<AgentTurnResult> {
  const mode = opts.cfg.turnMode ?? 'chat'
  const prompt = mode === 'research'
    ? `${opts.userInput}\n\n調査モードです。必要なら検索を使い、出典URLと取得時刻を添えてください。ローカルファイル変更やコマンド実行は行いません。`
    : opts.userInput
  const messages: ChatMessage[] = [...opts.messages, { role: 'user', content: prompt }]
  try {
    const assistant = await chat(opts.cfg, messages, [], opts.io.signal)
    const reply = assistant.content ?? ''
    opts.io.event?.({ type: 'model.decision', summary: 'モデルの次の1手を受信しました', origin: 'copilot', namespace: 'none', authority: 'claimed' })
    messages.push(assistant)
    opts.io.event?.({ type: 'plan.created', summary: mode === 'research' ? '調査モードを開始しました' : '通常回答モードを開始しました', origin: 'orchestrator', namespace: 'none', authority: 'derived' })
    if (mode === 'research') {
      const research = buildResearchBundle(opts.userInput, reply)
      if (research.sources.length === 0) {
        const message = '調査結果を確定できませんでした。出典URL付きで再試行してください。'
        opts.io.print(`[warn] ${message}`)
        opts.io.event?.({ type: 'run.warning', error: message, origin: 'orchestrator', namespace: 'none', authority: 'authoritative' })
        return { reply: '', messages: [...messages, { role: 'assistant', content: `[中断] ${message}` }], aborted: true }
      }
      opts.io.event?.({ type: 'step.completed', summary: `調査結果を受け取りました（出典${research.sources.length}件）`, origin: 'copilot', namespace: 'native', authority: 'claimed' })
      return { reply, messages, aborted: false, research }
    }
    opts.io.event?.({ type: 'step.completed', summary: '回答を受け取りました', origin: 'orchestrator', namespace: 'none', authority: 'derived' })
    return { reply, messages, aborted: false }
  } catch (err) {
    const msg = (err as Error).message
    opts.io.print(`[error] ${msg}`)
    return { reply: '', messages, aborted: true }
  }
}

async function runOpenAITurn(opts: {
  cfg: AgentConfig
  messages: ChatMessage[]
  userInput: string
  ctx: ToolContext
  io: AgentIO
}): Promise<AgentTurnResult> {
  const { cfg, ctx, io } = opts
  const policy = capabilityPolicy(cfg, 'work')
  const messages: ChatMessage[] = [...opts.messages, { role: 'user', content: opts.userInput }]
  io.event?.({ type: 'plan.created', summary: 'Runの計画と検証プロファイルを作成しました', origin: 'orchestrator', namespace: 'none', authority: 'derived' })
  const maxIter = policy.maxModelDecisions
  const maxExecutions = policy.maxHostExecutions
  const maxWrites = policy.maxWriteExecutions
  const maxCommands = policy.maxCommandExecutions
  const maxNoProgress = policy.maxNoProgress
  const actionCounts = new Map<string, number>()
  let executions = 0
  let writes = 0
  let commands = 0
  let noProgress = 0
  let lastResultKey = ''
  const warning = (message: string): AgentTurnResult => {
    io.print(`[warn] ${message}`)
    io.event?.({ type: 'run.warning', error: message, origin: 'orchestrator', namespace: 'none', authority: 'authoritative' })
    return { reply: '', messages, aborted: true }
  }
  for (let i = 0; i < maxIter; i++) {
    if (shouldCancel(io)) return { reply: '', messages, aborted: true }
    if (io.isPaused?.()) return { reply: '', messages, aborted: true, paused: true }
    let assistant: ChatMessage
    try {
      assistant = await chat(cfg, messages, openAITools({ allowArbitraryCommands: policy.allowArbitraryCommands }), io.signal)
    } catch (err) {
      const msg = (err as Error).message
      io.print(`[error] ${msg}`)
      return { reply: '', messages, aborted: true }
    }
    io.event?.({ type: 'model.decision', summary: 'モデルの次の1手を受信しました', origin: 'copilot', namespace: 'none', authority: 'claimed' })
    messages.push(assistant)
    const calls = assistant.tool_calls ?? []
    if (calls.length === 0) return { reply: assistant.content ?? '', messages, aborted: false }
    if (calls.length !== 1) return warning('1回の判断で複数のhostツールが要求されたため、安全のため停止しました')
    if (executions >= maxExecutions) return warning(`hostツール実行上限(${maxExecutions}回)に達したため停止しました`)
    const call = calls[0]
    const def = findHostTool(call.function.name)
    if (!def) return warning(`許可されていないhostツール ${call.function.name} が要求されたため停止しました`)
    if (bareToolName(def.name) === 'run_command' && !policy.allowArbitraryCommands) return warning('任意コマンド実行は設定で明示的に有効化されていないため停止しました')
    if (def.kind === 'write' && writes >= maxWrites) return warning(`書き込み実行上限(${maxWrites}回)に達したため停止しました`)
    if (def.kind === 'command' && commands >= maxCommands) return warning(`コマンド実行上限(${maxCommands}回)に達したため停止しました`)
    let argsForKey: unknown = {}
    try { argsForKey = call.function.arguments ? JSON.parse(call.function.arguments) : {} } catch {}
    const key = toolRequestKey(call.function.name, (argsForKey && typeof argsForKey === 'object' && !Array.isArray(argsForKey) ? argsForKey : {}) as Record<string, unknown>)
    if ((actionCounts.get(key) ?? 0) > 0) return warning('同じhostツール操作が繰り返されたため停止しました')
    actionCounts.set(key, 1)
    const output = await executeCall(call, cfg, ctx, io)
    executions++
    if (def.kind === 'write') writes++
    if (def.kind === 'command') commands++
    if (output.startsWith('[policy error]') || output.startsWith('[validation error]')) return warning(output)
    const metadata = parseToolResultMeta(output) as unknown as Record<string, unknown> | null
    const resultKey = `${call.function.name}:${metadata?.afterHash ?? output.slice(0, 1600)}`
    noProgress = resultKey === lastResultKey ? noProgress + 1 : 0
    lastResultKey = resultKey
    const status = output === '(ユーザーが拒否しました)' ? 'denied' : output.startsWith('[tool error]') ? 'failed' : 'succeeded'
    messages.push({ role: 'tool', tool_call_id: call.id, name: call.function.name, content: formatHostResult(call.function.name, output, metadata, status, call.id, ctx.runId) })
    if (noProgress >= maxNoProgress) return warning(`hostツール結果に進展がないため停止しました（${maxNoProgress}回連続）`)
  }
  return warning('最大反復回数に達しました')
}
async function executeCall(
  call: ToolCall,
  cfg: AgentConfig,
  ctx: ToolContext,
  io: AgentIO
): Promise<string> {
  const policy = capabilityPolicy(cfg, 'work')
  if (!call.function.name.startsWith('host.')) return '[policy error] host.* 以外のツールはworkモードで許可されていません'
  const def = findHostTool(call.function.name)
  if (!def) return `[policy error] 未知のhostツール: ${call.function.name}`
  if (bareToolName(def.name) === 'run_command' && !policy.allowArbitraryCommands) return '[policy error] 任意コマンド実行は設定で明示的に有効化されていません'
  let args: Record<string, unknown>
  try {
    const parsed = call.function.arguments ? JSON.parse(call.function.arguments) as unknown : {}
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('argsはJSONオブジェクトで指定してください')
    args = parsed as Record<string, unknown>
  } catch (err) {
    return `[validation error] ${(err as Error).message}`
  }
  const argError = validateToolArgs(def, args)
  if (argError) return `[validation error] ${argError}`
  const qualified = qualifiedToolName(def.name)
  const summary = summarize(qualified, args)
  io.event?.({ type: 'tool.requested', tool: qualified, summary, origin: 'host', namespace: 'app', authority: 'authoritative', callId: call.id })
  io.event?.({ type: 'step.started', tool: qualified, summary, origin: 'host', namespace: 'app', authority: 'authoritative', callId: call.id })
  if (def.kind !== 'read') {
      const auto = def.kind === 'write' ? policy.autoApproveWrite : policy.autoApproveCommand
    const fileBinding = await captureFileBinding(def, args, ctx)
    const approvalBinding: ApprovalBinding = { ...fileBinding, toolName: qualified, argsHash: JSON.stringify(normalizeForKey(args)), command: typeof args.command === 'string' ? args.command : undefined, network: def.kind === 'command', callId: call.id }
    if (!auto) {
      const ok = await io.askYesNo(`実行を許可しますか？\n${summary}`, approvalBinding)
      if (ok) io.event?.({ type: 'tool.approved', tool: qualified, summary, approved: true, origin: 'host', namespace: 'app', authority: 'authoritative', callId: call.id })
      if (ok && await approvalPreconditionChanged(approvalBinding, ctx)) {
        io.event?.({ type: 'tool.denied', tool: qualified, summary, approved: false, error: '承認後に対象ファイルが変更されたため承認を無効化しました', origin: 'host', namespace: 'app', authority: 'authoritative', callId: call.id })
        return '(ユーザーが拒否しました)'
      }
      if (!ok) {
        io.event?.({ type: 'tool.denied', tool: qualified, summary, origin: 'host', namespace: 'app', authority: 'authoritative', callId: call.id })
        return '(ユーザーが拒否しました)'
      }
    } else {
      io.event?.({ type: 'tool.approved', tool: qualified, summary, approved: true, metadata: { automatic: true }, origin: 'host', namespace: 'app', authority: 'authoritative', callId: call.id })
    }
  }
  io.event?.({ type: 'tool.started', tool: qualified, summary, origin: 'host', namespace: 'app', authority: 'authoritative', callId: call.id })
  io.print(`[tool] ${summary}`)
  const startedAt = Date.now()
  try {
    const output = await def.run(args, ctx)
    const durationMs = Date.now() - startedAt
    const metadata = parseToolResultMeta(output) as unknown as Record<string, unknown> | null
    io.event?.({ type: 'tool.succeeded', tool: qualified, summary, output: output.slice(0, 1200), durationMs, metadata, origin: 'host', namespace: 'app', authority: 'authoritative', callId: call.id })
    io.event?.({ type: 'step.completed', tool: qualified, summary, output: output.slice(0, 800), durationMs, metadata, origin: 'host', namespace: 'app', authority: 'authoritative', callId: call.id })
    return output
  } catch (err) {
    const output = `[tool error] ${(err as Error).message}`
    const durationMs = Date.now() - startedAt
    io.event?.({ type: 'tool.failed', tool: qualified, summary, output, error: output, durationMs, origin: 'host', namespace: 'app', authority: 'authoritative', callId: call.id })
    io.event?.({ type: 'step.failed', tool: qualified, summary, output, error: output, durationMs, origin: 'host', namespace: 'app', authority: 'authoritative', callId: call.id })
    return output
  }
}
function summarize(name: string, args: Record<string, unknown>): string {
  const bare = bareToolName(name)
  switch (bare) {
    case 'run_command':
      return `run_command: ${args.command}`
    case 'get_weather':
      return `get_weather: ${args.location ?? '設定の既定地域'}`
    case 'write_file':
      return `write_file: ${args.path}`
    case 'edit_file':
      return `edit_file: ${args.path}`
    default:
      return `${name}: ${JSON.stringify(args)}`
  }
}
