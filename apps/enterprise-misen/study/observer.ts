import { basename } from 'node:path'
import { createHash } from 'node:crypto'
import type { AgentEvent } from '@earendil-works/pi-agent-core'
import type { AssistantMessage, Usage } from '@earendil-works/pi-ai'
import type { ValidationResult } from '../src/acceptance/validator.js'
import {
  FAILURE_TAXONOMIES,
  FROZEN_CONFIGURATION,
  STUDY_SCHEMA_VERSION,
  type FailureTaxonomy,
  type IntegrityObservation,
  type SafeToolEnd,
  type SafeToolStart,
  type StudyMonth,
  type StudyRunRecord,
  type UsageTotals,
} from './schema.js'

const MAX_ERROR_CHARS = 240
const VALIDATION_ERROR = /invalid|validation|schema|argument|must|required|bounded|dimensions|range|literal|formula|not allowed/iu

function bounded(value: unknown): string {
  let text: string
  try { text = value instanceof Error ? value.message : typeof value === 'string' ? value : JSON.stringify(value) || String(value) }
  catch { text = '[unserializable error metadata]' }
  return text
    .replace(/[\r\n\t]+/gu, ' ')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gu, '[REDACTED]')
    .replace(/\bBearer\s+\S+/giu, 'Bearer [REDACTED]')
    .replace(/\b(?:password|secret|token|api[_-]?key|authorization|cookie)\s*[:=]\s*\S+/giu, '[REDACTED]')
    .replace(/\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/gu, '[REDACTED]')
    .slice(0, MAX_ERROR_CHARS)
}

function errorText(result: unknown): string {
  if (result && typeof result === 'object') {
    const candidate = result as { error?: unknown; message?: unknown; content?: unknown }
    if (candidate.error !== undefined) return bounded(candidate.error)
    if (candidate.message !== undefined) return bounded(candidate.message)
    if (Array.isArray(candidate.content)) {
      const first = candidate.content.find(item => item && typeof item === 'object' && 'text' in item) as { text?: unknown } | undefined
      if (first?.text !== undefined) return bounded(first.text)
    }
  }
  return bounded(result)
}

function target(args: unknown): { target: Record<string, string | number | boolean>; valuesShape?: SafeToolStart['valuesShape'] } {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return { target: {} }
  const source = args as Record<string, unknown>
  const safe: Record<string, string | number | boolean> = {}
  for (const key of ['path', 'extension', 'workbook', 'sheet', 'range', 'source', 'output', 'offset', 'limit', 'overwrite']) {
    const value = source[key]
    if (typeof value === 'string') safe[key] = `sha256:${createHash('sha256').update(value).digest('hex').slice(0, 16)}`
    else if (typeof value === 'number' && Number.isFinite(value)) safe[key] = value
    else if (typeof value === 'boolean') safe[key] = value
  }
  if (!Array.isArray(source.values)) return { target: safe }
  const rows = source.values as unknown[]
  const columns = Array.isArray(rows[0]) ? rows[0].length : 0
  let formulas = 0, literals = 0
  for (const row of rows) for (const value of Array.isArray(row) ? row : []) {
    if (value && typeof value === 'object' && !Array.isArray(value) && typeof (value as { formula?: unknown }).formula === 'string') formulas++
    else literals++
  }
  return { target: safe, valuesShape: { rows: rows.length, columns, formulas, literals } }
}

function zeroUsage(): UsageTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: null, totalTokens: 0, catalogEstimatedCostUsd: null }
}

function addUsage(total: UsageTotals, usage: Usage): UsageTotals {
  return {
    input: total.input + usage.input,
    output: total.output + usage.output,
    cacheRead: total.cacheRead + usage.cacheRead,
    cacheWrite: total.cacheWrite + usage.cacheWrite,
    reasoning: usage.reasoning === undefined ? total.reasoning : (total.reasoning ?? 0) + usage.reasoning,
    totalTokens: total.totalTokens + usage.totalTokens,
    catalogEstimatedCostUsd: Number.isFinite(usage.cost.total)
      ? (total.catalogEstimatedCostUsd ?? 0) + usage.cost.total
      : total.catalogEstimatedCostUsd,
  }
}

export interface ObserverMetadata {
  readonly studyId: string
  readonly studyRunNumber: number
  readonly paidAttemptNumber: number
  readonly month: StudyMonth
  readonly productionBaselineSha: string
  readonly observerSha: string
  readonly startedAtUtc?: string
}

export interface FinalizeObservation {
  readonly validation: ValidationResult | null
  readonly outputBytes?: number
  readonly inputHashesUnchanged: boolean | null
  readonly elapsedMs: number
  readonly rssBytes: number
  readonly integrity: IntegrityObservation
  readonly agentErrorMessage?: string
  readonly acceptanceFatal?: string
  readonly invalidReason?: string
  readonly endedAtUtc?: string
}

export class StudyObserver {
  private readonly starts: SafeToolStart[] = []
  private readonly ends: SafeToolEnd[] = []
  private readonly providers = new Set<string>()
  private readonly models = new Set<string>()
  private readonly stopReasons: string[] = []
  private usage = zeroUsage()
  private requestCount = 0
  private sequence = 0
  private lifecycle = { agentStart: 0, agentEnd: 0, turnStart: 0, turnEnd: 0 }

  constructor(private readonly metadata: ObserverMetadata, private readonly now: () => string = () => new Date().toISOString()) {}

  observe(event: AgentEvent): void {
    if (event.type === 'agent_start') { this.lifecycle.agentStart++; return }
    if (event.type === 'agent_end') { this.lifecycle.agentEnd++; return }
    if (event.type === 'turn_start') { this.lifecycle.turnStart++; return }
    if (event.type === 'turn_end') { this.lifecycle.turnEnd++; return }
    if (event.type === 'tool_execution_start') {
      const safe = target(event.args)
      this.starts.push({ sequence: ++this.sequence, toolCallId: event.toolCallId, toolName: event.toolName, timestampUtc: this.now(), ...safe })
      return
    }
    if (event.type === 'tool_execution_end') {
      const message = event.isError ? errorText(event.result) : ''
      const validationError = event.isError && VALIDATION_ERROR.test(message)
      this.ends.push({
        sequence: ++this.sequence,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        timestampUtc: this.now(),
        isError: event.isError,
        validationError,
        ...(event.isError ? { error: { class: 'ToolError', code: null, message: validationError ? 'tool validation error' : 'tool execution error' } } : {}),
      })
      return
    }
    if (event.type !== 'message_end' || event.message.role !== 'assistant') return
    const message = event.message as AssistantMessage
    this.requestCount++
    this.providers.add(message.provider)
    this.models.add(message.model)
    this.stopReasons.push(message.stopReason)
    this.usage = addUsage(this.usage, message.usage)
  }

  finalize(input: FinalizeObservation): StudyRunRecord {
    const startsById = new Map(this.starts.map(item => [item.toolCallId, item]))
    const endsById = new Map(this.ends.map(item => [item.toolCallId, item]))
    const toolBalance = this.starts.length === this.ends.length
      && this.starts.every(item => endsById.has(item.toolCallId))
      && this.ends.every(item => startsById.has(item.toolCallId))
    const validationErrors = this.ends.filter(item => item.validationError)
    const recovered = (failure: SafeToolEnd): boolean => {
      const failedStart = startsById.get(failure.toolCallId)
      const signature = failedStart ? JSON.stringify(failedStart.target) : ''
      if (!failedStart || signature === '{}') return false
      return this.ends.some(success => {
        const successStart = startsById.get(success.toolCallId)
        return !success.isError && success.sequence > failure.sequence && success.toolName === failure.toolName
          && successStart !== undefined && JSON.stringify(successStart.target) === signature
      })
    }
    let selfCorrectionCount: number | null = 0
    for (const failure of validationErrors) {
      const failedStart = startsById.get(failure.toolCallId)
      const signature = failedStart ? JSON.stringify(failedStart.target) : ''
      if (!failedStart || signature === '{}') { selfCorrectionCount = null; break }
      if (recovered(failure) && selfCorrectionCount !== null) selfCorrectionCount++
    }
    const forbiddenCapability = input.integrity.forbiddenCapability
      || this.starts.some(item => !FROZEN_CONFIGURATION.tools.includes(item.toolName))
    const integrity = { ...input.integrity, forbiddenCapability }
    const providerFailure = this.stopReasons.includes('error') || Boolean(input.agentErrorMessage)
    const incompleteEvidence = this.requestCount === 0 || this.starts.length === 0 || !toolBalance
      || this.lifecycle.agentStart !== 1 || this.lifecycle.agentEnd !== 1
      || this.lifecycle.turnStart < 1 || this.lifecycle.turnStart !== this.lifecycle.turnEnd
    const configurationDrift = this.providers.size !== 1 || !this.providers.has(FROZEN_CONFIGURATION.provider)
      || this.models.size !== 1 || !this.models.has(FROZEN_CONFIGURATION.model)
    let taxonomy: FailureTaxonomy | null = null
    let failureSummary: string | null = null
    if (integrity.inputMutation === true || integrity.forbiddenCapability || integrity.credentialExposure || integrity.unexpectedNetwork) { taxonomy = 'SECURITY_OR_INTEGRITY'; failureSummary = 'integrity or security incident' }
    else if (input.invalidReason) { taxonomy = 'INVALID_OBSERVER_OR_INFRA'; failureSummary = 'observer or infrastructure failure' }
    else if (providerFailure) { taxonomy = 'PROVIDER_OR_TRANSPORT'; failureSummary = 'provider or transport error' }
    else if (input.acceptanceFatal) { taxonomy = 'ACCEPTANCE_FATAL'; failureSummary = 'acceptance evaluation failed' }
    else if (configurationDrift) { taxonomy = 'INVALID_OBSERVER_OR_INFRA'; failureSummary = 'observed provider or model differs from frozen configuration' }
    else if (incompleteEvidence) { taxonomy = 'INVALID_OBSERVER_OR_INFRA'; failureSummary = 'incomplete observer event stream' }
    else if (this.stopReasons.includes('length') || this.stopReasons.includes('aborted')) { taxonomy = 'AGENT_INCOMPLETE'; failureSummary = 'agent did not complete' }
    else if (this.ends.some(item => item.isError) && (!input.validation || !input.validation.passed)) { taxonomy = 'TOOL_CONTRACT_OR_VALIDATION'; failureSummary = 'Tool contract or validation error affected completion' }
    else if (input.validation && !input.validation.passed) { taxonomy = 'BUSINESS_SEMANTIC'; failureSummary = 'one or more business Acceptance axes failed' }
    if (taxonomy && !FAILURE_TAXONOMIES.includes(taxonomy)) throw new Error('unsupported failure taxonomy')
    const status = taxonomy === 'INVALID_OBSERVER_OR_INFRA' ? 'INVALID' : taxonomy === null ? 'PASS' : 'FAIL'
    return {
      schemaVersion: STUDY_SCHEMA_VERSION,
      ...this.metadata,
      configuration: FROZEN_CONFIGURATION,
      startedAtUtc: this.metadata.startedAtUtc ?? this.now(),
      endedAtUtc: input.endedAtUtc ?? this.now(),
      status,
      failureTaxonomy: taxonomy,
      failureSummary,
      axisMatrix: input.validation?.axes ?? null,
      output: input.validation && input.outputBytes !== undefined ? { basename: basename(input.validation.output), bytes: input.outputBytes } : null,
      inputHashesUnchanged: input.inputHashesUnchanged,
      toolStarts: this.starts,
      toolResults: this.ends,
      toolBalance,
      toolErrorCount: this.ends.filter(item => item.isError).length,
      toolValidationErrorCount: validationErrors.length,
      selfCorrectionCount,
      requestCount: this.requestCount,
      lifecycle: { ...this.lifecycle },
      assistantStopReasons: this.stopReasons,
      observedProviders: [...this.providers].sort(),
      observedModels: [...this.models].sort(),
      usage: this.usage,
      elapsedMs: Math.max(0, Math.round(input.elapsedMs)),
      rssBytes: input.rssBytes,
      integrity,
      invalidReason: input.invalidReason ? 'observer or infrastructure failure' : null,
    }
  }
}
