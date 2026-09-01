import { mkdir, open, readFile, readdir, realpath, rename, writeFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { aggregateStudy } from './aggregate.js'
import { AXIS_NAMES } from '../src/acceptance/validator.js'
import {
  FROZEN_CONFIGURATION,
  FAILURE_TAXONOMIES,
  PRODUCTION_BASELINE_SHA,
  STUDY_SCHEMA_VERSION,
  alternatingSchedule,
  type PaidAttemptReservation,
  type StudyCheckpoint,
  type StudyRunRecord,
} from './schema.js'

const inside = (parent: string, child: string) => { const rel = relative(parent, child); return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)) }
const hex40 = /^[0-9a-f]{40}$/u
const safeStudyId = /^[a-z0-9][a-z0-9._-]{0,79}$/u
const utcTimestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u
const validUtc = (value: unknown): value is string => typeof value === 'string' && utcTimestamp.test(value) && Number.isFinite(Date.parse(value))
const sameConfiguration = (value: unknown): boolean => JSON.stringify(value) === JSON.stringify(FROZEN_CONFIGURATION)
const exactKeys = (value: object, keys: readonly string[], label: string): void => {
  const actual = Object.keys(value).sort(), expected = [...keys].sort()
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${label} fields mismatch`)
}
const forbiddenEvidenceKey = /^(?:rawProviderPayload|chainOfThought|reasoningContent|credential|apiKey|authorization|password|secret|token|cookie)$/iu
function assertSafeEvidence(value: unknown, label: string, depth = 0): void {
  if (depth > 12) throw new Error(`${label} nesting exceeds limit`)
  if (value === null || ['string','boolean'].includes(typeof value)) return
  if (typeof value === 'number' && Number.isFinite(value)) return
  if (Array.isArray(value)) { for (const item of value) assertSafeEvidence(item, label, depth + 1); return }
  if (!value || typeof value !== 'object') throw new Error(`${label} contains unsupported evidence`)
  for (const [key, item] of Object.entries(value)) {
    if (forbiddenEvidenceKey.test(key)) throw new Error(`${label} contains forbidden evidence field`)
    assertSafeEvidence(item, label, depth + 1)
  }
}

function assertCommon(value: unknown): asserts value is { schemaVersion: 1; studyId: string; productionBaselineSha: string; observerSha: string; configuration: unknown } {
  if (!value || typeof value !== 'object') throw new Error('study evidence must be an object')
  const item = value as Record<string, unknown>
  if (item.schemaVersion !== STUDY_SCHEMA_VERSION) throw new Error('unsupported study schema')
  if (typeof item.studyId !== 'string' || !safeStudyId.test(item.studyId)) throw new Error('invalid study ID')
  if (item.productionBaselineSha !== PRODUCTION_BASELINE_SHA) throw new Error('production baseline mismatch')
  if (typeof item.observerSha !== 'string' || !hex40.test(item.observerSha)) throw new Error('invalid observer SHA')
  if (!sameConfiguration(item.configuration)) throw new Error('frozen configuration mismatch')
}

export function assertCheckpoint(value: unknown): asserts value is StudyCheckpoint {
  assertCommon(value)
  const item = value as unknown as StudyCheckpoint
  exactKeys(item, ['schemaVersion','studyId','productionBaselineSha','observerSha','intendedValidRuns','maxPaidAttempts','hardSpendCapUsd','schedule','configuration','restartRule','costAuthority','providerHardCapConfirmed','hardSpendEnforcement','createdAtUtc'], 'checkpoint')
  if (item.intendedValidRuns !== 20 || item.maxPaidAttempts !== 24 || item.hardSpendCapUsd !== 10) throw new Error('study limits mismatch')
  if (JSON.stringify(item.schedule) !== JSON.stringify(alternatingSchedule())) throw new Error('study schedule mismatch')
  if (item.restartRule !== 'observer-change-restarts-at-run-1') throw new Error('restart rule mismatch')
  if (item.costAuthority !== 'pi-catalog-estimate-from-public-usage') throw new Error('cost authority mismatch')
  if (item.providerHardCapConfirmed !== true || item.hardSpendEnforcement !== 'provider-account-hard-cap-plus-observer-ledger') throw new Error('hard-cap confirmation missing')
  if (!validUtc(item.createdAtUtc)) throw new Error('invalid checkpoint timestamp')
}

export function assertRunRecord(value: unknown): asserts value is StudyRunRecord {
  assertCommon(value)
  const item = value as unknown as StudyRunRecord
  exactKeys(item, ['schemaVersion','studyId','studyRunNumber','paidAttemptNumber','month','productionBaselineSha','observerSha','configuration','startedAtUtc','endedAtUtc','status','failureTaxonomy','failureSummary','axisMatrix','output','inputHashesUnchanged','toolStarts','toolResults','toolBalance','toolErrorCount','toolValidationErrorCount','selfCorrectionCount','requestCount','lifecycle','assistantStopReasons','observedProviders','observedModels','usage','elapsedMs','rssBytes','integrity','invalidReason'], 'run')
  assertSafeEvidence(item, 'run')
  if (!Number.isInteger(item.studyRunNumber) || item.studyRunNumber < 1 || item.studyRunNumber > 20) throw new Error('invalid study run number')
  if (!Number.isInteger(item.paidAttemptNumber) || item.paidAttemptNumber < 1 || item.paidAttemptNumber > 24) throw new Error('invalid paid attempt number')
  if (!['7月', '8月'].includes(item.month) || item.month !== alternatingSchedule()[item.studyRunNumber - 1]) throw new Error('run schedule mismatch')
  if (!['PASS', 'FAIL', 'INVALID'].includes(item.status)) throw new Error('invalid run status')
  if (!validUtc(item.startedAtUtc) || !validUtc(item.endedAtUtc)
    || Date.parse(item.endedAtUtc) < Date.parse(item.startedAtUtc)) throw new Error('invalid run timestamps')
  if (item.failureTaxonomy !== null && !FAILURE_TAXONOMIES.includes(item.failureTaxonomy)) throw new Error('invalid failure taxonomy')
  if (item.failureSummary !== null && typeof item.failureSummary !== 'string' || item.invalidReason !== null && typeof item.invalidReason !== 'string') throw new Error('invalid run summary evidence')
  if (!Array.isArray(item.toolStarts) || !Array.isArray(item.toolResults) || !Array.isArray(item.assistantStopReasons)) throw new Error('invalid event evidence')
  if (item.assistantStopReasons.some(reason => typeof reason !== 'string')
    || !Array.isArray(item.observedProviders) || item.observedProviders.some(provider => typeof provider !== 'string')
    || !Array.isArray(item.observedModels) || item.observedModels.some(model => typeof model !== 'string')
    || new Set(item.observedProviders).size !== item.observedProviders.length || new Set(item.observedModels).size !== item.observedModels.length) throw new Error('invalid provider or stop-reason evidence')
  if (!item.integrity || ![true, false, null].includes(item.integrity.inputMutation) || typeof item.integrity.forbiddenCapability !== 'boolean'
    || ![true, false, null].includes(item.integrity.credentialExposure) || ![true, false, null].includes(item.integrity.unexpectedNetwork)) throw new Error('invalid integrity evidence')
  if (![true, false, null].includes(item.inputHashesUnchanged)) throw new Error('invalid input hash evidence')
  if (!item.lifecycle || !Object.values(item.lifecycle).every(count => Number.isInteger(count) && count >= 0)) throw new Error('invalid lifecycle evidence')
  exactKeys(item.lifecycle, ['agentStart','agentEnd','turnStart','turnEnd'], 'lifecycle')
  if (!Number.isInteger(item.requestCount) || item.requestCount !== item.assistantStopReasons.length) throw new Error('request count mismatch')
  const startIds = new Set(item.toolStarts.map(start => start.toolCallId)), endIds = new Set(item.toolResults.map(result => result.toolCallId))
  if (startIds.size !== item.toolStarts.length || endIds.size !== item.toolResults.length) throw new Error('duplicate Tool call ID')
  const eventSequences = [...item.toolStarts, ...item.toolResults].map(event => event.sequence).sort((left, right) => left - right)
  if (eventSequences.some((sequence, index) => sequence !== index + 1)) throw new Error('Tool event sequence mismatch')
  const computedBalance = item.toolStarts.length === item.toolResults.length && item.toolStarts.every(start => endIds.has(start.toolCallId)) && item.toolResults.every(result => startIds.has(result.toolCallId))
  if (item.toolBalance !== computedBalance) throw new Error('invalid tool balance evidence')
  if (item.toolErrorCount !== item.toolResults.filter(result => result.isError).length || item.toolValidationErrorCount !== item.toolResults.filter(result => result.validationError).length) throw new Error('tool count mismatch')
  for (const start of item.toolStarts) {
    if (!FROZEN_CONFIGURATION.tools.includes(start.toolName) || !Number.isInteger(start.sequence) || start.sequence < 1 || typeof start.toolCallId !== 'string') throw new Error('invalid Tool start evidence')
    exactKeys(start, start.valuesShape === undefined ? ['sequence','toolCallId','toolName','timestampUtc','target'] : ['sequence','toolCallId','toolName','timestampUtc','target','valuesShape'], 'Tool start')
    if (!start.toolCallId || !validUtc(start.timestampUtc) || Date.parse(start.timestampUtc) < Date.parse(item.startedAtUtc) || Date.parse(start.timestampUtc) > Date.parse(item.endedAtUtc)
      || !start.target || typeof start.target !== 'object' || Array.isArray(start.target)) throw new Error('invalid Tool start evidence')
    for (const [key, target] of Object.entries(start.target)) if (!['path','extension','workbook','sheet','range','source','output','offset','limit','overwrite'].includes(key)
      || !['string','number','boolean'].includes(typeof target) || (typeof target === 'string' && !/^sha256:[0-9a-f]{16}$/u.test(target))) throw new Error('invalid Tool target evidence')
    if (start.valuesShape && (Object.keys(start.valuesShape).sort().join(',') !== 'columns,formulas,literals,rows' || Object.values(start.valuesShape).some(count => typeof count !== 'number' || !Number.isInteger(count) || count < 0))) throw new Error('invalid values-shape evidence')
  }
  for (const result of item.toolResults) {
    const start = item.toolStarts.find(candidate => candidate.toolCallId === result.toolCallId)
    if (!start || start.toolName !== result.toolName || !Number.isInteger(result.sequence) || result.sequence <= start.sequence) throw new Error('Tool start/result mismatch')
    exactKeys(result, result.isError ? ['sequence','toolCallId','toolName','timestampUtc','isError','validationError','error'] : ['sequence','toolCallId','toolName','timestampUtc','isError','validationError'], 'Tool result')
    if (!validUtc(result.timestampUtc) || Date.parse(result.timestampUtc) < Date.parse(start.timestampUtc) || Date.parse(result.timestampUtc) > Date.parse(item.endedAtUtc)
      || typeof result.isError !== 'boolean' || typeof result.validationError !== 'boolean' || result.isError !== Boolean(result.error) || (result.validationError && !result.isError)) throw new Error('Tool result fields mismatch')
    if (result.error) {
      exactKeys(result.error, ['class','code','message'], 'Tool error')
      if (result.error.class !== 'ToolError' || result.error.code !== null || !['tool validation error','tool execution error'].includes(result.error.message)
        || result.validationError !== (result.error.message === 'tool validation error')) throw new Error('invalid Tool error evidence')
    }
  }
  let computedSelfCorrectionCount: number | null = 0
  for (const failure of item.toolResults.filter(result => result.validationError)) {
    const failedStart = item.toolStarts.find(start => start.toolCallId === failure.toolCallId)
    const signature = failedStart ? JSON.stringify(failedStart.target) : ''
    if (!failedStart || signature === '{}') { computedSelfCorrectionCount = null; break }
    const recovered = item.toolResults.some(success => {
      const successStart = item.toolStarts.find(start => start.toolCallId === success.toolCallId)
      return !success.isError && success.sequence > failure.sequence && success.toolName === failure.toolName
        && successStart !== undefined && JSON.stringify(successStart.target) === signature
    })
    if (recovered && computedSelfCorrectionCount !== null) computedSelfCorrectionCount++
  }
  if (item.selfCorrectionCount !== computedSelfCorrectionCount) throw new Error('invalid self-correction evidence')
  exactKeys(item.usage, ['input','output','cacheRead','cacheWrite','reasoning','totalTokens','catalogEstimatedCostUsd'], 'usage')
  const usageValues = [item.usage.input, item.usage.output, item.usage.cacheRead, item.usage.cacheWrite, item.usage.totalTokens, item.usage.reasoning, item.usage.catalogEstimatedCostUsd]
  if (usageValues.some(number => number !== null && (!Number.isFinite(number) || number < 0))) throw new Error('invalid usage evidence')
  const securityIncident = item.integrity.inputMutation === true || item.integrity.forbiddenCapability || item.integrity.credentialExposure === true || item.integrity.unexpectedNetwork === true
  exactKeys(item.integrity, ['inputMutation','forbiddenCapability','credentialExposure','unexpectedNetwork'], 'integrity')
  if (!Number.isFinite(item.elapsedMs) || item.elapsedMs < 0 || !Number.isFinite(item.rssBytes) || item.rssBytes < 0) throw new Error('invalid performance evidence')
  if (item.output) {
    exactKeys(item.output, ['basename','bytes'], 'output')
    if (!Number.isInteger(item.output.bytes) || item.output.bytes < 0 || !/^[^\\/]+\.xlsx$/iu.test(item.output.basename)) throw new Error('invalid output evidence')
  }
  if (item.axisMatrix) {
    exactKeys(item.axisMatrix, AXIS_NAMES, 'axis matrix')
    for (const [axisName, axis] of Object.entries(item.axisMatrix)) {
    if (!AXIS_NAMES.includes(axisName as typeof AXIS_NAMES[number]) || !axis || typeof axis !== 'object') throw new Error('invalid axis evidence')
    exactKeys(axis, ['status','evidence'], 'axis')
    if (!['PASS','FAIL'].includes(axis.status)) throw new Error('invalid axis evidence')
    assertSafeEvidence(axis.evidence, 'axis')
    }
  }
  if (item.status === 'PASS') {
    if (item.failureTaxonomy !== null || item.failureSummary !== null || item.invalidReason !== null || item.inputHashesUnchanged !== true || !item.output || item.requestCount < 1
      || !item.toolBalance || item.toolStarts.length < 1 || item.lifecycle.agentStart !== 1 || item.lifecycle.agentEnd !== 1 || item.lifecycle.turnStart < 1 || item.lifecycle.turnStart !== item.lifecycle.turnEnd
      || securityIncident || JSON.stringify(item.observedProviders) !== JSON.stringify([FROZEN_CONFIGURATION.provider]) || JSON.stringify(item.observedModels) !== JSON.stringify([FROZEN_CONFIGURATION.model])) throw new Error('PASS invariants violated')
    if (!item.axisMatrix || JSON.stringify(Object.keys(item.axisMatrix).sort()) !== JSON.stringify([...AXIS_NAMES].sort()) || Object.values(item.axisMatrix).some(axis => axis.status !== 'PASS')) throw new Error('PASS axis matrix incomplete')
  } else if (item.status === 'INVALID') {
    if (item.failureTaxonomy !== 'INVALID_OBSERVER_OR_INFRA' || item.invalidReason === null || securityIncident) throw new Error('INVALID invariants violated')
  } else {
    if (item.failureTaxonomy === null || item.failureTaxonomy === 'INVALID_OBSERVER_OR_INFRA' || item.invalidReason !== null) throw new Error('FAIL invariants violated')
    if (securityIncident && item.failureTaxonomy !== 'SECURITY_OR_INTEGRITY') throw new Error('security taxonomy mismatch')
  }
}

export function assertReservation(value: unknown): asserts value is PaidAttemptReservation {
  assertCommon(value)
  const item = value as unknown as PaidAttemptReservation
  exactKeys(item, ['schemaVersion','studyId','studyRunNumber','paidAttemptNumber','month','productionBaselineSha','observerSha','configuration','reservedAtUtc'], 'reservation')
  if (!Number.isInteger(item.studyRunNumber) || item.studyRunNumber < 1 || item.studyRunNumber > 20) throw new Error('invalid reserved run number')
  if (!Number.isInteger(item.paidAttemptNumber) || item.paidAttemptNumber < 1 || item.paidAttemptNumber > 24) throw new Error('invalid reserved attempt number')
  if (item.month !== alternatingSchedule()[item.studyRunNumber - 1]) throw new Error('reservation schedule mismatch')
  if (!validUtc(item.reservedAtUtc)) throw new Error('invalid reservation timestamp')
}

export async function prepareEvidenceDirectory(evidenceDirectory: string, workspaceRoot?: string): Promise<string> {
  if (!isAbsolute(evidenceDirectory)) throw new Error('evidence directory must be absolute')
  const absolute = resolve(evidenceDirectory)
  if (workspaceRoot && inside(resolve(workspaceRoot), absolute)) throw new Error('evidence directory must be outside the Agent workspace')
  await mkdir(absolute, { recursive: true })
  const actual = await realpath(absolute)
  if (workspaceRoot) {
    const workspace = await realpath(workspaceRoot)
    if (inside(workspace, actual)) throw new Error('evidence directory resolves inside the Agent workspace')
  }
  return actual
}

function safeSerialized(value: unknown): string {
  const serialized = JSON.stringify(value, null, 2) + '\n'
  const forbidden = /"(?:rawProviderPayload|chainOfThought|reasoningContent|credential|apiKey|authorization|password|secret|token|cookie)"\s*:/iu
  const secretShape = /(?:\bsk-[A-Za-z0-9_-]{8,}\b|\bBearer\s+\S+|\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b)/iu
  if (forbidden.test(serialized) || secretShape.test(serialized)) throw new Error('secret or raw-reasoning evidence rejected')
  return serialized
}

async function immutableJson(path: string, value: unknown): Promise<void> {
  const handle = await open(path, 'wx')
  try { await handle.writeFile(safeSerialized(value), 'utf8'); await handle.sync() }
  finally { await handle.close() }
}

async function replaceableJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, safeSerialized(value), { encoding: 'utf8', flag: 'wx' })
  await rename(temporary, path)
}

export async function writeCheckpoint(evidenceDirectory: string, checkpoint: StudyCheckpoint): Promise<void> {
  assertCheckpoint(checkpoint)
  await immutableJson(resolve(evidenceDirectory, 'checkpoint.json'), checkpoint)
}

export async function readCheckpoint(evidenceDirectory: string): Promise<StudyCheckpoint> {
  const value: unknown = JSON.parse(await readFile(resolve(evidenceDirectory, 'checkpoint.json'), 'utf8'))
  assertCheckpoint(value)
  return value
}

export async function readRunRecords(evidenceDirectory: string): Promise<StudyRunRecord[]> {
  const names = (await readdir(evidenceDirectory)).filter(name => /^run-\d{2}-attempt-\d{2}\.json$/u.test(name)).sort()
  const records = await Promise.all(names.map(async name => {
    const value: unknown = JSON.parse(await readFile(resolve(evidenceDirectory, name), 'utf8'))
    assertRunRecord(value)
    const expectedName = `run-${String(value.studyRunNumber).padStart(2, '0')}-attempt-${String(value.paidAttemptNumber).padStart(2, '0')}.json`
    if (name !== expectedName) throw new Error('run filename does not match record')
    return value
  }))
  if (new Set(records.map(record => record.paidAttemptNumber)).size !== records.length) throw new Error('duplicate paid attempt evidence')
  const checkpoint = await readCheckpoint(evidenceDirectory)
  const reservations = await readReservations(evidenceDirectory)
  for (const record of records) {
    if (record.studyId !== checkpoint.studyId || record.productionBaselineSha !== checkpoint.productionBaselineSha || record.observerSha !== checkpoint.observerSha || !sameConfiguration(record.configuration)) throw new Error('run/checkpoint provenance mismatch')
    const reservation = reservations.find(item => item.paidAttemptNumber === record.paidAttemptNumber)
    if (!reservation || reservation.studyRunNumber !== record.studyRunNumber || reservation.month !== record.month) throw new Error('run/reservation mismatch')
  }
  return records
}

export async function readReservations(evidenceDirectory: string): Promise<PaidAttemptReservation[]> {
  const names = (await readdir(evidenceDirectory)).filter(name => /^attempt-\d{2}-reservation\.json$/u.test(name)).sort()
  const reservations = await Promise.all(names.map(async name => {
    const value: unknown = JSON.parse(await readFile(resolve(evidenceDirectory, name), 'utf8'))
    assertReservation(value)
    if (name !== `attempt-${String(value.paidAttemptNumber).padStart(2, '0')}-reservation.json`) throw new Error('reservation filename does not match record')
    return value
  }))
  const checkpoint = await readCheckpoint(evidenceDirectory)
  for (const reservation of reservations) {
    if (reservation.studyId !== checkpoint.studyId || reservation.productionBaselineSha !== checkpoint.productionBaselineSha || reservation.observerSha !== checkpoint.observerSha || !sameConfiguration(reservation.configuration)) throw new Error('reservation/checkpoint provenance mismatch')
  }
  if (reservations.some((reservation, index) => reservation.paidAttemptNumber !== index + 1)) throw new Error('reservation sequence is not contiguous')
  return reservations
}

export async function reservePaidAttempt(evidenceDirectory: string, reservation: PaidAttemptReservation): Promise<void> {
  assertReservation(reservation)
  const checkpoint = await readCheckpoint(evidenceDirectory)
  if (reservation.studyId !== checkpoint.studyId || reservation.observerSha !== checkpoint.observerSha) throw new Error('reservation provenance mismatch')
  const existing = await readReservations(evidenceDirectory)
  if (existing.length >= checkpoint.maxPaidAttempts) throw new Error('maximum paid attempts already reserved')
  if (reservation.paidAttemptNumber !== existing.length + 1) throw new Error('paid attempts must be reserved sequentially')
  if (existing.some(item => item.paidAttemptNumber === reservation.paidAttemptNumber)) throw new Error('paid attempt already reserved')
  await immutableJson(resolve(evidenceDirectory, `attempt-${String(reservation.paidAttemptNumber).padStart(2, '0')}-reservation.json`), reservation)
  if (existing.length === 0) await immutableJson(resolve(evidenceDirectory, 'sample-started.json'), { schemaVersion: STUDY_SCHEMA_VERSION, studyId: checkpoint.studyId, observerSha: checkpoint.observerSha, startedAtUtc: reservation.reservedAtUtc })
}

export async function persistRun(evidenceDirectory: string, record: StudyRunRecord): Promise<void> {
  assertRunRecord(record)
  const checkpoint = await readCheckpoint(evidenceDirectory)
  if (record.studyId !== checkpoint.studyId || record.observerSha !== checkpoint.observerSha) throw new Error('run provenance mismatch')
  const reservations = await readReservations(evidenceDirectory)
  const reservation = reservations.find(item => item.paidAttemptNumber === record.paidAttemptNumber)
  if (!reservation || reservation.studyRunNumber !== record.studyRunNumber || reservation.month !== record.month) throw new Error('run has no matching paid-attempt reservation')
  const existing = await readRunRecords(evidenceDirectory)
  let expectedRun = 1
  for (const prior of [...existing].sort((left, right) => left.paidAttemptNumber - right.paidAttemptNumber)) {
    if (prior.studyRunNumber !== expectedRun) throw new Error('existing valid-run sequence mismatch')
    if (prior.status !== 'INVALID') expectedRun++
  }
  if (record.studyRunNumber !== expectedRun) throw new Error('valid-run sequence mismatch')
  const name = `run-${String(record.studyRunNumber).padStart(2, '0')}-attempt-${String(record.paidAttemptNumber).padStart(2, '0')}.json`
  await immutableJson(resolve(evidenceDirectory, name), record)
  const records = await readRunRecords(evidenceDirectory)
  await replaceableJson(resolve(evidenceDirectory, 'aggregate.json'), aggregateStudy(records, checkpoint, reservations))
}
