import { resolve } from 'node:path'
import { prepareEvidenceDirectory, writeCheckpoint } from './io.js'
import { alternatingSchedule, FROZEN_CONFIGURATION, PRODUCTION_BASELINE_SHA, STUDY_SCHEMA_VERSION, type StudyCheckpoint } from './schema.js'

const args = new Map<string, string>()
for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index]!, process.argv[index + 1] ?? '')
const evidenceDirectory = args.get('--evidence-dir'), observerSha = args.get('--observer-sha'), studyId = args.get('--study-id') ?? 'misen-enterprise-pi-reliability-2026'
if (!evidenceDirectory || !observerSha || args.get('--provider-hard-cap-confirmed') !== 'true') throw new Error('usage: study:checkpoint -- --evidence-dir <absolute> --observer-sha <40hex> --provider-hard-cap-confirmed true [--study-id <id>]')
const directory = await prepareEvidenceDirectory(resolve(evidenceDirectory))
const checkpoint: StudyCheckpoint = {
  schemaVersion: STUDY_SCHEMA_VERSION,
  studyId,
  productionBaselineSha: PRODUCTION_BASELINE_SHA,
  observerSha,
  intendedValidRuns: 20,
  maxPaidAttempts: 24,
  hardSpendCapUsd: 10,
  schedule: alternatingSchedule(),
  configuration: FROZEN_CONFIGURATION,
  restartRule: 'observer-change-restarts-at-run-1',
  costAuthority: 'pi-catalog-estimate-from-public-usage',
  providerHardCapConfirmed: true,
  hardSpendEnforcement: 'provider-account-hard-cap-plus-observer-ledger',
  createdAtUtc: new Date().toISOString(),
}
await writeCheckpoint(directory, checkpoint)
console.log(JSON.stringify(checkpoint))
