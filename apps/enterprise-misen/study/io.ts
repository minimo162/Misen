import { mkdir, open, readFile, readdir, realpath, rename, writeFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { aggregateStudy } from './aggregate.js'
import {
  FROZEN_CONFIGURATION,
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
const sameConfiguration = (value: unknown): boolean => JSON.stringify(value) === JSON.stringify(FROZEN_CONFIGURATION)

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
  if (item.intendedValidRuns !== 20 || item.maxPaidAttempts !== 24 || item.hardSpendCapUsd !== 10) throw new Error('study limits mismatch')
  if (JSON.stringify(item.schedule) !== JSON.stringify(alternatingSchedule())) throw new Error('study schedule mismatch')
  if (item.restartRule !== 'observer-change-restarts-at-run-1') throw new Error('restart rule mismatch')
  if (item.costAuthority !== 'pi-catalog-estimate-from-public-usage') throw new Error('cost authority mismatch')
  if (item.providerHardCapConfirmed !== true || item.hardSpendEnforcement !== 'provider-account-hard-cap-plus-observer-ledger') throw new Error('hard-cap confirmation missing')
  if (typeof item.createdAtUtc !== 'string' || !Number.isFinite(Date.parse(item.createdAtUtc))) throw new Error('invalid checkpoint timestamp')
}

export function assertRunRecord(value: unknown): asserts value is StudyRunRecord {
  assertCommon(value)
  const item = value as unknown as StudyRunRecord
  if (!Number.isInteger(item.studyRunNumber) || item.studyRunNumber < 1 || item.studyRunNumber > 20) throw new Error('invalid study run number')
  if (!Number.isInteger(item.paidAttemptNumber) || item.paidAttemptNumber < 1 || item.paidAttemptNumber > 24) throw new Error('invalid paid attempt number')
  if (!['7月', '8月'].includes(item.month) || item.month !== alternatingSchedule()[item.studyRunNumber - 1]) throw new Error('run schedule mismatch')
  if (!['PASS', 'FAIL', 'INVALID'].includes(item.status)) throw new Error('invalid run status')
  if (typeof item.startedAtUtc !== 'string' || typeof item.endedAtUtc !== 'string') throw new Error('missing run timestamps')
  if (!Array.isArray(item.toolStarts) || !Array.isArray(item.toolResults) || !Array.isArray(item.assistantStopReasons)) throw new Error('invalid event evidence')
  if (!item.integrity || typeof item.integrity.inputMutation !== 'boolean' || typeof item.integrity.forbiddenCapability !== 'boolean') throw new Error('invalid integrity evidence')
}

export function assertReservation(value: unknown): asserts value is PaidAttemptReservation {
  assertCommon(value)
  const item = value as unknown as PaidAttemptReservation
  if (!Number.isInteger(item.studyRunNumber) || item.studyRunNumber < 1 || item.studyRunNumber > 20) throw new Error('invalid reserved run number')
  if (!Number.isInteger(item.paidAttemptNumber) || item.paidAttemptNumber < 1 || item.paidAttemptNumber > 24) throw new Error('invalid reserved attempt number')
  if (item.month !== alternatingSchedule()[item.studyRunNumber - 1]) throw new Error('reservation schedule mismatch')
  if (typeof item.reservedAtUtc !== 'string' || !Number.isFinite(Date.parse(item.reservedAtUtc))) throw new Error('invalid reservation timestamp')
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
    return value
  }))
  if (new Set(records.map(record => record.paidAttemptNumber)).size !== records.length) throw new Error('duplicate paid attempt evidence')
  return records
}

export async function readReservations(evidenceDirectory: string): Promise<PaidAttemptReservation[]> {
  const names = (await readdir(evidenceDirectory)).filter(name => /^attempt-\d{2}-reservation\.json$/u.test(name)).sort()
  return Promise.all(names.map(async name => {
    const value: unknown = JSON.parse(await readFile(resolve(evidenceDirectory, name), 'utf8'))
    assertReservation(value)
    return value
  }))
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
  const name = `run-${String(record.studyRunNumber).padStart(2, '0')}-attempt-${String(record.paidAttemptNumber).padStart(2, '0')}.json`
  await immutableJson(resolve(evidenceDirectory, name), record)
  const records = await readRunRecords(evidenceDirectory)
  await replaceableJson(resolve(evidenceDirectory, 'aggregate.json'), aggregateStudy(records, checkpoint, reservations))
}
