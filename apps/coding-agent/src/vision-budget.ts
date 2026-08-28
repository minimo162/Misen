import type { ChatMessage } from './llm'
import type { AgentUserContent } from './multimodal'

/**
 * Host-side policy for the Qwen vision path.
 *
 * Qwen3-VL/Qwen3.5 use a 16px patch and a 2x2 merge, so the visual grid
 * factor is 32.  This file computes an estimate for admission control only;
 * the Qwen processor (and Ollama) remains authoritative for actual usage.
 */
export const VISION_TOKEN_BUDGETS = [512, 768, 1024] as const
export type VisionTokenBudget = (typeof VISION_TOKEN_BUDGETS)[number]
export const DEFAULT_VISION_TOKEN_BUDGET: VisionTokenBudget = 512
export const DEFAULT_MAX_CONTEXT_TOKENS = 4096
export const DEFAULT_RESERVED_VISUAL_TOKENS: VisionTokenBudget = DEFAULT_VISION_TOKEN_BUDGET
export const QWEN_VISION_FACTOR = 32
export type VisionEstimationBasis = 'qwen-factor-32-grid-estimate'

export interface VisionBudgetRequest {
  width: number
  height: number
  maxVisualTokens?: number
  requestedMaxVisualTokens?: number
}

export interface VisionResizeMetadata {
  readonly originalWidth: number
  readonly originalHeight: number
  readonly width: number
  readonly height: number
  readonly resizedWidth: number
  readonly resizedHeight: number
  readonly maxVisualTokens: VisionTokenBudget
  readonly requestedMaxVisualTokens: number
  readonly estimatedVisualTokens: number
  readonly estimatedTokens: number
  readonly visualTokenFactor: number
  readonly estimationBasis: VisionEstimationBasis
  readonly processorReported: false
  readonly resized: boolean
  readonly dimensionsAlignedTo: number
  readonly withinBudget: boolean
}

/** Round an arbitrary request up to one of the supported, bounded tiers. */
export function normalizeVisionTokenBudget(requested?: number): VisionTokenBudget {
  const value = requested ?? DEFAULT_VISION_TOKEN_BUDGET
  if (!Number.isFinite(value) || value <= 0) throw new RangeError('maxVisualTokens must be a positive finite number')
  const tier = VISION_TOKEN_BUDGETS.find((candidate) => candidate >= value)
  if (tier === undefined) throw new RangeError('maxVisualTokens exceeds the supported 4K budget (1024)')
  return tier
}

function assertDimension(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${label} must be a positive safe integer`)
}

/** Conservative Qwen grid estimate; it is not processor-reported. */
export function estimateQwenVisualTokens(width: number, height: number, factor = QWEN_VISION_FACTOR): number {
  assertDimension(width, 'width')
  assertDimension(height, 'height')
  if (!Number.isSafeInteger(factor) || factor <= 0) throw new RangeError('visual token factor must be a positive safe integer')
  const estimate = Math.ceil(width / factor) * Math.ceil(height / factor)
  if (!Number.isSafeInteger(estimate)) throw new RangeError('visual token estimate exceeds safe integer range')
  return estimate
}

export const estimateVisualTokens = estimateQwenVisualTokens

function requestParts(inputOrWidth: VisionBudgetRequest | number, height?: number, requested?: number): { width: number; height: number; requested: number } {
  if (typeof inputOrWidth === 'number') {
    if (height === undefined) throw new TypeError('height is required when width is passed positionally')
    return { width: inputOrWidth, height, requested: requested ?? DEFAULT_VISION_TOKEN_BUDGET }
  }
  return {
    width: inputOrWidth.width,
    height: inputOrWidth.height,
    requested: inputOrWidth.maxVisualTokens ?? inputOrWidth.requestedMaxVisualTokens ?? DEFAULT_VISION_TOKEN_BUDGET
  }
}

/** Select a bounded tier and factor-aligned dimensions. */
export function selectVisionBudget(input: VisionBudgetRequest): VisionResizeMetadata
export function selectVisionBudget(width: number, height: number, requestedMaxVisualTokens?: number): VisionResizeMetadata
export function selectVisionBudget(inputOrWidth: VisionBudgetRequest | number, height?: number, requested?: number): VisionResizeMetadata {
  const input = requestParts(inputOrWidth, height, requested)
  assertDimension(input.width, 'width')
  assertDimension(input.height, 'height')
  const maxVisualTokens = normalizeVisionTokenBudget(input.requested)
  const factor = QWEN_VISION_FACTOR
  const originalArea = input.width * input.height
  if (!Number.isSafeInteger(originalArea) || originalArea <= 0) throw new RangeError('image dimensions exceed safe arithmetic range')
  const maxPixels = maxVisualTokens * factor * factor
  const scale = Math.min(1, Math.sqrt(maxPixels / originalArea))
  let gridWidth = Math.max(1, Math.floor((input.width * scale) / factor))
  let gridHeight = Math.max(1, Math.floor((input.height * scale) / factor))
  while (gridWidth * gridHeight > maxVisualTokens) {
    if (gridWidth >= gridHeight && gridWidth > 1) gridWidth--
    else if (gridHeight > 1) gridHeight--
    else throw new RangeError('image cannot fit the requested visual-token budget')
  }
  const width = gridWidth * factor
  const resizedHeight = gridHeight * factor
  const estimatedVisualTokens = gridWidth * gridHeight
  return {
    originalWidth: input.width,
    originalHeight: input.height,
    width,
    height: resizedHeight,
    resizedWidth: width,
    resizedHeight,
    maxVisualTokens,
    requestedMaxVisualTokens: input.requested,
    estimatedVisualTokens,
    estimatedTokens: estimatedVisualTokens,
    visualTokenFactor: factor,
    estimationBasis: 'qwen-factor-32-grid-estimate',
    processorReported: false,
    resized: width !== input.width || resizedHeight !== input.height,
    dimensionsAlignedTo: factor,
    withinBudget: estimatedVisualTokens <= maxVisualTokens
  }
}

/** Exact (no wildcard) names allowed in a vision request. */
export const MINIMAL_ACTIVE_TOOL_ALLOWLIST = ['open_company'] as const
export type NamedTool = { name: string }

export function activeToolAllowlist<T extends NamedTool | string>(tools: readonly T[], allowedNames: readonly string[] = MINIMAL_ACTIVE_TOOL_ALLOWLIST): T[] {
  const allowed = new Set(allowedNames.filter((name) => typeof name === 'string' && name.length > 0))
  return tools.filter((tool) => allowed.has(typeof tool === 'string' ? tool : tool.name))
}

export const filterActiveTools = activeToolAllowlist

/** Text-only persisted history with small scalar state metadata. */
export interface WorkingContextMetadata {
  tool?: string
  status?: string
  approval?: string | boolean
  approved?: boolean
  precondition?: string | boolean
  before_sha256?: string
  after_sha256?: string
  path?: string
  structuredObservation?: boolean
  relevant?: boolean
  [key: string]: unknown
}

export interface WorkingContextMessage extends ChatMessage {
  kind?: string
  type?: string
  metadata?: WorkingContextMetadata
}

export interface SafeWorkingContextMessage {
  role: ChatMessage['role']
  content: string
  name?: string
  tool_call_id?: string
  /** Tool call names/IDs only; arguments are intentionally not persisted. */
  tool_calls?: readonly { id: string; name: string }[]
  metadata?: Record<string, string | number | boolean | null>
}

export interface PruneWorkingContextOptions {
  maxContextTokens?: number
  reservedVisualTokens?: number
  maxTextTokens?: number
  maxToolResultChars?: number
  maxMessageChars?: number
  keepRecentMessages?: number
  /** Ephemeral image content is accepted only to count and discard it. */
  ephemeralContent?: AgentUserContent
}

export interface PrunedWorkingContext {
  messages: SafeWorkingContextMessage[]
  workingContext: SafeWorkingContextMessage[]
  maxContextTokens: number
  reservedVisualTokens: number
  maxTextTokens: number
  estimatedTextTokens: number
  estimatedContextTokens: number
  withinBudget: boolean
  dropped: { reasoning: number; largeToolResults: number; images: number; oldImages: number; oldMessages: number }
  retained: { latestUserRequest: boolean; structuredObservations: number; toolEssentials: number; approvalEssentials: number; preconditionEssentials: number }
}

type Scalar = string | number | boolean | null
const DATA_IMAGE_RE = /data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=_-]*/giu

function scalar(value: unknown): Scalar | undefined {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value
  if (typeof value === 'string' && value.length <= 256 && !/^data:image\//iu.test(value)) return value
  return undefined
}

function safeMetadata(message: WorkingContextMessage): Record<string, Scalar> {
  const output: Record<string, Scalar> = {}
  const source = message.metadata
  const raw = message as unknown as Record<string, unknown>
  for (const key of ['tool', 'status', 'approval', 'approved', 'precondition', 'before_sha256', 'after_sha256', 'path', 'structuredObservation', 'relevant']) {
    const value = scalar(raw[key] ?? source?.[key])
    if (value !== undefined) output[key] = value
  }
  return output
}

function textOnly(content: unknown): { text: string; images: number } {
  if (typeof content === 'string') {
    const images = content.match(DATA_IMAGE_RE)?.length ?? 0
    return { text: content.replace(DATA_IMAGE_RE, '[image omitted]'), images }
  }
  if (!Array.isArray(content)) return { text: '', images: 0 }
  const text: string[] = []
  let images = 0
  for (const part of content) {
    if (!part || typeof part !== 'object') continue
    const candidate = part as { type?: unknown; text?: unknown }
    if (candidate.type === 'image') { images++; continue }
    if (candidate.type === 'text' && typeof candidate.text === 'string') text.push(candidate.text)
  }
  return { text: text.join(''), images }
}

function kindOf(message: WorkingContextMessage): string {
  return `${typeof message.kind === 'string' ? message.kind : ''} ${typeof message.type === 'string' ? message.type : ''}`.toLowerCase()
}

function classify(message: WorkingContextMessage): { metadata: Record<string, Scalar>; approval: boolean; precondition: boolean; structured: boolean } {
  const metadata = safeMetadata(message)
  const kind = kindOf(message)
  const approval = metadata.approval !== undefined || metadata.approved !== undefined || /approval|permission/u.test(kind)
  const precondition = metadata.precondition !== undefined || metadata.before_sha256 !== undefined || metadata.after_sha256 !== undefined || /precondition|before[_-]?sha|after[_-]?sha/u.test(kind)
  const structured = metadata.structuredObservation === true || /observation|finding|snapshot/u.test(kind)
  if (structured) metadata.structuredObservation = true
  return { metadata, approval, precondition, structured }
}

interface Candidate {
  index: number
  message: WorkingContextMessage
  content: string
  images: number
  approval: boolean
  precondition: boolean
  structured: boolean
  tool: boolean
  required: boolean
  priority: number
  metadata: Record<string, Scalar>
}

function safeToolCalls(message: WorkingContextMessage): readonly { id: string; name: string }[] | undefined {
  if (!Array.isArray(message.tool_calls)) return undefined
  const calls: Array<{ id: string; name: string }> = []
  for (const value of message.tool_calls) {
    if (!value || typeof value !== 'object') continue
    const call = value as { id?: unknown; function?: { name?: unknown } }
    const id = typeof call.id === 'string' ? call.id.slice(0, 80) : ''
    const name = typeof call.function?.name === 'string' ? call.function.name.slice(0, 120) : ''
    if (id || name) calls.push({ id, name })
  }
  return calls.length > 0 ? calls : undefined
}

function toSafeMessage(candidate: Candidate, content: string): SafeWorkingContextMessage {
  const toolCalls = safeToolCalls(candidate.message)
  return {
    role: candidate.message.role ?? 'assistant',
    content,
    ...(typeof candidate.message.name === 'string' ? { name: candidate.message.name.slice(0, 120) } : {}),
    ...(typeof candidate.message.tool_call_id === 'string' ? { tool_call_id: candidate.message.tool_call_id.slice(0, 120) } : {}),
    ...(toolCalls ? { tool_calls: toolCalls } : {}),
    ...(Object.keys(candidate.metadata).length > 0 ? { metadata: { ...candidate.metadata } } : {})
  }
}

function messageTokens(message: SafeWorkingContextMessage): number {
  return Math.max(1, Math.ceil(JSON.stringify(message).length / 4))
}

function truncate(text: string, chars: number): string {
  if (text.length <= chars) return text
  if (chars <= 1) return text.slice(0, chars)
  const head = Math.ceil(chars * 0.7)
  return `${text.slice(0, head)}…${text.slice(-(chars - head - 1))}`
}

function positiveInteger(value: number, label: string, max: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) throw new RangeError(`${label} must be an integer between 0 and ${max}`)
}

/** Remove stale reasoning/results/images while retaining the latest request and state essentials. */
export function pruneWorkingContext(messages: readonly WorkingContextMessage[], options: PruneWorkingContextOptions = {}): PrunedWorkingContext {
  const maxContextTokens = options.maxContextTokens ?? DEFAULT_MAX_CONTEXT_TOKENS
  if (!Number.isSafeInteger(maxContextTokens) || maxContextTokens <= 0 || maxContextTokens > DEFAULT_MAX_CONTEXT_TOKENS) throw new RangeError('maxContextTokens must be an integer between 1 and 4096')
  const reservedVisualTokens = options.reservedVisualTokens ?? DEFAULT_RESERVED_VISUAL_TOKENS
  if (reservedVisualTokens > (VISION_TOKEN_BUDGETS.at(-1) as number)) throw new RangeError('reservedVisualTokens exceeds the supported 4K visual tier')
  positiveInteger(reservedVisualTokens, 'reservedVisualTokens', VISION_TOKEN_BUDGETS.at(-1) as number)
  if (reservedVisualTokens > maxContextTokens) throw new RangeError('reservedVisualTokens cannot exceed maxContextTokens')
  const availableTextTokens = maxContextTokens - reservedVisualTokens
  const maxTextTokens = options.maxTextTokens ?? availableTextTokens
  positiveInteger(maxTextTokens, 'maxTextTokens', availableTextTokens)
  const maxToolResultChars = options.maxToolResultChars ?? 1600
  const maxMessageChars = options.maxMessageChars ?? 4000
  const keepRecentMessages = options.keepRecentMessages ?? 6
  positiveInteger(maxToolResultChars, 'maxToolResultChars', 100_000)
  positiveInteger(maxMessageChars, 'maxMessageChars', 100_000)
  positiveInteger(keepRecentMessages, 'keepRecentMessages', 1000)

  let latestUserIndex = -1
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]?.role === 'user') { latestUserIndex = index; break }
  }
  const candidates: Candidate[] = []
  let reasoningDropped = 0
  let imageCount = options.ephemeralContent && Array.isArray(options.ephemeralContent)
    ? options.ephemeralContent.filter((part) => part.type === 'image').length
    : 0
  let largeToolResults = 0
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]
    const kind = kindOf(message)
    const extracted = textOnly(message.content)
    imageCount += extracted.images
    const reasoning = /reasoning|analysis|thought|<think>/u.test(kind) || (message.role === 'assistant' && /<think>|<analysis>/iu.test(extracted.text))
    if (reasoning) { reasoningDropped++; continue }
    const classified = classify(message)
    const tool = message.role === 'tool' || typeof message.tool_call_id === 'string' || Array.isArray(message.tool_calls)
    const latestUser = index === latestUserIndex && message.role === 'user'
    const required = latestUser || tool || classified.approval || classified.precondition || classified.structured
    if (tool && extracted.text.length > maxToolResultChars) largeToolResults++
    const content = tool && extracted.text.length > maxToolResultChars
      ? `[large tool result omitted (${extracted.text.length} chars)]`
      : extracted.text
    candidates.push({
      index,
      message,
      content,
      images: extracted.images,
      approval: classified.approval,
      precondition: classified.precondition,
      structured: classified.structured,
      tool,
      required,
      priority: latestUser ? 0 : (classified.approval || classified.precondition || classified.structured ? 1 : (tool ? 2 : (message.role === 'system' ? 3 : 4))),
      metadata: classified.metadata
    })
  }

  const selected = new Map<number, Candidate>()
  for (const candidate of candidates.filter((item) => item.required)) selected.set(candidate.index, candidate)
  for (const candidate of candidates.filter((item) => !item.required).slice(-keepRecentMessages)) selected.set(candidate.index, candidate)
  const ordered = [...selected.values()].sort((a, b) => a.index - b.index)
  const allocation = [...ordered].sort((a, b) => a.priority - b.priority || a.index - b.index)
  const output = new Map<number, SafeWorkingContextMessage>()
  let estimatedTextTokens = 0
  for (const candidate of allocation) {
    const cap = candidate.tool ? maxToolResultChars : maxMessageChars
    let content = truncate(candidate.content, cap)
    let safe = toSafeMessage(candidate, content)
    const remaining = maxTextTokens - estimatedTextTokens
    if (messageTokens(safe) > remaining) {
      let low = 0
      let high = content.length
      let best = ''
      while (low <= high) {
        const middle = Math.floor((low + high) / 2)
        const attempt = toSafeMessage(candidate, truncate(content, middle))
        if (messageTokens(attempt) <= remaining) { best = truncate(content, middle); low = middle + 1 } else high = middle - 1
      }
      content = best
      safe = toSafeMessage(candidate, content)
    }
    const tokens = messageTokens(safe)
    if (tokens > remaining) {
      if (candidate.required) throw new RangeError('required working-context state exceeds the available 4K text budget')
      continue
    }
    output.set(candidate.index, safe)
    estimatedTextTokens += tokens
  }

  const resultMessages = ordered.filter((candidate) => output.has(candidate.index)).map((candidate) => output.get(candidate.index) as SafeWorkingContextMessage)
  const droppedOldMessages = candidates.filter((candidate) => !selected.has(candidate.index)).length + ordered.filter((candidate) => !output.has(candidate.index)).length
  const retained = {
    latestUserRequest: latestUserIndex >= 0 && output.has(latestUserIndex),
    structuredObservations: resultMessages.filter((message) => message.metadata?.structuredObservation === true).length,
    toolEssentials: resultMessages.filter((message) => message.role === 'tool' || message.tool_call_id !== undefined || message.tool_calls !== undefined).length,
    approvalEssentials: resultMessages.filter((message) => message.metadata?.approval !== undefined || message.metadata?.approved !== undefined).length,
    preconditionEssentials: resultMessages.filter((message) => message.metadata?.precondition !== undefined || message.metadata?.before_sha256 !== undefined || message.metadata?.after_sha256 !== undefined).length
  }
  return {
    messages: resultMessages,
    workingContext: resultMessages,
    maxContextTokens,
    reservedVisualTokens,
    maxTextTokens,
    estimatedTextTokens,
    estimatedContextTokens: estimatedTextTokens + reservedVisualTokens,
    withinBudget: estimatedTextTokens + reservedVisualTokens <= maxContextTokens,
    dropped: { reasoning: reasoningDropped, largeToolResults, images: imageCount, oldImages: imageCount, oldMessages: droppedOldMessages },
    retained
  }
}
