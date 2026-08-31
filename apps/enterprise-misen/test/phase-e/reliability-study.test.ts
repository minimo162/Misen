import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import {
  collectToolCorrectionSummary,
  createLiveSessionId,
  type MonthResult,
} from '../../acceptance/live-brain.js'
import {
  RELIABILITY_MONTHS,
  RELIABILITY_RUNS_PER_MONTH,
  summarizeReliabilityRun,
  summarizeReliabilityStudy,
} from '../../acceptance/reliability-study.js'

function monthResult(
  month: string,
  status: 'PASS' | 'FAIL',
  elapsedMs: number,
  totalTokens?: number,
): MonthResult {
  return {
    month,
    status,
    ...(status === 'FAIL' ? { reason: 'output validation failed (ROW)', failureCode: 'ROW' } : {}),
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
    toolErrorCount: 0,
    toolValidationErrorCount: 0,
    agentSelfCorrection: false,
    agentSelfCorrectionSucceeded: false,
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

test('Decision 431 freezes exactly five independent runs for July and August', () => {
  assert.deepEqual(RELIABILITY_MONTHS, ['7月', '8月'])
  assert.equal(RELIABILITY_RUNS_PER_MONTH, 5)
  assert.notEqual(
    String(createLiveSessionId('7月', 'decision-431-7月-1')),
    String(createLiveSessionId('7月', 'decision-431-7月-2')),
  )
})

test('Decision 431 observer distinguishes Tool errors and same-turn correction success', () => {
  const events = [
    { type: 'tool/call', data: { callId: 'first', name: 'spreadsheet_update', arguments: '{}' } },
    {
      type: 'tool/result',
      data: {
        message: {
          source: { kind: 'tool', callId: 'first' },
          content: [{
            type: 'tool-result',
            isError: true,
            content: [{ type: 'text', text: 'Error: unsupported spreadsheet cell value' }],
          }],
        },
      },
    },
    { type: 'tool/call', data: { callId: 'second', name: 'spreadsheet_update', arguments: '{}' } },
    {
      type: 'tool/result',
      data: {
        message: {
          source: { kind: 'tool', callId: 'second' },
          content: [{ type: 'tool-result', isError: false }],
        },
      },
    },
  ]
  assert.deepEqual(collectToolCorrectionSummary(events), {
    toolErrorCount: 1,
    validationErrorCount: 1,
    selfCorrectionAttempted: true,
    selfCorrectionSucceeded: true,
  })
})

test('Decision 431 does not call a runtime failure or unrelated later operation a validation correction', () => {
  const events = [
    { type: 'tool/call', data: { callId: 'first', name: 'spreadsheet_update', arguments: '{"workbook":"output/a.xlsx","sheet":"Report","range":"B2:B2","values":[[1]]}' } },
    {
      type: 'tool/result',
      data: {
        message: {
          source: { kind: 'tool', callId: 'first' },
          content: [{ type: 'tool-result', isError: true, content: [{ type: 'text', text: 'Error: I/O failure' }] }],
        },
        error: { name: 'Error', code: 'EIO' },
      },
    },
    { type: 'tool/call', data: { callId: 'other', name: 'workspace_read_text', arguments: '{"path":"業務引継ぎ.md"}' } },
    {
      type: 'tool/result',
      data: {
        message: {
          source: { kind: 'tool', callId: 'other' },
          content: [{ type: 'tool-result', isError: false, content: [] }],
        },
      },
    },
    { type: 'tool/call', data: { callId: 'later', name: 'spreadsheet_update', arguments: '{"workbook":"output/a.xlsx","sheet":"Report","range":"D9:D9","values":[[1]]}' } },
    {
      type: 'tool/result',
      data: {
        message: {
          source: { kind: 'tool', callId: 'later' },
          content: [{ type: 'tool-result', isError: false, content: [] }],
        },
      },
    },
  ]
  assert.deepEqual(collectToolCorrectionSummary(events), {
    toolErrorCount: 1,
    validationErrorCount: 0,
    selfCorrectionAttempted: false,
    selfCorrectionSucceeded: false,
  })
})

test('Decision 431 requires an immediate same-target call before recording validation self-correction', () => {
  const events = [
    { type: 'tool/call', data: { callId: 'invalid', name: 'spreadsheet_update', arguments: '{"workbook":"output/a.xlsx","sheet":"Report","range":"B2:B2","values":[[{"kind":"unsupported"}]]}' } },
    {
      type: 'tool/result',
      data: {
        message: {
          source: { kind: 'tool', callId: 'invalid' },
          content: [{
            type: 'tool-result',
            isError: true,
            content: [{ type: 'text', text: 'Error: unsupported spreadsheet cell value' }],
          }],
        },
      },
    },
    { type: 'tool/call', data: { callId: 'intervening', name: 'workspace_read_text', arguments: '{"path":"業務引継ぎ.md"}' } },
    {
      type: 'tool/result',
      data: {
        message: {
          source: { kind: 'tool', callId: 'intervening' },
          content: [{ type: 'tool-result', isError: false, content: [] }],
        },
      },
    },
    { type: 'tool/call', data: { callId: 'late-success', name: 'spreadsheet_update', arguments: '{"workbook":"output/a.xlsx","sheet":"Report","range":"B2:B2","values":[["7月"]]}' } },
    {
      type: 'tool/result',
      data: {
        message: {
          source: { kind: 'tool', callId: 'late-success' },
          content: [{ type: 'tool-result', isError: false, content: [] }],
        },
      },
    },
  ]
  assert.deepEqual(collectToolCorrectionSummary(events), {
    toolErrorCount: 1,
    validationErrorCount: 1,
    selfCorrectionAttempted: false,
    selfCorrectionSucceeded: false,
  })
})

test('Decision 431 failed runs retain only bounded synthetic-safe failure evidence', () => {
  const run = summarizeReliabilityRun(monthResult('7月', 'FAIL', 30_000, 50_000), 3)
  assert.equal(run.failureAxis, 'ROWS')
  assert.equal(run.actualB2, '2024年7月')
  assert.deepEqual(run.actualRows, [['Gamma', 1100, 650], ['Beta', 950, 500], ['Alpha', 1200, 700]])
  assert.equal(run.spreadsheetUpdates?.[0]?.range, 'A5:E8')
  assert.equal('finalText' in run, false)
  assert.equal('inputHashesBefore' in run, false)
})

test('Decision 431 summary reports all runs, failure patterns, and median/range without a threshold', () => {
  const runs = [
    summarizeReliabilityRun(monthResult('7月', 'PASS', 10, 100), 1),
    summarizeReliabilityRun(monthResult('7月', 'FAIL', 20, 200), 2),
    summarizeReliabilityRun(monthResult('8月', 'PASS', 30, 300), 1),
    summarizeReliabilityRun(monthResult('8月', 'PASS', 40, 400), 2),
  ]
  const summary = summarizeReliabilityStudy(runs)
  assert.equal(summary.status, 'COMPLETE')
  assert.deepEqual(summary.passCounts, { '7月': 1, '8月': 2 })
  assert.equal(summary.overallPassCount, 3)
  assert.deepEqual(summary.failureAxes, { ROWS: 1 })
  assert.deepEqual(summary.performance.elapsedMs, { count: 4, min: 10, median: 25, max: 40 })
  assert.deepEqual(summary.performance.providerTotalTokens, { count: 4, min: 100, median: 250, max: 400 })
  assert.equal('threshold' in summary, false)
})
