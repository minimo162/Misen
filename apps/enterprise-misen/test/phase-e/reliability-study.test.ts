import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import {
  collectProviderRetryCount,
  collectToolCorrectionSummary,
  createLiveSessionId,
  type MonthResult,
} from '../../acceptance/live-brain.js'
import {
  RELIABILITY_MONTHS,
  RELIABILITY_REASONING_EFFORT,
  RELIABILITY_RUNS_PER_MONTH,
  reliabilityInfrastructureBlocker,
  summarizeReliabilityRun,
  summarizeReliabilityStudy,
} from '../../acceptance/reliability-study.js'

const OPAQUE_CALL_PREFIX = `call_${'provider-issued/'.repeat(12)}`

function toolCall(callId: string, name: string, argumentsJson = '{}', turn = 1): unknown {
  return { type: 'tool/call', data: { turn, step: 1, callId, name, arguments: argumentsJson } }
}

function toolResult(
  callId: string,
  options: { isError?: boolean; error?: { name: string; code: string }; text?: string; turn?: number } = {},
): unknown {
  return {
    type: 'tool/result',
    data: {
      turn: options.turn ?? 1,
      step: 1,
      message: {
        source: { kind: 'tool', callId },
        content: [{
          type: 'tool-result',
          toolCallId: callId,
          isError: options.isError ?? false,
          content: options.text === undefined ? [] : [{ type: 'text', text: options.text }],
        }],
      },
      ...(options.error === undefined ? {} : { error: options.error }),
    },
  }
}

function monthResult(
  month: string,
  status: 'PASS' | 'FAIL',
  elapsedMs: number,
  totalTokens?: number,
): MonthResult {
  return {
    month,
    status,
    ...(status === 'FAIL' ? { reason: 'output validation failed (ROWS)', businessFailureCode: 'ROWS' } : {}),
    outputWorkbookCount: 1,
    toolNames: ['spreadsheet_update'],
    metrics: {
      elapsedMs,
      llmRequestCount: 10,
      toolCallCount: 1,
      toolResultCount: 1,
      ...(totalTokens === undefined ? {} : { usage: { totalTokens } }),
      outputBytes: 3_200,
      memoryBytes: 100_000_000,
    },
    inputHashesBefore: { '7月/Alpha.xlsx': 'same' },
    inputHashesAfter: { '7月/Alpha.xlsx': 'same' },
    forbiddenToolNames: [],
    reasoningBlocks: 0,
    requestToolRoster: [
      'workspace_list_files',
      'workspace_read_text',
      'spreadsheet_read',
      'spreadsheet_create_output',
      'spreadsheet_update',
    ],
    retryEventCount: 0,
    toolOutcomes: [{ sequence: 1, tool: 'spreadsheet_update', result: 'success', validationError: false }],
    toolErrorCount: 0,
    toolValidationErrorCount: 0,
    toolMissingResultCount: 0,
    toolOrphanResultCount: 0,
    toolCorrelationBalanced: true,
    agentSelfCorrection: false,
    agentSelfCorrectionSucceeded: false,
    agentSelfCorrectionCount: 0,
    agentSelfCorrectionSucceededCount: 0,
    outputDiagnosis: {
      actualB2: '2024年7月',
      actualRows: [['Gamma', 1100, 650], ['Beta', 950, 500], ['Alpha', 1200, 700]],
      expectedSourceRows: [['Alpha', 1200, 700], ['Beta', 950, 500], ['Gamma', 1100, 650]],
      rowSetMatches: true,
      checks: {
        SHEET: 'PASS',
        MONTH: 'PASS',
        ROWS: status === 'PASS' ? 'PASS' : 'FAIL',
        PROFIT_FORMULAS: 'PASS',
        STATUS: 'PASS',
        TOTAL: 'PASS',
        FOOTER: 'PASS',
        FORMAT: 'PASS',
      },
    },
    spreadsheetUpdates: [{
      sequence: 1,
      workbook: 'output/report.xlsx',
      sheet: 'Report',
      range: 'A5:E8',
      values: [['Gamma', 1100, 650]],
      result: 'success',
    }],
    turnEnd: 'completed',
  }
}

test('Decision 432 freezes five fresh July and August runs at Luna medium', () => {
  assert.deepEqual(RELIABILITY_MONTHS, ['7月', '8月'])
  assert.equal(RELIABILITY_RUNS_PER_MONTH, 5)
  assert.equal(RELIABILITY_REASONING_EFFORT, 'medium')
  assert.notEqual(
    String(createLiveSessionId('7月', 'decision-432-7月-1')),
    String(createLiveSessionId('7月', 'decision-432-7月-2')),
  )
})

test('observer correlates realistic opaque DSH ids and records Tool success', () => {
  const callId = `${OPAQUE_CALL_PREFIX}success`
  assert.deepEqual(collectToolCorrectionSummary([
    toolCall(callId, 'workspace_list_files', '{"path":"."}'),
    toolResult(callId),
  ]), {
    toolErrorCount: 0,
    validationErrorCount: 0,
    missingResultCount: 0,
    orphanResultCount: 0,
    correlationBalanced: true,
    selfCorrectionAttempted: false,
    selfCorrectionSucceeded: false,
    selfCorrectionCount: 0,
    selfCorrectionSucceededCount: 0,
    outcomes: [{ sequence: 1, tool: 'workspace_list_files', result: 'success', validationError: false }],
  })
})

test('observer classifies validation error and Agent self-correction separately from provider retry', () => {
  const invalidId = `${OPAQUE_CALL_PREFIX}invalid`
  const correctedId = `${OPAQUE_CALL_PREFIX}corrected`
  const operation = '{"workbook":"output/a.xlsx","sheet":"Report","range":"B2:B2","values":[[1]]}'
  const corrected = '{"workbook":"output/a.xlsx","sheet":"Report","range":"B2:B2","values":[["7月"]]}'
  assert.deepEqual(collectToolCorrectionSummary([
    toolCall(invalidId, 'spreadsheet_update', operation),
    toolResult(invalidId, {
      isError: true,
      error: { name: 'ToolArgsError', code: 'INVALID_ARGS' },
      text: 'Error: invalid arguments: values are invalid',
    }),
    toolCall(correctedId, 'spreadsheet_update', corrected),
    toolResult(correctedId),
  ]), {
    toolErrorCount: 1,
    validationErrorCount: 1,
    missingResultCount: 0,
    orphanResultCount: 0,
    correlationBalanced: true,
    selfCorrectionAttempted: true,
    selfCorrectionSucceeded: true,
    selfCorrectionCount: 1,
    selfCorrectionSucceededCount: 1,
    outcomes: [
      {
        sequence: 1,
        tool: 'spreadsheet_update',
        result: 'error',
        validationError: true,
        errorCode: 'INVALID_ARGS',
        errorCategory: 'ToolArgsError',
      },
      { sequence: 2, tool: 'spreadsheet_update', result: 'success', validationError: false },
    ],
  })
})

test('observer distinguishes non-validation errors and multiple Tool errors', () => {
  const first = `${OPAQUE_CALL_PREFIX}io`
  const second = `${OPAQUE_CALL_PREFIX}output`
  assert.deepEqual(collectToolCorrectionSummary([
    toolCall(first, 'spreadsheet_update'),
    toolResult(first, { isError: true, error: { name: 'Error', code: 'EIO' }, text: 'Error: I/O failure' }),
    toolCall(second, 'spreadsheet_update'),
    toolResult(second, {
      isError: true,
      error: { name: 'ToolOutputError', code: 'INVALID_TOOL_OUTPUT' },
      text: 'Error: invalid output',
    }),
  ]), {
    toolErrorCount: 2,
    validationErrorCount: 1,
    missingResultCount: 0,
    orphanResultCount: 0,
    correlationBalanced: true,
    selfCorrectionAttempted: false,
    selfCorrectionSucceeded: false,
    selfCorrectionCount: 0,
    selfCorrectionSucceededCount: 0,
    outcomes: [
      {
        sequence: 1,
        tool: 'spreadsheet_update',
        result: 'error',
        validationError: false,
        errorCode: 'EIO',
        errorCategory: 'Error',
      },
      {
        sequence: 2,
        tool: 'spreadsheet_update',
        result: 'error',
        validationError: true,
        errorCode: 'INVALID_TOOL_OUTPUT',
        errorCategory: 'ToolOutputError',
      },
    ],
  })
})

test('observer does not treat a missing result as success even when raw counts match', () => {
  const missing = `${OPAQUE_CALL_PREFIX}missing`
  const orphan = `${OPAQUE_CALL_PREFIX}orphan`
  const summary = collectToolCorrectionSummary([
    toolCall(missing, 'workspace_read_text', '{"path":"業務引継ぎ.md"}'),
    toolResult(orphan),
  ])
  assert.equal(summary.toolErrorCount, 0)
  assert.equal(summary.missingResultCount, 1)
  assert.equal(summary.orphanResultCount, 1)
  assert.equal(summary.correlationBalanced, false)
  assert.deepEqual(summary.outcomes, [
    { sequence: 1, tool: 'workspace_read_text', result: 'missing-result', validationError: false },
  ])
})

test('provider retry scheduled/started pair counts as one retry, not Agent self-correction', () => {
  assert.equal(collectProviderRetryCount([
    { type: 'llm/retry', data: { retryId: 'retry-1', retry: 1 } },
    { type: 'llm/retry-started', data: { retryId: 'retry-1', retry: 1 } },
  ]), 1)
})

test('non-validation Tool error followed by same-operation success is Agent self-correction', () => {
  const failed = `${OPAQUE_CALL_PREFIX}runtime-error`
  const corrected = `${OPAQUE_CALL_PREFIX}runtime-corrected`
  const failedArgs = '{"workbook":"output/a.xlsx","sheet":"Report","range":"E9:E9","values":[[{"formula":"=1"}]]}'
  const correctedArgs = '{"workbook":"output/a.xlsx","sheet":"Report","range":"E9:E9","values":[["On target"]]}'
  const summary = collectToolCorrectionSummary([
    toolCall(failed, 'spreadsheet_update', failedArgs),
    toolResult(failed, { isError: true, error: { name: 'Error', code: 'EIO' }, text: 'Error: I/O failure' }),
    toolCall(corrected, 'spreadsheet_update', correctedArgs),
    toolResult(corrected),
  ])
  assert.equal(summary.toolErrorCount, 1)
  assert.equal(summary.validationErrorCount, 0)
  assert.equal(summary.selfCorrectionCount, 1)
  assert.equal(summary.selfCorrectionSucceededCount, 1)
})

test('business STATUS failure is not reported as a provider failure', () => {
  const result = monthResult('7月', 'FAIL', 10)
  result.businessFailureCode = 'STATUS'
  result.outputDiagnosis = {
    ...result.outputDiagnosis!,
    checks: { ...result.outputDiagnosis!.checks, ROWS: 'PASS', STATUS: 'FAIL' },
  }
  const run = summarizeReliabilityRun(result, 1)
  assert.equal(run.failureAxis, 'STATUS')
  assert.equal(run.businessFailureCode, 'STATUS')
  assert.equal(run.providerOrTransportFailure, false)
  assert.equal(run.providerFailureCode, undefined)
})

test('provider failure is separate from business Acceptance failure', () => {
  const result = monthResult('7月', 'FAIL', 10)
  delete result.businessFailureCode
  delete result.outputDiagnosis
  result.providerFailureCode = 'INVALID_CREDENTIAL'
  result.executionErrorClass = 'LlmError'
  result.turnEnd = 'error'
  const run = summarizeReliabilityRun(result, 1)
  assert.equal(run.businessFailureCode, undefined)
  assert.equal(run.providerFailureCode, 'INVALID_CREDENTIAL')
  assert.equal(run.providerOrTransportFailure, true)
})

test('generic Agent-loop error is not mislabeled as provider/transport failure', () => {
  const result = monthResult('7月', 'FAIL', 10)
  delete result.businessFailureCode
  delete result.outputDiagnosis
  result.executionErrorClass = 'Error'
  result.executionErrorCode = 'UNKNOWN'
  result.turnEnd = 'error'
  const run = summarizeReliabilityRun(result, 1)
  assert.equal(run.providerFailureCode, undefined)
  assert.equal(run.providerOrTransportFailure, false)
})

test('aggregate Tool errors must not contradict bounded Spreadsheet evidence', () => {
  const result = monthResult('7月', 'FAIL', 10)
  result.toolErrorCount = 0
  result.toolValidationErrorCount = 0
  result.toolOutcomes = [{
    sequence: 1,
    tool: 'spreadsheet_update',
    result: 'error',
    validationError: true,
    errorCode: 'INVALID_ARGS',
  }]
  result.spreadsheetUpdates = [{ sequence: 1, result: 'error', errorCode: 'INVALID_ARGS' }]
  assert.equal(
    reliabilityInfrastructureBlocker(result),
    'aggregate Tool-error count contradicts bounded Tool evidence',
  )
  result.toolErrorCount = 1
  result.toolValidationErrorCount = 1
  assert.equal(reliabilityInfrastructureBlocker(result), undefined)
})

test('failed runs retain bounded synthetic-safe evidence and explicit failure categories', () => {
  const run = summarizeReliabilityRun(monthResult('7月', 'FAIL', 30_000, 50_000), 3)
  assert.equal(run.failureAxis, 'ROWS')
  assert.equal(run.businessFailureCode, 'ROWS')
  assert.equal(run.providerFailureCode, undefined)
  assert.equal(run.actualB2, '2024年7月')
  assert.deepEqual(run.actualRows, [['Gamma', 1100, 650], ['Beta', 950, 500], ['Alpha', 1200, 700]])
  assert.equal(run.spreadsheetUpdates?.[0]?.range, 'A5:E8')
  assert.equal('finalText' in run, false)
  assert.equal('inputHashesBefore' in run, false)
})

test('Decision 432 summary reports medium runs and distributions without a threshold', () => {
  const corrected = summarizeReliabilityRun(monthResult('7月', 'PASS', 10, 100), 1)
  const correctedRun = {
    ...corrected,
    agentSelfCorrection: true,
    agentSelfCorrectionSucceeded: true,
    agentSelfCorrectionCount: 2,
    agentSelfCorrectionSucceededCount: 1,
  }
  const runs = [
    correctedRun,
    summarizeReliabilityRun(monthResult('7月', 'FAIL', 20, 200), 2),
    summarizeReliabilityRun(monthResult('8月', 'PASS', 30, 300), 1),
    summarizeReliabilityRun(monthResult('8月', 'PASS', 40, 400), 2),
  ]
  const summary = summarizeReliabilityStudy(runs)
  assert.equal(summary.status, 'COMPLETE')
  assert.equal(summary.reasoningEffort, 'medium')
  assert.deepEqual(summary.passCounts, { '7月': 1, '8月': 2 })
  assert.equal(summary.overallPassCount, 3)
  assert.deepEqual(summary.failureAxes, { ROWS: 1 })
  assert.equal(summary.selfCorrectionCount, 2)
  assert.equal(summary.selfCorrectionSucceededCount, 1)
  assert.deepEqual(summary.performance.elapsedMs, { count: 4, min: 10, median: 25, max: 40 })
  assert.deepEqual(summary.performance.providerTotalTokens, { count: 4, min: 100, median: 250, max: 400 })
  assert.equal('threshold' in summary, false)
})
