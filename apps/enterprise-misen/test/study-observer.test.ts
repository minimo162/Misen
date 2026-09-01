import test from 'node:test'
import { strict as assert } from 'node:assert'
import { Agent } from '@earendil-works/pi-agent-core'
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, type AssistantMessage } from '@earendil-works/pi-ai'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent } from '@earendil-works/pi-agent-core'
import { AXIS_NAMES, type ValidationResult } from '../src/acceptance/validator.js'
import { fixture } from '../demo/enterprise-excel/fixtures.js'
import { enterpriseTools } from '../src/capabilities/tools.js'
import { WorkspaceBoundary } from '../src/workspace/boundary.js'
import { aggregateStudy, wilson95 } from '../study/aggregate.js'
import { assertRunRecord, prepareEvidenceDirectory, persistRun, readCheckpoint, readReservations, readRunRecords, reservePaidAttempt, writeCheckpoint } from '../study/io.js'
import { StudyObserver } from '../study/observer.js'
import { protectedTrackedFileCounts } from '../study/provenance.js'
import { sameFixtureInputs, snapshotFixtureInputs } from '../study/integrity.js'
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
const begin = (observer: StudyObserver) => { observer.observe({ type: 'agent_start' }); observer.observe({ type: 'turn_start' }) }
const finish = (observer: StudyObserver, event = assistant()) => {
  observer.observe(event)
  const message = (event as Extract<AgentEvent, { type: 'message_end' }>).message
  observer.observe({ type: 'turn_end', message, toolResults: [] })
  observer.observe({ type: 'agent_end', messages: [message] })
}
const complete = (observer: StudyObserver, event = assistant()) => { begin(observer); finish(observer, event) }

test('observer stores public usage but no model text, raw targets, reasoning, or provider payload', () => {
  const observer = new StudyObserver(metadata, () => '2026-09-01T00:00:01.000Z')
  begin(observer)
  observer.observe({ type: 'tool_execution_start', toolCallId: 'read', toolName: 'workspace_read_text', args: { path: 'confidential-customer-name.md' } })
  observer.observe({ type: 'tool_execution_end', toolCallId: 'read', toolName: 'workspace_read_text', result: { content: [] }, isError: false })
  finish(observer)
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
  const drift = new StudyObserver(metadata); complete(drift, assistant('stop', 'another-provider', 'another-model'))
  const driftRecord = drift.finalize({ validation: validation('PASS'), outputBytes: 1, inputHashesUnchanged: true, elapsedMs: 1, rssBytes: 1, integrity })
  assert.equal(driftRecord.status, 'INVALID')
  assert.doesNotThrow(() => assertRunRecord(driftRecord))
})

test('provider failure is a reliability FAIL and Tool errors emit their taxonomy when Acceptance cannot pass', () => {
  const provider = new StudyObserver(metadata); complete(provider, assistant('error'))
  assert.equal(provider.finalize({ validation: null, inputHashesUnchanged: true, elapsedMs: 1, rssBytes: 1, integrity, agentErrorMessage: 'transport detail', acceptanceFatal: 'missing output' }).failureTaxonomy, 'PROVIDER_OR_TRANSPORT')
  const tool = new StudyObserver(metadata); begin(tool)
  tool.observe({ type: 'tool_execution_start', toolCallId: 'bad', toolName: 'spreadsheet_update', args: { range: 'A1' } })
  tool.observe({ type: 'tool_execution_end', toolCallId: 'bad', toolName: 'spreadsheet_update', result: { message: 'validation failed' }, isError: true })
  finish(tool)
  assert.equal(tool.finalize({ validation: validation('FAIL'), inputHashesUnchanged: true, elapsedMs: 1, rssBytes: 1, integrity }).failureTaxonomy, 'TOOL_CONTRACT_OR_VALIDATION')
})

test('Tool validation error followed by exact-target success is a conservative self-correction', () => {
  const observer = new StudyObserver(metadata, () => '2026-09-01T00:00:01.000Z')
  begin(observer)
  const start = (id: string): AgentEvent => ({ type: 'tool_execution_start', toolCallId: id, toolName: 'spreadsheet_update', args: { workbook: 'output/report.xlsx', sheet: 'Report', range: 'D5:D5', values: [[{ formula: '=B5-C5' }]] } })
  observer.observe(start('bad'))
  observer.observe({ type: 'tool_execution_end', toolCallId: 'bad', toolName: 'spreadsheet_update', result: { content: [{ type: 'text', text: 'validation error api_key=very-secret-value' }] }, isError: true })
  observer.observe(start('fixed'))
  observer.observe({ type: 'tool_execution_end', toolCallId: 'fixed', toolName: 'spreadsheet_update', result: { content: [{ type: 'text', text: 'large successful result is not stored' }] }, isError: false })
  finish(observer)
  const record = observer.finalize({ validation: validation('PASS'), outputBytes: 100, inputHashesUnchanged: true, elapsedMs: 1, rssBytes: 1, integrity })
  assert.equal(record.status, 'PASS')
  assert.equal(record.toolErrorCount, 1)
  assert.equal(record.selfCorrectionCount, 1)
  assert.doesNotMatch(JSON.stringify(record), /very-secret-value|large successful result/u)
})

test('persisted Tool evidence rejects fabricated correction, nested payloads, and duplicate sequencing', () => {
  const observer = new StudyObserver(metadata, () => '2026-09-01T00:00:01.000Z')
  begin(observer)
  observer.observe({ type: 'tool_execution_start', toolCallId: 'bad', toolName: 'spreadsheet_update', args: { range: 'A1' } })
  observer.observe({ type: 'tool_execution_end', toolCallId: 'bad', toolName: 'spreadsheet_update', result: { message: 'validation failed' }, isError: true })
  finish(observer)
  const record = observer.finalize({ validation: validation('FAIL'), inputHashesUnchanged: true, elapsedMs: 1, rssBytes: 1, integrity })
  assert.equal(record.selfCorrectionCount, 0)
  assert.doesNotThrow(() => assertRunRecord(record))
  assert.throws(() => assertRunRecord({ ...record, selfCorrectionCount: 1 }), /self-correction/u)
  assert.throws(() => assertRunRecord({ ...record, toolResults: [{ ...record.toolResults[0]!, error: { ...record.toolResults[0]!.error!, rawProviderPayload: 'secret' } }] }), /Tool error fields|forbidden evidence/u)
  assert.throws(() => assertRunRecord({ ...record, toolResults: [{ ...record.toolResults[0]!, sequence: record.toolStarts[0]!.sequence }] }), /sequence/u)
  assert.throws(() => assertRunRecord({ ...record, toolStarts: [{ ...record.toolStarts[0]!, sequence: 2 }], toolResults: [{ ...record.toolResults[0]!, sequence: 1 }] }), /start\/result/u)
  assert.throws(() => assertRunRecord({ ...record, startedAtUtc: 'not-a-time' }), /timestamps/u)
  assert.throws(() => assertRunRecord({ ...record, startedAtUtc: '2026-09-01' }), /timestamps/u)
  assert.throws(() => assertRunRecord({ ...record, startedAtUtc: '2026-02-31T00:00:00.000Z' }), /timestamps/u)
  assert.throws(() => assertRunRecord({ ...record, failureTaxonomy: 'MADE_UP' }), /taxonomy/u)
  assert.throws(() => assertRunRecord({ ...record, failureSummary: 'Bearer private-value' }), /sensitive evidence/u)
  assert.throws(() => assertRunRecord({ ...record, failureSummary: { rawProviderPayload: 'secret' } }), /forbidden evidence|summary/u)
  assert.throws(() => assertRunRecord({ ...record, assistantStopReasons: [{ bad: true }] }), /provider or stop-reason/u)
  assert.throws(() => assertRunRecord({ ...record, observedProviders: { openai: true } }), /provider or stop-reason/u)
  assert.throws(() => assertRunRecord({ ...record, toolStarts: [{ ...record.toolStarts[0]!, timestampUtc: '2026-08-31T23:59:59.000Z' }] }), /Tool start/u)
  assert.throws(() => assertRunRecord({ ...record, toolResults: [{ ...record.toolResults[0]!, timestampUtc: '2026-08-31T23:59:59.000Z' }] }), /Tool result|chronology/u)
  const correctionObserver = new StudyObserver(metadata, (() => { const times = ['2026-09-01T00:00:01.000Z','2026-09-01T00:00:02.000Z','2026-09-01T00:00:03.000Z','2026-09-01T00:00:04.000Z']; let index = 0; return () => times[index++] ?? times.at(-1)! })())
  begin(correctionObserver); correctionObserver.observe({ type: 'tool_execution_start', toolCallId: 'one', toolName: 'workspace_read_text', args: { path: 'one' } }); correctionObserver.observe({ type: 'tool_execution_start', toolCallId: 'two', toolName: 'workspace_read_text', args: { path: 'two' } }); correctionObserver.observe({ type: 'tool_execution_end', toolCallId: 'one', toolName: 'workspace_read_text', result: {}, isError: false }); correctionObserver.observe({ type: 'tool_execution_end', toolCallId: 'two', toolName: 'workspace_read_text', result: {}, isError: false }); finish(correctionObserver)
  const chronology = correctionObserver.finalize({ validation: validation('PASS'), outputBytes: 10, inputHashesUnchanged: true, elapsedMs: 1, rssBytes: 1, integrity, endedAtUtc: '2026-09-01T00:00:05.000Z' })
  assert.throws(() => assertRunRecord({ ...chronology, toolResults: chronology.toolResults.map((result, index) => index === 0 ? { ...result, timestampUtc: '2026-09-01T00:00:01.500Z' } : result) }), /chronology/u)
  const passObserver = new StudyObserver(metadata); begin(passObserver); passObserver.observe({ type: 'tool_execution_start', toolCallId: 'read', toolName: 'workspace_read_text', args: { path: '業務引継ぎ.md' } }); passObserver.observe({ type: 'tool_execution_end', toolCallId: 'read', toolName: 'workspace_read_text', result: {}, isError: false }); finish(passObserver)
  const pass = passObserver.finalize({ validation: validation('PASS'), outputBytes: 10, inputHashesUnchanged: true, elapsedMs: 1, rssBytes: 1, integrity })
  assert.throws(() => assertRunRecord({ ...pass, output: { ...pass.output!, rawProviderPayload: 'secret' } }), /output fields|forbidden evidence/u)
  assert.throws(() => assertRunRecord({ ...pass, axisMatrix: { ...pass.axisMatrix!, SHEET: { ...pass.axisMatrix!.SHEET, evidence: { rawProviderPayload: 'secret' } } } }), /forbidden evidence/u)
})

test('provenance protected pathspecs resolve to tracked repository files', () => {
  const counts = protectedTrackedFileCounts()
  assert.deepEqual(Object.keys(counts).sort(), ['apps/enterprise-misen/acceptance','apps/enterprise-misen/demo','apps/enterprise-misen/package-lock.json','apps/enterprise-misen/src'].sort())
  assert.equal(Object.values(counts).every(count => count > 0), true)
})

test('public Pi lifecycle without the frozen Tool loop is rejected as incomplete', async () => {
  const provider = fauxProvider({ provider: 'openai', models: [{ id: 'gpt-5.6-luna', reasoning: true }] })
  provider.setResponses([fauxAssistantMessage('private replay response')])
  const models = createModels(); models.setProvider(provider.provider)
  const model = models.getModel('openai', 'gpt-5.6-luna')!
  const observer = new StudyObserver(metadata)
  const agent = new Agent({ initialState: { systemPrompt: 'test', model, thinkingLevel: 'medium', tools: [] }, streamFn: models.streamSimple.bind(models) })
  agent.subscribe(event => observer.observe(event))
  await agent.prompt('test prompt')
  const record = observer.finalize({ validation: validation('PASS'), outputBytes: 1, inputHashesUnchanged: true, elapsedMs: 1, rssBytes: 1, integrity })
  assert.equal(record.status, 'INVALID')
  assert.doesNotMatch(JSON.stringify(record), /private replay response|test prompt/u)
})

test('public Pi faux tool loop supplies lifecycle and balanced Tool evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'misen-study-pi-loop-'))
  try {
    await fixture(root)
    const provider = fauxProvider({ provider: 'openai', models: [{ id: 'gpt-5.6-luna', reasoning: true }] })
    provider.setResponses([
      fauxAssistantMessage(fauxToolCall('workspace_list_files', { path: '../', extension: '.xlsx' }, { id: 'bad-list' })),
      fauxAssistantMessage(fauxToolCall('workspace_list_files', { path: '7月', extension: '.xlsx' }, { id: 'list' })),
      fauxAssistantMessage('private completion'),
    ])
    const models = createModels(); models.setProvider(provider.provider)
    const model = models.getModel('openai', 'gpt-5.6-luna')!
    const observer = new StudyObserver(metadata)
    const agent = new Agent({ initialState: { systemPrompt: 'test', model, thinkingLevel: 'medium', tools: enterpriseTools(new WorkspaceBoundary(root)) }, streamFn: models.streamSimple.bind(models) })
    agent.subscribe(event => observer.observe(event))
    await agent.prompt('private prompt')
    const record = observer.finalize({ validation: validation('PASS'), outputBytes: 1, inputHashesUnchanged: true, elapsedMs: 1, rssBytes: 1, integrity })
    assert.equal(record.status, 'PASS')
    assert.equal(record.lifecycle.agentStart, 1)
    assert.equal(record.toolBalance, true)
    assert.equal(record.toolErrorCount, 1)
    assert.doesNotMatch(JSON.stringify(record), /private completion|private prompt/u)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('fixture integrity detects content changes, additions, and deletions outside output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'misen-study-integrity-'))
  try {
    await fixture(root)
    const before = await snapshotFixtureInputs(root)
    await writeFile(join(root, '業務引継ぎ.md'), 'changed', 'utf8')
    assert.equal(sameFixtureInputs(before, await snapshotFixtureInputs(root)), false)
    await fixture(root)
    await writeFile(join(root, 'unexpected.txt'), 'added', 'utf8')
    assert.equal(sameFixtureInputs(before, await snapshotFixtureInputs(root)), false)
    await rm(join(root, 'unexpected.txt'))
    await rm(join(root, '8月', 'Alpha.xlsx'))
    assert.equal(sameFixtureInputs(before, await snapshotFixtureInputs(root)), false)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('aggregate validates one provenance and reports invalid integrity plus reserved-attempt budget', () => {
  const records: StudyRunRecord[] = []
  const reservations: PaidAttemptReservation[] = []
  for (let index = 0; index < 20; index++) {
    const runMetadata = { ...metadata, studyRunNumber: index + 1, paidAttemptNumber: index + 1, month: index % 2 === 0 ? '7月' as const : '8月' as const }
    const observer = new StudyObserver(runMetadata); begin(observer); observer.observe({ type: 'tool_execution_start', toolCallId: `read-${index}`, toolName: 'workspace_read_text', args: { path: '業務引継ぎ.md' } }); observer.observe({ type: 'tool_execution_end', toolCallId: `read-${index}`, toolName: 'workspace_read_text', result: {}, isError: false }); finish(observer)
    records.push(observer.finalize({ validation: validation(index < 16 ? 'PASS' : 'FAIL'), outputBytes: 100, inputHashesUnchanged: true, elapsedMs: index + 1, rssBytes: 100 + index, integrity }))
    reservations.push(reservation(index + 1, index + 1))
  }
  const aggregate = aggregateStudy(records, checkpoint, reservations)
  assert.deepEqual(aggregate.reliability.combined, { pass: 16, fail: 4, total: 20, wilson95: wilson95(16, 20) })
  assert.equal(aggregate.performance.elapsedMs.median, 10.5)
  assert.equal(aggregate.budget.catalogEstimatedCostUsd, 0.6)
  assert.equal(aggregate.budget.paidAttemptsReserved, 20)
  const correctionUnknown = { ...records[0]!, selfCorrectionCount: null, toolValidationErrorCount: 5 }
  const correctionKnown = { ...records[1]!, selfCorrectionCount: 1, toolValidationErrorCount: 2 }
  const correctionAggregate = aggregateStudy([correctionUnknown, correctionKnown], checkpoint, [reservations[0]!, reservations[1]!])
  assert.equal(correctionAggregate.behavior.selfCorrectionFrequency, 0.5)
  assert.throws(() => aggregateStudy([{ ...records[0]!, observerSha: 'b'.repeat(40) }], checkpoint, [reservations[0]!]), /mixed study provenance/u)
  assert.throws(() => aggregateStudy([records[0]!, { ...records[1]!, studyRunNumber: 1, month: '7月' }], checkpoint, [reservations[0]!, { ...reservations[1]!, studyRunNumber: 1, month: '7月' }]), /valid-run sequence/u)
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
    const observer = new StudyObserver(metadata); begin(observer); observer.observe({ type: 'tool_execution_start', toolCallId: 'read', toolName: 'workspace_read_text', args: { path: '業務引継ぎ.md' } }); observer.observe({ type: 'tool_execution_end', toolCallId: 'read', toolName: 'workspace_read_text', result: {}, isError: false }); finish(observer)
    const record = observer.finalize({ validation: validation('PASS'), outputBytes: 100, inputHashesUnchanged: true, elapsedMs: 1, rssBytes: 1, integrity })
    await persistRun(directory, record)
    await assert.rejects(persistRun(directory, record), /exist|valid-run sequence/u)
    assert.equal((await readRunRecords(directory)).length, 1)
    assert.equal((await readReservations(directory)).length, 1)
    assert.match(await readFile(join(directory, 'sample-started.json'), 'utf8'), /startedAtUtc/u)
    assert.doesNotMatch(await readFile(join(directory, 'aggregate.json'), 'utf8'), /"(?:apiKey|credential|chainOfThought|rawProviderPayload)"\s*:/u)
    const runPath = join(directory, 'run-01-attempt-01.json')
    await writeFile(runPath, JSON.stringify({ ...record, observerSha: 'b'.repeat(40) }), 'utf8')
    await assert.rejects(readRunRecords(directory), /run\/checkpoint provenance/u)
    await writeFile(runPath, JSON.stringify({ ...record, paidAttemptNumber: 2 }), 'utf8')
    await assert.rejects(readRunRecords(directory), /filename/u)
    await writeFile(runPath, JSON.stringify({ ...record, studyRunNumber: 2, month: '8月' }), 'utf8')
    await writeFile(join(directory, 'run-02-attempt-01.json'), await readFile(runPath, 'utf8'), 'utf8')
    await rm(runPath)
    await writeFile(join(directory, 'attempt-01-reservation.json'), JSON.stringify(reservation(2, 1)), 'utf8')
    await assert.rejects(readRunRecords(directory), /valid-run sequence/u)
    await rm(join(directory, 'run-02-attempt-01.json'))
    await writeFile(join(directory, 'attempt-01-reservation.json'), JSON.stringify(reservation()), 'utf8')
    await writeFile(runPath, JSON.stringify({ ...record, rawProviderPayload: { secret: true }, output: { basename: '../bad.xlsx', bytes: -1 }, integrity: { ...record.integrity, inputMutation: true, credentialExposure: true } }), 'utf8')
    await assert.rejects(readRunRecords(directory), /fields mismatch|output evidence|PASS invariants/u)
    const reservationPath = join(directory, 'attempt-01-reservation.json')
    await writeFile(reservationPath, JSON.stringify({ ...reservation(), observerSha: 'b'.repeat(40) }), 'utf8')
    await assert.rejects(readReservations(directory), /provenance mismatch/u)
    const tampered = { ...checkpoint, maxPaidAttempts: 25 }
    await writeFile(join(directory, 'checkpoint.json'), JSON.stringify(tampered), 'utf8')
    await assert.rejects(readCheckpoint(directory), /limits mismatch/u)
  } finally { await rm(root, { recursive: true, force: true }) }
})
