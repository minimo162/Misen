// Tiered regression runner for Enterprise Misen (Issue #93 C).
//
//   node scripts/test.mjs unit         no OfficeCLI, no network, no browser (default `npm test`, target < 30 s)
//   node scripts/test.mjs integration  OfficeCLI-backed tests; needs MISEN_OFFICECLI_PATH
//   node scripts/test.mjs study        Issue #73 frozen-study observer tests (informational, see docs)
//   node scripts/test.mjs live         acceptance/live.js against the configured Brain (manual only)
//   node scripts/test.mjs all          unit + integration
//
// Tiers are selected by file name: `*.integration.test.ts` -> integration, `*.study.test.ts` -> study,
// every other `*.test.ts` -> unit. The build is incremental (scripts/build.mjs); pass --force-build to rebuild.
import { spawn } from 'node:child_process'
import { access, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureBuilt } from './build.mjs'

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const compiledTests = join(appRoot, 'dist', 'test')
const UNIT_BUDGET_MS = 30_000

const argv = process.argv.slice(2)
const tier = argv.find((arg) => !arg.startsWith('--')) ?? 'unit'
const forceBuild = argv.includes('--force-build')
if (!['unit', 'integration', 'study', 'live', 'all'].includes(tier)) {
  console.error(`[test] unknown tier: ${tier} (expected unit | integration | study | live | all)`)
  process.exit(2)
}

function classify(name) {
  if (!name.endsWith('.test.js')) return null
  if (name.endsWith('.integration.test.js')) return 'integration'
  if (name.endsWith('.study.test.js')) return 'study'
  return 'unit'
}

async function compiledTestFiles(wanted) {
  const entries = await readdir(compiledTests)
  return entries
    .filter((name) => wanted.includes(classify(name)))
    .sort()
    .map((name) => join('dist', 'test', name))
}

function runNode(args, env) {
  return new Promise((resolveExit) => {
    const child = spawn(process.execPath, args, { cwd: appRoot, env, stdio: 'inherit', windowsHide: true })
    child.on('error', (error) => {
      console.error(`[test] failed to start node: ${error.message}`)
      resolveExit(1)
    })
    child.on('close', (code) => resolveExit(code ?? 1))
  })
}

async function requireOfficeCli() {
  const path = process.env.MISEN_OFFICECLI_PATH
  if (!path) {
    console.error('[test] MISEN_OFFICECLI_PATH is not set. Integration tests run the pinned OfficeCLI executable.')
    console.error('[test]   acquire: npm run acquire:officecli-runtime -- --output <dir>')
    console.error('[test]   then:    set MISEN_OFFICECLI_PATH=<dir>\\officecli.exe')
    process.exit(2)
  }
  try {
    await access(path)
  } catch {
    console.error(`[test] MISEN_OFFICECLI_PATH does not exist: ${path}`)
    process.exit(2)
  }
}

const started = performance.now()
await ensureBuilt({ force: forceBuild })

const runs = []
if (tier === 'unit' || tier === 'all') {
  // Tool construction resolves the OfficeCLI path eagerly (fail-closed production contract). Unit tests may
  // construct the tool roster but must never invoke OfficeCLI, so point the path at a file that cannot exist:
  // any accidental invocation fails with `missing_binary` instead of silently using a developer's binary.
  const sentinel = join(tmpdir(), 'misen-unit-tier-no-officecli', 'officecli.exe')
  runs.push({
    name: 'unit',
    files: await compiledTestFiles(['unit']),
    env: { ...process.env, MISEN_OFFICECLI_PATH: sentinel, MISEN_TEST_TIER: 'unit' },
    budgetMs: UNIT_BUDGET_MS,
  })
}
if (tier === 'integration' || tier === 'all') {
  await requireOfficeCli()
  runs.push({
    name: 'integration',
    files: await compiledTestFiles(['integration']),
    env: { ...process.env, OFFICECLI_NO_AUTO_RESIDENT: '1', OFFICECLI_SKIP_UPDATE: '1', MISEN_TEST_TIER: 'integration' },
  })
}
if (tier === 'study') {
  await requireOfficeCli()
  runs.push({ name: 'study', files: await compiledTestFiles(['study']), env: { ...process.env, MISEN_TEST_TIER: 'study' } })
}
if (tier === 'live') {
  runs.push({ name: 'live', files: null, env: { ...process.env, MISEN_TEST_TIER: 'live' } })
}

let failed = false
for (const run of runs) {
  const runStarted = performance.now()
  console.log(`\n=== ${run.name} (${run.files ? `${run.files.length} files` : 'acceptance/live.js'}) ===`)
  const code = run.files
    ? await runNode(['--test', ...run.files], run.env)
    : await runNode([join('dist', 'acceptance', 'live.js')], run.env)
  const ms = Math.round(performance.now() - runStarted)
  if (code !== 0) failed = true
  console.log(`[test] ${run.name}: ${code === 0 ? 'PASS' : `FAIL (exit ${code})`} in ${ms} ms`)
  if (run.budgetMs && ms > run.budgetMs) console.warn(`[test] ${run.name} exceeded its ${run.budgetMs} ms budget`)
}
console.log(`[test] total ${Math.round(performance.now() - started)} ms (tier: ${tier})`)
process.exitCode = failed ? 1 : 0
