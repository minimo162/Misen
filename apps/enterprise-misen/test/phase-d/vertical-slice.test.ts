import { strict as assert } from 'node:assert'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import test from 'node:test'

import { getFormulaText, isFormulaValue } from '@office-kit/xlsx/cell'
import { getCellByCoord } from '@office-kit/xlsx/worksheet'
import {
  createUserMessage,
  LlmAdapter,
  ReasoningEffortId,
  ToolCallId,
} from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelReasoningInfo,
  LlmResolvedModelInfo,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'

import { HANDOFF_MARKERS, SYNTHETIC_MONTHS, SYNTHETIC_TARGETS, createEnterpriseFixtureWorkspace } from '../../demo/enterprise-excel/fixtures.js'
import { createPhaseAContext } from '../../src/runtime/phase-a.js'
import { ENTERPRISE_CAPABILITY_TOOL_NAMES, ENTERPRISE_FORBIDDEN_TOOL_NAMES, registerEnterpriseCapabilities } from '../../src/capabilities/index.js'
import { WorkspaceBoundary } from '../../src/workspace/boundary.js'
import { listWorksheetTitles, openSpreadsheet, readCell, readCellStyle, readRange, requireWorksheet } from '../../src/spreadsheet/engine.js'

type JsonScalar = string | number | boolean | null
type JsonValue = JsonScalar | { readonly [key: string]: JsonValue } | readonly JsonValue[]
type ToolArguments = Record<string, JsonValue>
type ScriptStage = 'list' | 'handoff' | 'handoff-read' | 'master' | 'actuals' | 'create' | 'month' | 'update' | 'final' | 'done'

interface ToolResultObservation {
  readonly callId: string
  readonly payload: unknown
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function textResponse(text: string): readonly StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 64, outputTokens: text.length, reasoningTokens: 0 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function toolCallResponse(callId: string, name: string, args: ToolArguments): readonly StreamChunk[] {
  const id = ToolCallId(callId)
  const argumentsJson = JSON.stringify(args)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    {
      type: 'tool-call-delta',
      index: 0,
      id,
      name,
      argumentsDelta: argumentsJson,
    },
    {
      type: 'block-end',
      index: 0,
      block: { type: 'tool-call', id, name, arguments: argumentsJson },
    },
    { type: 'usage', usage: { inputTokens: 64, outputTokens: argumentsJson.length, reasoningTokens: 0 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

function lastToolResult(options: GenerateOptions): ToolResultObservation | undefined {
  for (const message of [...options.messages].reverse()) {
    for (const block of [...message.content].reverse()) {
      if (block.type !== 'tool-result') continue
      const text = block.content.find(candidate => candidate.type === 'text')
      if (text?.type !== 'text') return undefined
      let payload: unknown = text.text
      try {
        payload = JSON.parse(text.text) as unknown
      } catch {
        // A tool may return human-readable text; retaining it still lets the
        // replay adapter include the real result in the next request.
      }
      return { callId: String(block.toolCallId), payload }
    }
  }
  return undefined
}

function payloadRecord(observation: ToolResultObservation | undefined): Record<string, unknown> {
  if (observation?.payload === null || typeof observation?.payload !== 'object' || Array.isArray(observation.payload)) return {}
  return observation.payload as Record<string, unknown>
}

/**
 * Test-only Brain replay. It uses DSH's public LlmAdapter seam and the standard
 * Agent Loop; it is deliberately not a production provider or a custom loop.
 * Its state advances from the prior tool result, making the assertions inspect
 * actual model-visible result messages rather than directly calling tools.
 */
class EnterpriseReplayAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  readonly toolArguments: Array<{ name: string; args: ToolArguments }> = []
  readonly listedXlsx: string[] = []
  private stage: ScriptStage = 'list'
  private actualWorkbookPaths: string[] = []
  private companyValues: Array<{ company: string; revenue: number; cost: number }> = []
  private readonly targets = new Map<string, number>()

  constructor(readonly month: string) {
    super()
  }

  providerInfo(provider: string) {
    return { id: provider, name: 'Enterprise deterministic replay' }
  }

  resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const reasoning: LlmModelReasoningInfo = {
      efforts: [{ id: ReasoningEffortId('off'), name: 'Off' }],
      defaultEffort: ReasoningEffortId('off'),
    }
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      context: { contextWindow: 4096 },
      inputModalities: ['text'],
      reasoning,
    })
  }

  private nextAction(options: GenerateOptions): readonly [ScriptStage, string, ToolArguments] | undefined {
    const observation = lastToolResult(options)
    const previous = payloadRecord(observation)
    if (observation !== undefined && previous.error !== undefined) {
      throw new Error(`tool ${observation.callId} returned an error: ${JSON.stringify(previous)}`)
    }

    switch (this.stage) {
      case 'list': {
        this.stage = 'handoff'
        return ['list', 'workspace_list_files', { path: this.month, extension: '.xlsx' }]
      }
      case 'handoff': {
        const files = Array.isArray(previous.files) ? previous.files.filter((value): value is string => typeof value === 'string') : []
        this.listedXlsx.splice(0, this.listedXlsx.length, ...files.filter(path => path.toLocaleLowerCase().endsWith('.xlsx')))
        this.actualWorkbookPaths = this.listedXlsx.filter(path => path.startsWith(`${this.month}/`)).sort((left, right) => left.localeCompare(right))
        if (this.actualWorkbookPaths.length !== 3) throw new Error(`replay expected three ${this.month} workbooks`)
        this.stage = 'handoff-read'
        return ['handoff-read', 'workspace_read_text', { path: '業務引継ぎ.md' }]
      }
      case 'handoff-read': {
        this.stage = 'master'
        return ['master', 'spreadsheet_read', { workbook: 'master.xlsx', sheet: 'Targets', range: 'A1:B4' }]
      }
      case 'master': {
        const values = Array.isArray(previous.values) ? previous.values : []
        for (const row of values.slice(1)) {
          if (!Array.isArray(row) || typeof row[0] !== 'string' || typeof row[1] !== 'number') continue
          this.targets.set(row[0], row[1])
        }
        if (this.targets.size !== 3) throw new Error('replay could not parse three master targets')
        this.stage = 'actuals'
        return ['actuals', 'spreadsheet_read', { workbook: this.actualWorkbookPaths[0]!, sheet: 'Actuals', range: 'A1:B5' }]
      }
      case 'actuals': {
        const values = Array.isArray(previous.values) ? previous.values : []
        const pairs = new Map<string, unknown>()
        for (const row of values) {
          if (!Array.isArray(row) || typeof row[0] !== 'string') continue
          pairs.set(row[0].toLocaleLowerCase(), row[1])
        }
        const company = typeof pairs.get('company') === 'string' ? pairs.get('company') as string : undefined
        const revenue = typeof pairs.get('revenue') === 'number' ? pairs.get('revenue') as number : undefined
        const cost = typeof pairs.get('cost') === 'number' ? pairs.get('cost') as number : undefined
        if (company === undefined || revenue === undefined || cost === undefined) throw new Error('replay could not parse Actuals tool result')
        this.companyValues.push({ company, revenue, cost })
        if (this.companyValues.length < this.actualWorkbookPaths.length) {
          return ['actuals', 'spreadsheet_read', {
            workbook: this.actualWorkbookPaths[this.companyValues.length]!,
            sheet: 'Actuals',
            range: 'A1:B5',
          }]
        }
        this.stage = 'create'
        return ['create', 'spreadsheet_create_output', {
          source: '月次管理レポート_template.xlsx',
          output: `output/${this.month}-月次管理レポート.xlsx`,
          overwrite: true,
        }]
      }
      case 'create': {
        this.stage = 'month'
        return ['month', 'spreadsheet_update', {
          workbook: `output/${this.month}-月次管理レポート.xlsx`,
          sheet: 'Report',
          range: 'B2:B2',
          values: [[this.month]],
        }]
      }
      case 'month': {
        this.stage = 'update'
        const rows: JsonValue[][] = [...this.companyValues].sort((left, right) => left.company.localeCompare(right.company)).map((row, index) => {
          const excelRow = index + 5
          const profit = row.revenue - row.cost
          const target = this.targets.get(row.company)
          if (target === undefined) throw new Error(`missing target for ${row.company}`)
          return [
            row.company,
            row.revenue,
            row.cost,
            { kind: 'formula', formula: `=B${excelRow}-C${excelRow}` },
            profit >= target ? 'On target' : 'Review',
          ]
        })
        rows.push([null, null, null, null, null])
        rows.push([
          'Totals',
          { kind: 'formula', formula: '=SUM(B5:B7)' },
          { kind: 'formula', formula: '=SUM(C5:C7)' },
          { kind: 'formula', formula: '=SUM(D5:D7)' },
          '',
        ])
        return ['update', 'spreadsheet_update', {
          workbook: `output/${this.month}-月次管理レポート.xlsx`,
          sheet: 'Report',
          range: 'A5:E9',
          values: rows,
        }]
      }
      case 'update': {
        this.stage = 'final'
        return undefined
      }
      case 'final': {
        this.stage = 'done'
        return undefined
      }
      case 'done':
        throw new Error('replay adapter received a request after completion')
    }
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(structuredClone(options))
    const next = this.nextAction(options)
    if (next === undefined) {
      yield* textResponse(`Completed ${this.month} monthly management report from all three company workbooks.`)
      return
    }
    const [, name, args] = next
    this.toolArguments.push({ name, args })
    yield* toolCallResponse(`enterprise-${this.requests.length}`, name, args)
  }
}

function sendAndWait(ctx: Awaited<ReturnType<typeof createPhaseAContext>>, agent: Agent, text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject !== agent || status !== 'idle' || settled) return
      settled = true
      dispose()
      resolve()
    })
    try {
      agent.followup(createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'user' },
      }))
    } catch (error) {
      settled = true
      dispose()
      reject(error)
    }
  })
}

function modelVisibleBytes(requests: readonly GenerateOptions[]): number {
  return requests.reduce((sum, request) => sum + Buffer.byteLength(JSON.stringify(request.messages), 'utf8'), 0)
}

function toolResultBytes(requests: readonly GenerateOptions[]): number {
  let total = 0
  for (const request of requests) {
    for (const message of request.messages) {
      for (const block of message.content) {
        if (block.type !== 'tool-result') continue
        total += Buffer.byteLength(JSON.stringify(block.content), 'utf8')
      }
    }
  }
  return total
}

async function sourceText(root: string): Promise<string> {
  const chunks: string[] = []
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile() && entry.name.endsWith('.ts')) chunks.push(await readFile(path, 'utf8'))
    }
  }
  await visit(root)
  return chunks.join('\n')
}

test('Phase D mechanical slice drives the real DSH Agent Loop and capabilities for both months', async () => {
  const root = await mkdtemp(join(tmpdir(), 'misen-phase-d-acceptance-'))
  try {
    await createEnterpriseFixtureWorkspace(root)
    const boundary = new WorkspaceBoundary(root)
    const handoff = await readFile(join(root, '業務引継ぎ.md'), 'utf8')
    for (const marker of HANDOFF_MARKERS) assert.match(handoff, new RegExp(`## ${marker}`))
    assert.doesNotMatch(handoff, /first\s+open|next\s+call|tool\s+call/i)

    const allResults = []
    for (const fixture of SYNTHETIC_MONTHS) {
      const started = performance.now()
      const inputRelativePaths = [
        ...fixture.companies.map(company => `${fixture.month}/${company.company}.xlsx`),
        'master.xlsx',
        '月次管理レポート_template.xlsx',
      ]
      const inputHashesBefore = new Map<string, string>()
      for (const relativePath of inputRelativePaths) {
        inputHashesBefore.set(relativePath, sha256(await readFile(await boundary.resolveFile(relativePath))))
      }
      const ctx = await createPhaseAContext({ persona: 'Enterprise Excel deterministic acceptance.' })
      const adapter = new EnterpriseReplayAdapter(fixture.month)
      const disposeAdapter = ctx.llm.registerAdapter(['enterprise-replay'], adapter)
      const disposeCapabilities = registerEnterpriseCapabilities(ctx, boundary)
      try {
        assert.deepEqual(ctx.tools.schemas().map(({ name }) => name).sort(), [...ENTERPRISE_CAPABILITY_TOOL_NAMES].sort())
        for (const forbidden of ENTERPRISE_FORBIDDEN_TOOL_NAMES) {
          assert.equal(ctx.tools.schemas().some(({ name }) => name === forbidden), false, `${forbidden} must not be model-facing`)
        }
        const agent = ctx.agentLoop.create(SessionId(`phase-d-${fixture.month}`), {
          provider: 'enterprise-replay',
          model: 'decision-427-deterministic-replay',
        })
        await sendAndWait(ctx, agent, `Complete the monthly management report for ${fixture.month}. Read the handoff and all workbooks, then save the completed report in output.`)

        const events = agent.session.events
        const toolCallEvents = events.filter(event => event.type === 'tool/call')
        const toolResultEvents = events.filter(event => event.type === 'tool/result')
        const assistantMessages = events.filter(event => event.type === 'assistant/message')
        const toolNames = toolCallEvents.map(event => event.type === 'tool/call' ? event.data.name : '')
        assert.deepEqual(toolNames, [
          'workspace_list_files',
          'workspace_read_text',
          'spreadsheet_read',
          'spreadsheet_read',
          'spreadsheet_read',
          'spreadsheet_read',
          'spreadsheet_create_output',
          'spreadsheet_update',
          'spreadsheet_update',
        ])
        assert.equal(toolCallEvents.length, 9)
        assert.equal(toolResultEvents.length, 9)
        assert.equal(assistantMessages.some(event => event.data.message.content.some(block => block.type === 'reasoning')), false)
        assert.equal(adapter.requests.length, 10)
        assert.equal(adapter.requests.every(request => request.reasoningEffort === undefined || String(request.reasoningEffort) === 'off'), true)
        assert.deepEqual(adapter.requests[0]?.tools?.map(({ name }) => name).sort(), [...ENTERPRISE_CAPABILITY_TOOL_NAMES].sort())

        const outputRelative = `output/${fixture.month}-月次管理レポート.xlsx`
        const outputPath = await boundary.resolveOutputFile(outputRelative)
        const output = await openSpreadsheet(outputPath)
        assert.deepEqual(listWorksheetTitles(output), ['Report'])
        assert.equal(readCell(output, 'Report', 'B2'), fixture.month)
        const sorted = [...fixture.companies].sort((left, right) => left.company.localeCompare(right.company))
        assert.deepEqual(readRange(output, 'Report', 'A5:C7'), sorted.map(row => [row.company, row.revenue, row.cost]))
        for (const [index, source] of sorted.entries()) {
          const rowNumber = index + 5
          const profit = source.revenue - source.cost
          const value = readCell(output, 'Report', `D${rowNumber}`)
          assert.ok(isFormulaValue(value))
          assert.equal(getFormulaText(getCellByCoord(requireWorksheet(output, 'Report'), `D${rowNumber}`)!), `=B${rowNumber}-C${rowNumber}`)
          const target = SYNTHETIC_TARGETS[source.company]
          assert.ok(target !== undefined)
          assert.equal(readCell(output, 'Report', `E${rowNumber}`), profit >= target ? 'On target' : 'Review')
        }
        const total = readCell(output, 'Report', 'D9')
        assert.ok(isFormulaValue(total))
        assert.equal(getFormulaText(getCellByCoord(requireWorksheet(output, 'Report'), 'D9')!), '=SUM(D5:D7)')
        assert.equal(readCell(output, 'Report', 'A11'), 'Template footer — untouched by the agent')
        assert.equal(readCellStyle(output, 'Report', 'A1')?.font.bold, true)
        assert.equal(readCellStyle(output, 'Report', 'B5')?.numberFormat, '#,##0')

        // Re-read all source hashes immediately after the run and compare with
        // snapshots captured before the Agent was started.
        for (const [relativePath, beforeHash] of inputHashesBefore) {
          assert.equal(sha256(await readFile(await boundary.resolveFile(relativePath))), beforeHash, `${relativePath} mutated`)
        }

        const outputSize = (await stat(outputPath)).size
        const elapsedMs = performance.now() - started
        const callsByStep = new Map(toolCallEvents.map(event => [
          `${event.data.turn}:${event.data.step}`,
          { name: event.data.name, time: event.time },
        ]))
        const spreadsheetProcessingMs = toolResultEvents.reduce((sum, event) => {
          const call = callsByStep.get(`${event.data.turn}:${event.data.step}`)
          return call?.name.startsWith('spreadsheet_') === true
            ? sum + Math.max(0, event.time - call.time)
            : sum
        }, 0)
        const metrics = {
          elapsedMs,
          spreadsheetProcessingMs,
          llmRequestCount: adapter.requests.length,
          toolCallCount: toolCallEvents.length,
          modelVisibleInputBytes: modelVisibleBytes(adapter.requests),
          toolResultBytes: toolResultBytes(adapter.requests),
          memoryBytes: process.memoryUsage().rss,
          outputBytes: outputSize,
        }
        assert.ok(metrics.elapsedMs > 0 && metrics.elapsedMs < 30_000)
        assert.ok(metrics.spreadsheetProcessingMs >= 0)
        assert.ok(metrics.modelVisibleInputBytes > 0)
        assert.ok(metrics.toolResultBytes > 0)
        assert.ok(metrics.memoryBytes > 0)
        assert.ok(metrics.outputBytes > 1_000 && metrics.outputBytes < 2_000_000)
        allResults.push({ fixture: fixture.month, metrics, toolNames, rows: sorted })
      } finally {
        disposeCapabilities()
        disposeAdapter()
        await ctx.fiber.dispose()
      }
    }

    assert.equal(allResults.length, 2)
    assert.notDeepEqual(allResults[0]?.rows.map(row => row.revenue), allResults[1]?.rows.map(row => row.revenue))
    const productionSource = await sourceText(join(process.cwd(), 'src'))
    for (const forbidden of ['7月', '8月', 'Alpha', 'Beta', 'Gamma', 'process_three_companies', 'create_monthly_finance_report']) {
      assert.equal(productionSource.includes(forbidden), false, `production source hard-codes ${forbidden}`)
    }
    console.log(`DECISION_427_VERTICAL_SLICE_METRICS ${JSON.stringify(allResults.map(result => ({
      month: result.fixture,
      ...result.metrics,
    })))}`)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
