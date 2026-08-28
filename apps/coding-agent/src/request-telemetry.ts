/**
 * Secret-safe, provider-neutral request telemetry.
 *
 * This module deliberately accepts metadata rather than model messages,
 * prompts, tool arguments, or tool output.  Callers must reduce those values
 * to the small, typed metadata records below before starting a request.
 * Provider usage is copied only when the provider reports a non-negative
 * integer; missing fields remain null rather than being estimated.
 */

export const REQUEST_TELEMETRY_SCHEMA_VERSION = 'misen.request-telemetry/v1' as const

export type NullableTokenCount = number | null

/** Provider-reported values only.  Undefined and null both mean unknown. */
export interface ProviderReportedTokenUsage {
  readonly inputTokens?: number | null
  readonly outputTokens?: number | null
  readonly reasoningTokens?: number | null
  readonly cachedInputTokens?: number | null
}

export interface RequestTelemetryTokenUsage {
  readonly inputTokens: NullableTokenCount
  readonly outputTokens: NullableTokenCount
  readonly reasoningTokens: NullableTokenCount
  readonly cachedInputTokens: NullableTokenCount
}

/** The categories emitted by vision-budget's context pruner. */
export const PRUNING_REASON_CATEGORIES = [
  'reasoning',
  'largeToolResults',
  'images',
  'oldImages',
  'oldMessages',
  // Context-pruner implementations may report these more granular buckets.
  // They are labels only; no content may be attached to a reason.
  'assistant',
  'toolPairs',
  'toolResults',
  'protocol',
  'base64'
] as const

export type PruningReasonCategory = (typeof PRUNING_REASON_CATEGORIES)[number]

export type RequestTelemetryPruningReasons = Readonly<Record<PruningReasonCategory, number> & Record<string, number>>

export interface RequestTelemetryPruningSummary {
  readonly count: number
  readonly reasons: RequestTelemetryPruningReasons
}

export type ToolResultStatus = 'succeeded' | 'failed' | 'denied' | 'unknown'

/**
 * A tool definition reduced to names and parameter names.  Descriptions,
 * schemas, implementations, and arguments are intentionally not accepted.
 */
export interface RequestTelemetryToolDefinition {
  readonly name: string
  readonly parameterNames?: readonly string[]
  readonly parameterCount?: number
}

/**
 * A tool result reduced to scalar metadata.  `resultChars` is a caller-owned
 * count, not the result itself; this lets us size context without retaining
 * output, prompts, credentials, or image/base64 bytes.
 */
export interface RequestTelemetryToolResultContext {
  readonly toolName: string
  readonly status: ToolResultStatus
  readonly resultChars?: number | null
  readonly metadataKeys?: readonly string[]
}

export interface RequestTelemetryPruningInput {
  readonly count?: number
  readonly reasons?: Readonly<Partial<Record<PruningReasonCategory, number>> & Record<string, number | undefined>>
}

export interface RequestTelemetryBeginInput {
  readonly requestIndex: number
  readonly runId: string
  readonly provider: string
  readonly model: string
  readonly workingMessageCount: number
  readonly exposedToolDefs?: readonly RequestTelemetryToolDefinition[]
  /** Optional when definitions are unavailable; when present it must agree. */
  readonly exposedToolCount?: number
  /** Caller-computed UTF-8 approximation over a trusted, non-persisted schema. */
  readonly toolSchemaBytes?: number | null
  readonly toolResultContext?: readonly RequestTelemetryToolResultContext[]
  /** Caller-computed UTF-8 approximation over trusted result metadata. */
  readonly toolResultContextBytes?: number | null
  readonly pruning?: RequestTelemetryPruningInput
}

export interface RequestTelemetryRecord {
  readonly schemaVersion: typeof REQUEST_TELEMETRY_SCHEMA_VERSION
  readonly requestIndex: number
  readonly runId: string
  readonly provider: string
  readonly model: string
  readonly elapsedMs: number
  readonly tokenUsage: RequestTelemetryTokenUsage
  readonly workingMessageCount: number
  readonly exposedToolCount: number
  readonly toolSchemaBytes: number | null
  readonly toolResultContextBytes: number | null
  readonly pruning: RequestTelemetryPruningSummary
}

export interface RequestTelemetryCollectorOptions {
  /** A monotonic or deterministic clock returning milliseconds. */
  readonly now?: () => number
}

const IDENTIFIER_MAX_LENGTH = 256
const PARAMETER_MAX_COUNT = 256
const TOOL_MAX_COUNT = 256
const RESULT_CONTEXT_MAX_COUNT = 256
const METADATA_KEY_MAX_COUNT = 128
const MAX_SAFE_METADATA_STRING_LENGTH = 160

// Match a forbidden key when it is the key's leading semantic word.  Avoid a
// broad substring match: safe counters such as `workingMessageCount` and
// `outputTokens` must remain usable.
const FORBIDDEN_KEY_RE = /^(?:prompt|reason(?:ing)?|thought|analysis|chain[_-]?of[_-]?thought|credential|secret|password|passwd|api[_-]?key|authorization|cookie|image|base64|raw|message|content|completion|response|argument|input[_-]?text|output[_-]?text)(?:$|[_-])/iu
const FORBIDDEN_VALUE_RE = /(?:data:image\/[a-z0-9.+-]+;base64,|-----BEGIN [^-]+-----|(?:^|\b)(?:sk-[a-z0-9]|pk-[a-z0-9]|ghp_[a-z0-9]|github_pat_|xox[baprs]-|bearer\s+|AIza[0-9a-z_-]|(?:secret|credential|password|authorization)[_-]?))/iu
const CONTROL_RE = /[\u0000-\u001f\u007f]/u

function looksLikeEncodedBlob(value: string): boolean {
  if (value.length < 32 || !/^[A-Za-z0-9+/=_-]+$/u.test(value)) return false
  // UUIDs and hexadecimal hashes are useful non-secret identifiers in audit
  // metadata; they are not treated as encoded payloads here.
  if (/^[0-9a-f-]+$/iu.test(value)) return false
  if (value.includes('-')) return false
  // Identifiers in this API are short human-readable labels.  A long compact
  // base64/base64url value is therefore treated as a payload and rejected.
  return value.length >= 32
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function ownKeys(value: Record<string, unknown>): string[] {
  if (Object.getOwnPropertySymbols(value).length > 0) throw new TypeError('telemetry metadata cannot contain symbol keys')
  return Object.keys(value)
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowedSet = new Set(allowed)
  for (const key of ownKeys(value)) {
    if (!allowedSet.has(key) || FORBIDDEN_KEY_RE.test(key)) {
      throw new TypeError(`${label} contains an unsafe key: ${key}`)
    }
  }
}

function safeString(value: unknown, label: string, maxLength = IDENTIFIER_MAX_LENGTH): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw new TypeError(`${label} must be a non-empty bounded string`)
  }
  // `content`, `arguments`, and `reasoning_effort` are legitimate schema
  // identifiers. Raw values cannot enter because surrounding objects use
  // strict allowlists; secret-shaped/blob-like identifier values remain denied.
  if (CONTROL_RE.test(value) || FORBIDDEN_VALUE_RE.test(value) || looksLikeEncodedBlob(value)) {
    throw new TypeError(`${label} contains forbidden or secret-like content`)
  }
  return value
}

function safeMetadataKey(value: unknown, label: string): string {
  return safeString(value, label, MAX_SAFE_METADATA_STRING_LENGTH)
}

function safeCount(value: unknown, label: string, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > max) {
    throw new RangeError(`${label} must be a non-negative safe integer`)
  }
  return value as number
}

function safeElapsed(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new RangeError('elapsedMs must be a non-negative finite number')
  }
  return value
}

function safeToken(value: unknown, label: string): NullableTokenCount {
  if (value === undefined || value === null) return null
  return safeCount(value, label)
}

function safeTokenUsage(value: ProviderReportedTokenUsage | undefined): RequestTelemetryTokenUsage {
  if (value === undefined) {
    return { inputTokens: null, outputTokens: null, reasoningTokens: null, cachedInputTokens: null }
  }
  if (!isPlainObject(value)) throw new TypeError('provider usage must be a plain metadata object')
  rejectUnknownKeys(value, ['inputTokens', 'outputTokens', 'reasoningTokens', 'cachedInputTokens'], 'provider usage')
  return {
    inputTokens: safeToken(value.inputTokens, 'inputTokens'),
    outputTokens: safeToken(value.outputTokens, 'outputTokens'),
    reasoningTokens: safeToken(value.reasoningTokens, 'reasoningTokens'),
    cachedInputTokens: safeToken(value.cachedInputTokens, 'cachedInputTokens')
  }
}

function safeToolDefinition(value: RequestTelemetryToolDefinition, index: number): RequestTelemetryToolDefinition {
  if (!isPlainObject(value)) throw new TypeError(`exposedToolDefs[${index}] must be a plain metadata object`)
  rejectUnknownKeys(value, ['name', 'parameterNames', 'parameterCount'], `exposedToolDefs[${index}]`)
  const name = safeString(value.name, `exposedToolDefs[${index}].name`)
  let parameterNames: string[] | undefined
  if (value.parameterNames !== undefined) {
    if (!Array.isArray(value.parameterNames) || value.parameterNames.length > PARAMETER_MAX_COUNT) {
      throw new RangeError(`exposedToolDefs[${index}].parameterNames exceeds the safe bound`)
    }
    parameterNames = value.parameterNames.map((parameter, parameterIndex) =>
      safeMetadataKey(parameter, `exposedToolDefs[${index}].parameterNames[${parameterIndex}]`)
    )
    if (new Set(parameterNames).size !== parameterNames.length) {
      throw new TypeError(`exposedToolDefs[${index}].parameterNames must be unique`)
    }
  }
  const parameterCount = value.parameterCount === undefined
    ? parameterNames?.length
    : safeCount(value.parameterCount, `exposedToolDefs[${index}].parameterCount`, PARAMETER_MAX_COUNT)
  if (parameterNames !== undefined && parameterCount !== parameterNames.length) {
    throw new RangeError(`exposedToolDefs[${index}] parameterCount does not match parameterNames`)
  }
  return Object.freeze({
    name,
    ...(parameterNames !== undefined ? { parameterNames: Object.freeze(parameterNames.slice()) } : {}),
    ...(parameterCount !== undefined ? { parameterCount } : {})
  })
}

function safeToolDefinitions(value: readonly RequestTelemetryToolDefinition[] | undefined): RequestTelemetryToolDefinition[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > TOOL_MAX_COUNT) throw new RangeError('exposedToolDefs exceeds the safe bound')
  return value.map((item, index) => safeToolDefinition(item, index))
}

function safeResultContext(value: RequestTelemetryToolResultContext, index: number): RequestTelemetryToolResultContext {
  if (!isPlainObject(value)) throw new TypeError(`toolResultContext[${index}] must be a plain metadata object`)
  rejectUnknownKeys(value, ['toolName', 'status', 'resultChars', 'metadataKeys'], `toolResultContext[${index}]`)
  const toolName = safeString(value.toolName, `toolResultContext[${index}].toolName`)
  if (value.status !== 'succeeded' && value.status !== 'failed' && value.status !== 'denied' && value.status !== 'unknown') {
    throw new TypeError(`toolResultContext[${index}].status is not a supported status`)
  }
  const resultChars = value.resultChars === undefined || value.resultChars === null
    ? null
    : safeCount(value.resultChars, `toolResultContext[${index}].resultChars`, Number.MAX_SAFE_INTEGER)
  let metadataKeys: string[] | undefined
  if (value.metadataKeys !== undefined) {
    if (!Array.isArray(value.metadataKeys) || value.metadataKeys.length > METADATA_KEY_MAX_COUNT) {
      throw new RangeError(`toolResultContext[${index}].metadataKeys exceeds the safe bound`)
    }
    metadataKeys = value.metadataKeys.map((key, keyIndex) => safeMetadataKey(key, `toolResultContext[${index}].metadataKeys[${keyIndex}]`))
    if (new Set(metadataKeys).size !== metadataKeys.length) {
      throw new TypeError(`toolResultContext[${index}].metadataKeys must be unique`)
    }
  }
  return Object.freeze({
    toolName,
    status: value.status,
    resultChars,
    ...(metadataKeys !== undefined ? { metadataKeys: Object.freeze(metadataKeys.slice()) } : {})
  })
}

function safeResultContexts(value: readonly RequestTelemetryToolResultContext[] | undefined): RequestTelemetryToolResultContext[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > RESULT_CONTEXT_MAX_COUNT) throw new RangeError('toolResultContext exceeds the safe bound')
  return value.map((item, index) => safeResultContext(item, index))
}

function zeroPruningReasons(): Record<PruningReasonCategory, number> {
  return {
    reasoning: 0,
    largeToolResults: 0,
    images: 0,
    oldImages: 0,
    oldMessages: 0,
    assistant: 0,
    toolPairs: 0,
    toolResults: 0,
    protocol: 0,
    base64: 0
  }
}

const PRUNING_REASON_SET = new Set<string>(PRUNING_REASON_CATEGORIES)
const PRUNING_REASON_KEY_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u

function safePruningReasonKey(value: string): string {
  if (!PRUNING_REASON_KEY_RE.test(value) || (FORBIDDEN_KEY_RE.test(value) && !PRUNING_REASON_SET.has(value))) {
    throw new TypeError(`pruning.reasons contains an unsafe category: ${value}`)
  }
  return value
}

function safePruning(value: RequestTelemetryPruningInput | undefined): RequestTelemetryPruningSummary {
  if (value === undefined) return Object.freeze({ count: 0, reasons: Object.freeze(zeroPruningReasons()) as RequestTelemetryPruningReasons })
  if (!isPlainObject(value)) throw new TypeError('pruning must be a plain metadata object')
  rejectUnknownKeys(value, ['count', 'reasons'], 'pruning')
  const reasons: Record<string, number> = zeroPruningReasons()
  if (value.reasons !== undefined) {
    if (!isPlainObject(value.reasons)) throw new TypeError('pruning.reasons must be a plain metadata object')
    for (const key of ownKeys(value.reasons)) {
      const reason = safePruningReasonKey(key)
      const count = safeCount(value.reasons[key], `pruning.reasons.${reason}`)
      reasons[reason] = count
    }
  }
  const calculatedCount = Object.values(reasons).reduce((sum, count) => sum + count, 0)
  const count = value.count === undefined ? calculatedCount : safeCount(value.count, 'pruning.count')
  if (count !== calculatedCount) throw new RangeError('pruning.count must equal the sum of pruning.reasons')
  return Object.freeze({ count, reasons: Object.freeze(reasons) as RequestTelemetryPruningReasons })
}

function utf8Bytes(value: unknown): number {
  const serialized = JSON.stringify(value)
  if (serialized === undefined) throw new TypeError('telemetry metadata is not JSON serializable')
  return new TextEncoder().encode(serialized).byteLength
}

/** Deterministic UTF-8 byte size for already-sanitized tool schema metadata. */
export function approximateToolSchemaBytes(definitions: readonly RequestTelemetryToolDefinition[]): number {
  const sanitized = safeToolDefinitions(definitions)
  return utf8Bytes(sanitized?.map((definition) => ({
    name: definition.name,
    ...(definition.parameterNames !== undefined ? { parameterNames: [...definition.parameterNames] } : {}),
    ...(definition.parameterCount !== undefined ? { parameterCount: definition.parameterCount } : {})
  })) ?? [])
}

/** Deterministic UTF-8 byte size for already-sanitized result metadata. */
export function approximateToolResultContextBytes(context: readonly RequestTelemetryToolResultContext[]): number {
  const sanitized = safeResultContexts(context)
  return utf8Bytes(sanitized?.map((result) => ({
    toolName: result.toolName,
    status: result.status,
    resultChars: result.resultChars,
    ...(result.metadataKeys !== undefined ? { metadataKeys: [...result.metadataKeys] } : {})
  })) ?? [])
}

function safeBeginInput(input: RequestTelemetryBeginInput): {
  input: RequestTelemetryBeginInput
  toolDefs: RequestTelemetryToolDefinition[] | undefined
  resultContext: RequestTelemetryToolResultContext[] | undefined
  toolSchemaBytes: number | null | undefined
  toolResultContextBytes: number | null | undefined
  pruning: RequestTelemetryPruningSummary
} {
  if (!isPlainObject(input)) throw new TypeError('request telemetry input must be a plain metadata object')
  rejectUnknownKeys(input, ['requestIndex', 'runId', 'provider', 'model', 'workingMessageCount', 'exposedToolDefs', 'exposedToolCount', 'toolSchemaBytes', 'toolResultContext', 'toolResultContextBytes', 'pruning'], 'request telemetry input')
  const requestIndex = safeCount(input.requestIndex, 'requestIndex')
  const runId = safeString(input.runId, 'runId')
  const provider = safeString(input.provider, 'provider')
  const model = safeString(input.model, 'model')
  const workingMessageCount = safeCount(input.workingMessageCount, 'workingMessageCount')
  const toolDefs = safeToolDefinitions(input.exposedToolDefs)
  const resultContext = safeResultContexts(input.toolResultContext)
  const exposedToolCount = input.exposedToolCount === undefined
    ? (toolDefs?.length ?? 0)
    : safeCount(input.exposedToolCount, 'exposedToolCount', TOOL_MAX_COUNT)
  if (toolDefs !== undefined && exposedToolCount !== toolDefs.length) {
    throw new RangeError('exposedToolCount must equal exposedToolDefs.length')
  }
  const toolSchemaBytes = input.toolSchemaBytes === undefined || input.toolSchemaBytes === null
    ? input.toolSchemaBytes
    : safeCount(input.toolSchemaBytes, 'toolSchemaBytes')
  const toolResultContextBytes = input.toolResultContextBytes === undefined || input.toolResultContextBytes === null
    ? input.toolResultContextBytes
    : safeCount(input.toolResultContextBytes, 'toolResultContextBytes')
  const pruning = safePruning(input.pruning)
  return {
    input: Object.freeze({ requestIndex, runId, provider, model, workingMessageCount, exposedToolCount, toolSchemaBytes, toolResultContextBytes }),
    toolDefs,
    resultContext,
    toolSchemaBytes,
    toolResultContextBytes,
    pruning
  }
}

function safeClock(now: () => number): number {
  const value = now()
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new RangeError('telemetry clock must return a finite number')
  return value
}

function freezeRecord(record: RequestTelemetryRecord): RequestTelemetryRecord {
  return Object.freeze({
    ...record,
    tokenUsage: Object.freeze({ ...record.tokenUsage }),
    pruning: Object.freeze({ count: record.pruning.count, reasons: Object.freeze({ ...record.pruning.reasons }) })
  })
}

export interface RequestTelemetryRequest {
  readonly finish: (usage?: ProviderReportedTokenUsage) => RequestTelemetryRecord
}

export class RequestTelemetryCollector {
  readonly #now: () => number
  readonly #records: RequestTelemetryRecord[] = []

  constructor(options: RequestTelemetryCollectorOptions = {}) {
    this.#now = options.now ?? (() => Date.now())
  }

  /** Start one model request; no input or raw content is retained. */
  beginRequest(input: RequestTelemetryBeginInput): RequestTelemetryRequest {
    const safe = safeBeginInput(input)
    const startedAt = safeClock(this.#now)
    let finished = false
    const finish = (usage?: ProviderReportedTokenUsage): RequestTelemetryRecord => {
      if (finished) throw new Error('request telemetry cannot be finished twice')
      const tokenUsage = safeTokenUsage(usage)
      const elapsedMs = safeElapsed(Math.max(0, safeClock(this.#now) - startedAt))
      const record = freezeRecord({
        schemaVersion: REQUEST_TELEMETRY_SCHEMA_VERSION,
        requestIndex: safe.input.requestIndex,
        runId: safe.input.runId,
        provider: safe.input.provider,
        model: safe.input.model,
        elapsedMs,
        tokenUsage,
        workingMessageCount: safe.input.workingMessageCount,
        exposedToolCount: safe.input.exposedToolCount ?? (safe.toolDefs?.length ?? 0),
        toolSchemaBytes: safe.toolSchemaBytes !== undefined
          ? safe.toolSchemaBytes
          : safe.toolDefs === undefined ? null : approximateToolSchemaBytes(safe.toolDefs),
        toolResultContextBytes: safe.toolResultContextBytes !== undefined
          ? safe.toolResultContextBytes
          : safe.resultContext === undefined ? null : approximateToolResultContextBytes(safe.resultContext),
        pruning: safe.pruning
      })
      finished = true
      this.#records.push(record)
      return record
    }
    return Object.freeze({ finish })
  }

  /** Convenience for callers that do not need to retain a request handle. */
  finishRequest(request: RequestTelemetryRequest, usage?: ProviderReportedTokenUsage): RequestTelemetryRecord {
    if (!request || typeof request.finish !== 'function') throw new TypeError('request handle is invalid')
    return request.finish(usage)
  }

  /** Read-only insertion-order snapshot; records are frozen at completion. */
  records(): readonly RequestTelemetryRecord[] {
    return this.#records.slice()
  }

  clear(): void {
    this.#records.length = 0
  }
}

export function createRequestTelemetryCollector(options: RequestTelemetryCollectorOptions = {}): RequestTelemetryCollector {
  return new RequestTelemetryCollector(options)
}

/** Build a record without a collector when an elapsed value is already known. */
export function createRequestTelemetryRecord(
  input: RequestTelemetryBeginInput & { readonly elapsedMs: number },
  usage?: ProviderReportedTokenUsage
): RequestTelemetryRecord {
  if (!isPlainObject(input)) throw new TypeError('request telemetry input must be a plain metadata object')
  // `elapsedMs` is a record-only field; do not let it leak into the begin
  // input contract (or permit beginRequest callers to smuggle it through).
  const { elapsedMs, ...beginInput } = input
  const safe = safeBeginInput(beginInput)
  const tokenUsage = safeTokenUsage(usage)
  return freezeRecord({
    schemaVersion: REQUEST_TELEMETRY_SCHEMA_VERSION,
    requestIndex: safe.input.requestIndex,
    runId: safe.input.runId,
    provider: safe.input.provider,
    model: safe.input.model,
    elapsedMs: safeElapsed(elapsedMs),
    tokenUsage,
    workingMessageCount: safe.input.workingMessageCount,
    exposedToolCount: safe.input.exposedToolCount ?? (safe.toolDefs?.length ?? 0),
    toolSchemaBytes: safe.toolSchemaBytes !== undefined
      ? safe.toolSchemaBytes
      : safe.toolDefs === undefined ? null : approximateToolSchemaBytes(safe.toolDefs),
    toolResultContextBytes: safe.toolResultContextBytes !== undefined
      ? safe.toolResultContextBytes
      : safe.resultContext === undefined ? null : approximateToolResultContextBytes(safe.resultContext),
    pruning: safe.pruning
  })
}

/** Revalidate an event/artifact record before persistence. Unknown or content-like fields fail closed. */
export function parseRequestTelemetryRecord(value: unknown): RequestTelemetryRecord {
  if (!isPlainObject(value)) throw new TypeError('request telemetry record must be a plain metadata object')
  const requiredKeys = [
    'schemaVersion', 'requestIndex', 'runId', 'provider', 'model', 'elapsedMs',
    'tokenUsage', 'workingMessageCount', 'exposedToolCount', 'toolSchemaBytes',
    'toolResultContextBytes', 'pruning'
  ] as const
  rejectUnknownKeys(value, requiredKeys, 'request telemetry record')
  for (const key of requiredKeys) if (!Object.hasOwn(value, key)) throw new TypeError(`request telemetry record is missing ${key}`)
  if (value.schemaVersion !== REQUEST_TELEMETRY_SCHEMA_VERSION) throw new TypeError('request telemetry schemaVersion is unsupported')
  const nullableCount = (candidate: unknown, label: string): number | null => candidate === null ? null : safeCount(candidate, label)
  return freezeRecord({
    schemaVersion: REQUEST_TELEMETRY_SCHEMA_VERSION,
    requestIndex: safeCount(value.requestIndex, 'requestIndex'),
    runId: safeString(value.runId, 'runId'),
    provider: safeString(value.provider, 'provider'),
    model: safeString(value.model, 'model'),
    elapsedMs: safeElapsed(value.elapsedMs),
    tokenUsage: safeTokenUsage(value.tokenUsage as ProviderReportedTokenUsage),
    workingMessageCount: safeCount(value.workingMessageCount, 'workingMessageCount'),
    exposedToolCount: safeCount(value.exposedToolCount, 'exposedToolCount', TOOL_MAX_COUNT),
    toolSchemaBytes: nullableCount(value.toolSchemaBytes, 'toolSchemaBytes'),
    toolResultContextBytes: nullableCount(value.toolResultContextBytes, 'toolResultContextBytes'),
    pruning: safePruning(value.pruning as RequestTelemetryPruningInput)
  })
}
