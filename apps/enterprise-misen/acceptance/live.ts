import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fixture, PROMPTS, SYNTHETIC_MONTHS } from '../demo/enterprise-excel/fixtures.js'
import { snapshotOutputScope, validateReport } from '../src/acceptance/validator.js'
import { liveAgent } from '../src/runtime/live.js'

const argument = process.argv[2] ?? 'july'
const month = argument === 'august' || argument === '8月'
  ? '8月'
  : argument === 'july' || argument === '7月'
    ? '7月'
    : undefined

if (!month) throw new Error('usage: npm run live -- july|august|7月|8月')

const scenario = SYNTHETIC_MONTHS.find(candidate => candidate.month === month)!
const root = await mkdtemp(join(tmpdir(), 'misen-pi-live-'))
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const toolStarts: string[] = []
const toolEnds: string[] = []
const spreadsheetUpdates: Array<{ id: string; workbook?: unknown; sheet?: unknown; range?: unknown; values?: unknown; status: string }> = []
let failureClass: 'PROVIDER_OR_TRANSPORT' | 'TOOL' | 'ACCEPTANCE_FATAL' = 'ACCEPTANCE_FATAL'
const started = performance.now()

try {
  await fixture(root)
  const inputs = ['master.xlsx', '月次管理レポート_template.xlsx', ...scenario.companies.map(company => `${month}/${company.company}.xlsx`)]
  const before = new Map(await Promise.all(inputs.map(async file => [file, digest(await readFile(join(root, file)))] as const)))
  const outputBefore = await snapshotOutputScope(root)
  const agent = await liveAgent(root)

  agent.subscribe(event => {
    if (event.type === 'tool_execution_start') {
      toolStarts.push(event.toolName)
      if (event.toolName === 'spreadsheet_update') {
        const args = event.args as Record<string, unknown>
        spreadsheetUpdates.push({
          id: event.toolCallId,
          workbook: args.workbook,
          sheet: args.sheet,
          range: args.range,
          values: args.values,
          status: 'started'
        })
      }
    }
    if (event.type === 'tool_execution_end') {
      toolEnds.push(event.toolName)
      const update = spreadsheetUpdates.find(item => item.id === event.toolCallId)
      if (update) update.status = event.isError ? 'error' : 'success'
    }
  })

  await agent.prompt(PROMPTS[month])
  if (agent.state.errorMessage) {
    failureClass = spreadsheetUpdates.some(update => update.status === 'error') ? 'TOOL' : 'PROVIDER_OR_TRANSPORT'
    throw new Error('agent run failed')
  }

  const validation = await validateReport(root, scenario, before, outputBefore)
  const bytes = (await stat(join(root, validation.output))).size
  const evidence = {
    month,
    status: validation.passed ? 'PASS' : 'FAIL',
    axisMatrix: validation.axes,
    diagnostics: validation.diagnostics,
    output: { path: validation.output, bytes },
    spreadsheetUpdates,
    toolStarts,
    toolEnds,
    toolBalance: toolStarts.length === toolEnds.length,
    elapsedMs: Math.round(performance.now() - started),
    rss: process.memoryUsage().rss
  }
  console.log(JSON.stringify(evidence))
  if (!validation.passed) process.exitCode = 1
} catch (error) {
  console.error(JSON.stringify({
    month,
    status: 'FATAL',
    failureClass,
    toolStarts,
    toolEnds,
    toolBalance: toolStarts.length === toolEnds.length,
    spreadsheetUpdates,
    elapsedMs: Math.round(performance.now() - started),
    failure: error instanceof Error && failureClass === 'ACCEPTANCE_FATAL' ? error.message : undefined
  }))
  process.exitCode = 1
} finally {
  await rm(root, { recursive: true, force: true })
}
