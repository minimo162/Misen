import test from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent } from '@earendil-works/pi-agent-core'
import type { AssistantMessage } from '@earendil-works/pi-ai'
import { AXIS_NAMES, type ValidationResult } from '../src/acceptance/validator.js'
import { fixture } from '../demo/enterprise-excel/fixtures.js'
import { aggregateStudy } from '../study/aggregate.js'
import { captureRuntimeContextBinding } from '../study/context.js'
import { assertRunRecord } from '../study/io.js'
import { StudyObserver } from '../study/observer.js'
import {
  alternatingSchedule,
  FROZEN_CONFIGURATION,
  PRODUCTION_BASELINE_SHA,
  STUDY_SCHEMA_VERSION,
  type PaidAttemptReservation,
  type StudyCheckpoint,
} from '../study/schema.js'

const metadata = {
  studyId: 'review-fix-study',
  studyRunNumber: 1,
  paidAttemptNumber: 1,
  month: '7月' as const,
  productionBaselineSha: PRODUCTION_BASELINE_SHA,
  observerSha: 'a'.repeat(40),
  startedAtUtc: '2026-09-01T00:00:00.000Z',
}
const integrity = { inputMutation: false, forbiddenCapability: false, credentialExposure: null, unexpectedNetwork: null }
const axes = Object.fromEntries(AXIS_NAMES.map(axis => [axis, { status: 'PASS' as const, evidence: { axis } }])) as ValidationResult['axes']
const validation: ValidationResult = { period: { year: 2024, month: 7 }, output: 'output/report.xlsx', passed: true, axes, diagnostics: [] }
const checkpoint: StudyCheckpoint = {
  schemaVersion: STUDY_SCHEMA_VERSION,
  studyId: metadata.studyId,
  productionBaselineSha: PRODUCTION_BASELINE_SHA,
  observerSha: metadata.observerSha,
  intendedValidRuns: 20,
  maxPaidAttempts: 24,
  hardSpendCapUsd: 10,
  schedule: alternatingSchedule(),
  configuration: FROZEN_CONFIGURATION,
  restartRule: 'observer-change-restarts-at-run-1',
  costAuthority: 'pi-catalog-estimate-from-public-usage',
  providerHardCapConfirmed: true,
  hardSpendEnforcement: 'provider-account-hard-cap-plus-observer-ledger',
  createdAtUtc: '2026-09-01T00:00:00.000Z',
}
const reservation: PaidAttemptReservation = {
  schemaVersion: STUDY_SCHEMA_VERSION,
  studyId: metadata.studyId,
  studyRunNumber: 1,
  paidAttemptNumber: 1,
  month: '7月',
  productionBaselineSha: PRODUCTION_BASELINE_SHA,
  observerSha: metadata.observerSha,
  configuration: FROZEN_CONFIGURATION,
  reservedAtUtc: '2026-09-01T00:00:00.500Z',
}

function assistant(costTotal = 0.03, provider = 'openai', model = 'gpt-5.6-luna'): AgentEvent {
  return {
    type: 'message_end',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'not persisted' }],
      api: 'openai-responses',
      provider,
      model,
      usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, reasoning: 3, totalTokens: 18, cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: costTotal } },
      stopReason: 'stop',
      timestamp: 1,
    },
  }
}

function beginWithTool(observer: StudyObserver): void {
  observer.observe({ type: 'agent_start' })
  observer.observe({ type: 'turn_start' })
  observer.observe({ type: 'tool_execution_start', toolCallId: 'read', toolName: 'workspace_read_text', args: { path: '業務引継ぎ.md' } })
  observer.observe({ type: 'tool_execution_end', toolCallId: 'read', toolName: 'workspace_read_text', result: {}, isError: false })
}

function finish(observer: StudyObserver, event: AgentEvent): void {
  observer.observe(event)
  const message = (event as Extract<AgentEvent, { type: 'message_end' }>).message
  observer.observe({ type: 'turn_end', message, toolResults: [] })
  observer.observe({ type: 'agent_end', messages: [message] })
}

function finalizePass(observer: StudyObserver) {
  return observer.finalize({ validation, outputBytes: 100, inputHashesUnchanged: true, elapsedMs: 1, rssBytes: 1, integrity, endedAtUtc: '2026-09-01T00:00:01.000Z' })
}

test('INVALID evidence persists only bounded reason codes and distinguishes failure classes', () => {
  const raw = new StudyObserver(metadata, () => '2026-09-01T00:00:01.000Z')
  const rawRecord = raw.finalize({ validation: null, inputHashesUnchanged: true, elapsedMs: 1, rssBytes: 1, integrity, invalidReason: 'observer crashed with password=hunter2', endedAtUtc: '2026-09-01T00:00:01.000Z' })
  assert.equal(rawRecord.status, 'INVALID')
  assert.equal(rawRecord.invalidReason, 'INFRASTRUCTURE_FAILURE')
  assert.doesNotMatch(JSON.stringify(rawRecord), /hunter2|password/u)
  assert.doesNotThrow(() => assertRunRecord(rawRecord))

  const capture = new StudyObserver(metadata, () => '2026-09-01T00:00:01.000Z')
  const captureRecord = capture.finalize({ validation: null, inputHashesUnchanged: true, elapsedMs: 1, rssBytes: 1, integrity, invalidReasonCode: 'OBSERVER_CAPTURE_FAILURE', endedAtUtc: '2026-09-01T00:00:01.000Z' })
  assert.equal(captureRecord.invalidReason, 'OBSERVER_CAPTURE_FAILURE')
  assert.doesNotThrow(() => assertRunRecord(captureRecord))

  const incomplete = new StudyObserver(metadata, () => '2026-09-01T00:00:01.000Z')
  incomplete.observe({ type: 'agent_start' })
  incomplete.observe({ type: 'turn_start' })
  finish(incomplete, assistant())
  const incompleteRecord = incomplete.finalize({ validation: null, inputHashesUnchanged: true, elapsedMs: 1, rssBytes: 1, integrity, endedAtUtc: '2026-09-01T00:00:01.000Z' })
  assert.equal(incompleteRecord.invalidReason, 'INCOMPLETE_EVENT_STREAM')
  assert.doesNotThrow(() => assertRunRecord(incompleteRecord))

  const drift = new StudyObserver(metadata, () => '2026-09-01T00:00:01.000Z')
  beginWithTool(drift)
  finish(drift, assistant(0.03, 'another-provider', 'another-model'))
  const driftRecord = drift.finalize({ validation, outputBytes: 100, inputHashesUnchanged: true, elapsedMs: 1, rssBytes: 1, integrity, endedAtUtc: '2026-09-01T00:00:01.000Z' })
  assert.equal(driftRecord.invalidReason, 'CONFIGURATION_DRIFT')
  assert.doesNotThrow(() => assertRunRecord(driftRecord))

  assert.throws(() => assertRunRecord({ ...rawRecord, invalidReason: 'raw observer detail' } as unknown), /summary evidence|invalid reason|INVALID invariants/u)
})

test('one unknown Pi catalog cost makes the run and study estimates unknown', () => {
  const finiteThenUnknown = new StudyObserver(metadata, () => '2026-09-01T00:00:01.000Z')
  beginWithTool(finiteThenUnknown)
  finiteThenUnknown.observe(assistant(0.03))
  finish(finiteThenUnknown, assistant(Number.NaN))
  const first = finalizePass(finiteThenUnknown)
  assert.equal(first.usage.catalogEstimatedCostUsd, null)
  assert.doesNotThrow(() => assertRunRecord(first))
  const aggregate = aggregateStudy([first], checkpoint, [reservation])
  assert.equal(aggregate.budget.catalogEstimatedCostUsd, null)
  assert.equal(aggregate.budget.recordsWithoutCatalogCostEstimate, 1)

  const unknownThenFinite = new StudyObserver(metadata, () => '2026-09-01T00:00:01.000Z')
  beginWithTool(unknownThenFinite)
  unknownThenFinite.observe(assistant(Number.NaN))
  finish(unknownThenFinite, assistant(0.03))
  const second = finalizePass(unknownThenFinite)
  assert.equal(second.usage.catalogEstimatedCostUsd, null)
  assert.doesNotThrow(() => assertRunRecord(second))
})

test('semantic fixture context is stable across fresh workbook serialization', async () => {
  const root = await mkdtemp(join(tmpdir(), 'misen-study-semantic-context-'))
  try {
    await fixture(root)
    const first = await captureRuntimeContextBinding(root)
    assert.deepEqual(first, FROZEN_CONFIGURATION.context)
    await fixture(root)
    const second = await captureRuntimeContextBinding(root)
    assert.deepEqual(second, first)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
