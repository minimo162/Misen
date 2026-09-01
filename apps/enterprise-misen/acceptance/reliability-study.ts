import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ENTERPRISE_CAPABILITY_TOOL_NAMES } from '../src/capabilities/index.js'
import {
  createLivePrompt,
  runMonth,
  type LiveMetrics,
  type MonthResult,
  type OutputDiagnosis,
  type SpreadsheetUpdateDiagnostic,
  type ToolOutcomeDiagnostic,
} from './live-brain.js'

const PROVIDER = 'openai'
const MODEL = 'gpt-5.6-luna'
export const RELIABILITY_REASONING_EFFORT = 'medium' as const
export const RELIABILITY_MONTHS = Object.freeze(['7月', '8月'] as const)
export const RELIABILITY_RUNS_PER_MONTH = 5
const AXES = Object.freeze([
  'SHEET',
  'MONTH',
  'ROWS',
  'PROFIT_FORMULAS',
  'STATUS',
  'TOTAL',
  'FOOTER',
  'FORMAT',
] as const)

type Axis = typeof AXES[number]
type StudyStatus = 'COMPLETE' | 'STOPPED_SECURITY_INTEGRITY' | 'STOPPED_INFRASTRUCTURE'

export interface ReliabilityRunSummary {
  readonly month: string
  readonly runNumber: number
  readonly status: 'PASS' | 'FAIL'
  readonly failureAxis?: string
  readonly businessFailureCode?: string
  readonly reason?: string
  readonly checks?: OutputDiagnosis['checks']
  readonly outputWorkbookCount?: number
  readonly inputUnchanged: boolean
  readonly forbiddenToolNames: readonly string[]
  readonly requestToolRoster: readonly string[]
  readonly toolCallsBalanced: boolean
  readonly toolNames: readonly string[]
  readonly toolErrorCount: number
  readonly toolValidationErrorCount: number
  readonly toolMissingResultCount: number
  readonly toolOrphanResultCount: number
  readonly toolCorrelationBalanced: boolean
  readonly agentSelfCorrection: boolean
  readonly agentSelfCorrectionSucceeded: boolean
  readonly agentSelfCorrectionCount: number
  readonly agentSelfCorrectionSucceededCount: number
  readonly providerRetryCount: number
  readonly providerOrTransportFailure: boolean
  readonly providerFailureCode?: string
  readonly toolOutcomes: readonly ToolOutcomeDiagnostic[]
  readonly metrics: LiveMetrics
  readonly actualB2?: unknown
  readonly actualRows?: readonly unknown[][]
  readonly spreadsheetUpdates?: readonly SpreadsheetUpdateDiagnostic[]
  readonly reasoningBlocks: number
  readonly turnEnd?: string
}

export interface NumericSummary {
  readonly count: number
  readonly min: number
  readonly median: number
  readonly max: number
}

export interface ReliabilityStudySummary {
  readonly status: StudyStatus
  readonly blocker?: string
  readonly provider: string
  readonly model: string
  readonly reasoningEffort: typeof RELIABILITY_REASONING_EFFORT
  readonly runsPerMonth: number
  readonly runs: readonly ReliabilityRunSummary[]
  readonly passCounts: Readonly<Record<string, number>>
  readonly overallPassCount: number
  readonly failureAxes: Readonly<Record<string, number>>
  readonly toolErrorRuns: number
  readonly toolValidationErrorRuns: number
  readonly selfCorrectionAttemptRuns: number
  readonly selfCorrectionSucceededRuns: number
  readonly selfCorrectionCount: number
  readonly selfCorrectionSucceededCount: number
  readonly providerOrTransportFailureRuns: number
  readonly performance: Readonly<{
    elapsedMs: NumericSummary
    llmRequests: NumericSummary
    toolCalls: NumericSummary
    providerTotalTokens?: NumericSummary
  }>
}

function inputUnchanged(result: MonthResult): boolean {
  return Object.entries(result.inputHashesBefore)
    .every(([path, before]) => result.inputHashesAfter[path] === before)
}

function firstFailureAxis(result: MonthResult): string | undefined {
  const checks = result.outputDiagnosis?.checks
  if (checks !== undefined) {
    const failed = AXES.find(axis => checks[axis] === 'FAIL')
    if (failed !== undefined) return failed
  }
  if (result.businessFailureCode !== undefined) return result.businessFailureCode
  if (result.status === 'FAIL') return 'RUNTIME_OR_OUTPUT'
  return undefined
}

function providerOrTransportFailure(result: MonthResult): boolean {
  return result.executionErrorClass === 'LlmError' ||
    result.providerFailureCode !== undefined ||
    result.failureDiagnostic !== undefined
}

export function reliabilityInfrastructureBlocker(result: MonthResult): string | undefined {
  const status = result.failureDiagnostic?.status
  if (status === 401 || status === 403 || status === 429) return `provider status ${status}`
  if (result.failureDiagnostic?.modelNotFound === true) return 'provider model not found'
  if (result.failureDiagnostic?.unsupportedReasoning === true) return 'provider rejected reasoning setting'
  if (result.failureDiagnostic?.invalidRequest === true) return 'provider rejected the fixed request contract'
  if (result.providerFailureCode === 'AUTH') return 'provider authentication failure'
  if (result.toolCorrelationBalanced === false) return 'Tool call/result identity correlation is not balanced'
  const outcomes = result.toolOutcomes
  if (outcomes === undefined || outcomes.length !== result.metrics.toolCallCount) {
    return 'bounded Tool outcomes do not cover every Tool call'
  }
  if (outcomes.filter(outcome => outcome.result === 'error').length !== (result.toolErrorCount ?? 0)) {
    return 'aggregate Tool-error count contradicts bounded Tool evidence'
  }
  if (outcomes.filter(outcome => outcome.validationError).length !== (result.toolValidationErrorCount ?? 0)) {
    return 'aggregate Tool-validation-error count contradicts bounded Tool evidence'
  }
  return undefined
}

function securityOrIntegrityBlocker(result: MonthResult): string | undefined {
  if (!inputUnchanged(result)) return 'input workbook mutation'
  if (result.forbiddenToolNames.length > 0) {
    return `forbidden Tool requested: ${result.forbiddenToolNames.join(', ')}`
  }
  if (result.requestToolRoster.length > 0 &&
    (result.requestToolRoster.length !== ENTERPRISE_CAPABILITY_TOOL_NAMES.length ||
      result.requestToolRoster.some(name => !(ENTERPRISE_CAPABILITY_TOOL_NAMES as readonly string[]).includes(name)))) {
    return `unexpected request Tool roster: ${result.requestToolRoster.join(', ')}`
  }
  if (result.metrics.toolCallCount !== result.metrics.toolResultCount) return 'Tool call/result imbalance'
  return undefined
}

export function summarizeReliabilityRun(result: MonthResult, runNumber: number): ReliabilityRunSummary {
  const failed = result.status === 'FAIL'
  const validationErrorCount = result.toolValidationErrorCount ?? 0
  return {
    month: result.month,
    runNumber,
    status: result.status,
    ...(failed ? { failureAxis: firstFailureAxis(result) ?? 'UNKNOWN' } : {}),
    ...(result.businessFailureCode === undefined ? {} : { businessFailureCode: result.businessFailureCode }),
    ...(result.reason === undefined ? {} : { reason: result.reason }),
    ...(result.outputDiagnosis === undefined ? {} : { checks: result.outputDiagnosis.checks }),
    ...(result.outputWorkbookCount === undefined ? {} : { outputWorkbookCount: result.outputWorkbookCount }),
    inputUnchanged: inputUnchanged(result),
    forbiddenToolNames: result.forbiddenToolNames,
    requestToolRoster: result.requestToolRoster,
    toolCallsBalanced: result.metrics.toolCallCount === result.metrics.toolResultCount,
    toolNames: result.toolNames,
    toolErrorCount: result.toolErrorCount ?? 0,
    toolValidationErrorCount: validationErrorCount,
    toolMissingResultCount: result.toolMissingResultCount ?? 0,
    toolOrphanResultCount: result.toolOrphanResultCount ?? 0,
    toolCorrelationBalanced: result.toolCorrelationBalanced ?? false,
    agentSelfCorrection: result.agentSelfCorrection ?? false,
    agentSelfCorrectionSucceeded: result.agentSelfCorrectionSucceeded ?? false,
    agentSelfCorrectionCount: result.agentSelfCorrectionCount ?? 0,
    agentSelfCorrectionSucceededCount: result.agentSelfCorrectionSucceededCount ?? 0,
    providerRetryCount: result.retryEventCount ?? 0,
    providerOrTransportFailure: providerOrTransportFailure(result),
    ...(result.providerFailureCode === undefined ? {} : { providerFailureCode: result.providerFailureCode }),
    toolOutcomes: result.toolOutcomes ?? [],
    metrics: result.metrics,
    ...(result.outputDiagnosis?.actualB2 === undefined ? {} : { actualB2: result.outputDiagnosis.actualB2 }),
    ...(result.outputDiagnosis?.actualRows === undefined ? {} : { actualRows: result.outputDiagnosis.actualRows }),
    ...((failed || (result.toolErrorCount ?? 0) > 0) && result.spreadsheetUpdates !== undefined
      ? { spreadsheetUpdates: result.spreadsheetUpdates }
      : {}),
    reasoningBlocks: result.reasoningBlocks,
    ...(result.turnEnd === undefined ? {} : { turnEnd: result.turnEnd }),
  }
}

function numericSummary(values: readonly number[]): NumericSummary {
  if (values.length === 0) return { count: 0, min: 0, median: 0, max: 0 }
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  const median = sorted.length % 2 === 1
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2
  return { count: sorted.length, min: sorted[0]!, median, max: sorted.at(-1)! }
}

export function summarizeReliabilityStudy(
  runs: readonly ReliabilityRunSummary[],
  status: StudyStatus = 'COMPLETE',
  blocker?: string,
): ReliabilityStudySummary {
  const passCounts = Object.fromEntries(RELIABILITY_MONTHS.map(month => [
    month,
    runs.filter(run => run.month === month && run.status === 'PASS').length,
  ]))
  const failureAxes: Record<string, number> = {}
  for (const run of runs) {
    if (run.status !== 'FAIL') continue
    const axis = run.failureAxis ?? 'UNKNOWN'
    failureAxes[axis] = (failureAxes[axis] ?? 0) + 1
  }
  const tokenValues = runs.flatMap(run => run.metrics.usage?.totalTokens === undefined
    ? []
    : [run.metrics.usage.totalTokens])
  return {
    status,
    ...(blocker === undefined ? {} : { blocker }),
    provider: PROVIDER,
    model: MODEL,
    reasoningEffort: RELIABILITY_REASONING_EFFORT,
    runsPerMonth: RELIABILITY_RUNS_PER_MONTH,
    runs,
    passCounts,
    overallPassCount: runs.filter(run => run.status === 'PASS').length,
    failureAxes,
    toolErrorRuns: runs.filter(run => run.toolErrorCount > 0).length,
    toolValidationErrorRuns: runs.filter(run => run.toolValidationErrorCount > 0).length,
    selfCorrectionAttemptRuns: runs.filter(run => run.agentSelfCorrection).length,
    selfCorrectionSucceededRuns: runs.filter(run => run.agentSelfCorrectionSucceeded).length,
    selfCorrectionCount: runs.reduce((total, run) => total + run.agentSelfCorrectionCount, 0),
    selfCorrectionSucceededCount: runs.reduce((total, run) => total + run.agentSelfCorrectionSucceededCount, 0),
    providerOrTransportFailureRuns: runs.filter(run => run.providerOrTransportFailure).length,
    performance: {
      elapsedMs: numericSummary(runs.map(run => run.metrics.elapsedMs)),
      llmRequests: numericSummary(runs.map(run => run.metrics.llmRequestCount)),
      toolCalls: numericSummary(runs.map(run => run.metrics.toolCallCount)),
      ...(tokenValues.length === 0 ? {} : { providerTotalTokens: numericSummary(tokenValues) }),
    },
  }
}

export async function runReliabilityStudy(): Promise<ReliabilityStudySummary | undefined> {
  if (typeof process.env.OPENAI_API_KEY !== 'string' || process.env.OPENAI_API_KEY.trim().length === 0) {
    console.log('NOT RUN — OPENAI_API_KEY unavailable')
    return undefined
  }

  const runs: ReliabilityRunSummary[] = []
  for (const month of RELIABILITY_MONTHS) {
    for (let runNumber = 1; runNumber <= RELIABILITY_RUNS_PER_MONTH; runNumber += 1) {
      let result: MonthResult
      try {
        result = await runMonth(month, `decision-432-${month}-${runNumber}`, RELIABILITY_REASONING_EFFORT)
      } catch (error) {
        const blocker = error instanceof Error ? error.name : 'UnknownError'
        const summary = summarizeReliabilityStudy(runs, 'STOPPED_INFRASTRUCTURE', `study runner stage failure (${blocker})`)
        console.log(`DECISION_432_RELIABILITY_SUMMARY ${JSON.stringify(summary)}`)
        return summary
      }
      const run = summarizeReliabilityRun(result, runNumber)
      runs.push(run)
      console.log(`DECISION_432_RUN ${JSON.stringify({
        prompt: createLivePrompt(month),
        ...run,
      })}`)

      const securityBlocker = securityOrIntegrityBlocker(result)
      if (securityBlocker !== undefined) {
        const summary = summarizeReliabilityStudy(runs, 'STOPPED_SECURITY_INTEGRITY', securityBlocker)
        console.log(`DECISION_432_RELIABILITY_SUMMARY ${JSON.stringify(summary)}`)
        return summary
      }
      const providerBlocker = reliabilityInfrastructureBlocker(result)
      if (providerBlocker !== undefined) {
        const summary = summarizeReliabilityStudy(runs, 'STOPPED_INFRASTRUCTURE', providerBlocker)
        console.log(`DECISION_432_RELIABILITY_SUMMARY ${JSON.stringify(summary)}`)
        return summary
      }
    }
  }

  const summary = summarizeReliabilityStudy(runs)
  console.log(`DECISION_432_RELIABILITY_SUMMARY ${JSON.stringify(summary)}`)
  return summary
}

const entry = process.argv[1]
if (entry !== undefined && resolve(entry) === resolve(fileURLToPath(import.meta.url))) {
  const result = await runReliabilityStudy()
  if (result === undefined || result.status !== 'COMPLETE') process.exitCode = 1
}
