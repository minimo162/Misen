import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fixture, PROMPTS, SYNTHETIC_MONTHS } from '../demo/enterprise-excel/fixtures.js'
import { snapshotOutputScope, validateReport, type ValidationResult } from '../src/acceptance/validator.js'
import { liveAgent } from '../src/runtime/live.js'
import { prepareEvidenceDirectory, persistRun, readCheckpoint, readReservations, readRunRecords, reservePaidAttempt } from './io.js'
import { StudyObserver } from './observer.js'
import { PRODUCTION_BASELINE_SHA, type StudyMonth } from './schema.js'
import { FROZEN_CONFIGURATION } from './schema.js'
import { verifyRepositoryProvenance } from './provenance.js'
import { sameFixtureInputs, snapshotFixtureInputs } from './integrity.js'
import { assertFrozenRuntimeContext, captureRuntimeContextBinding } from './context.js'

const args = new Map<string, string>()
for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index]!, process.argv[index + 1] ?? '')
const evidenceArg = args.get('--evidence-dir'), observerSha = args.get('--observer-sha')
const runNumber = Number(args.get('--run')), paidAttemptNumber = Number(args.get('--attempt'))
if (!evidenceArg || !observerSha || !Number.isInteger(runNumber) || !Number.isInteger(paidAttemptNumber)) throw new Error('usage: study:live -- --evidence-dir <absolute> --observer-sha <40hex> --run <1..20> --attempt <1..24>')
verifyRepositoryProvenance(observerSha)

const evidenceDirectory = await prepareEvidenceDirectory(resolve(evidenceArg))
const checkpoint = await readCheckpoint(evidenceDirectory)
if (checkpoint.productionBaselineSha !== PRODUCTION_BASELINE_SHA || checkpoint.observerSha !== observerSha) throw new Error('checkpoint SHA mismatch; observer changes require restart at run 1')
if (checkpoint.providerHardCapConfirmed !== true || checkpoint.hardSpendEnforcement !== 'provider-account-hard-cap-plus-observer-ledger') throw new Error('external USD 10 provider hard cap is not confirmed')
if (runNumber < 1 || runNumber > checkpoint.intendedValidRuns || paidAttemptNumber < 1 || paidAttemptNumber > checkpoint.maxPaidAttempts) throw new Error('run or paid-attempt number outside approved bounds')
const month = checkpoint.schedule[runNumber - 1] as StudyMonth
const existing = await readRunRecords(evidenceDirectory)
const reservations = await readReservations(evidenceDirectory)
if (reservations.length !== existing.length) throw new Error('unresolved paid-attempt reservation; stop and audit before any further request')
if (paidAttemptNumber !== reservations.length + 1) throw new Error('paid attempts must be reserved sequentially')
const nextRun = existing.filter(record => record.status !== 'INVALID').length + 1
if (runNumber !== nextRun) throw new Error('study run number must follow the valid-run sequence')
const catalogCosts = existing.map(record => record.usage.catalogEstimatedCostUsd)
if (catalogCosts.some(cost => cost === null)) throw new Error('catalog cost estimate unavailable; stop and audit before any further request')
const spent = catalogCosts.reduce((sum, cost) => sum + (cost ?? 0), 0)
if (spent >= checkpoint.hardSpendCapUsd) throw new Error('catalog-estimated spend has reached the hard-cap threshold')

const scenario = SYNTHETIC_MONTHS.find(candidate => candidate.month === month)!
const workspace = await mkdtemp(join(tmpdir(), 'misen-pi-study-workspace-'))
const startedAtUtc = new Date().toISOString(), started = performance.now()
const observer = new StudyObserver({ studyId: checkpoint.studyId, studyRunNumber: runNumber, paidAttemptNumber, month, productionBaselineSha: PRODUCTION_BASELINE_SHA, observerSha, startedAtUtc })
let validation: ValidationResult | null = null, outputBytes: number | undefined, agentErrorMessage: string | undefined, acceptanceFatal: string | undefined
let inputHashesUnchanged: boolean | null = null
let observerFailure = false, agentStarted = false, persistenceStarted = false

try {
  await fixture(workspace)
  const before = await snapshotFixtureInputs(workspace)
  const outputBefore = await snapshotOutputScope(workspace)
  assertFrozenRuntimeContext(await captureRuntimeContextBinding(workspace))
  const agent = await liveAgent(workspace)
  const actualTools = agent.state.tools.map(tool => tool.name)
  if (agent.state.model.provider !== FROZEN_CONFIGURATION.provider || agent.state.model.id !== FROZEN_CONFIGURATION.model
    || agent.state.thinkingLevel !== FROZEN_CONFIGURATION.reasoning || JSON.stringify(actualTools) !== JSON.stringify(FROZEN_CONFIGURATION.tools)) {
    throw new Error('actual Agent state differs from frozen study configuration')
  }
  agent.subscribe(event => { try { observer.observe(event) } catch { observerFailure = true; agent.abort() } })
  await reservePaidAttempt(evidenceDirectory, {
    schemaVersion: checkpoint.schemaVersion,
    studyId: checkpoint.studyId,
    studyRunNumber: runNumber,
    paidAttemptNumber,
    month,
    productionBaselineSha: checkpoint.productionBaselineSha,
    observerSha,
    configuration: checkpoint.configuration,
    reservedAtUtc: new Date().toISOString(),
  })
  agentStarted = true
  try { await agent.prompt(PROMPTS[month]) } catch (error) { agentErrorMessage = error instanceof Error ? error.message : String(error) }
  agentErrorMessage = agent.state.errorMessage ?? agentErrorMessage
  inputHashesUnchanged = sameFixtureInputs(before, await snapshotFixtureInputs(workspace))
  try {
    validation = await validateReport(workspace, scenario, before, outputBefore)
    outputBytes = (await stat(join(workspace, validation.output))).size
  } catch (error) {
    acceptanceFatal = error instanceof Error ? error.message : String(error)
  }
  const record = observer.finalize({
    validation,
    outputBytes,
    inputHashesUnchanged,
    elapsedMs: performance.now() - started,
    rssBytes: process.memoryUsage().rss,
    integrity: {
      inputMutation: !inputHashesUnchanged,
      forbiddenCapability: false,
      credentialExposure: null,
      unexpectedNetwork: null,
    },
    agentErrorMessage,
    acceptanceFatal,
    invalidReasonCode: observerFailure ? 'OBSERVER_CAPTURE_FAILURE' : undefined,
  })
  persistenceStarted = true
  await persistRun(evidenceDirectory, record)
  console.log(JSON.stringify({ status: record.status, run: runNumber, attempt: paidAttemptNumber, month, catalogEstimatedCostUsd: record.usage.catalogEstimatedCostUsd, evidenceDirectory }))
  if (record.status !== 'PASS') process.exitCode = 1
} catch (error) {
  if (!agentStarted || persistenceStarted) throw error
  const record = observer.finalize({
    validation: null,
    inputHashesUnchanged,
    elapsedMs: performance.now() - started,
    rssBytes: process.memoryUsage().rss,
    integrity: { inputMutation: inputHashesUnchanged === false ? true : null, forbiddenCapability: false, credentialExposure: null, unexpectedNetwork: null },
    invalidReasonCode: 'INFRASTRUCTURE_FAILURE',
  })
  await persistRun(evidenceDirectory, record)
  console.error(JSON.stringify({ status: record.status, run: runNumber, attempt: paidAttemptNumber, month, failureTaxonomy: record.failureTaxonomy, invalidReason: record.invalidReason }))
  process.exitCode = 1
} finally {
  await rm(workspace, { recursive: true, force: true })
}
