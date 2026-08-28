import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { generateText, jsonSchema, tool, type LanguageModel, type ToolSet } from 'ai'
import type { ApprovalBinding } from './approvals'
import {
  approvalPreconditionChanged,
  buildProtocolRules,
  buildResearchBundle,
  captureFileBinding,
  formatHostResult,
  buildToolAuditMetadata,
  normalizeForKey,
  emitModelWait,
  modelEventOrigin,
  shouldCancel,
  summarize,
  toolRequestKey,
  type AgentIO,
  type AgentTurnResult
} from './agent'
import { assertSyntheticWorkspaceBoundary, capabilityPolicy, resolveApiKey, type AgentConfig } from './config'
import { runToolExecuteBeforeHooks, type ToolExecuteBeforeHook } from './hooks'
import { createPermissionHook, type PermissionDecision } from './permission-hook'
import type { ChatMessage, ToolCall } from './llm'
import { containsAgentImage, normalizeAgentUserContent, type AgentUserContent } from './multimodal'
import {
  bareToolName,
  parseToolResultMeta,
  qualifiedToolName,
  toolDefsForContract,
  validateToolArgs,
  type ToolContext,
  type ToolDef
} from './tools'

type V2ModelMessage = NonNullable<Parameters<typeof generateText>[0]['messages']>[number]
type FetchImplementation = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

/**
 * Ollama's OpenAI-compatible endpoint is local, but Japanese tool arguments
 * still need an explicit wire encoding. Keep this middleware isolated to the
 * Ollama provider so the existing Copilot/OpenAI request path is byte-for-byte
 * unchanged.
 */
export function createOllamaFetch(baseFetch: FetchImplementation = fetch): FetchImplementation {
  return async (input, init) => {
    const headers = new Headers((typeof input === 'object' && input !== null && 'headers' in input)
      ? (input as Request).headers
      : undefined)
    new Headers(init?.headers).forEach((value, key) => headers.set(key, value))
    const body = init?.body
    const contentType = headers.get('content-type')
    if (body !== undefined && body !== null) {
      if (contentType && /^application\/json(?:\s*;|$)/iu.test(contentType) && !/\bcharset\s*=/iu.test(contentType)) {
        headers.set('content-type', `${contentType}; charset=utf-8`)
      } else if (!contentType && typeof body === 'string') {
        headers.set('content-type', 'application/json; charset=utf-8')
      }
    }
    const response = await baseFetch(input, { ...init, headers })
    const responseType = response.headers.get('content-type') ?? ''
    if (!/^application\/json(?:\s*;|$)/iu.test(responseType)) return response
    // Decode with fatal UTF-8 semantics. A malformed response must fail the
    // model turn rather than silently replacing bytes with U+FFFD.
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(await response.arrayBuffer()))
    const responseHeaders = new Headers(response.headers)
    responseHeaders.set('content-type', 'application/json; charset=utf-8')
    return new Response(new TextEncoder().encode(decoded), {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders
    })
  }
}

function providerOptionsFor(cfg: AgentConfig): { ollama: { reasoningEffort: string } } | undefined {
  if (cfg.provider !== 'ollama' || cfg.reasoningEffort === undefined) return undefined
  // @ai-sdk/openai-compatible resolves this provider key and emits the
  // snake_case HTTP field `reasoning_effort`.
  return { ollama: { reasoningEffort: cfg.reasoningEffort } }
}

function modelUsageMetadata(usage: {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  inputTokenDetails?: { cacheReadTokens?: number }
  outputTokenDetails?: { reasoningTokens?: number }
}): Record<string, unknown> {
  return {
    usage: {
      inputTokens: typeof usage.inputTokens === 'number' ? usage.inputTokens : null,
      outputTokens: typeof usage.outputTokens === 'number' ? usage.outputTokens : null,
      totalTokens: typeof usage.totalTokens === 'number' ? usage.totalTokens : null,
      reasoningTokens: typeof usage.outputTokenDetails?.reasoningTokens === 'number' ? usage.outputTokenDetails.reasoningTokens : null,
      cachedInputTokens: typeof usage.inputTokenDetails?.cacheReadTokens === 'number' ? usage.inputTokenDetails.cacheReadTokens : null
    }
  }
}

export interface AgentV2Options {
  cfg: AgentConfig
  messages: ChatMessage[]
  userInput: string
  /** Ephemeral text/image content for the model; never returned in messages. */
  userContent?: AgentUserContent
  ctx: ToolContext
  io: AgentIO
  /** Optional run-scoped host tool allowlist. An empty list exposes no tools. */
  toolDefs?: readonly ToolDef[]
  /**
   * Produce ephemeral model-only context after a host-tool observation. The
   * callback may be async; returned image content is never persisted.
   */
  afterToolObservation?: (observation: {
    toolName: string
    input: unknown
    status: ExecutedToolCall['status']
  }) => AgentUserContent | undefined | PromiseLike<AgentUserContent | undefined>
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

function toModelMessages(messages: ChatMessage[], userContent?: AgentUserContent): V2ModelMessage[] {
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
  if (userContent !== undefined) {
    let lastUserIndex = -1
    for (let index = converted.length - 1; index >= 0; index--) {
      if (converted[index].role === 'user') {
        lastUserIndex = index
        break
      }
    }
    if (lastUserIndex >= 0) {
      converted[lastUserIndex] = {
        role: 'user',
        content: typeof userContent === 'string'
          ? userContent
          : userContent.map((part) => part.type === 'text'
            ? { type: 'text', text: part.text }
            : { type: 'image', image: part.image, mediaType: part.mediaType })
      } as V2ModelMessage
    }
  }
  return converted
}

function runToolDefs(cfg: AgentConfig, ctx: ToolContext, supplied?: readonly ToolDef[]): ToolDef[] {
  const policy = capabilityPolicy(cfg, 'work')
  if (supplied !== undefined) {
    return supplied.filter((def) => (
      (policy.allowArbitraryCommands || def.name !== 'run_command') &&
      !(ctx.safeCommandOnly && def.name === 'get_weather')
    ))
  }
  return toolDefsForContract({
    allowArbitraryCommands: policy.allowArbitraryCommands,
    safeCommandOnly: ctx.safeCommandOnly
  })
}

function aiTools(cfg: AgentConfig, ctx: ToolContext, supplied?: readonly ToolDef[]): ToolSet {
  const defs = runToolDefs(cfg, ctx, supplied)
  const entries = defs.map((def) => [
    def.name,
    tool({
      description: def.description,
      inputSchema: jsonSchema({ ...def.parameters, additionalProperties: false })
    })
  ])
  // When a run-scoped allowlist is supplied, no global definition is appended.
  return Object.fromEntries(entries) as ToolSet
}

function configuredModel(cfg: AgentConfig): LanguageModel {
  if (!cfg.baseURL || !cfg.model) throw new Error('agentLoop=v2 には bridge の baseURL / model が必要です')
  const isOllama = cfg.provider === 'ollama'
  const isExternal = cfg.provider === 'external-openai'
  if (isExternal && Object.prototype.hasOwnProperty.call(cfg, 'apiKey')) throw new Error('provider=external-openai は plaintext apiKey を受け付けません')
  const apiKey = isOllama ? undefined : (isExternal ? (cfg.apiKeyEnv ? process.env[cfg.apiKeyEnv] : undefined) : resolveApiKey(cfg))
  if (!isOllama && !apiKey) throw new Error('agentLoop=v2 には bridge の apiKey または apiKeyEnv が必要です')
  return createOpenAICompatible({
    name: isOllama ? 'ollama' : isExternal ? 'external-openai' : 'copilot-openai-bridge',
    baseURL: cfg.baseURL.replace(/\/+$/u, ''),
    ...(apiKey ? { apiKey } : {}),
    ...(isOllama ? { fetch: createOllamaFetch() } : {})
  }).chatModel(cfg.model)
}

/**
 * External providers are permanently confined to the synthetic workspace and
 * safe-command profile.  Config files are validated before startup, but v2 is
 * also callable directly in tests and by embedders, so do not trust either a
 * hand-built AgentConfig or a caller-supplied ToolContext here.
 */
function enforceExternalProviderSafety(cfg: AgentConfig, suppliedCtx: ToolContext): ToolContext {
  if (cfg.provider !== 'external-openai') return suppliedCtx
  if (cfg.restrictToWorkspace === false) throw new Error('provider=external-openai ではワークスペース制限を解除できません')
  if (cfg.safeCommandOnly === false) throw new Error('provider=external-openai では安全なコマンド制限を解除できません')
  if (suppliedCtx.restrictToWorkspace === false) throw new Error('provider=external-openai の ToolContext はワークスペース制限が必須です')
  if (suppliedCtx.safeCommandOnly === false) throw new Error('provider=external-openai の ToolContext は安全なコマンド制限が必須です')
  // Missing optional flags are repaired to the safe value.  Explicit false is
  // rejected above so a caller cannot use a stale context to bypass the guard.
  return { ...suppliedCtx, restrictToWorkspace: true, safeCommandOnly: true }
}

function assertExternalBoundaryBeforeRequest(cfg: AgentConfig, ctx: ToolContext, io: AgentIO): void {
  if (cfg.provider !== 'external-openai') return
  try {
    assertSyntheticWorkspaceBoundary(cfg, ctx.workspace)
  } catch (error) {
    const message = (error as Error).message || String(error)
    io.event?.({
      type: 'run.warning',
      error: message,
      metadata: { safetyBoundary: 'external-synthetic-workspace' },
      origin: 'orchestrator',
      namespace: 'none',
      authority: 'authoritative'
    })
    throw error
  }
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
  let audit = buildToolAuditMetadata(qualified, args, def.kind === 'read' ? 'allow' : 'ask', {
    required: def.kind !== 'read',
    outcome: 'not_required',
    actor: 'policy',
    automatic: def.kind === 'read'
  })
  io.event?.({ type: 'tool.requested', tool: qualified, summary, audit, origin: 'host', namespace: 'app', authority: 'authoritative', callId: call.toolCallId })
  io.event?.({ type: 'step.started', tool: qualified, summary, audit, origin: 'host', namespace: 'app', authority: 'authoritative', callId: call.toolCallId })

  const permissionController = cfg.permissions && cfg.permissions.length > 0 ? createPermissionHook(cfg.permissions) : undefined
  // Evaluate permissions after all other before-hooks so the decision is bound
  // to the exact arguments that will reach approval and the existing guards.
  const effectiveBeforeHooks = permissionController ? [...beforeHooks, permissionController.hook] : beforeHooks
  let permissionDecision: PermissionDecision | undefined
  try {
    await runToolExecuteBeforeHooks({ tool: qualified, args, ctx }, effectiveBeforeHooks)
    permissionDecision = permissionController?.takeDecision(args)
  } catch (err) {
    const reason = (err as Error).message || String(err)
    const output = `[hook denied] ${reason}`
    const permission = permissionController && /^permission denied:/u.test(reason) ? 'deny' : (def.kind === 'read' ? 'allow' : 'ask')
    audit = buildToolAuditMetadata(qualified, args, permission, {
      required: false,
      outcome: 'not_required',
      actor: 'policy',
      automatic: true
    })
    io.event?.({ type: 'tool.denied', tool: qualified, summary, approved: false, error: reason, audit, origin: 'host', namespace: 'app', authority: 'authoritative', callId: call.toolCallId })
    io.event?.({ type: 'step.failed', tool: qualified, summary, output, error: reason, audit, origin: 'host', namespace: 'app', authority: 'authoritative', callId: call.toolCallId })
    return { output, status: 'denied', executed: false, metadata: null }
  }

  const policy = capabilityPolicy(cfg, 'work')
  const permissionAsk = permissionDecision === 'ask'
  const permissionAllow = permissionDecision === 'allow'
  const permission = permissionDecision ?? (def.kind === 'read' ? 'allow' : 'ask')
  const effectiveSummary = summarize(qualified, args)
  audit = buildToolAuditMetadata(qualified, args, permission, {
    required: def.kind !== 'read',
    outcome: def.kind === 'read' ? 'not_required' : 'not_required',
    actor: 'policy',
    automatic: def.kind === 'read'
  })
  if (permissionAsk || def.kind !== 'read') {
    // A permission allow is equivalent to the existing automatic approval
    // branch, while a permission ask always forces the normal user prompt.
    const automatic = permissionAllow || (!permissionAsk && (def.kind === 'write' ? policy.autoApproveWrite : policy.autoApproveCommand))
    const fileBinding = await captureFileBinding(def, args, ctx)
    const binding: ApprovalBinding = {
      ...fileBinding,
      toolName: qualified,
      argsHash: JSON.stringify(normalizeForKey(args)),
      command: typeof args.command === 'string' ? args.command : undefined,
      network: def.kind === 'command',
      callId: call.toolCallId
    }
    audit = buildToolAuditMetadata(qualified, args, permission, {
      required: true,
      outcome: 'not_required',
      actor: 'policy',
      automatic: false
    }, { path: fileBinding.path ?? null, before_sha256: fileBinding.beforeHash ?? null })
    if (!automatic) {
      io.event?.({ type: 'approval.requested', tool: qualified, summary: effectiveSummary, audit, origin: 'host', namespace: 'app', authority: 'authoritative', callId: call.toolCallId })
      const approved = await io.askYesNo(`実行を許可しますか？\n${effectiveSummary}`, binding)
      audit = buildToolAuditMetadata(qualified, args, permission, {
        required: true,
        outcome: approved ? 'approved' : 'denied',
        actor: 'user',
        automatic: false
      }, { path: fileBinding.path ?? null, before_sha256: fileBinding.beforeHash ?? null })
      io.event?.({ type: 'approval.resolved', tool: qualified, summary: effectiveSummary, approved, audit, origin: 'host', namespace: 'app', authority: 'authoritative', callId: call.toolCallId })
      if (approved && await approvalPreconditionChanged(binding, ctx)) {
        const output = '承認後に対象ファイルが変更されたため実行しませんでした'
        io.event?.({ type: 'tool.denied', tool: qualified, summary: effectiveSummary, approved: false, error: output, audit, origin: 'host', namespace: 'app', authority: 'authoritative', callId: call.toolCallId })
        io.event?.({ type: 'step.failed', tool: qualified, summary: effectiveSummary, output, error: output, audit, origin: 'host', namespace: 'app', authority: 'authoritative', callId: call.toolCallId })
        return { output, status: 'denied', executed: false, metadata: null }
      }
      if (!approved) {
        const output = 'ユーザーが拒否しました'
        io.event?.({ type: 'tool.denied', tool: qualified, summary: effectiveSummary, approved: false, output, audit, origin: 'host', namespace: 'app', authority: 'authoritative', callId: call.toolCallId })
        io.event?.({ type: 'step.failed', tool: qualified, summary: effectiveSummary, output, audit, origin: 'host', namespace: 'app', authority: 'authoritative', callId: call.toolCallId })
        return { output, status: 'denied', executed: false, metadata: null }
      }
      io.event?.({ type: 'tool.approved', tool: qualified, summary: effectiveSummary, approved: true, audit, origin: 'host', namespace: 'app', authority: 'authoritative', callId: call.toolCallId })
    } else {
      audit = buildToolAuditMetadata(qualified, args, permission, {
        required: true,
        outcome: 'approved',
        actor: 'policy',
        automatic: true
      }, { path: fileBinding.path ?? null, before_sha256: fileBinding.beforeHash ?? null })
      io.event?.({ type: 'tool.approved', tool: qualified, summary: effectiveSummary, approved: true, audit, metadata: { automatic: true, ...(permissionAllow ? { permission: 'allow' } : {}) }, origin: 'host', namespace: 'app', authority: 'authoritative', callId: call.toolCallId })
    }
  }

  io.event?.({ type: 'tool.started', tool: qualified, summary: effectiveSummary, audit, origin: 'host', namespace: 'app', authority: 'authoritative', callId: call.toolCallId })
  io.print(`[tool] ${effectiveSummary}`)
  const startedAt = Date.now()
  try {
    const output = await def.run(args, ctx)
    const durationMs = Date.now() - startedAt
    const metadata = parseToolResultMeta(output) as unknown as Record<string, unknown> | null
    const terminalAudit = buildToolAuditMetadata(qualified, args, permission, audit.approval, {
      ...audit.target,
      after_sha256: typeof metadata?.afterHash === 'string' ? metadata.afterHash : null
    })
    io.event?.({ type: 'tool.succeeded', tool: qualified, summary: effectiveSummary, output: output.slice(0, 1200), durationMs, metadata, audit: terminalAudit, origin: 'host', namespace: 'app', authority: 'authoritative', callId: call.toolCallId })
    io.event?.({ type: 'step.completed', tool: qualified, summary: effectiveSummary, output: output.slice(0, 800), durationMs, metadata, audit: terminalAudit, origin: 'host', namespace: 'app', authority: 'authoritative', callId: call.toolCallId })
    return { output, status: 'succeeded', executed: true, metadata }
  } catch (err) {
    const output = `[tool error] ${(err as Error).message}`
    const durationMs = Date.now() - startedAt
    const terminalAudit = buildToolAuditMetadata(qualified, args, permission, audit.approval, { ...audit.target })
    io.event?.({ type: 'tool.failed', tool: qualified, summary: effectiveSummary, output, error: output, durationMs, audit: terminalAudit, origin: 'host', namespace: 'app', authority: 'authoritative', callId: call.toolCallId })
    io.event?.({ type: 'step.failed', tool: qualified, summary: effectiveSummary, output, error: output, durationMs, audit: terminalAudit, origin: 'host', namespace: 'app', authority: 'authoritative', callId: call.toolCallId })
    return { output, status: 'failed', executed: true, metadata: null }
  }
}

export async function runAgentTurnV2(opts: AgentV2Options): Promise<AgentTurnResult> {
  const { cfg, io } = opts
  const ctx = enforceExternalProviderSafety(cfg, opts.ctx)
  const userContent = opts.userContent === undefined
    ? undefined
    : normalizeAgentUserContent(opts.userContent, opts.userInput)
  if (opts.toolDefs?.some((def) => def.requiresImage) && !containsAgentImage(userContent)) {
    throw new Error('画像必須のhostツールはスクリーンショットなしでは利用できません')
  }
  if (containsAgentImage(userContent) && cfg.provider !== 'ollama' && cfg.provider !== 'external-openai') {
    throw new Error('このproviderは画像入力に対応していません。Copilot/v1ではテキストだけを指定してください')
  }
  assertExternalBoundaryBeforeRequest(cfg, ctx, io)
  if (cfg.provider === 'external-openai') {
    if (Object.prototype.hasOwnProperty.call(cfg, 'apiKey')) throw new Error('provider=external-openai は plaintext apiKey を受け付けません')
    if (!cfg.apiKeyEnv || !process.env[cfg.apiKeyEnv]) throw new Error('provider=external-openai の秘密情報が環境変数にありません')
  }
  const mode = cfg.turnMode ?? 'work'
  const policy = capabilityPolicy(cfg, mode)
  const model = opts.model ?? configuredModel(cfg)
  const messages: ChatMessage[] = [...opts.messages, { role: 'user', content: opts.userInput }]
  const priorSystem = opts.messages.filter((message) => message.role === 'system').map((message) => message.content ?? '').filter(Boolean)
  const modelMessages = toModelMessages(messages.filter((message) => message.role !== 'system'), userContent)
  const scopedToolDefs = runToolDefs(cfg, ctx, opts.toolDefs)
  const systemFor = (targetMode: 'work' | 'research' | 'chat'): string => [...new Set([
    ...priorSystem,
    cfg.systemPrompt,
    buildProtocolRules(targetMode, policy.allowArbitraryCommands, policy.autoApproveCommand, ctx.safeCommandOnly === true, scopedToolDefs)
  ].filter((value): value is string => typeof value === 'string' && value.length > 0))].join('\n\n')

  io.event?.({ type: 'plan.created', summary: mode === 'work' ? 'Runの計画と検証プロファイルを作成しました' : mode === 'research' ? '調査モードを開始しました' : '通常回答モードを開始しました', origin: 'orchestrator', namespace: 'none', authority: 'derived' })

  if (mode !== 'work') {
    try {
      emitModelWait(io, cfg)
      assertExternalBoundaryBeforeRequest(cfg, ctx, io)
      const result = await generateText({
        model,
        messages: modelMessages,
        system: systemFor(mode),
        temperature: cfg.temperature ?? 0.2,
        providerOptions: providerOptionsFor(cfg),
        maxRetries: 0,
        abortSignal: io.signal,
        experimental_include: { requestBody: false, responseBody: false }
      })
      io.event?.({ type: 'model.decision', summary: 'モデルの次の1手を受信しました', metadata: modelUsageMetadata(result.usage), origin: modelEventOrigin(cfg), namespace: 'none', authority: 'claimed' })
      messages.push({ role: 'assistant', content: result.text })
      if (mode === 'research') {
        const research = buildResearchBundle(opts.userInput, result.text)
        if (research.sources.length === 0) return warningResult('調査結果を確定できませんでした。出典URL付きで再試行してください。', messages, io)
        io.event?.({ type: 'step.completed', summary: `調査結果を受け取りました（出典${research.sources.length}件）`, origin: modelEventOrigin(cfg), namespace: 'native', authority: 'claimed' })
        return { reply: result.text, messages, aborted: false, research }
      }
      io.event?.({ type: 'step.completed', summary: '回答を受け取りました', origin: 'orchestrator', namespace: 'none', authority: 'derived' })
      return { reply: result.text, messages, aborted: false }
    } catch (err) {
      io.print(`[error] ${(err as Error).message}`)
      return { reply: '', messages, aborted: true }
    }
  }

  const tools = aiTools(cfg, ctx, scopedToolDefs)
  const actionCounts = new Map<string, number>()
  let executions = 0
  let writes = 0
  let commands = 0
  let noProgress = 0
  let lastResultKey = ''
  let confirmationOnly = false

  for (let iteration = 0; iteration < policy.maxModelDecisions; iteration++) {
    if (shouldCancel(io)) return { reply: '', messages, aborted: true }
    if (io.isPaused?.()) return { reply: '', messages, aborted: true, paused: true }
    let result: Awaited<ReturnType<typeof generateText>>
    try {
      emitModelWait(io, cfg)
      assertExternalBoundaryBeforeRequest(cfg, ctx, io)
      result = await generateText({
        model,
        messages: modelMessages,
        system: systemFor('work'),
        tools,
        ...(confirmationOnly ? { activeTools: [] as string[] } : {}),
        temperature: cfg.temperature ?? 0.2,
        providerOptions: providerOptionsFor(cfg),
        maxRetries: 0,
        abortSignal: io.signal,
        experimental_include: { requestBody: false, responseBody: false }
      })
    } catch (err) {
      io.print(`[error] ${(err as Error).message}`)
      return { reply: '', messages, aborted: true }
    }
    io.event?.({ type: 'model.decision', summary: 'モデルの次の1手を受信しました', metadata: modelUsageMetadata(result.usage), origin: modelEventOrigin(cfg), namespace: 'none', authority: 'claimed' })
    modelMessages.push(...result.response.messages as V2ModelMessage[])
    const calls = result.toolCalls
    const legacyCalls: ToolCall[] = calls.map((call) => ({ id: call.toolCallId, type: 'function', function: { name: qualifiedToolName(call.toolName), arguments: JSON.stringify(call.input) } }))
    messages.push({ role: 'assistant', content: result.text, ...(legacyCalls.length ? { tool_calls: legacyCalls } : {}) })
    if (calls.length === 0) return { reply: result.text, messages, aborted: false }
    if (calls.length !== 1) return warningResult('1回の判断で複数のhostツールが要求されたため、安全のため停止しました', messages, io)

    const call = calls[0]
    const qualifiedCallName = qualifiedToolName(call.toolName)
    const def = scopedToolDefs.find((candidate) => qualifiedToolName(candidate.name) === qualifiedCallName)
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
    if (opts.afterToolObservation && executed.status === 'succeeded') {
      const observation = await opts.afterToolObservation({
        toolName: bareToolName(def.name),
        input: call.input,
        status: executed.status
      })
      if (observation !== undefined) {
        const normalizedObservation = normalizeAgentUserContent(observation)
        modelMessages.push({
          role: 'user',
          content: typeof normalizedObservation === 'string'
            ? normalizedObservation
            : normalizedObservation.map((part) => part.type === 'text'
              ? { type: 'text', text: part.text }
              : { type: 'image', image: part.image, mediaType: part.mediaType })
        } as V2ModelMessage)
        // A post-action observation is a confirmation step.  Keep the
        // run-scoped definitions available in this process for validation, but
        // expose no callable tools on the next model request.
        confirmationOnly = true
      }
    }
    if (noProgress >= policy.maxNoProgress) return warningResult(`hostツール結果に進展がないため停止しました（${policy.maxNoProgress}回連続）`, messages, io)
  }
  return warningResult('最大反復回数に達しました', messages, io)
}

function warningResult(message: string, messages: ChatMessage[], io: AgentIO): AgentTurnResult {
  io.print(`[warn] ${message}`)
  io.event?.({ type: 'run.warning', error: message, origin: 'orchestrator', namespace: 'none', authority: 'authoritative' })
  return { reply: '', messages, aborted: true }
}
