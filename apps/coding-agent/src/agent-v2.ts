import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { generateText, jsonSchema, tool, type LanguageModel, type ToolSet } from 'ai'
import type { ApprovalBinding } from './approvals'
import {
  approvalPreconditionChanged,
  buildProtocolRules,
  buildResearchBundle,
  captureFileBinding,
  formatHostResult,
  normalizeForKey,
  shouldCancel,
  summarize,
  toolRequestKey,
  type AgentIO,
  type AgentTurnResult
} from './agent'
import { capabilityPolicy, resolveApiKey, type AgentConfig } from './config'
import { runToolExecuteBeforeHooks, type ToolExecuteBeforeHook } from './hooks'
import type { ChatMessage, ToolCall } from './llm'
import {
  bareToolName,
  findHostTool,
  parseToolResultMeta,
  qualifiedToolName,
  toolDefsForContract,
  validateToolArgs,
  type ToolContext,
  type ToolDef
} from './tools'

type V2ModelMessage = NonNullable<Parameters<typeof generateText>[0]['messages']>[number]

export interface AgentV2Options {
  cfg: AgentConfig
  messages: ChatMessage[]
  userInput: string
  ctx: ToolContext
  io: AgentIO
  /** Per-run hooks are primarily a deterministic test seam. */
  beforeHooks?: readonly ToolExecuteBeforeHook[]
  /** A model override keeps smoke tests entirely local and deterministic. */
  model?: LanguageModel
}

export interface ExecutedToolCall {
  output: string
  status: 'succeeded' | 'failed' | 'denied'
  executed: boolean
  metadata: Record<string, unknown> | null
}

function toModelMessages(messages: ChatMessage[]): V2ModelMessage[] {
  const converted: V2ModelMessage[] = []
  for (const message of messages) {
    if (message.role === 'system' || message.role === 'user') {
      converted.push({ role: message.role, content: message.content ?? '' } as V2ModelMessage)
      continue
    }
    if (message.role === 'assistant') {
      if (!message.tool_calls?.length) {
        converted.push({ role: 'assistant', content: message.content ?? '' } as V2ModelMessage)
        continue
      }
      const content: Array<Record<string, unknown>> = []
      if (message.content) content.push({ type: 'text', text: message.content })
      for (const call of message.tool_calls) {
        let input: unknown = {}
        try { input = call.function.arguments ? JSON.parse(call.function.arguments) : {} } catch {}
        content.push({ type: 'tool-call', toolCallId: call.id, toolName: bareToolName(call.function.name), input })
      }
      converted.push({ role: 'assistant', content } as V2ModelMessage)
      continue
    }
    converted.push({
      role: 'tool',
      content: [{
        type: 'tool-result',
        toolCallId: message.tool_call_id ?? 'unknown-call',
        toolName: bareToolName(message.name ?? 'unknown-tool'),
        output: { type: 'text', value: message.content ?? '' }
      }]
    } as V2ModelMessage)
  }
  return converted
}

function aiTools(cfg: AgentConfig, ctx: ToolContext): ToolSet {
  const policy = capabilityPolicy(cfg, 'work')
  const entries = toolDefsForContract({
    allowArbitraryCommands: policy.allowArbitraryCommands,
    safeCommandOnly: ctx.safeCommandOnly
  }).map((def) => [
    def.name,
    tool({
      description: def.description,
      inputSchema: jsonSchema({ ...def.parameters, additionalProperties: false })
    })
  ])
  return Object.fromEntries(entries) as ToolSet
}

function configuredModel(cfg: AgentConfig): LanguageModel {
  if (!cfg.baseURL || !cfg.model) throw new Error('agentLoop=v2 には bridge の baseURL / model が必要です')
  const apiKey = resolveApiKey(cfg)
  if (!apiKey) throw new Error('agentLoop=v2 には bridge の apiKey または apiKeyEnv が必要です')
  return createOpenAICompatible({
    name: 'copilot-openai-bridge',
    baseURL: cfg.baseURL.replace(/\/+$/u, ''),
    apiKey
  }).chatModel(cfg.model)
}

export async function executeV2ToolCall(
  call: { toolCallId: string; toolName: string; input: unknown },
  def: ToolDef,
  cfg: AgentConfig,
  ctx: ToolContext,
  io: AgentIO,
  beforeHooks: readonly ToolExecuteBeforeHook[]
): Promise<ExecutedToolCall> {
  if (!call.input || typeof call.input !== 'object' || Array.isArray(call.input)) {
    return { output: '[validation error] argsはJSONオブジェクトで指定してください', status: 'failed', executed: false, metadata: null }
  }
  const args = call.input as Record<string, unknown>
  const argError = validateToolArgs(def, args)
  if (argError) return { output: `[validation error] ${argError}`, status: 'failed', executed: false, metadata: null }

  const qualified = qualifiedToolName(def.name)
  const summary = summarize(qualified, args)
  io.event?.({ type: 'tool.requested', tool: qualified, summary, origin: 'host', namespace: 'app', authority: 'authoritative', callId: call.toolCallId })
  io.event?.({ type: 'step.started', tool: qualified, summary, origin: 'host', namespace: 'app', authority: 'authoritative', callId: call.toolCallId })

  try {
    await runToolExecuteBeforeHooks({ tool: qualified, args, ctx }, beforeHooks)
  } catch (err) {
    const reason = (err as Error).message || String(err)
    const output = `[hook denied] ${reason}`
    io.event?.({ type: 'tool.denied', tool: qualified, summary, approved: false, error: reason, origin: 'host', namespace: 'app', authority: 'authoritative', callId: call.toolCallId })
    io.event?.({ type: 'step.failed', tool: qualified, summary, output, error: reason, origin: 'host', namespace: 'app', authority: 'authoritative', callId: call.toolCallId })
    return { output, status: 'denied', executed: false, metadata: null }
  }

  const policy = capabilityPolicy(cfg, 'work')
  if (def.kind !== 'read') {
    const automatic = def.kind === 'write' ? policy.autoApproveWrite : policy.autoApproveCommand
    const fileBinding = await captureFileBinding(def, args, ctx)
    const binding: ApprovalBinding = {
      ...fileBinding,
      toolName: qualified,
      argsHash: JSON.stringify(normalizeForKey(args)),
      command: typeof args.command === 'string' ? args.command : undefined,
      network: def.kind === 'command',
      callId: call.toolCallId
    }
    if (!automatic) {
      io.event?.({ type: 'approval.requested', tool: qualified, summary, origin: 'host', namespace: 'app', authority: 'authoritative', callId: call.toolCallId })
      const approved = await io.askYesNo(`実行を許可しますか？\n${summary}`, binding)
      io.event?.({ type: 'approval.resolved', tool: qualified, summary, approved, origin: 'host', namespace: 'app', authority: 'authoritative', callId: call.toolCallId })
      if (approved && await approvalPreconditionChanged(binding, ctx)) {
        const output = '承認後に対象ファイルが変更されたため実行しませんでした'
        io.event?.({ type: 'tool.denied', tool: qualified, summary, approved: false, error: output, origin: 'host', namespace: 'app', authority: 'authoritative', callId: call.toolCallId })
        io.event?.({ type: 'step.failed', tool: qualified, summary, output, error: output, origin: 'host', namespace: 'app', authority: 'authoritative', callId: call.toolCallId })
        return { output, status: 'denied', executed: false, metadata: null }
      }
      if (!approved) {
        const output = 'ユーザーが拒否しました'
        io.event?.({ type: 'tool.denied', tool: qualified, summary, approved: false, origin: 'host', namespace: 'app', authority: 'authoritative', callId: call.toolCallId })
        io.event?.({ type: 'step.failed', tool: qualified, summary, output, origin: 'host', namespace: 'app', authority: 'authoritative', callId: call.toolCallId })
        return { output, status: 'denied', executed: false, metadata: null }
      }
      io.event?.({ type: 'tool.approved', tool: qualified, summary, approved: true, origin: 'host', namespace: 'app', authority: 'authoritative', callId: call.toolCallId })
    } else {
      io.event?.({ type: 'tool.approved', tool: qualified, summary, approved: true, metadata: { automatic: true }, origin: 'host', namespace: 'app', authority: 'authoritative', callId: call.toolCallId })
    }
  }

  io.event?.({ type: 'tool.started', tool: qualified, summary, origin: 'host', namespace: 'app', authority: 'authoritative', callId: call.toolCallId })
  io.print(`[tool] ${summary}`)
  const startedAt = Date.now()
  try {
    const output = await def.run(args, ctx)
    const durationMs = Date.now() - startedAt
    const metadata = parseToolResultMeta(output) as unknown as Record<string, unknown> | null
    io.event?.({ type: 'tool.succeeded', tool: qualified, summary, output: output.slice(0, 1200), durationMs, metadata, origin: 'host', namespace: 'app', authority: 'authoritative', callId: call.toolCallId })
    io.event?.({ type: 'step.completed', tool: qualified, summary, output: output.slice(0, 800), durationMs, metadata, origin: 'host', namespace: 'app', authority: 'authoritative', callId: call.toolCallId })
    return { output, status: 'succeeded', executed: true, metadata }
  } catch (err) {
    const output = `[tool error] ${(err as Error).message}`
    const durationMs = Date.now() - startedAt
    io.event?.({ type: 'tool.failed', tool: qualified, summary, output, error: output, durationMs, origin: 'host', namespace: 'app', authority: 'authoritative', callId: call.toolCallId })
    io.event?.({ type: 'step.failed', tool: qualified, summary, output, error: output, durationMs, origin: 'host', namespace: 'app', authority: 'authoritative', callId: call.toolCallId })
    return { output, status: 'failed', executed: true, metadata: null }
  }
}

export async function runAgentTurnV2(opts: AgentV2Options): Promise<AgentTurnResult> {
  const { cfg, ctx, io } = opts
  const mode = cfg.turnMode ?? 'work'
  const policy = capabilityPolicy(cfg, mode)
  const model = opts.model ?? configuredModel(cfg)
  const messages: ChatMessage[] = [...opts.messages, { role: 'user', content: opts.userInput }]
  const priorSystem = opts.messages.filter((message) => message.role === 'system').map((message) => message.content ?? '').filter(Boolean)
  const modelMessages = toModelMessages(messages.filter((message) => message.role !== 'system'))
  const systemFor = (targetMode: 'work' | 'research' | 'chat'): string => [...new Set([
    ...priorSystem,
    cfg.systemPrompt,
    buildProtocolRules(targetMode, policy.allowArbitraryCommands, policy.autoApproveCommand, ctx.safeCommandOnly === true)
  ].filter((value): value is string => typeof value === 'string' && value.length > 0))].join('\n\n')

  io.event?.({ type: 'plan.created', summary: mode === 'work' ? 'Runの計画と検証プロファイルを作成しました' : mode === 'research' ? '調査モードを開始しました' : '通常回答モードを開始しました', origin: 'orchestrator', namespace: 'none', authority: 'derived' })

  if (mode !== 'work') {
    try {
      const result = await generateText({
        model,
        messages: modelMessages,
        system: systemFor(mode),
        temperature: cfg.temperature ?? 0.2,
        maxRetries: 0,
        abortSignal: io.signal
      })
      io.event?.({ type: 'model.decision', summary: 'モデルの次の1手を受信しました', origin: 'copilot', namespace: 'none', authority: 'claimed' })
      messages.push({ role: 'assistant', content: result.text })
      if (mode === 'research') {
        const research = buildResearchBundle(opts.userInput, result.text)
        if (research.sources.length === 0) return warningResult('調査結果を確定できませんでした。出典URL付きで再試行してください。', messages, io)
        io.event?.({ type: 'step.completed', summary: `調査結果を受け取りました（出典${research.sources.length}件）`, origin: 'copilot', namespace: 'native', authority: 'claimed' })
        return { reply: result.text, messages, aborted: false, research }
      }
      io.event?.({ type: 'step.completed', summary: '回答を受け取りました', origin: 'orchestrator', namespace: 'none', authority: 'derived' })
      return { reply: result.text, messages, aborted: false }
    } catch (err) {
      io.print(`[error] ${(err as Error).message}`)
      return { reply: '', messages, aborted: true }
    }
  }

  const tools = aiTools(cfg, ctx)
  const actionCounts = new Map<string, number>()
  let executions = 0
  let writes = 0
  let commands = 0
  let noProgress = 0
  let lastResultKey = ''

  for (let iteration = 0; iteration < policy.maxModelDecisions; iteration++) {
    if (shouldCancel(io)) return { reply: '', messages, aborted: true }
    if (io.isPaused?.()) return { reply: '', messages, aborted: true, paused: true }
    let result: Awaited<ReturnType<typeof generateText>>
    try {
      result = await generateText({
        model,
        messages: modelMessages,
        system: systemFor('work'),
        tools,
        temperature: cfg.temperature ?? 0.2,
        maxRetries: 0,
        abortSignal: io.signal
      })
    } catch (err) {
      io.print(`[error] ${(err as Error).message}`)
      return { reply: '', messages, aborted: true }
    }
    io.event?.({ type: 'model.decision', summary: 'モデルの次の1手を受信しました', origin: 'copilot', namespace: 'none', authority: 'claimed' })
    modelMessages.push(...result.response.messages as V2ModelMessage[])
    const calls = result.toolCalls
    const legacyCalls: ToolCall[] = calls.map((call) => ({ id: call.toolCallId, type: 'function', function: { name: qualifiedToolName(call.toolName), arguments: JSON.stringify(call.input) } }))
    messages.push({ role: 'assistant', content: result.text, ...(legacyCalls.length ? { tool_calls: legacyCalls } : {}) })
    if (calls.length === 0) return { reply: result.text, messages, aborted: false }
    if (calls.length !== 1) return warningResult('1回の判断で複数のhostツールが要求されたため、安全のため停止しました', messages, io)

    const call = calls[0]
    const def = findHostTool(qualifiedToolName(call.toolName))
    if (!def) return warningResult(`許可されていないhostツール ${call.toolName} が要求されたため停止しました`, messages, io)
    if (ctx.safeCommandOnly && bareToolName(def.name) === 'get_weather') return warningResult('この構成ではネットワーク通信を行うhostツールは利用できません', messages, io)
    if (bareToolName(def.name) === 'run_command' && !policy.allowArbitraryCommands) return warningResult('任意コマンド実行は設定で明示的に有効化されていないため停止しました', messages, io)
    if (executions >= policy.maxHostExecutions) return warningResult(`hostツール実行上限(${policy.maxHostExecutions}回)に達したため停止しました`, messages, io)
    if (def.kind === 'write' && writes >= policy.maxWriteExecutions) return warningResult(`書き込み実行上限(${policy.maxWriteExecutions}回)に達したため停止しました`, messages, io)
    if (def.kind === 'command' && commands >= policy.maxCommandExecutions) return warningResult(`コマンド実行上限(${policy.maxCommandExecutions}回)に達したため停止しました`, messages, io)

    const keyArgs = call.input && typeof call.input === 'object' && !Array.isArray(call.input) ? call.input as Record<string, unknown> : {}
    const key = toolRequestKey(qualifiedToolName(def.name), keyArgs)
    if ((actionCounts.get(key) ?? 0) > 0) return warningResult('同じhostツール操作が繰り返されたため停止しました', messages, io)
    actionCounts.set(key, 1)

    const executed = await executeV2ToolCall(call, def, cfg, ctx, io, opts.beforeHooks ?? [])
    if (executed.executed) {
      executions++
      if (def.kind === 'write') writes++
      if (def.kind === 'command') commands++
      const resultKey = `${qualifiedToolName(def.name)}:${executed.metadata?.afterHash ?? executed.output.slice(0, 1600)}`
      noProgress = resultKey === lastResultKey ? noProgress + 1 : 0
      lastResultKey = resultKey
    }
    const hostResult = formatHostResult(qualifiedToolName(def.name), executed.output, executed.metadata, executed.status, call.toolCallId, ctx.runId)
    modelMessages.push({ role: 'tool', content: [{ type: 'tool-result', toolCallId: call.toolCallId, toolName: call.toolName, output: { type: 'text', value: hostResult } }] } as V2ModelMessage)
    messages.push({ role: 'tool', tool_call_id: call.toolCallId, name: qualifiedToolName(def.name), content: hostResult })
    if (noProgress >= policy.maxNoProgress) return warningResult(`hostツール結果に進展がないため停止しました（${policy.maxNoProgress}回連続）`, messages, io)
  }
  return warningResult('最大反復回数に達しました', messages, io)
}

function warningResult(message: string, messages: ChatMessage[], io: AgentIO): AgentTurnResult {
  io.print(`[warn] ${message}`)
  io.event?.({ type: 'run.warning', error: message, origin: 'orchestrator', namespace: 'none', authority: 'authoritative' })
  return { reply: '', messages, aborted: true }
}
