import type { AxisName, AxisResult } from '../src/acceptance/validator.js'

export const PRODUCTION_BASELINE_SHA = '06804c5eb0c8f9e42322d66b11c2f5ae0153da69'
export const STUDY_SCHEMA_VERSION = 1 as const
export const FAILURE_TAXONOMIES = [
  'BUSINESS_SEMANTIC',
  'TOOL_CONTRACT_OR_VALIDATION',
  'AGENT_INCOMPLETE',
  'PROVIDER_OR_TRANSPORT',
  'ACCEPTANCE_FATAL',
  'SECURITY_OR_INTEGRITY',
  'INVALID_OBSERVER_OR_INFRA',
] as const

export type FailureTaxonomy = typeof FAILURE_TAXONOMIES[number]
export type StudyMonth = '7月' | '8月'
export type StudyRunStatus = 'PASS' | 'FAIL' | 'INVALID'

export interface FrozenConfiguration {
  readonly runtime: 'pi-agent-core-0.84.4'
  readonly provider: 'openai'
  readonly model: 'gpt-5.6-luna'
  readonly reasoning: 'medium'
  readonly providerRetry: 0
  readonly fallback: null
  readonly tools: readonly string[]
}

export const FROZEN_CONFIGURATION: FrozenConfiguration = Object.freeze({
  runtime: 'pi-agent-core-0.84.4',
  provider: 'openai',
  model: 'gpt-5.6-luna',
  reasoning: 'medium',
  providerRetry: 0,
  fallback: null,
  tools: Object.freeze([
    'workspace_list_files',
    'workspace_read_text',
    'spreadsheet_read',
    'spreadsheet_create_output',
    'spreadsheet_update',
  ]),
})

export interface UsageTotals {
  readonly input: number
  readonly output: number
  readonly cacheRead: number
  readonly cacheWrite: number
  readonly reasoning: number | null
  readonly totalTokens: number
  readonly catalogEstimatedCostUsd: number | null
}

export interface SafeToolStart {
  readonly sequence: number
  readonly toolCallId: string
  readonly toolName: string
  readonly timestampUtc: string
  readonly target: Readonly<Record<string, string | number | boolean>>
  readonly valuesShape?: { readonly rows: number; readonly columns: number; readonly formulas: number; readonly literals: number }
}

export interface SafeToolEnd {
  readonly sequence: number
  readonly toolCallId: string
  readonly toolName: string
  readonly timestampUtc: string
  readonly isError: boolean
  readonly validationError: boolean
  readonly error?: { readonly class: string; readonly code: string | null; readonly message: string }
}

export interface IntegrityObservation {
  readonly inputMutation: boolean | null
  readonly forbiddenCapability: boolean
  readonly credentialExposure: boolean | null
  readonly unexpectedNetwork: boolean | null
}

export interface StudyRunRecord {
  readonly schemaVersion: typeof STUDY_SCHEMA_VERSION
  readonly studyId: string
  readonly studyRunNumber: number
  readonly paidAttemptNumber: number
  readonly month: StudyMonth
  readonly productionBaselineSha: string
  readonly observerSha: string
  readonly configuration: FrozenConfiguration
  readonly startedAtUtc: string
  readonly endedAtUtc: string
  readonly status: StudyRunStatus
  readonly failureTaxonomy: FailureTaxonomy | null
  readonly failureSummary: string | null
  readonly providerOrTransportErrorObserved: boolean
  readonly acceptanceFatalObserved: boolean
  readonly observerOrInfraErrorObserved: boolean
  readonly axisMatrix: Readonly<Record<AxisName, AxisResult>> | null
  readonly output: { readonly basename: string; readonly bytes: number } | null
  readonly inputHashesUnchanged: boolean | null
  readonly toolStarts: readonly SafeToolStart[]
  readonly toolResults: readonly SafeToolEnd[]
  readonly toolBalance: boolean
  readonly toolErrorCount: number
  readonly toolValidationErrorCount: number
  readonly selfCorrectionCount: number | null
  readonly requestCount: number
  readonly lifecycle: { readonly agentStart: number; readonly agentEnd: number; readonly turnStart: number; readonly turnEnd: number }
  readonly assistantStopReasons: readonly string[]
  readonly observedProviders: readonly string[]
  readonly observedModels: readonly string[]
  readonly usage: UsageTotals
  readonly elapsedMs: number
  readonly rssBytes: number
  readonly integrity: IntegrityObservation
  readonly invalidReason: string | null
}

export interface StudyCheckpoint {
  readonly schemaVersion: typeof STUDY_SCHEMA_VERSION
  readonly studyId: string
  readonly productionBaselineSha: typeof PRODUCTION_BASELINE_SHA
  readonly observerSha: string
  readonly intendedValidRuns: 20
  readonly maxPaidAttempts: 24
  readonly hardSpendCapUsd: 10
  readonly schedule: readonly StudyMonth[]
  readonly configuration: FrozenConfiguration
  readonly restartRule: 'observer-change-restarts-at-run-1'
  readonly costAuthority: 'pi-catalog-estimate-from-public-usage'
  readonly providerHardCapConfirmed: true
  readonly hardSpendEnforcement: 'provider-account-hard-cap-plus-observer-ledger'
  readonly createdAtUtc: string
}

export interface PaidAttemptReservation {
  readonly schemaVersion: typeof STUDY_SCHEMA_VERSION
  readonly studyId: string
  readonly studyRunNumber: number
  readonly paidAttemptNumber: number
  readonly month: StudyMonth
  readonly productionBaselineSha: typeof PRODUCTION_BASELINE_SHA
  readonly observerSha: string
  readonly configuration: FrozenConfiguration
  readonly reservedAtUtc: string
}

export const alternatingSchedule = (): readonly StudyMonth[] => Object.freeze(
  Array.from({ length: 20 }, (_, index) => index % 2 === 0 ? '7月' : '8月'),
)
