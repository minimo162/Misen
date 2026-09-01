import test from 'node:test'
import { strict as assert } from 'node:assert'
import { Agent } from '@earendil-works/pi-agent-core'
import { createModels, fauxAssistantMessage, fauxProvider, type AssistantMessage } from '@earendil-works/pi-ai'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent } from '@earendil-works/pi-agent-core'
import { AXIS_NAMES, type ValidationResult } from '../src/acceptance/validator.js'
import { aggregateStudy, wilson95 } from '../study/aggregate.js'
import { prepareEvidenceDirectory, persistRun, readCheckpoint, readReservations, readRunRecords, reservePaidAttempt, writeCheckpoint } from '../study/io.js'
import { StudyObserver } from '../study/observer.js'
import { alternatingSchedule, FROZEN_CONFIGURATION, PRODUCTION_BASELINE_SHA, STUDY_SCHEMA_VERSION, type PaidAttemptReservation, type StudyCheckpoint, type StudyRunRecord } from '../study/schema.js'

const axes = (status: 'PASS' | 'FAIL') => Object.fromEntries(AXIS_NAMES.map(axis => [axis, { status, evidence: { axis } }])) as ValidationResult['axes']
const validation = (status: 'PASS' | 'FAIL'): ValidationResult => ({ period: { year: 2024, month: 7 }, output: 'output/report.xlsx', passed: status === 'PASS', axes: axes(status), diagnostics: [] })
const metadata = { studyId: 'test-study', studyRunNumber: 1, paidAttemptNumber: 1, month: '7月' as const, productionBaselineSha: PRODUCTION_BASELINE_SHA, observerSha: 'a'.repeat(40), startedAtUtc: '2026-09-01T00:00:00.000Z' }
const integrity = { inputMutation: false, forbiddenCapability: false, credentialExposure: null, unexpectedNetwork: null }
const checkpoint: StudyCheckpoint = { schemaVersion: STUDY_SCHEMA_VERSION, studyId: 'test-study', productionBaselineSha: PRODUCTION_BASELINE_SHA, observerSha: 'a'.repeat(40), intendedValidRuns: 20, maxPaidAttempts: 24, hardSpendCapUsd: 10, schedule: alternatingSchedule(), configuration: FROZEN_CONFIGURATION, restartRule: 'observer-change-restarts-at-run-1', costAuthority: 'pi-catalog-estimate-from-public-usage', providerHardCapConfirmed: true, hardSpendEnforcement: 'provider-account-hard-cap-plus-observer-ledger', createdAtUtc: '2026-09-01T00:00:00.000Z' }
const reservation = (run = 1, attempt = 1): PaidAttemptReservation => ({ schemaVersion: STUDY_SCHEMA_VERSION, studyId: checkpoint.studyId, studyRunNumber: run, paidAttemptNumber: attempt, month: alternatingSchedule()[run - 1]!, productionBaselineSha: PRODUCTION_BASELINE_SHA, observerSha: checkpoint.observerSha, configuration: FROZEN_CONFIGURATION, reservedAtUtc: `2026-09-01T00:00:${String(attempt).padStart(2, '0')}.000Z` })
const assistant = (stopReason: AssistantMessage['stopReason'] = 'stop', provider = 'openai', model = 'gpt-5.6-luna'): AgentEvent => ({
  type: 'message_end',
  message: {
    role: 'assistant', content: [{ type: 'text', text: 'not persisted' }], api: 'openai-responses', provider, model,
    usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, reasoning: 3, totalTokens: 18, cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 } },
    stopReason, timestamp: 1,
  },
})

test('observer stores public usage but no model text, raw targets, reasoning, or provider payload', () => {
  const observer = new StudyObserver(metadata, () => '2026-09-01T00:00:01.000Z')
  observer.observe({ type: 'tool_execution_start', toolCallId: 'read', toolName: 'workspace_read_text', args: { path: 'confidential-customer-name.md' } })
  observer.observe({ type: 'tool_execution_end', toolCallId: 'read', toolName: 'workspace_read_text', result: { content: [] }, isError: false })
  observer.observe(assistant())
  const record = observer.finalize({ validation: validation('PASS'), outputBytes: 123, inputHashesUnchanged: true, elapsedMs: 50, rssBytes: 1000, integrity })
  assert.equal(record.status, 'PASS')
  assert.equal(record.requestCount, 1)
  assert.equal(record.usage.reasoning, 3)
  assert.equal(record.usage.catalogEstimatedCostUsd, 0.03)
  const serialized = JSON.stringify(record)
  assert.doesNotMatch(serialized, /not persisted|confidential-customer-name|providerPayload|chainOfThought|reasoningContent/u)
  assert.match(serialized, /sha256:/u)
})

test('security outranks invalid, and incomplete or drifted event streams cannot pass', () => {
  const invalid = new StudyObserver(metadata)
  assert.equal(invalid.finalize({ validation: null, inputHashesUnchanged: true, elapsedMs: 1, rssBytes: 1, integrity, invalidReason: 'observer crashed with password=hunter2' }).status, 'INVALID')
  const mutation = new StudyObserver(metadata)
  const incident = mutation.finalize({ validation: validation('PASS'), outputBytes: 1, inputHashesUnchanged: false, elapsedMs: 1, rssBytes: 1, integrity: { ...integrity, inputMutation: true }, invalidReason: 'observer crashed' })
  assert.equal(incident.status, 'FAIL')
  assert.equal(incident.failureTaxonomy, 'SECURITY_OR_INTEGRITY')
  assert.doesNotMatch(JSON.stringify(incident), /hunter2|password/u)
  const empty = new StudyObserver(metadata)
  assert.equal(empty.finalize({ validation: validation('PASS'), outputBytes: 1, inputHashesUnchanged: true, elapsedMs: 1, rssBytes: 1, integrity }).status, 'INVALID')
  const drift = new StudyObserver(metadata); drift.observe(assistant('stop', 'another-provider', 'another-model'))
  assert.equal(drift.finalize({ validation: validation('PASS'), outputBytes: 1, inputHashesUnchanged: true, elapsedMs: 1, rssBytes: 1, integrity }).status, 'INVALID')
})

test('Tool validation error followed by exact-target success is a conservative self-correction', () => {
  const observer = new StudyObserver(metadata, () => '2026-09-01T00:00:01.000Z')
  const start = (id: string): AgentEvent => ({ type: 'tool_execution_start', toolCallId: id, toolName: 'spreadsheet_update', args: { workbook: 'output/report.xlsx', sheet: 'Report', range: 'D5:D5', values: [[{ formula: '=B5-C5' }]] } })
  observer.observe(start('bad'))
  observer.observe({ type: 'tool_execution_end', toolCallId: 'bad', toolName: 'spreadsheet_update', result: { content: [{ type: 'text', text: 'validation error api_key=very-secret-value' }] }, isError: true })
  observer.observe(start('fixed'))
  observer.observe({ type: 'tool_execution_end', toolCallId: 'fixed', toolName: 'spreadsheet_update', result: { content: [{ type: 'text', text: 'large successful result is not stored' }] }, isError: false })
  observer.observe(assistant())
  const record = observer.finalize({ validation: validation('PASS'), outputBytes: 100, inputHashesUnchanged: true, elapsedMs: 1, rssBytes: 1, integrity })
  assert.equal(record.status, 'PASS')
  assert.equal(record.toolErrorCount, 1)
  assert.equal(record.selfCorrectionCount, 1)
  assert.doesNotMatch(JSON.stringify(record), /very-secret-value|large successful result/u)
})

test('public Pi faux Agent stream integrates with the observer without content persistence', async () => {
  const provider = fauxProvider({ provider: 'openai', models: [{ id: 'gpt-5.6-luna', reasoning: true }] })
  provider.setResponses([fauxAssistantMessage('private replay response')])
  const models = createModels(); models.setProvider(provider.provider)
  const model = models.getModel('openai', 'gpt-5.6-luna')!
  const observer = new StudyObserver(metadata)
  const agent = new Agent({ initialState: { systemPrompt: 'test', model, thinkingLevel: 'medium', tools: [] }, streamFn: models.streamSimple.bind(models) })
  agent.subscribe(event => observer.observe(event))
  await agent.prompt('test prompt')
  const record = observer.finalize({ validation: validation('PASS'), outputBytes: 1, inputHashesUnchanged: true, elapsedMs: 1, rssBytes: 1, integrity })
  assert.equal(record.status, 'PASS')
  assert.doesNotMatch(JSON.stringify(record), /private replay response|test prompt/u)
})

test('aggregate validates one provenance and reports invalid integrity plus reserved-attempt budget', () => {
  const records: StudyRunRecord[] = []
  const reservations: PaidAttemptReservation[] = []
  for (let index = 0; index < 20; index++) {
    const runMetadata = { ...metadata, studyRunNumber: index + 1, paidAttemptNumber: index + 1, month: index % 2 === 0 ? '7月' as const : '8月' as const }
    const observer = new StudyObserver(runMetadata); observer.observe(assistant())
    records.push(observer.finalize({ validation: validation(index < 16 ? 'PASS' : 'FAIL'), outputBytes: 100, inputHashesUnchanged: true, elapsedMs: index + 1, rssBytes: 100 + index, integrity }))
    reservations.push(reservation(index + 1, index + 1))
  }
  const aggregate = aggregateStudy(records, checkpoint, reservations)
  assert.deepEqual(aggregate.reliability.combined, { pass: 16, fail: 4, total: 20, wilson95: wilson95(16, 20) })
  assert.equal(aggregate.performance.elapsedMs.median, 10.5)
  assert.equal(aggregate.budget.catalogEstimatedCostUsd, 0.6)
  assert.equal(aggregate.budget.paidAttemptsReserved, 20)
  assert.throws(() => aggregateStudy([{ ...records[0]!, observerSha: 'b'.repeat(40) }], checkpoint, [reservations[0]!]), /mixed study provenance/u)
})

test('checkpoint, reservation, and run files are validated, immutable, and restart-safe', async () => {
  const root = await mkdtemp(join(tmpdir(), 'misen-study-io-'))
  const workspace = join(root, 'workspace'), evidence = join(root, 'evidence')
  try {
    await mkdir(workspace)
    const directory = await prepareEvidenceDirectory(evidence, workspace)
    await assert.rejects(prepareEvidenceDirectory(join(workspace, 'evidence'), workspace), /outside/u)
    await writeCheckpoint(directory, checkpoint)
    await assert.rejects(writeCheckpoint(directory, checkpoint), /exist/u)
    await reservePaidAttempt(directory, reservation())
    await assert.rejects(reservePaidAttempt(directory, reservation()), /sequentially|already reserved|exist/u)
    const observer = new StudyObserver(metadata); observer.observe(assistant())
    const record = observer.finalize({ validation: validation('PASS'), outputBytes: 100, inputHashesUnchanged: true, elapsedMs: 1, rssBytes: 1, integrity })
    await persistRun(directory, record)
    await assert.rejects(persistRun(directory, record), /exist/u)
    assert.equal((await readRunRecords(directory)).length, 1)
    assert.equal((await readReservations(directory)).length, 1)
    assert.match(await readFile(join(directory, 'sample-started.json'), 'utf8'), /startedAtUtc/u)
    assert.doesNotMatch(await readFile(join(directory, 'aggregate.json'), 'utf8'), /"(?:apiKey|credential|chainOfThought|rawProviderPayload)"\s*:/u)
    const tampered = { ...checkpoint, maxPaidAttempts: 25 }
    await writeFile(join(directory, 'checkpoint.json'), JSON.stringify(tampered), 'utf8')
    await assert.rejects(readCheckpoint(directory), /limits mismatch/u)
  } finally { await rm(root, { recursive: true, force: true }) }
})
