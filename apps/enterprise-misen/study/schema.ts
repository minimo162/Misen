import type { AxisName, AxisResult } from '../src/acceptance/validator.js'

export const PRODUCTION_BASELINE_SHA = 'f3b772f7765206f75f7296e436d89c6a771b690a'
export const STUDY_SCHEMA_VERSION = 2 as const
export const SELECTED_SKILL_PATH = '.agents/skills/monthly-report/SKILL.md'
export const FAILURE_TAXONOMIES = [
  'BUSINESS_SEMANTIC',
  'TOOL_CONTRACT_OR_VALIDATION',
  'AGENT_INCOMPLETE',
  'PROVIDER_OR_TRANSPORT',
  'ACCEPTANCE_FATAL',
  'SECURITY_OR_INTEGRITY',
  'INVALID_OBSERVER_OR_INFRA',
] as const
export const INVALID_REASONS = [
  'OBSERVER_CAPTURE_FAILURE',
  'INFRASTRUCTURE_FAILURE',
  'CONFIGURATION_DRIFT',
  'INCOMPLETE_EVENT_STREAM',
] as const

export type FailureTaxonomy = typeof FAILURE_TAXONOMIES[number]
export type InvalidReason = typeof INVALID_REASONS[number]
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
  readonly context: RuntimeContextBinding
  readonly source: {
    readonly acceptanceTreeOid: string
    readonly fixtureBlobOid: string
    readonly packageLockBlobOid: string
  }
}

export interface RuntimeContextBinding {
  readonly promptsSha256: string
  readonly fixtureInputsSha256: string
  readonly systemPromptSha256: string
  readonly workspaceInstructionsSha256: string
  readonly skillCatalogSha256: string
  readonly selectedSkillBodySha256: string
  readonly toolContractSha256: string
  readonly hookConfigurationSha256: string
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
  context: Object.freeze({
    promptsSha256: '5ea8f22701b108db2b369f3dc0706571d1afad4042df12f17db8b8cdee6348c6',
    fixtureInputsSha256: '99b45f6960c151287e6e10f81a59eac3e5d2ecec2bb506c7730117cd5070753a',
    systemPromptSha256: 'a359beecace889e596eee1a7ebcea42053081e80cf2ddddd7e96c70b7305c7ef',
    workspaceInstructionsSha256: '036d0ab99d944ad3eb00c6a1143313ecbae9adc4c97df5b8c9468e97e9d65e5b',
    skillCatalogSha256: 'e2389dd414def4faa62dccd4bfe0ff1288bbf9e6c94ddcdb709bffe0024916a7',
    selectedSkillBodySha256: 'e8ee7a76499a1915cdb1e6ac9471ee96a69de99203f741e64e0291712e833133',
    toolContractSha256: '1a5b5f0e7c6fcc52ace45b2cbd9da7113558dd3a7513206c2c22a2ad8c0b454d',
    hookConfigurationSha256: 'f02dc7005d5a2772e48d90b2378a461ac8c580466de839b17b444812bc51bd82',
  }),
  source: Object.freeze({
    acceptanceTreeOid: '53fac17e753da5bb16d7264e0ce39a7bf69dc59f',
    fixtureBlobOid: '7a8585bcacfacecdedd2ce0737094b22c26d4a54',
    packageLockBlobOid: '14c0985705885be0258f67ea55787f87d4769ecc',
  }),
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
  readonly progressiveSkillReadObserved: boolean
  readonly requestCount: number
  readonly lifecycle: { readonly agentStart: number; readonly agentEnd: number; readonly turnStart: number; readonly turnEnd: number }
  readonly assistantStopReasons: readonly string[]
  readonly observedProviders: readonly string[]
  readonly observedModels: readonly string[]
  readonly usage: UsageTotals
  readonly elapsedMs: number
  readonly rssBytes: number
  readonly integrity: IntegrityObservation
  readonly invalidReason: InvalidReason | null
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
