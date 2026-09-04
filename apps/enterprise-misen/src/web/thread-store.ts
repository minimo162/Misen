import type { ExternalStoreThreadData, MessageStatus, ThreadMessageLike } from '@assistant-ui/react'

/**
 * Pure projection from Misen's loopback SSE contract onto assistant-ui's
 * External Store vocabulary. The browser keeps exactly one piece of state,
 * `ThreadStore`, and every UI element (Tool rows, artifacts, running/error
 * status, thread list) is derived from it through assistant-ui hooks.
 *
 * Provider payloads never reach this module: the server emits only visible
 * text, allowlisted Tool names, short path summaries, and validated artifacts.
 */

export type RunStatus = 'running' | 'COMPLETED' | 'FAIL' | 'CANCELLED'
export type ThreadStatus = 'idle' | RunStatus
export type SessionStatus = 'NEW' | 'RUNNING' | 'COMPLETED' | 'FAIL' | 'CANCELLED'

export type ThreadArtifact = { id: string; runId: string; filename: string; available: boolean }
export type PlanStep = { id: string; title: string; tool: string; target: string; status: 'pending' | 'running' | 'completed'; unplanned?: boolean }
export type RunPlan = { id: string; title: string; steps: PlanStep[]; visible: boolean; completed: boolean; fallback?: boolean }
export type CheckpointCard = { id: string; verb: string; target: string; risk: '低' | '中' | '高'; reason: string; status: 'pending' | 'approved' | 'rejected'; approveSimilar?: boolean }
export type RunUiState = { runId: string; plan?: RunPlan; checkpoints: CheckpointCard[] }
export type SessionToolEvent = { id: string; runId: string; name: string; target?: string; status: 'success' | 'error'; cached?: boolean }
export type SessionMessage = { id: string; role: 'user' | 'assistant'; text: string; timestamp?: string }
export type SessionSummary = { id: string; title: string; createdAt: string; updatedAt: string; status: SessionStatus }
export type SessionSnapshot = SessionSummary & { messages: SessionMessage[]; tools: SessionToolEvent[]; artifacts: ThreadArtifact[]; runUi?: RunUiState[] }

export type ServerEvent =
  | { type: 'state'; state: { status: ThreadStatus; runId?: string; sessionId?: string; artifacts: ThreadArtifact[]; runUi?: RunUiState; error?: string } }
  | { type: 'user'; sessionId?: string; id: string; text: string }
  | { type: 'assistant'; sessionId?: string; text: string; done?: boolean }
  | { type: 'tool'; sessionId?: string; phase: 'start' | 'end'; id: string; name: string; target?: string; status?: 'success' | 'error'; cached?: boolean }
  | { type: 'plan'; sessionId?: string; plan: RunPlan }
  | { type: 'step'; sessionId?: string; planId: string; stepId: string; status: PlanStep['status'] }
  | { type: 'checkpoint_request'; sessionId?: string; checkpoint: Omit<CheckpointCard, 'status'> }
  | { type: 'checkpoint_response'; sessionId?: string; id: string; decision: 'approved' | 'rejected'; approveSimilar?: boolean }
  | { type: 'status'; sessionId?: string; status: RunStatus; error?: string }

export type ToolCallResult = 'success' | 'error' | { status: 'success'; cached: true }
export type ToolCallArgs = { readonly target?: string }

/** `metadata.custom` shape carried by every Misen assistant message. */
export type AssistantCustomMetadata = { readonly runId: string; readonly artifacts: readonly ThreadArtifact[]; readonly plan?: RunPlan; readonly checkpoints: readonly CheckpointCard[] }

export type ThreadStore = {
  readonly sessionId?: string
  readonly runId?: string
  readonly status: ThreadStatus
  readonly messages: readonly ThreadMessageLike[]
}

export const RUN_FAILED_TEXT = '処理に失敗しました。'
export const RUN_INTERRUPTED_TEXT = '前回の処理は完了していません。'
export const RUN_START_FAILED_TEXT = '依頼を開始できませんでした。'
export const SESSION_START_FAILED_TEXT = '新しいチャットを開始できませんでした。'

const ASSISTANT_PREFIX = 'assistant-'
const ACTIVE_RUN = 'active'

export const assistantMessageId = (runId: string): string => `${ASSISTANT_PREFIX}${runId}`
export const runIdFromAssistantMessageId = (messageId: string): string =>
  messageId.startsWith(ASSISTANT_PREFIX) ? messageId.slice(ASSISTANT_PREFIX.length) : messageId

type Part = Exclude<ThreadMessageLike['content'], string>[number]
type ToolCallPart = Extract<Part, { type: 'tool-call' }>
type TextPart = { readonly type: 'text'; readonly text: string }

const isToolCall = (part: Part): part is ToolCallPart => part.type === 'tool-call'
const isText = (part: Part): part is TextPart => part.type === 'text'

const COMPLETE: MessageStatus = { type: 'complete', reason: 'stop' }
const RUNNING: MessageStatus = { type: 'running' }
const CANCELLED: MessageStatus = { type: 'incomplete', reason: 'cancelled' }
const errorStatus = (error: string): MessageStatus => ({ type: 'incomplete', reason: 'error', error })

function toolCallPart(tool: { id: string; name: string; target?: string; result?: ToolCallResult }): ToolCallPart {
  return {
    type: 'tool-call',
    toolCallId: tool.id,
    toolName: tool.name,
    args: tool.target === undefined ? {} : { target: tool.target },
    ...(tool.result === undefined ? {} : { result: tool.result, isError: tool.result === 'error' }),
  }
}

function userMessage(id: string, text: string, options: { optimistic?: boolean; createdAt?: string } = {}): ThreadMessageLike {
  return {
    id,
    role: 'user',
    content: [{ type: 'text', text }],
    ...(options.createdAt ? { createdAt: new Date(options.createdAt) } : {}),
    ...(options.optimistic ? { metadata: { isOptimistic: true } } : {}),
  }
}

function assistantMessage(runId: string, options: {
  text?: string
  tools?: readonly ToolCallPart[]
  artifacts?: readonly ThreadArtifact[]
  plan?: RunPlan
  checkpoints?: readonly CheckpointCard[]
  status: MessageStatus
  createdAt?: string
}): ThreadMessageLike {
  const content: Part[] = [...(options.tools ?? [])]
  if (options.text !== undefined && options.text.length > 0) content.push({ type: 'text', text: options.text })
  const custom: AssistantCustomMetadata = { runId, artifacts: options.artifacts ?? [], plan: options.plan, checkpoints: options.checkpoints ?? [] }
  return {
    id: assistantMessageId(runId),
    role: 'assistant',
    content,
    status: options.status,
    ...(options.createdAt ? { createdAt: new Date(options.createdAt) } : {}),
    metadata: { custom },
  }
}

const customOf = (message: ThreadMessageLike): AssistantCustomMetadata | undefined =>
  message.role === 'assistant' ? (message.metadata?.custom as AssistantCustomMetadata | undefined) : undefined

const withContent = (message: ThreadMessageLike, content: readonly Part[]): ThreadMessageLike => ({ ...message, content })
const withStatus = (message: ThreadMessageLike, status: MessageStatus): ThreadMessageLike => ({ ...message, status })
const withArtifacts = (message: ThreadMessageLike, artifacts: readonly ThreadArtifact[]): ThreadMessageLike => {
  const custom = customOf(message)
  if (!custom) return message
  return { ...message, metadata: { ...message.metadata, custom: { ...custom, artifacts } } }
}
const withRunUi = (message: ThreadMessageLike, update: (custom: AssistantCustomMetadata) => AssistantCustomMetadata): ThreadMessageLike => {
  const custom = customOf(message)
  return custom ? { ...message, metadata: { ...message.metadata, custom: update(custom) } } : message
}

const statusForRun = (status: ThreadStatus, error?: string): MessageStatus | undefined =>
  status === 'running' ? RUNNING
    : status === 'COMPLETED' ? COMPLETE
      : status === 'CANCELLED' ? CANCELLED
        : status === 'FAIL' ? errorStatus(error ?? RUN_FAILED_TEXT)
          : undefined

export function emptyThreadStore(sessionId?: string): ThreadStore {
  return { sessionId, status: 'idle', messages: [] }
}

/** Project a persisted local session onto assistant-ui messages. */
export function threadStoreFromSession(session: SessionSnapshot): ThreadStore {
  const messages: ThreadMessageLike[] = []
  for (const message of session.messages) {
    if (message.role === 'user') {
      messages.push(userMessage(message.id, message.text, { createdAt: message.timestamp }))
      continue
    }
    const runId = runIdFromAssistantMessageId(message.id)
    const runUi = session.runUi?.find(item => item.runId === runId)
    messages.push(assistantMessage(runId, {
      text: message.text,
      tools: session.tools.filter(tool => tool.runId === runId).map(tool => toolCallPart({ id: tool.id, name: tool.name, target: tool.target, result: tool.cached ? { status: 'success', cached: true } : tool.status })),
      artifacts: session.artifacts.filter(artifact => artifact.runId === runId),
      plan: runUi?.plan,
      checkpoints: runUi?.checkpoints,
      status: COMPLETE,
      createdAt: message.timestamp,
    }))
  }
  const last = messages.at(-1)
  const lastRunId = last ? runIdFromAssistantMessageId(last.id ?? '') : undefined
  let status: ThreadStatus = session.status === 'NEW' ? 'idle' : session.status === 'RUNNING' ? 'FAIL' : session.status
  if (session.status === 'RUNNING' && lastRunId) {
    const interrupted = errorStatus(RUN_INTERRUPTED_TEXT)
    if (last?.role === 'assistant') messages[messages.length - 1] = withStatus(last, interrupted)
    else messages.push(assistantMessage(lastRunId, { status: interrupted }))
  } else if (session.status === 'FAIL' && last?.role === 'assistant') {
    messages[messages.length - 1] = withStatus(last, errorStatus(RUN_FAILED_TEXT))
  } else if (session.status === 'CANCELLED' && last?.role === 'assistant') {
    messages[messages.length - 1] = withStatus(last, CANCELLED)
  } else if (session.status === 'NEW') {
    status = 'idle'
  }
  return { sessionId: session.id, runId: lastRunId, status, messages }
}

/** Optimistic user turn plus the assistant placeholder that owns Tool rows and status. */
export function startRun(store: ThreadStore, clientId: string, text: string): ThreadStore {
  return {
    ...store,
    runId: clientId,
    status: 'running',
    messages: [...store.messages, userMessage(clientId, text, { optimistic: true }), assistantMessage(clientId, { status: RUNNING })],
  }
}

/** Surface a host-side failure on the run's assistant message, without provider details. */
export function failRun(store: ThreadStore, text: string): ThreadStore {
  const runId = store.runId ?? ACTIVE_RUN
  return { ...store, status: 'FAIL', messages: upsertAssistant(store.messages, runId, message => withStatus(message, errorStatus(text)), errorStatus(text)) }
}

function upsertAssistant(
  messages: readonly ThreadMessageLike[],
  runId: string,
  update: (message: ThreadMessageLike) => ThreadMessageLike,
  createStatus: MessageStatus,
): ThreadMessageLike[] {
  const id = assistantMessageId(runId)
  const index = messages.findIndex(message => message.id === id)
  if (index >= 0) return messages.map((message, current) => current === index ? update(message) : message)
  return [...messages, update(assistantMessage(runId, { status: createStatus }))]
}

function applyRunStatus(store: ThreadStore, status: ThreadStatus, error?: string): ThreadStore {
  const messageStatus = statusForRun(status, error)
  if (!messageStatus) return { ...store, status }
  const runId = store.runId ?? ACTIVE_RUN
  return { ...store, status, messages: upsertAssistant(store.messages, runId, message => withStatus(message, messageStatus), messageStatus) }
}

/**
 * Fold one UI-safe SSE event into the store. Callers filter by active session
 * first (`eventAppliesToActiveSession`); this reducer never inspects session ids.
 */
export function applyServerEvent(store: ThreadStore, event: ServerEvent): ThreadStore {
  if (event.type === 'state') {
    const runId = event.state.runId ?? store.runId
    let messages = store.messages
    const byRun = new Map<string, ThreadArtifact[]>()
    for (const artifact of event.state.artifacts) byRun.set(artifact.runId, [...(byRun.get(artifact.runId) ?? []), artifact])
    if (byRun.size > 0) {
      messages = messages.map(message => {
        const custom = customOf(message)
        return custom && byRun.has(custom.runId) ? withArtifacts(message, byRun.get(custom.runId) ?? []) : message
      })
    }
    if (event.state.runUi && runId === event.state.runUi.runId) {
      const runUi = event.state.runUi
      const restoredStatus = statusForRun(event.state.status, event.state.error) ?? COMPLETE
      messages = upsertAssistant(messages, runId, message => withRunUi(message, custom => ({ ...custom, plan: runUi.plan, checkpoints: runUi.checkpoints })), restoredStatus)
    }
    return applyRunStatus({ ...store, runId, sessionId: event.state.sessionId ?? store.sessionId, messages }, event.state.status, event.state.error)
  }
  if (event.type === 'status') return applyRunStatus(store, event.status, event.error)
  if (event.type === 'user') {
    const existing = store.messages.findIndex(message => message.id === event.id)
    if (existing >= 0) {
      return { ...store, messages: store.messages.map((message, index) => index === existing ? { ...message, metadata: undefined } : message) }
    }
    const confirmed = userMessage(event.id, event.text)
    const placeholder = store.messages.findIndex(message => message.id === assistantMessageId(event.id))
    if (placeholder < 0) return { ...store, messages: [...store.messages, confirmed] }
    return { ...store, messages: [...store.messages.slice(0, placeholder), confirmed, ...store.messages.slice(placeholder)] }
  }
  const runId = store.runId ?? ACTIVE_RUN
  const createStatus = store.status === 'running' ? RUNNING : COMPLETE
  if (event.type === 'assistant') {
    return {
      ...store,
      messages: upsertAssistant(store.messages, runId, message => {
        const parts = message.content as readonly Part[]
        const textIndex = parts.findIndex(isText)
        const text: TextPart = { type: 'text', text: event.text }
        return withContent(message, textIndex >= 0 ? parts.map((part, index) => index === textIndex ? text : part) : [...parts, text])
      }, createStatus),
    }
  }
  if (event.type === 'plan') {
    return { ...store, messages: upsertAssistant(store.messages, runId, message => withRunUi(message, custom => ({ ...custom, plan: event.plan })), createStatus) }
  }
  if (event.type === 'step') {
    return { ...store, messages: upsertAssistant(store.messages, runId, message => withRunUi(message, custom => custom.plan?.id === event.planId ? ({ ...custom, plan: { ...custom.plan, steps: custom.plan.steps.map(step => step.id === event.stepId ? { ...step, status: event.status } : step) } }) : custom), createStatus) }
  }
  if (event.type === 'checkpoint_request') {
    return { ...store, messages: upsertAssistant(store.messages, runId, message => withRunUi(message, custom => ({ ...custom, checkpoints: [...custom.checkpoints.filter(item => item.id !== event.checkpoint.id), { ...event.checkpoint, status: 'pending' }] })), createStatus) }
  }
  if (event.type === 'checkpoint_response') {
    return { ...store, messages: upsertAssistant(store.messages, runId, message => withRunUi(message, custom => ({ ...custom, checkpoints: custom.checkpoints.map(item => item.id === event.id ? { ...item, status: event.decision, ...(event.approveSimilar ? { approveSimilar: true } : {}) } : item) })), createStatus) }
  }
  return {
    ...store,
    messages: upsertAssistant(store.messages, runId, message => {
      const parts = message.content as readonly Part[]
      const index = parts.findIndex(part => isToolCall(part) && part.toolCallId === event.id)
      if (event.phase === 'start') {
        const next = toolCallPart({ id: event.id, name: event.name, target: event.target })
        if (index >= 0) return withContent(message, parts.map((part, current) => current === index ? next : part))
        const textIndex = parts.findIndex(isText)
        return withContent(message, textIndex < 0 ? [...parts, next] : [...parts.slice(0, textIndex), next, ...parts.slice(textIndex)])
      }
      const result: ToolCallResult = event.status === 'error' ? 'error' : event.cached ? { status: 'success', cached: true } : 'success'
      if (index < 0) {
        const next = toolCallPart({ id: event.id, name: event.name, result })
        const textIndex = parts.findIndex(isText)
        return withContent(message, textIndex < 0 ? [...parts, next] : [...parts.slice(0, textIndex), next, ...parts.slice(textIndex)])
      }
      return withContent(message, parts.map((part, current) => current === index && isToolCall(part) ? { ...part, result, isError: result === 'error' } : part))
    }, createStatus),
  }
}

/** Thread list `custom` metadata derived once, so rows read grouping through hooks only. */
export type ThreadListCustom = { readonly updatedAt: string; readonly sessionStatus: SessionStatus; readonly group: string; readonly showGroup: boolean }

const startOfDay = (value: Date): number => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime()

export function dateGroupLabel(updatedAt: string, now: Date = new Date()): string {
  const updated = new Date(updatedAt)
  const days = Math.round((startOfDay(now) - startOfDay(updated)) / 86_400_000)
  if (days === 0) return '今日'
  if (days === 1) return '昨日'
  return new Intl.DateTimeFormat('ja-JP', { month: 'numeric', day: 'numeric' }).format(updated)
}

export function updatedTimeLabel(updatedAt: string, now: Date = new Date()): string {
  const updated = new Date(updatedAt)
  return dateGroupLabel(updatedAt, now) === '今日'
    ? new Intl.DateTimeFormat('ja-JP', { hour: '2-digit', minute: '2-digit' }).format(updated)
    : new Intl.DateTimeFormat('ja-JP', { month: 'numeric', day: 'numeric' }).format(updated)
}

/** `adapters.threadList.threads` input; sessions arrive newest-first from `/sessions`. */
export function threadListThreads(sessions: readonly SessionSummary[], now: Date = new Date()): ExternalStoreThreadData<'regular'>[] {
  let priorGroup = ''
  return sessions.map(session => {
    const group = dateGroupLabel(session.updatedAt, now)
    const custom: ThreadListCustom = { updatedAt: session.updatedAt, sessionStatus: session.status, group, showGroup: group !== priorGroup }
    priorGroup = group
    return { id: session.id, title: session.title, status: 'regular', custom }
  })
}
