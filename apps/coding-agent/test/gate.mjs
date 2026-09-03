import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

// Regression gate with three tiers (Issue #93 C):
//   unit        … no network, no external process, no browser. Default for `npm test`.
//   integration … process/wall-clock bound smoke sub-tests (spawn node/powershell, real loopback servers).
//   live        … needs a real provider (Copilot/Ollama/converter); opt in with the --live-* flags.
// typecheck + build are skipped when nothing under src/, test/, vendor/ or the build inputs changed since
// the last successful build (stamp in .tmp/build-stamp.json). Pass --force-build to rebuild anyway.

const projectRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const tmpDir = path.join(projectRoot, '.tmp')
const resultPath = path.join(tmpDir, 'gate-result.json')
const stampPath = path.join(tmpDir, 'build-stamp.json')
const nodeCommand = process.execPath

const argv = process.argv.slice(2)
const tierIndex = argv.indexOf('--tier')
const tier = tierIndex >= 0 ? argv[tierIndex + 1] : 'unit'
if (!['unit', 'integration', 'live', 'all'].includes(tier)) {
  console.error(`[gate] unknown tier: ${tier} (expected unit | integration | live | all)`)
  process.exit(2)
}
const forceBuild = argv.includes('--force-build')
const liveFlags = ['--live-converter', '--live-copilot', '--live-copilot-v2', '--live-ollama', '--live-computer-use']
const enabledLive = new Set(liveFlags.filter((flag) => argv.includes(flag)))
const consumed = new Set([...liveFlags, '--force-build', '--tier'])
const liveArgs = argv.filter((arg, index) => !consumed.has(arg) && !(index > 0 && argv[index - 1] === '--tier'))

const typecheckCommand = process.platform === 'win32'
  ? { command: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', 'npx.cmd tsc --noEmit'] }
  : { command: 'npx', args: ['tsc', '--noEmit'] }

const buildStages = [
  { name: 'typecheck', ...typecheckCommand, build: true },
  { name: 'build', command: nodeCommand, args: ['esbuild.config.mjs'], build: true }
]

const unitStages = [
  { name: 'smoke', command: nodeCommand, args: ['dist/smoke.js', '--tier', 'unit'], requiresBuild: true },
  { name: 'benchmark', command: nodeCommand, args: ['dist/benchmark-test.js'], requiresBuild: true },
  { name: 'multimodal', command: nodeCommand, args: ['dist/multimodal-test.js'], requiresBuild: true },
  { name: 'computer-use-demo', command: nodeCommand, args: ['dist/computer-use-demo-test.js'], requiresBuild: true },
  { name: 'computer-use-safety', command: nodeCommand, args: ['dist/computer-use-safety-test.js'], requiresBuild: true },
  { name: 'vision-budget', command: nodeCommand, args: ['dist/vision-budget-test.js'], requiresBuild: true },
  { name: 'active-tools', command: nodeCommand, args: ['dist/active-tools-test.js'], requiresBuild: true },
  { name: 'completion-policy', command: nodeCommand, args: ['dist/completion-policy-test.js'], requiresBuild: true },
  { name: 'request-telemetry', command: nodeCommand, args: ['dist/request-telemetry-test.js'], requiresBuild: true },
  { name: 'working-context', command: nodeCommand, args: ['dist/working-context-test.js'], requiresBuild: true },
  { name: 'flex-validate', command: nodeCommand, args: ['dist/flex-harness.js'], requiresBuild: true }
]

const integrationStages = [
  { name: 'smoke-process', command: nodeCommand, args: ['dist/smoke.js', '--tier', 'integration'], requiresBuild: true }
]

const liveStages = [
  { name: 'live-converter', flag: '--live-converter', command: nodeCommand, args: ['dist/flex-harness.js', '--live'] },
  { name: 'live-copilot', flag: '--live-copilot', command: nodeCommand, args: ['test/measure-flex-copilot.mjs', ...liveArgs] },
  { name: 'live-copilot-v2', flag: '--live-copilot-v2', command: nodeCommand, args: ['test/measure-flex-copilot-v2.mjs', ...liveArgs] },
  { name: 'live-ollama', flag: '--live-ollama', command: nodeCommand, args: ['test/measure-flex-ollama.mjs', ...liveArgs] },
  { name: 'live-computer-use', flag: '--live-computer-use', command: nodeCommand, args: ['dist/measure-computer-use-ollama.js', ...liveArgs] }
].map((stage) => ({ ...stage, requiresBuild: true, enabled: enabledLive.has(stage.flag), skipReason: `enable with ${stage.flag}` }))

if (tier === 'live' && enabledLive.size === 0) {
  console.error(`[gate] tier live needs at least one of: ${liveFlags.join(' ')}`)
  process.exit(2)
}

const stages = [
  ...buildStages,
  ...(tier === 'unit' || tier === 'all' ? unitStages : []),
  ...(tier === 'integration' || tier === 'all' ? integrationStages : []),
  ...(tier === 'live' || tier === 'all' ? liveStages : [])
]

const summaryPattern = /^[A-Z0-9_]+_SUMMARY(?:\s|$)/u
const ansiPattern = /\u001b\[[0-?]*[ -/]*[@-~]/gu

async function walk(directory, files) {
  const entries = await fs.readdir(directory, { withFileTypes: true })
  entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
  for (const entry of entries) {
    const full = path.join(directory, entry.name)
    if (entry.isDirectory()) await walk(full, files)
    else if (entry.isFile()) files.push(full)
  }
  return files
}

async function buildInputDigest() {
  const files = []
  for (const directory of ['src', 'test', 'vendor']) {
    try { await walk(path.join(projectRoot, directory), files) } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  for (const file of ['esbuild.config.mjs', 'tsconfig.json', 'package.json', 'package-lock.json']) files.push(path.join(projectRoot, file))
  const hash = createHash('sha256')
  hash.update(process.version)
  for (const file of files) {
    let bytes
    try { bytes = await fs.readFile(file) } catch (error) { if (error.code === 'ENOENT') continue; throw error }
    hash.update(path.relative(projectRoot, file).replaceAll('\\', '/'))
    hash.update('\0')
    hash.update(bytes)
    hash.update('\0')
  }
  return hash.digest('hex')
}

async function buildOutputsPresent() {
  try {
    await Promise.all(['index.js', 'server.js', 'smoke.js', 'flex-harness.js', 'benchmark-test.js'].map((file) => fs.access(path.join(projectRoot, 'dist', file))))
    return true
  } catch {
    return false
  }
}

async function readStamp() {
  try { return JSON.parse(await fs.readFile(stampPath, 'utf8')) } catch { return null }
}

function summaryCollector(stream, destination, summaryLines) {
  let pending = ''
  stream.setEncoding('utf8')
  stream.on('data', (chunk) => {
    destination.write(chunk)
    const lines = `${pending}${chunk}`.split(/\r?\n/u)
    pending = lines.pop() ?? ''
    for (const line of lines) collectSummary(line, summaryLines)
  })
  stream.on('end', () => {
    if (pending) collectSummary(pending, summaryLines)
  })
}

function collectSummary(line, summaryLines) {
  const normalized = line.replace(ansiPattern, '').trim()
  if (summaryPattern.test(normalized)) summaryLines.push(normalized)
}

function runStage(stage) {
  console.log(`\n=== ${stage.name} ===`)
  const started = performance.now()
  const summaryLines = []

  return new Promise((resolve) => {
    let child
    try {
      child = spawn(stage.command, stage.args, {
        cwd: projectRoot,
        env: { ...process.env, NO_COLOR: '1' },
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch (error) {
      console.error(`[gate] ${stage.name} could not start: ${error instanceof Error ? error.message : String(error)}`)
      resolve({ name: stage.name, status: 'fail', ms: Math.round(performance.now() - started), exitCode: null, summaryLines })
      return
    }

    summaryCollector(child.stdout, process.stdout, summaryLines)
    summaryCollector(child.stderr, process.stderr, summaryLines)

    let spawnError = null
    child.on('error', (error) => {
      spawnError = error
      console.error(`[gate] ${stage.name} process error: ${error.message}`)
    })
    child.on('close', (code, signal) => {
      if (signal) console.error(`[gate] ${stage.name} terminated by signal ${signal}`)
      resolve({
        name: stage.name,
        status: !spawnError && code === 0 ? 'pass' : 'fail',
        ms: Math.round(performance.now() - started),
        exitCode: typeof code === 'number' ? code : null,
        summaryLines
      })
    })
  })
}

function skippedStage(stage, reason) {
  console.log(`\n=== ${stage.name} ===`)
  console.log(`SKIP: ${reason}`)
  return { name: stage.name, status: 'skip', ms: 0, exitCode: null, summaryLines: [] }
}

function printTable(results) {
  const headers = ['Stage', 'Status', 'Duration', 'Exit']
  const rows = results.map((result) => [
    result.name,
    result.status.toUpperCase(),
    `${result.ms} ms`,
    result.exitCode === null ? '-' : String(result.exitCode)
  ])
  const widths = headers.map((header, index) => Math.max(header.length, ...rows.map((row) => row[index].length)))
  const render = (row) => row.map((value, index) => value.padEnd(widths[index])).join(' | ')

  console.log(`\nGate summary (tier: ${tier})`)
  console.log(render(headers))
  console.log(widths.map((width) => '-'.repeat(width)).join('-+-'))
  for (const row of rows) console.log(render(row))
}

const startedAt = new Date().toISOString()
const gateStarted = performance.now()
const results = []
const inputDigest = await buildInputDigest()
const stamp = await readStamp()
const buildUpToDate = !forceBuild && stamp?.inputDigest === inputDigest && (await buildOutputsPresent())
let buildPassed = buildUpToDate ? true : null
let buildStagesPassed = 0

for (const stage of stages) {
  let result
  if (stage.build && buildUpToDate) {
    result = skippedStage(stage, 'sources unchanged since the last successful build (use --force-build to rebuild)')
  } else if (stage.enabled === false) {
    result = skippedStage(stage, stage.skipReason)
  } else if (stage.requiresBuild && buildPassed === false) {
    result = skippedStage(stage, 'build failed; dist-dependent stage was not run')
  } else {
    result = await runStage(stage)
  }
  results.push(result)
  if (stage.build) {
    if (result.status === 'fail') buildPassed = false
    if (result.status === 'pass') buildStagesPassed += 1
    if (buildStagesPassed === buildStages.length && buildPassed !== false) {
      buildPassed = true
      await fs.mkdir(tmpDir, { recursive: true })
      await fs.writeFile(stampPath, `${JSON.stringify({ inputDigest, builtAt: new Date().toISOString() }, null, 2)}\n`, 'utf8')
    }
  }
}

const overall = results.some((result) => result.status === 'fail') ? 'fail' : 'pass'
const gateResult = {
  startedAt,
  finishedAt: new Date().toISOString(),
  tier,
  overall,
  totalMs: Math.round(performance.now() - gateStarted),
  stages: results
}

await fs.mkdir(path.dirname(resultPath), { recursive: true })
await fs.writeFile(resultPath, `${JSON.stringify(gateResult, null, 2)}\n`, 'utf8')
printTable(results)
console.log(`Total: ${gateResult.totalMs} ms`)
console.log(`\nResult JSON: ${path.relative(projectRoot, resultPath)}`)
process.exitCode = overall === 'pass' ? 0 : 1
