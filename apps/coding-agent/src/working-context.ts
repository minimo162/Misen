/** Model-only context projection. Complete session/audit history stays with the caller. */
export interface ModelMessageLike {
  role: string
  content?: unknown
  [key: string]: unknown
}

export interface WorkingContextOptions {
  keepRecentMessages?: number
  keepRecentToolPairs?: number
  maxToolResultBytes?: number
}

export interface WorkingContextTelemetry {
  inputMessages: number
  outputMessages: number
  inputBytes: number
  outputBytes: number
  dropped: {
    reasoning: number
    images: number
    oldMessages: number
    toolPairs: number
    orphanToolCalls: number
    orphanToolResults: number
    cappedToolResults: number
  }
  reasons: Record<string, number>
}

export interface ModelWorkingContextResult {
  messages: ModelMessageLike[]
  telemetry: WorkingContextTelemetry
}

export interface CappedToolResult {
  content: string
  chunks: readonly string[]
  originalBytes: number
  retainedBytes: number
  omittedBytes: number
  truncated: boolean
  format: 'text' | 'json'
}

export const DEFAULT_TOOL_RESULT_BYTES = 4096
export const DEFAULT_KEEP_RECENT_MESSAGES = 6
export const DEFAULT_KEEP_RECENT_TOOL_PAIRS = 3
export const TRUNCATION_MARKER = 'tool-result-truncated'

const encoder = new TextEncoder()
const SECRET_FACT_KEY = /(?:secret|token|password|passwd|api[_-]?key|authorization|cookie|credential|base64|image|screenshot|reasoning|thought|analysis)/iu
const SAFE_FACT_KEYS = [
  'status', 'outcome', 'success', 'approved', 'approval', 'permission',
  'precondition', 'before_sha256', 'after_sha256', 'beforeHash', 'afterHash',
  'path', 'exitCode', 'exit_code', 'changed', 'error'
] as const

function bytes(value: string): number {
  return encoder.encode(value).byteLength
}

function utf8Prefix(value: string, maxBytes: number): string {
  let size = 0
  let output = ''
  for (const character of Array.from(value)) {
    const next = bytes(character)
    if (size + next > maxBytes) break
    output += character
    size += next
  }
  return output
}

function assertByteLimit(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 128) throw new RangeError(`${name} must be an integer of at least 128 bytes`)
}

function parseJson(value: string): unknown {
  try { return JSON.parse(value) as unknown } catch { return undefined }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function safeScalar(value: unknown): string | number | boolean | null | undefined {
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') return value.slice(0, 160)
  return undefined
}

function jsonFacts(value: unknown): { facts: Record<string, string | number | boolean | null>; keys: string[] } {
  const record = asRecord(value)
  const facts: Record<string, string | number | boolean | null> = {}
  if (record) {
    for (const key of SAFE_FACT_KEYS) {
      const fact = safeScalar(record[key])
      if (fact !== undefined) facts[key] = fact
    }
  }
  return {
    facts,
    keys: record ? Object.keys(record).filter((key) => !SECRET_FACT_KEY.test(key)).slice(0, 24) : []
  }
}

function boundedJsonEnvelope(parsed: unknown, originalBytes: number, maxBytes: number): string {
  const summary = jsonFacts(parsed)
  const candidates: unknown[] = [
    { truncated: true, marker: TRUNCATION_MARKER, originalBytes, summary },
    { truncated: true, marker: TRUNCATION_MARKER, originalBytes, summary: { facts: summary.facts } },
    { truncated: true, marker: TRUNCATION_MARKER, originalBytes }
  ]
  for (const candidate of candidates) {
    const serialized = JSON.stringify(candidate)
    if (bytes(serialized) <= maxBytes) return serialized
  }
  throw new RangeError('maxBytes is too small for a valid JSON truncation envelope')
}

function textChunks(value: string, maxBytes: number): string[] {
  const chunks: string[] = []
  let rest = value
  while (rest.length > 0) {
    const chunk = utf8Prefix(rest, maxBytes)
    if (!chunk) break
    chunks.push(chunk)
    rest = rest.slice(chunk.length)
  }
  return chunks.length ? chunks : ['']
}

/** Cap one model-visible result without splitting its tool-result protocol pair. */
export function capToolResultForModel(value: unknown, options: { maxBytes?: number; chunkBytes?: number } = {}): CappedToolResult {
  const maxBytes = options.maxBytes ?? DEFAULT_TOOL_RESULT_BYTES
  const chunkBytes = options.chunkBytes ?? maxBytes
  assertByteLimit(maxBytes, 'maxBytes')
  assertByteLimit(chunkBytes, 'chunkBytes')
  const original = typeof value === 'string' ? value : JSON.stringify(value)
  const originalBytes = bytes(original)
  const parsed = parseJson(original)
  const format: 'text' | 'json' = parsed === undefined ? 'text' : 'json'
  if (originalBytes <= maxBytes) {
    return { content: original, chunks: [original], originalBytes, retainedBytes: originalBytes, omittedBytes: 0, truncated: false, format }
  }
  const content = format === 'json'
    ? boundedJsonEnvelope(parsed, originalBytes, maxBytes)
    : (() => {
        const marker = `\n[${TRUNCATION_MARKER}; originalBytes=${originalBytes}]`
        return `${utf8Prefix(original, Math.max(0, maxBytes - bytes(marker)))}${marker}`
      })()
  const chunks = textChunks(original, chunkBytes)
  const retainedBytes = bytes(content)
  return { content, chunks, originalBytes, retainedBytes, omittedBytes: Math.max(0, originalBytes - retainedBytes), truncated: true, format }
}

type Normalized = {
  index: number
  message: ModelMessageLike
  callIds: string[]
  resultIds: string[]
  isTool: boolean
  isUser: boolean
  reasoningParts: number
  imageParts: number
}

function parts(content: unknown): Array<Record<string, unknown>> {
  return Array.isArray(content)
    ? content.filter((part): part is Record<string, unknown> => part !== null && typeof part === 'object')
    : []
}

function normalized(message: ModelMessageLike, index: number): Normalized {
  const contentParts = parts(message.content)
  const callIds = contentParts.filter((part) => part.type === 'tool-call' && typeof part.toolCallId === 'string').map((part) => part.toolCallId as string)
  const resultIds = contentParts.filter((part) => part.type === 'tool-result' && typeof part.toolCallId === 'string').map((part) => part.toolCallId as string)
  return {
    index,
    message,
    callIds,
    resultIds,
    isTool: message.role === 'tool' || resultIds.length > 0,
    isUser: message.role === 'user',
    reasoningParts: contentParts.filter((part) => part.type === 'reasoning' || part.type === 'analysis').length,
    imageParts: contentParts.filter((part) => part.type === 'image').length
  }
}

function sanitizedMessage(item: Normalized, maxToolResultBytes: number, matchedToolCallIds: ReadonlySet<string>): { message: ModelMessageLike; reasoning: number; images: number; capped: number } {
  if (!Array.isArray(item.message.content)) return { message: { ...item.message }, reasoning: 0, images: 0, capped: 0 }
  let capped = 0
  const content = parts(item.message.content).flatMap((part) => {
    if (part.type === 'reasoning' || part.type === 'analysis' || part.type === 'image') return []
    if ((part.type === 'tool-call' || part.type === 'tool-result') &&
        (typeof part.toolCallId !== 'string' || !matchedToolCallIds.has(part.toolCallId))) return []
    if (part.type !== 'tool-result') return [{ ...part }]
    const output = asRecord(part.output)
    const raw = output?.type === 'text' ? output.value : (part.output ?? '')
    const result = capProtocolSafeToolResult(raw, maxToolResultBytes)
    if (result.truncated) capped++
    return [{ ...part, output: { type: 'text', value: result.content } }]
  })
  return { message: { ...item.message, content }, reasoning: item.reasoningParts, images: item.imageParts, capped }
}

const HOST_RESULT_BEGIN = '[BEGIN_UNTRUSTED_HOST_RESULT]'
const HOST_RESULT_END = '[END_UNTRUSTED_HOST_RESULT]'

function parseHostResult(value: string): Record<string, unknown> | undefined {
  const prefix = `${HOST_RESULT_BEGIN}\n`
  const suffix = `\n${HOST_RESULT_END}`
  if (!value.startsWith(prefix) || !value.endsWith(suffix)) return undefined
  return asRecord(parseJson(value.slice(prefix.length, -suffix.length)))
}

function serializeHostResult(payload: Record<string, unknown>): string {
  return `${HOST_RESULT_BEGIN}\n${JSON.stringify(payload)}\n${HOST_RESULT_END}`
}

/** Cap the untrusted data field while keeping the sentinel and JSON envelope intact. */
function capProtocolSafeToolResult(value: unknown, maxBytes: number): CappedToolResult {
  const raw = typeof value === 'string' ? value : JSON.stringify(value)
  const payload = parseHostResult(raw)
  if (!payload || bytes(raw) <= maxBytes) return capToolResultForModel(raw, { maxBytes })

  const data = asRecord(payload.data)
  const summary = typeof data?.summary === 'string' ? data.summary : ''
  let low = 128
  let high = Math.max(128, maxBytes)
  let best: string | undefined
  while (low <= high) {
    const budget = Math.floor((low + high) / 2)
    const cappedSummary = capToolResultForModel(summary, { maxBytes: budget }).content
    const candidate = serializeHostResult({
      ...payload,
      data: { ...(data ?? {}), summary: cappedSummary },
      truncation: { ...(asRecord(payload.truncation) ?? {}), truncated: true }
    })
    if (bytes(candidate) <= maxBytes) {
      best = candidate
      low = budget + 1
    } else {
      high = budget - 1
    }
  }
  if (!best) {
    const minimal = serializeHostResult({
      kind: payload.kind ?? 'host_result',
      schemaVersion: payload.schemaVersion ?? '1',
      ...(typeof payload.runId === 'string' ? { runId: payload.runId } : {}),
      ...(typeof payload.callId === 'string' ? { callId: payload.callId } : {}),
      tool: payload.tool ?? 'host.unknown',
      status: payload.status ?? 'failed',
      data: { summary: `[${TRUNCATION_MARKER}]` },
      sideEffectState: payload.sideEffectState ?? 'unknown',
      truncation: { truncated: true },
      security: { contentIsUntrusted: true }
    })
    if (bytes(minimal) > maxBytes) throw new RangeError('maxToolResultBytes is too small for the host-result protocol envelope')
    best = minimal
  }
  return {
    content: best,
    chunks: [best],
    originalBytes: bytes(raw),
    retainedBytes: bytes(best),
    omittedBytes: Math.max(0, bytes(raw) - bytes(best)),
    truncated: true,
    format: 'json'
  }
}

/** Keep recent tool call/result units atomically and discard stale explanatory turns. */
export function buildModelWorkingContext(history: readonly ModelMessageLike[], options: WorkingContextOptions = {}): ModelWorkingContextResult {
  const keepRecentMessages = options.keepRecentMessages ?? DEFAULT_KEEP_RECENT_MESSAGES
  const keepRecentToolPairs = options.keepRecentToolPairs ?? DEFAULT_KEEP_RECENT_TOOL_PAIRS
  const maxToolResultBytes = options.maxToolResultBytes ?? DEFAULT_TOOL_RESULT_BYTES
  if (!Number.isSafeInteger(keepRecentMessages) || keepRecentMessages < 1) throw new RangeError('keepRecentMessages must be a positive integer')
  if (!Number.isSafeInteger(keepRecentToolPairs) || keepRecentToolPairs < 0) throw new RangeError('keepRecentToolPairs must be a non-negative integer')
  assertByteLimit(maxToolResultBytes, 'maxToolResultBytes')

  const input = history.map(normalized)
  const resultOwner = new Map<string, number>()
  for (const item of input) for (const id of item.resultIds) resultOwner.set(id, item.index)
  const pairUnits: Array<{ indexes: number[]; last: number }> = []
  const paired = new Set<number>()
  const matchedToolCallIds = new Set<string>()
  for (const item of input) {
    if (!item.callIds.length) continue
    for (const id of item.callIds) {
      const resultIndex = resultOwner.get(id)
      if (resultIndex === undefined) continue
      matchedToolCallIds.add(id)
      const indexes = [item.index, resultIndex].sort((a, b) => a - b)
      indexes.forEach((value) => paired.add(value))
      pairUnits.push({ indexes, last: Math.max(...indexes) })
    }
  }
  const selected = new Set<number>()
  // Tool pairs may contain source facts, approval/precondition evidence, or a
  // prerequisite for a later action. Without a semantic proof that a pair is
  // stale, positional pruning is unsafe, so retain every complete pair.
  const retainedPairs = pairUnits
  for (const pair of retainedPairs) pair.indexes.forEach((index) => selected.add(index))
  for (const item of input) if (item.isUser || item.message.role === 'system') selected.add(item.index)
  const ordinary = input.filter((item) => !paired.has(item.index) && !item.isTool && !item.isUser && item.message.role !== 'system' && item.callIds.length === 0 && item.resultIds.length === 0)
  for (const item of ordinary.slice(-keepRecentMessages)) selected.add(item.index)

  let reasoning = 0
  let images = 0
  let capped = 0
  const output = input.filter((item) => selected.has(item.index)).map((item) => {
    const result = sanitizedMessage(item, maxToolResultBytes, matchedToolCallIds)
    reasoning += result.reasoning
    images += result.images
    capped += result.capped
    return result.message
  })
  const orphanToolCalls = input.reduce((count, item) => count + item.callIds.filter((id) => !matchedToolCallIds.has(id)).length, 0)
  const orphanToolResults = input.reduce((count, item) => count + item.resultIds.filter((id) => !matchedToolCallIds.has(id)).length, 0)
  const droppedToolPairs = 0
  const droppedMessages = history.length - output.length
  const reasons: Record<string, number> = {}
  if (droppedMessages) reasons.oldMessages = droppedMessages
  if (droppedToolPairs) reasons.toolPairs = droppedToolPairs
  if (orphanToolCalls || orphanToolResults) reasons.protocol = orphanToolCalls + orphanToolResults
  if (reasoning) reasons.reasoning = reasoning
  if (images) reasons.images = images
  if (capped) reasons.largeToolResults = capped
  return {
    messages: output,
    telemetry: {
      inputMessages: history.length,
      outputMessages: output.length,
      inputBytes: bytes(JSON.stringify(history)),
      outputBytes: bytes(JSON.stringify(output)),
      dropped: { reasoning, images, oldMessages: droppedMessages, toolPairs: droppedToolPairs, orphanToolCalls, orphanToolResults, cappedToolResults: capped },
      reasons
    }
  }
}
