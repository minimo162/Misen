import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const resultPath = path.join(projectRoot, '.tmp', 'gate-result.json')
const requestedArgs = process.argv.slice(2)
const liveConverter = requestedArgs.includes('--live-converter')
const liveCopilot = requestedArgs.includes('--live-copilot')
const liveCopilotV2 = requestedArgs.includes('--live-copilot-v2')
const liveOllama = requestedArgs.includes('--live-ollama')
const liveCopilotArgs = requestedArgs.filter((arg) => arg !== '--live-converter' && arg !== '--live-copilot' && arg !== '--live-copilot-v2' && arg !== '--live-ollama')
const nodeCommand = process.execPath

const typecheckCommand = process.platform === 'win32'
  ? {
      command: process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', 'npx.cmd tsc --noEmit']
    }
  : { command: 'npx', args: ['tsc', '--noEmit'] }

const stages = [
  { name: 'typecheck', ...typecheckCommand },
  { name: 'build', command: nodeCommand, args: ['esbuild.config.mjs'] },
  { name: 'smoke', command: nodeCommand, args: ['dist/smoke.js'], requiresBuild: true },
  { name: 'benchmark', command: nodeCommand, args: ['dist/benchmark-test.js'], requiresBuild: true },
  { name: 'flex-validate', command: nodeCommand, args: ['dist/flex-harness.js'], requiresBuild: true },
  {
    name: 'live-converter',
    command: nodeCommand,
    args: ['dist/flex-harness.js', '--live'],
    enabled: liveConverter,
    requiresBuild: true,
    skipReason: 'enable with --live-converter'
  },
  {
    name: 'live-copilot',
    command: nodeCommand,
    args: ['test/measure-flex-copilot.mjs', ...liveCopilotArgs],
    enabled: liveCopilot,
    requiresBuild: true,
    skipReason: 'enable with --live-copilot'
  },
  {
    name: 'live-copilot-v2',
    command: nodeCommand,
    args: ['test/measure-flex-copilot-v2.mjs', ...liveCopilotArgs],
    enabled: liveCopilotV2,
    requiresBuild: true,
    skipReason: 'enable with --live-copilot-v2'
  },
  {
    name: 'live-ollama',
    command: nodeCommand,
    args: ['test/measure-flex-ollama.mjs', ...liveCopilotArgs],
    enabled: liveOllama,
    requiresBuild: true,
    skipReason: 'enable with --live-ollama'
  }
]

const summaryPattern = /^[A-Z0-9_]+_SUMMARY(?:\s|$)/u
const ansiPattern = /\u001b\[[0-?]*[ -/]*[@-~]/gu

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

  console.log('\nGate summary')
  console.log(render(headers))
  console.log(widths.map((width) => '-'.repeat(width)).join('-+-'))
  for (const row of rows) console.log(render(row))
}

const startedAt = new Date().toISOString()
const results = []
let buildPassed = null

for (const stage of stages) {
  let result
  if (stage.enabled === false) {
    result = skippedStage(stage, stage.skipReason)
  } else if (stage.requiresBuild && buildPassed === false) {
    result = skippedStage(stage, 'build failed; dist-dependent stage was not run')
  } else {
    result = await runStage(stage)
  }
  results.push(result)
  if (stage.name === 'build') buildPassed = result.status === 'pass'
}

const overall = results.some((result) => result.status === 'fail') ? 'fail' : 'pass'
const gateResult = {
  startedAt,
  finishedAt: new Date().toISOString(),
  overall,
  stages: results
}

await fs.mkdir(path.dirname(resultPath), { recursive: true })
await fs.writeFile(resultPath, `${JSON.stringify(gateResult, null, 2)}\n`, 'utf8')
printTable(results)
console.log(`\nResult JSON: ${path.relative(projectRoot, resultPath)}`)
process.exitCode = overall === 'pass' ? 0 : 1
