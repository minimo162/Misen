import { createHash } from 'node:crypto'
import { readFile, readdir, stat, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'

import {
  createUserMessage,
  LlmError,
  ReasoningEffortId,
} from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { isFormulaValue, getFormulaText } from '@office-kit/xlsx/cell'
import { getCellByCoord } from '@office-kit/xlsx/worksheet'

import {
  ENTERPRISE_CAPABILITY_TOOL_NAMES,
  ENTERPRISE_FORBIDDEN_TOOL_NAMES,
  registerEnterpriseCapabilities,
} from '../src/capabilities/index.js'
import {
  listWorksheetTitles,
  openSpreadsheet,
  readCell,
  readCellStyle,
  readRange,
  requireWorksheet,
} from '../src/spreadsheet/engine.js'
import { createEnterpriseBrainContext } from '../src/runtime/phase-a.js'
import {
  createEnterpriseFixtureWorkspace,
  SYNTHETIC_MONTHS,
  SYNTHETIC_TARGETS,
} from '../demo/enterprise-excel/fixtures.js'
import { WorkspaceBoundary } from '../src/workspace/boundary.js'

const LIVE_MODEL = 'gpt-5.6-luna'
const LIVE_PROVIDER = 'openai'
const LIVE_TIMEOUT_MS = 15 * 60 * 1_000

type JsonRecord = Record<string, unknown>

export interface ReportingPeriod {
  readonly year: number
  readonly month: number
}

interface UsageTotals {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  reasoningTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

interface LiveMetrics {
  elapsedMs: number
  llmRequestCount: number
  toolCallCount: number
  toolResultCount: number
  usage?: UsageTotals
  outputBytes?: number
  memoryBytes: number
}

interface MonthResult {
  month: string
  status: 'PASS' | 'FAIL'
  reason?: string
  failureCode?: string
  failureDiagnostic?: FailureDiagnostic
  finalText?: string
  output?: string
  toolNames: string[]
  metrics: LiveMetrics
  inputHashesBefore: Record<string, string>
  inputHashesAfter: Record<string, string>
  forbiddenToolNames: string[]
  reasoningBlocks: number
  requestToolRoster: string[]
  turnEnd?: string
  executionErrorClass?: string
  executionErrorCode?: string
  sessionEventCounts?: Record<string, number>
  toolResultErrors?: ToolResultError[]
  retryEventCount?: number
  spreadsheetUpdates?: SpreadsheetUpdateDiagnostic[]
  outputDiagnosis?: OutputDiagnosis
}

interface ToolResultError {
  readonly tool?: string
  readonly code?: string
  readonly category?: string
}

interface FailureDiagnostic {
  readonly status?: number
  readonly modelNotFound?: boolean
  readonly unsupportedReasoning?: boolean
  readonly toolSchema?: boolean
  readonly invalidRequest?: boolean
  readonly network?: boolean
  readonly messageSha256?: string
  readonly messageLength?: number
}

interface SpreadsheetUpdateDiagnostic {
  readonly sequence: number
  readonly workbook?: string
  readonly sheet?: string
  readonly range?: string
  readonly values?: unknown
  readonly result: 'success' | 'error' | 'missing-result'
  readonly errorCode?: string
  readonly errorCategory?: string
}

interface OutputDiagnosis {
  readonly actualA2?: unknown
  readonly actualB2?: unknown
  readonly checks: Readonly<Record<
    'SHEET' | 'MONTH' | 'ROWS' | 'PROFIT_FORMULAS' | 'STATUS' | 'TOTAL' | 'FOOTER' | 'FORMAT',
    'PASS' | 'FAIL'
  >>
}

interface LiveAcceptanceResult {
  status: 'PASS' | 'FAIL' | 'NOT RUN'
  reason?: string
  provider: string
  model: string
  months: MonthResult[]
}

class LiveAcceptanceStageError extends Error {
  readonly name = 'LiveAcceptanceStageError'

  constructor(readonly stage: string, cause: unknown) {
    super('live acceptance stage failed', { cause })
  }
}

function outputValidationFailureCode(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined
  const message = error.message
  if (message === 'output must contain the Report worksheet') return 'SHEET'
  if (message.startsWith('reporting period does not match source period ')) return 'MONTH'
  if (message.startsWith('report row ')) return 'ROW'
  if (message.startsWith('profit formula missing ')) return 'PROFIT_FORMULA'
  if (message.startsWith('status missing ')) return 'STATUS'
  if (message === 'total formula missing at D9') return 'TOTAL_FORMULA_MISSING'
  if (message === 'total formula is incorrect') return 'TOTAL_FORMULA_INCORRECT'
  if (message === 'template footer was not preserved') return 'FOOTER'
  if (message === 'heading style was not preserved') return 'HEADING_STYLE'
  if (message === 'number format was not preserved') return 'NUMBER_FORMAT'
  return undefined
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * DSH carries SessionId into the provider's transport headers. Keep the
 * correlation id deterministic but ASCII-only so a localized month label can
 * never become an invalid HTTP ByteString header value.
 */
export function createLiveSessionId(month: string): SessionId {
  return SessionId(`enterprise-live-${sha256(Buffer.from(month, 'utf8')).slice(0, 16)}`)
}

/**
 * Keep the live acceptance request intentionally minimal and identical across
 * datasets. Business meaning comes from the handoff/workspace; the model
 * chooses the capability calls and their order.
 */
export function createLivePrompt(month: string): string {
  return `${month}の3社実績を取りまとめて、月次管理レポートを完成させて`
}

function sumUsage(target: UsageTotals, usage: Record<string, unknown>): void {
  const fields = [
    'inputTokens',
    'outputTokens',
    'totalTokens',
    'reasoningTokens',
    'cacheReadTokens',
    'cacheWriteTokens',
  ] as const
  for (const field of fields) {
    const value = usage[field]
    if (typeof value !== 'number' || !Number.isFinite(value)) continue
    target[field] = (target[field] ?? 0) + value
  }
}

function isEmptyUsage(usage: UsageTotals): boolean {
  return Object.keys(usage).length === 0
}

/** Return stable DSH error identifiers without serialising provider messages. */
function safeFailureReason(error: unknown): string {
  if (error instanceof LlmError) return `LlmError:${error.code}`
  if (error instanceof Error) return error.name || 'Error'
  return 'UnknownError'
}

/** Keep diagnostics to stable runtime class/code identifiers only. */
function safeErrorClass(error: unknown): string {
  if (error instanceof LlmError) return 'LlmError'
  if (error instanceof Error) {
    const name = error.constructor?.name
    return typeof name === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u.test(name)
      ? name
      : 'Error'
  }
  return 'UnknownError'
}

function safeErrorCode(error: unknown): string | undefined {
  const code = error instanceof LlmError
    ? error.code
    : typeof error === 'object' && error !== null && 'code' in error
      ? (error as { code?: unknown }).code
      : undefined
  return typeof code === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u.test(code) ? code : undefined
}

function safeIdentifier(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u.test(value) ? value : undefined
}

/**
 * Reduce a provider failure to an allowlisted, credential-safe diagnostic.
 * The provider message is inspected transiently and never returned or logged.
 * A fingerprint is retained only when no semantic category is recognisable.
 */
function diagnoseFailure(message: unknown): FailureDiagnostic | undefined {
  if (typeof message !== 'string' || message.length === 0) return undefined
  const statusMatch = message.match(/\b(400|401|403|404|408|409|413|422|429|5\d{2})\b/u)
  const status = statusMatch === null ? undefined : Number(statusMatch[1])
  const modelNotFound = /(?:model|deployment).*(?:not found|unknown|does not exist)|(?:not found|unknown).*(?:model|deployment)/iu.test(message)
  const unsupportedReasoning = /(?:reasoning|thinking).*(?:unsupported|not support|invalid)|(?:unsupported|invalid).*(?:reasoning|thinking)/iu.test(message)
  const toolSchema = /(?:tool|function).*(?:schema|argument|parameter)|(?:schema|argument|parameter).*(?:tool|function)/iu.test(message)
  const invalidRequest = /(?:invalid|bad|malformed).*(?:request|payload)|(?:request|payload).*(?:invalid|bad|malformed)/iu.test(message)
  const network = /(?:network|connection|socket|fetch|econn|timeout|dns|terminated|premature close)/iu.test(message)
  const categoryPresent = status !== undefined || modelNotFound || unsupportedReasoning || toolSchema || invalidRequest || network
  if (categoryPresent) {
    return {
      ...(status === undefined ? {} : { status }),
      ...(modelNotFound ? { modelNotFound: true } : {}),
      ...(unsupportedReasoning ? { unsupportedReasoning: true } : {}),
      ...(toolSchema ? { toolSchema: true } : {}),
      ...(invalidRequest ? { invalidRequest: true } : {}),
      ...(network ? { network: true } : {}),
    }
  }
  return {
    messageSha256: sha256(Buffer.from(message, 'utf8')),
    messageLength: message.length,
  }
}

async function fixtureInputPaths(root: string, month: string): Promise<string[]> {
  const monthFixture = SYNTHETIC_MONTHS.find(candidate => candidate.month === month)
  if (monthFixture === undefined) throw new Error(`unknown synthetic month: ${month}`)
  return [
    ...monthFixture.companies.map(company => `${month}/${company.company}.xlsx`),
    'master.xlsx',
    '月次管理レポート_template.xlsx',
    '業務引継ぎ.md',
  ].map(path => join(root, path))
}

/**
 * Derive one concrete reporting period from the source workbook as-of values.
 * A disagreement is an Acceptance-fixture inconsistency, never a value that
 * the Agent may resolve or that the validator may silently pick around.
 */
export function deriveUniqueReportingPeriod(asOfValues: readonly unknown[]): ReportingPeriod {
  if (asOfValues.length === 0) throw new Error('source reporting period is missing')
  let expected: ReportingPeriod | undefined
  for (const value of asOfValues) {
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      throw new Error('source reporting period is not a valid date')
    }
    const candidate = { year: value.getUTCFullYear(), month: value.getUTCMonth() + 1 }
    if (expected === undefined) expected = candidate
    else if (candidate.year !== expected.year || candidate.month !== expected.month) {
      throw new Error('source reporting periods are inconsistent')
    }
  }
  return expected!
}

/** Accept only the two Decision 429 representations: M月 and YYYY年M月. */
export function reportingPeriodMatches(value: unknown, expected: ReportingPeriod): boolean {
  if (typeof value !== 'string') return false
  const match = /^(?:(?<year>[1-9]\d{3})年)?(?<month>[1-9]|1[0-2])月$/u.exec(value)
  if (match?.groups === undefined) return false
  const month = Number(match.groups.month)
  if (month !== expected.month) return false
  const year = match.groups.year
  return year === undefined || Number(year) === expected.year
}

export async function deriveSourceReportingPeriod(root: string, month: string): Promise<ReportingPeriod> {
  const fixture = SYNTHETIC_MONTHS.find(candidate => candidate.month === month)
  if (fixture === undefined) throw new Error(`unknown synthetic month: ${month}`)
  const asOfValues: unknown[] = []
  for (const company of fixture.companies) {
    const workbook = await openSpreadsheet(join(root, month, `${company.company}.xlsx`))
    asOfValues.push(readCell(workbook, 'Actuals', 'B4'))
  }
  return deriveUniqueReportingPeriod(asOfValues)
}

async function hashPaths(paths: readonly string[]): Promise<Record<string, string>> {
  const result: Record<string, string> = {}
  for (const path of paths) {
    result[relative(dirname(paths[0] ?? path), path)] = sha256(await readFile(path))
  }
  return result
}

function textFromAssistantEvent(event: unknown): string {
  if (typeof event !== 'object' || event === null) return ''
  const data = (event as { data?: unknown }).data
  if (typeof data !== 'object' || data === null) return ''
  const message = (data as { message?: unknown }).message
  if (typeof message !== 'object' || message === null) return ''
  const content = (message as { content?: unknown }).content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block): block is { type: 'text'; text: string } =>
      typeof block === 'object' && block !== null &&
      (block as { type?: unknown }).type === 'text' &&
      typeof (block as { text?: unknown }).text === 'string')
    .map(block => block.text)
    .join('')
}

function hasReasoningBlock(event: unknown): boolean {
  if (typeof event !== 'object' || event === null) return false
  const data = (event as { data?: unknown }).data
  if (typeof data !== 'object' || data === null) return false
  const message = (data as { message?: unknown }).message
  if (typeof message !== 'object' || message === null) return false
  const content = (message as { content?: unknown }).content
  if (!Array.isArray(content)) return false
  return content.some(block => typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'reasoning')
}

function eventData(event: unknown): JsonRecord {
  if (typeof event !== 'object' || event === null) return {}
  const data = (event as { data?: unknown }).data
  return typeof data === 'object' && data !== null && !Array.isArray(data) ? data as JsonRecord : {}
}

async function waitForAgent(agent: Agent, timeoutMs = LIVE_TIMEOUT_MS): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      agent.whenIdle(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`live agent timeout after ${timeoutMs}ms`)), timeoutMs)
      }),
    ])
  } catch (error) {
    if (timer !== undefined) clearTimeout(timer)
    // Cancellation is only a convergence action; the original failure remains
    // in the session's turn/end evidence and is reported by the caller.
    agent.cancel({ kind: 'user' })
    await agent.whenIdle().catch(() => undefined)
    throw error
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function validateOutput(
  workbook: Awaited<ReturnType<typeof openSpreadsheet>>,
  month: string,
  expectedPeriod: ReportingPeriod,
): void {
  const fixture = SYNTHETIC_MONTHS.find(candidate => candidate.month === month)
  if (fixture === undefined) throw new Error(`missing fixture for ${month}`)
  if (listWorksheetTitles(workbook).length !== 1 || listWorksheetTitles(workbook)[0] !== 'Report') {
    throw new Error('output must contain the Report worksheet')
  }
  if (!reportingPeriodMatches(readCell(workbook, 'Report', 'B2'), expectedPeriod)) {
    throw new Error(`reporting period does not match source period ${expectedPeriod.year}-${String(expectedPeriod.month).padStart(2, '0')}`)
  }
  const sorted = [...fixture.companies].sort((left, right) => left.company.localeCompare(right.company))
  for (const [index, company] of sorted.entries()) {
    const row = index + 5
    const values = readRange(workbook, 'Report', `A${row}:C${row}`)[0]
    if (values?.[0] !== company.company || values?.[1] !== company.revenue || values?.[2] !== company.cost) {
      throw new Error(`report row ${row} does not match ${company.company}`)
    }
    const profit = company.revenue - company.cost
    const formulaCell = readCell(workbook, 'Report', `D${row}`)
    const formulaObject = formulaCell !== null && isFormulaValue(formulaCell)
      ? getFormulaText(getCellByCoord(requireWorksheet(workbook, 'Report'), `D${row}`)!)
      : undefined
    if (formulaObject !== `=B${row}-C${row}`) throw new Error(`profit formula missing at D${row}`)
    const expectedStatus = profit >= (SYNTHETIC_TARGETS[company.company] ?? Number.POSITIVE_INFINITY) ? 'On target' : 'Review'
    if (readCell(workbook, 'Report', `E${row}`) !== expectedStatus) throw new Error(`status missing at E${row}`)
  }
  const total = readCell(workbook, 'Report', 'D9')
  if (total === null || !isFormulaValue(total)) throw new Error('total formula missing at D9')
  const totalCell = getCellByCoord(requireWorksheet(workbook, 'Report'), 'D9')
  if (totalCell === undefined || getFormulaText(totalCell) !== '=SUM(D5:D7)') throw new Error('total formula is incorrect')
  if (readCell(workbook, 'Report', 'A11') !== 'Template footer — untouched by the agent') {
    throw new Error('template footer was not preserved')
  }
  if (readCellStyle(workbook, 'Report', 'A1')?.font.bold !== true) throw new Error('heading style was not preserved')
  if (readCellStyle(workbook, 'Report', 'B5')?.numberFormat !== '#,##0') throw new Error('number format was not preserved')
}

function diagnosticCellValue(value: ReturnType<typeof readCell>): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
  if (value instanceof Date) return { kind: 'date', value: value.toISOString() }
  if (isFormulaValue(value)) return { kind: 'formula', formula: value.formula }
  return { kind: typeof value === 'object' && value !== null && 'kind' in value ? String(value.kind) : 'other' }
}

function checkOutput(predicate: () => boolean): 'PASS' | 'FAIL' {
  try {
    return predicate() ? 'PASS' : 'FAIL'
  } catch {
    return 'FAIL'
  }
}

/**
 * Read-only, synthetic-safe diagnosis of every independent output axis. This
 * does not replace or weaken validateOutput: the acceptance still stops on its
 * original first failure, while this observer records how much of the output
 * was otherwise correct.
 */
function diagnoseOutput(
  workbook: Awaited<ReturnType<typeof openSpreadsheet>>,
  month: string,
  expectedPeriod: ReportingPeriod,
): OutputDiagnosis {
  const fixture = SYNTHETIC_MONTHS.find(candidate => candidate.month === month)
  const hasReport = listWorksheetTitles(workbook).length === 1 && listWorksheetTitles(workbook)[0] === 'Report'
  const actualA2 = hasReport ? diagnosticCellValue(readCell(workbook, 'Report', 'A2')) : undefined
  const actualB2 = hasReport ? diagnosticCellValue(readCell(workbook, 'Report', 'B2')) : undefined
  const sorted = fixture === undefined ? [] : [...fixture.companies].sort((left, right) => left.company.localeCompare(right.company))

  return {
    ...(actualA2 === undefined ? {} : { actualA2 }),
    ...(actualB2 === undefined ? {} : { actualB2 }),
    checks: {
      SHEET: hasReport ? 'PASS' : 'FAIL',
      MONTH: hasReport && reportingPeriodMatches(actualB2, expectedPeriod) ? 'PASS' : 'FAIL',
      ROWS: checkOutput(() => hasReport && sorted.every((company, index) => {
        const values = readRange(workbook, 'Report', `A${index + 5}:C${index + 5}`)[0]
        return values?.[0] === company.company && values?.[1] === company.revenue && values?.[2] === company.cost
      })),
      PROFIT_FORMULAS: checkOutput(() => hasReport && sorted.every((_company, index) => {
        const row = index + 5
        const cell = getCellByCoord(requireWorksheet(workbook, 'Report'), `D${row}`)
        return cell !== undefined && isFormulaValue(cell.value) && getFormulaText(cell) === `=B${row}-C${row}`
      })),
      STATUS: checkOutput(() => hasReport && sorted.every((company, index) => {
        const profit = company.revenue - company.cost
        const expected = profit >= (SYNTHETIC_TARGETS[company.company] ?? Number.POSITIVE_INFINITY) ? 'On target' : 'Review'
        return readCell(workbook, 'Report', `E${index + 5}`) === expected
      })),
      TOTAL: checkOutput(() => {
        if (!hasReport) return false
        const cell = getCellByCoord(requireWorksheet(workbook, 'Report'), 'D9')
        return cell !== undefined && isFormulaValue(cell.value) && getFormulaText(cell) === '=SUM(D5:D7)'
      }),
      FOOTER: checkOutput(() => hasReport && readCell(workbook, 'Report', 'A11') === 'Template footer — untouched by the agent'),
      FORMAT: checkOutput(() => hasReport &&
        readCellStyle(workbook, 'Report', 'A1')?.font.bold === true &&
        readCellStyle(workbook, 'Report', 'B5')?.numberFormat === '#,##0'),
    },
  }
}

function boundedDiagnosticValue(value: unknown): unknown {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'string') return value.length <= 256 ? value : `${value.slice(0, 256)}…`
  if (Array.isArray(value)) {
    if (value.length > 100) return { omitted: 'array-too-large', length: value.length }
    return value.map(boundedDiagnosticValue)
  }
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value)
    if (entries.length > 20) return { omitted: 'object-too-wide', keys: entries.length }
    return Object.fromEntries(entries.map(([key, child]) => [key, boundedDiagnosticValue(child)]))
  }
  return undefined
}

export function collectSpreadsheetUpdateDiagnostics(events: readonly unknown[]): SpreadsheetUpdateDiagnostic[] {
  const results = new Map<string, { result: 'success' | 'error'; errorCode?: string; errorCategory?: string }>()
  for (const event of events) {
    if ((event as { type?: unknown }).type !== 'tool/result') continue
    const data = eventData(event)
    const message = typeof data.message === 'object' && data.message !== null && !Array.isArray(data.message)
      ? data.message as JsonRecord
      : {}
    const source = typeof message.source === 'object' && message.source !== null && !Array.isArray(message.source)
      ? message.source as JsonRecord
      : {}
    const content = Array.isArray(message.content) ? message.content : []
    const resultBlock = typeof content[0] === 'object' && content[0] !== null && !Array.isArray(content[0])
      ? content[0] as JsonRecord
      : {}
    const callId = typeof source.callId === 'string' ? source.callId : undefined
    if (callId === undefined) continue
    const error = typeof data.error === 'object' && data.error !== null && !Array.isArray(data.error)
      ? data.error as JsonRecord
      : undefined
    const errorCode = error === undefined ? undefined : safeIdentifier(error.code)
    const errorCategory = error === undefined ? undefined : safeIdentifier(error.name)
    results.set(callId, {
      result: error === undefined && resultBlock.isError !== true ? 'success' : 'error',
      ...(errorCode === undefined ? {} : { errorCode }),
      ...(errorCategory === undefined ? {} : { errorCategory }),
    })
  }

  const diagnostics: SpreadsheetUpdateDiagnostic[] = []
  let sequence = 0
  for (const event of events) {
    if ((event as { type?: unknown }).type !== 'tool/call') continue
    sequence += 1
    const data = eventData(event)
    if (data.name !== 'spreadsheet_update') continue
    const callId = typeof data.callId === 'string' ? data.callId : undefined
    let parsed: JsonRecord = {}
    if (typeof data.arguments === 'string') {
      try {
        const candidate = JSON.parse(data.arguments) as unknown
        if (typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate)) parsed = candidate as JsonRecord
      } catch {
        // Invalid JSON is already represented by the matching Tool error; do
        // not retain the raw model text in diagnostic output.
      }
    }
    const result = callId === undefined ? undefined : results.get(callId)
    diagnostics.push({
      sequence,
      ...(typeof parsed.workbook === 'string' ? { workbook: parsed.workbook.slice(0, 256) } : {}),
      ...(typeof parsed.sheet === 'string' ? { sheet: parsed.sheet.slice(0, 128) } : {}),
      ...(typeof parsed.range === 'string' ? { range: parsed.range.slice(0, 64) } : {}),
      ...(parsed.values === undefined ? {} : { values: boundedDiagnosticValue(parsed.values) }),
      result: result?.result ?? 'missing-result',
      ...(result?.errorCode === undefined ? {} : { errorCode: result.errorCode }),
      ...(result?.errorCategory === undefined ? {} : { errorCategory: result.errorCategory }),
    })
  }
  return diagnostics
}

function collectResult(
  root: string,
  month: string,
  startedAt: number,
  agent: Agent,
  inputBefore: Record<string, string>,
  inputAfter: Record<string, string>,
  outputRelative: string | undefined,
  outputBytes: number | undefined,
  executionError?: unknown,
): MonthResult {
  const events = agent.session.events as readonly unknown[]
  const sessionEventCounts = events.reduce<Record<string, number>>((counts, event) => {
    const rawType = (event as { type?: unknown }).type
    const type = safeIdentifier(rawType) ?? 'unknown'
    counts[type] = (counts[type] ?? 0) + 1
    return counts
  }, {})
  const toolEvents = events.filter(event => (event as { type?: unknown }).type === 'tool/call')
  const toolResultEvents = events.filter(event => (event as { type?: unknown }).type === 'tool/result')
  const assistantEvents = events.filter(event => (event as { type?: unknown }).type === 'assistant/message')
  const turnEnd = [...events].reverse().find(event => (event as { type?: unknown }).type === 'turn/end')
  const turnEndData = turnEnd === undefined ? undefined : eventData(turnEnd)
  const toolNames = toolEvents
    .map(event => eventData(event).name)
    .filter((name): name is string => typeof name === 'string')
  const forbiddenToolNames = toolNames.filter(name => (ENTERPRISE_FORBIDDEN_TOOL_NAMES as readonly string[]).includes(name))
  const toolNamesByCallId = new Map<string, string>()
  for (const event of toolEvents) {
    const data = eventData(event)
    const callId = safeIdentifier(data.callId)
    const name = typeof data.name === 'string' ? data.name : undefined
    if (callId !== undefined && name !== undefined) toolNamesByCallId.set(callId, name)
  }
  const toolResultErrors = toolResultEvents.flatMap<ToolResultError>(event => {
    const data = eventData(event)
    const rawMessage = data.message
    const callId = typeof rawMessage === 'object' && rawMessage !== null && !Array.isArray(rawMessage)
      ? safeIdentifier((rawMessage as JsonRecord).callId)
      : undefined
    const rawError = data.error
    if (typeof rawError !== 'object' || rawError === null || Array.isArray(rawError)) return []
    const code = safeIdentifier((rawError as JsonRecord).code)
    const category = safeIdentifier((rawError as JsonRecord).name)
    const tool = callId === undefined ? undefined : toolNamesByCallId.get(callId)
    if (code === undefined && category === undefined) return []
    return [{
      ...(tool === undefined ? {} : { tool }),
      ...(code === undefined ? {} : { code }),
      ...(category === undefined ? {} : { category }),
    }]
  })
  const retryEventCount = events.filter(event => {
    const type = (event as { type?: unknown }).type
    return type === 'llm/retry' || type === 'llm/retry-started'
  }).length
  const spreadsheetUpdates = collectSpreadsheetUpdateDiagnostics(events)
  const reasoningBlocks = assistantEvents.reduce<number>(
    (count: number, event: unknown) => count + (hasReasoningBlock(event) ? 1 : 0),
    0,
  )
  const usage: UsageTotals = {}
  for (const event of assistantEvents) {
    const data = eventData(event)
    const rawUsage = data.usage
    if (typeof rawUsage === 'object' && rawUsage !== null && !Array.isArray(rawUsage)) {
      sumUsage(usage, rawUsage as Record<string, unknown>)
    }
  }
  // A failed or retried request may have usage on its terminal chunk without
  // an assistant/message event. Include those counters without retaining raw
  // provider payloads.
  for (const event of events) {
    if ((event as { type?: unknown }).type !== 'assistant/chunk') continue
    const chunk = eventData(event).chunk
    if (typeof chunk !== 'object' || chunk === null || Array.isArray(chunk)) continue
    const chunkRecord = chunk as JsonRecord
    if (chunkRecord.type !== 'usage') continue
    const rawUsage = chunkRecord.usage
    if (typeof rawUsage === 'object' && rawUsage !== null && !Array.isArray(rawUsage)) {
      sumUsage(usage, rawUsage as Record<string, unknown>)
    }
  }
  const rosterEvents = events.filter(event => (event as { type?: unknown }).type === 'request/header')
  const requestToolRoster = rosterEvents
    .flatMap(event => {
      const tools = eventData(event).header
      if (typeof tools !== 'object' || tools === null || Array.isArray(tools)) return []
      const schemas = (tools as JsonRecord).tools
      if (!Array.isArray(schemas)) return []
      return schemas
        .map(schema => typeof schema === 'object' && schema !== null ? (schema as JsonRecord).name : undefined)
        .filter((name): name is string => typeof name === 'string')
      })
  const requestCount = events.filter(event => {
    if ((event as { type?: unknown }).type !== 'assistant/chunk') return false
    const chunk = eventData(event).chunk
    return typeof chunk === 'object' && chunk !== null && !Array.isArray(chunk) &&
      (chunk as JsonRecord).type === 'finish'
  }).length
  const endReason = typeof turnEndData?.reason === 'object' && turnEndData.reason !== null
    ? (turnEndData.reason as JsonRecord).kind
    : undefined
  const endFailure = typeof turnEndData?.reason === 'object' && turnEndData.reason !== null &&
      typeof (turnEndData.reason as JsonRecord).error === 'object' &&
      (turnEndData.reason as JsonRecord).error !== null &&
      !Array.isArray((turnEndData.reason as JsonRecord).error)
    ? (turnEndData.reason as JsonRecord).error as JsonRecord
    : undefined
  const failureCode = typeof endFailure?.code === 'string' ? endFailure.code : undefined
  const failureDiagnostic = diagnoseFailure(endFailure?.message)
  const executionErrorCode = safeErrorCode(executionError)
  const finalAssistant = [...assistantEvents].reverse().find(event => {
    const data = eventData(event)
    const message = data.message
    if (typeof message !== 'object' || message === null) return false
    return Array.isArray((message as JsonRecord).content)
  })
  const finalText = finalAssistant === undefined ? undefined : textFromAssistantEvent(finalAssistant)
  const reason = executionError !== undefined
    ? `agent execution error (${safeFailureReason(executionError)})`
    : endReason !== 'completed'
    ? endReason === 'error'
      ? `turn error${failureCode === undefined ? '' : ` (${failureCode})`}`
      : `turn ended ${String(endReason ?? 'without turn/end')}`
    : forbiddenToolNames.length > 0
      ? `forbidden tool requested: ${forbiddenToolNames.join(', ')}`
      : reasoningBlocks > 0
        ? 'assistant reasoning content was emitted'
        : undefined
  return {
    month,
    status: reason === undefined ? 'PASS' : 'FAIL',
    ...(reason === undefined ? {} : { reason }),
    ...(failureCode === undefined ? {} : { failureCode }),
    ...(failureDiagnostic === undefined ? {} : { failureDiagnostic }),
    ...(finalText === undefined ? {} : { finalText }),
    ...(outputRelative === undefined ? {} : { output: outputRelative }),
    toolNames,
    metrics: {
      elapsedMs: performance.now() - startedAt,
      llmRequestCount: requestCount > 0 ? requestCount : assistantEvents.length,
      toolCallCount: toolEvents.length,
      toolResultCount: toolResultEvents.length,
      ...(isEmptyUsage(usage) ? {} : { usage }),
      ...(outputBytes === undefined ? {} : { outputBytes }),
      memoryBytes: process.memoryUsage().rss,
    },
    inputHashesBefore: inputBefore,
    inputHashesAfter: inputAfter,
    forbiddenToolNames,
    reasoningBlocks,
    requestToolRoster: [...new Set(requestToolRoster)],
    ...(typeof endReason === 'string' ? { turnEnd: endReason } : {}),
    ...(executionError === undefined ? {} : { executionErrorClass: safeErrorClass(executionError) }),
    ...(executionErrorCode === undefined ? {} : { executionErrorCode }),
    sessionEventCounts,
    ...(toolResultErrors.length === 0 ? {} : { toolResultErrors }),
    retryEventCount,
    ...(spreadsheetUpdates.length === 0 ? {} : { spreadsheetUpdates }),
  }
}

async function runMonth(month: string): Promise<MonthResult> {
  const root = await mkdtemp(join(tmpdir(), 'misen-enterprise-live-'))
  const startedAt = performance.now()
  let ctx: Awaited<ReturnType<typeof createEnterpriseBrainContext>> | undefined
  let disposeCapabilities: (() => void) | undefined
  let stage = 'fixture-setup'
  try {
    await createEnterpriseFixtureWorkspace(root)
    const boundary = new WorkspaceBoundary(root)
    const inputPaths = await fixtureInputPaths(root, month)
    stage = 'source-period-derive'
    const expectedPeriod = await deriveSourceReportingPeriod(root, month)
    stage = 'input-hash-before'
    const inputBefore = await hashPaths(inputPaths)
    stage = 'brain-mount'
    ctx = await createEnterpriseBrainContext({ persona: 'A general enterprise workspace assistant.' })
    stage = 'capability-register'
    disposeCapabilities = registerEnterpriseCapabilities(ctx, boundary)
    const schemas = ctx.tools.schemas().map(({ name }) => name)
    if (schemas.length !== ENTERPRISE_CAPABILITY_TOOL_NAMES.length ||
      schemas.some(name => !(ENTERPRISE_CAPABILITY_TOOL_NAMES as readonly string[]).includes(name))) {
      throw new Error(`unexpected model-facing capability roster: ${schemas.join(', ')}`)
    }
    const agent = ctx.agentLoop.create(createLiveSessionId(month), {
      provider: LIVE_PROVIDER,
      model: LIVE_MODEL,
      reasoningEffort: ReasoningEffortId('off'),
      maxTokens: 4_096,
    })
    // Keep the live request intentionally minimal and identical across months.
    // The handoff supplies business meaning; the model must choose the
    // capability calls and their order without procedural hints.
    const prompt = createLivePrompt(month)
    let executionError: unknown
    try {
      stage = 'agent-execution'
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: prompt }],
        source: { kind: 'user' },
      }))
      await waitForAgent(agent)
    } catch (error) {
      // Keep the agent/session alive until its event log is snapshotted below.
      // In particular, do not replace a provider failure with a generic
      // "no output" error or lose the turn/end evidence by disposing here.
      executionError = error
    }

    stage = 'input-hash-after'
    const inputAfter = await hashPaths(inputPaths)
    // Inspect the Agent Loop terminal event before touching output files. A
    // provider/credential failure is the primary acceptance finding; do not
    // overwrite it with the secondary fact that no deliverable was produced.
    stage = 'session-collect'
    const terminal = collectResult(root, month, startedAt, agent, inputBefore, inputAfter, undefined, undefined, executionError)
    if (terminal.status === 'FAIL') return terminal

    stage = 'output-list'
    const outputFiles = (await readdir(join(root, 'output'), { withFileTypes: true }))
      .filter(entry => entry.isFile() && entry.name.toLocaleLowerCase().endsWith('.xlsx'))
      .map(entry => entry.name)
    let outputRelative: string | undefined
    let outputBytes: number | undefined
    if (outputFiles.length === 1) {
      stage = 'output-validation'
      outputRelative = `output/${outputFiles[0]}`
      const outputPath = await boundary.resolveOutputFile(outputRelative)
      outputBytes = (await stat(outputPath)).size
      try {
        const workbook = await openSpreadsheet(outputPath)
        terminal.outputDiagnosis = diagnoseOutput(workbook, month, expectedPeriod)
        validateOutput(workbook, month, expectedPeriod)
      } catch (error) {
        // Session/tool evidence was collected before touching the deliverable.
        // Preserve that evidence when independent output validation rejects a
        // model-produced workbook; a stage-level catch must not replace it
        // with a zero-metric synthetic result.
        const failureCode = outputValidationFailureCode(error) ?? 'UNKNOWN'
        terminal.status = 'FAIL'
        terminal.reason = `output validation failed (${failureCode})`
        terminal.failureCode = failureCode
        terminal.output = outputRelative
        terminal.metrics.outputBytes = outputBytes
        return terminal
      }
    }
    stage = 'final-collect'
    const result = collectResult(root, month, startedAt, agent, inputBefore, inputAfter, outputRelative, outputBytes)
    if (terminal.outputDiagnosis !== undefined) result.outputDiagnosis = terminal.outputDiagnosis
    if (Object.entries(inputBefore).some(([path, before]) => inputAfter[path] !== before)) {
      result.status = 'FAIL'
      result.reason = 'an input workbook changed'
    } else if (outputFiles.length !== 1) {
      result.status = 'FAIL'
      result.reason = `expected exactly one output workbook, found ${outputFiles.length}`
    } else if (result.metrics.toolResultCount !== result.metrics.toolCallCount) {
      result.status = 'FAIL'
      result.reason = 'tool calls and tool results are not balanced'
    } else if (result.requestToolRoster.length > 0 &&
      (result.requestToolRoster.length !== ENTERPRISE_CAPABILITY_TOOL_NAMES.length ||
        result.requestToolRoster.some(name => !(ENTERPRISE_CAPABILITY_TOOL_NAMES as readonly string[]).includes(name)))) {
      result.status = 'FAIL'
      result.reason = `request/header exposed an unexpected tool roster: ${result.requestToolRoster.join(', ')}`
    }
    return result
  } catch (error) {
    if (error instanceof LiveAcceptanceStageError) throw error
    throw new LiveAcceptanceStageError(stage, error)
  } finally {
    try {
      disposeCapabilities?.()
    } catch {
      // Cleanup must never replace the already captured Agent/acceptance
      // outcome. This temporary workspace contains synthetic fixtures only.
    }
    if (ctx !== undefined) await ctx.fiber.dispose().catch(() => undefined)
    await rm(root, { recursive: true, force: true }).catch(() => undefined)
  }
}

/**
 * Execute the credential-gated live acceptance. The key is intentionally read
 * only by DSH from process.env.OPENAI_API_KEY; this runner never prints,
 * persists, or copies its value. Missing credentials are an explicit NOT RUN,
 * not a deterministic failure and not a fallback trigger.
 */
export async function runLiveAcceptance(): Promise<LiveAcceptanceResult> {
  if (typeof process.env.OPENAI_API_KEY !== 'string' || process.env.OPENAI_API_KEY.trim().length === 0) {
    const notRun: LiveAcceptanceResult = {
      status: 'NOT RUN',
      reason: 'OPENAI_API_KEY unavailable',
      provider: LIVE_PROVIDER,
      model: LIVE_MODEL,
      months: [],
    }
    console.log('NOT RUN — OPENAI_API_KEY unavailable')
    return notRun
  }

  const months: MonthResult[] = []
  for (const fixture of SYNTHETIC_MONTHS) {
    try {
      const result = await runMonth(fixture.month)
      months.push(result)
      if (result.status === 'FAIL') break
    } catch (error) {
      months.push({
        month: fixture.month,
        status: 'FAIL',
        reason: error instanceof LiveAcceptanceStageError
          ? `stage error (${error.stage}${error.stage === 'output-validation'
            ? `:${outputValidationFailureCode(error.cause) ?? 'UNKNOWN'}`
            : ''})`
          : safeFailureReason(error),
        toolNames: [],
        metrics: {
          elapsedMs: 0,
          llmRequestCount: 0,
          toolCallCount: 0,
          toolResultCount: 0,
          memoryBytes: process.memoryUsage().rss,
        },
        inputHashesBefore: {},
        inputHashesAfter: {},
        forbiddenToolNames: [],
        reasoningBlocks: 0,
        requestToolRoster: [],
      })
      break
    }
  }
  const result: LiveAcceptanceResult = {
    status: months.length === SYNTHETIC_MONTHS.length && months.every(month => month.status === 'PASS') ? 'PASS' : 'FAIL',
    provider: LIVE_PROVIDER,
    model: LIVE_MODEL,
    months,
  }
  // Emit only redacted acceptance status and metrics. In particular, omit
  // final assistant text and input hashes so an unexpected model echo cannot
  // become a process/CI log artifact; the independent harness retains those
  // checks locally.
  console.log(`LIVE_BRAIN_ACCEPTANCE_METRICS ${JSON.stringify({
    status: result.status,
    ...(result.reason === undefined ? {} : { reason: result.reason }),
    provider: result.provider,
    model: result.model,
    months: result.months.map(month => ({
      month: month.month,
      status: month.status,
      ...(month.reason === undefined ? {} : { reason: month.reason }),
      ...(month.failureCode === undefined ? {} : { failureCode: month.failureCode }),
      ...(month.failureDiagnostic === undefined ? {} : { failureDiagnostic: month.failureDiagnostic }),
      ...(month.executionErrorClass === undefined ? {} : { executionErrorClass: month.executionErrorClass }),
      ...(month.executionErrorCode === undefined ? {} : { executionErrorCode: month.executionErrorCode }),
      toolNames: month.toolNames,
      metrics: month.metrics,
      forbiddenToolNames: month.forbiddenToolNames,
      reasoningBlocks: month.reasoningBlocks,
      requestToolRoster: month.requestToolRoster,
      ...(month.sessionEventCounts === undefined ? {} : { sessionEventCounts: month.sessionEventCounts }),
      ...(month.toolResultErrors === undefined ? {} : { toolResultErrors: month.toolResultErrors }),
      ...(month.retryEventCount === undefined ? {} : { retryEventCount: month.retryEventCount }),
      ...(month.outputDiagnosis === undefined ? {} : { outputDiagnosis: month.outputDiagnosis }),
      inputUnchanged: Object.entries(month.inputHashesBefore).every(([path, before]) => month.inputHashesAfter[path] === before),
      ...(month.turnEnd === undefined ? {} : { turnEnd: month.turnEnd }),
    })),
  })}`)
  return result
}

/**
 * Decision 428 diagnosis-only entry point. It performs exactly one July run
 * and cannot advance to August, even if the rerun happens to pass.
 */
export async function runJulyMonthDiagnosis(): Promise<LiveAcceptanceResult> {
  if (typeof process.env.OPENAI_API_KEY !== 'string' || process.env.OPENAI_API_KEY.trim().length === 0) {
    console.log('NOT RUN — OPENAI_API_KEY unavailable')
    return { status: 'NOT RUN', reason: 'OPENAI_API_KEY unavailable', provider: LIVE_PROVIDER, model: LIVE_MODEL, months: [] }
  }

  const month = '7月'
  let monthResult: MonthResult
  try {
    monthResult = await runMonth(month)
  } catch (error) {
    monthResult = {
      month,
      status: 'FAIL',
      reason: error instanceof LiveAcceptanceStageError
        ? `stage error (${error.stage}${error.stage === 'output-validation'
          ? `:${outputValidationFailureCode(error.cause) ?? 'UNKNOWN'}`
          : ''})`
        : safeFailureReason(error),
      toolNames: [],
      metrics: { elapsedMs: 0, llmRequestCount: 0, toolCallCount: 0, toolResultCount: 0, memoryBytes: process.memoryUsage().rss },
      inputHashesBefore: {},
      inputHashesAfter: {},
      forbiddenToolNames: [],
      reasoningBlocks: 0,
      requestToolRoster: [],
    }
  }
  const result: LiveAcceptanceResult = {
    status: monthResult.status,
    provider: LIVE_PROVIDER,
    model: LIVE_MODEL,
    months: [monthResult],
  }
  console.log(`DECISION_428_DIAGNOSIS ${JSON.stringify({
    status: result.status,
    provider: result.provider,
    model: result.model,
    prompt: createLivePrompt(month),
    month: monthResult.month,
    ...(monthResult.reason === undefined ? {} : { reason: monthResult.reason }),
    ...(monthResult.failureCode === undefined ? {} : { failureCode: monthResult.failureCode }),
    toolNames: monthResult.toolNames,
    ...(monthResult.spreadsheetUpdates === undefined ? {} : { spreadsheetUpdates: monthResult.spreadsheetUpdates }),
    ...(monthResult.outputDiagnosis === undefined ? {} : { outputDiagnosis: monthResult.outputDiagnosis }),
    metrics: monthResult.metrics,
    inputUnchanged: Object.entries(monthResult.inputHashesBefore).every(([path, before]) => monthResult.inputHashesAfter[path] === before),
    forbiddenToolNames: monthResult.forbiddenToolNames,
    reasoningBlocks: monthResult.reasoningBlocks,
    retryEventCount: monthResult.retryEventCount ?? 0,
    ...(monthResult.turnEnd === undefined ? {} : { turnEnd: monthResult.turnEnd }),
  })}`)
  return result
}

async function main(): Promise<void> {
  const result = await runLiveAcceptance()
  if (result.status === 'FAIL') process.exitCode = 1
}

const entry = process.argv[1]
if (entry !== undefined && resolve(entry) === resolve(fileURLToPath(import.meta.url))) {
  await main()
}
