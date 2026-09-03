import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { OfficeCliProcess, OfficeCliProcessError, OFFICECLI_VERSION, type OfficeCliProcessOptions, type OfficeCliProcessResult } from './officecli-process.js'
import { rangeBoundaries, tupleToCoordinate } from './range.js'

export type SpreadsheetLiteral = string | number | boolean | Date | null
export interface SpreadsheetFormula {
  readonly formula: string
  readonly cachedValue?: string | number | boolean
  readonly computedValue?: string | number | boolean
}
export type SpreadsheetValue = SpreadsheetLiteral | SpreadsheetFormula
export interface SpreadsheetCell {
  readonly row: number
  readonly col: number
  readonly coordinate: string
  readonly value: SpreadsheetValue
  readonly displayText: string
  readonly format: Readonly<Record<string, unknown>>
}
export interface SpreadsheetWorksheet {
  readonly title: string
  readonly cells: ReadonlyMap<string, SpreadsheetCell>
}
export interface SpreadsheetWorkbook {
  readonly sheets: readonly SpreadsheetWorksheet[]
}

export interface OfficeCliBatchItem {
  readonly command: string
  readonly path?: string
  readonly parent?: string
  readonly type?: string
  readonly props?: Readonly<Record<string, string>>
  readonly [key: string]: unknown
}

interface OfficeCliNode {
  readonly path?: unknown
  readonly type?: unknown
  readonly text?: unknown
  readonly preview?: unknown
  readonly format?: unknown
  readonly children?: unknown
}

interface OfficeCliEnvelope {
  readonly success?: unknown
  readonly data?: unknown
  readonly error?: unknown
  readonly diagnostics?: readonly string[]
}

export interface OfficeCliBatchResult {
  readonly success?: unknown
  readonly output?: unknown
}

const DEFAULT_INSPECTION_RANGE = 'A1:Z200'

function parseJsonResult(result: OfficeCliProcessResult): OfficeCliEnvelope {
  let parsed: unknown
  try {
    parsed = JSON.parse(result.stdout.replace(/^\uFEFF/u, '').trim())
  } catch {
    throw new OfficeCliProcessError('OfficeCLI stdout was not one JSON document', 'malformed_stdout', result.exitCode, result.stdout, result.stderr)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new OfficeCliProcessError('OfficeCLI returned an unexpected JSON shape', 'unexpected_output', result.exitCode, result.stdout, result.stderr)
  }
  const envelope = parsed as OfficeCliEnvelope
  const failure = firstFailure(envelope)
  if (result.exitCode !== 0 || envelope.success !== true) {
    throw new OfficeCliProcessError(failure.message, failure.code, result.exitCode, result.stdout, result.stderr)
  }
  const diagnostics = result.stderr.split(/\r?\n/u).map(line => line.trim()).filter(Boolean)
  return diagnostics.length > 0 ? { ...envelope, diagnostics } : envelope
}

function firstFailure(envelope: OfficeCliEnvelope): { message: string; code: string } {
  const direct = envelope.error
  if (direct && typeof direct === 'object') {
    const value = direct as Record<string, unknown>
    return { message: typeof value.error === 'string' ? value.error : 'OfficeCLI command failed', code: typeof value.code === 'string' ? value.code : 'officecli_error' }
  }
  const data = envelope.data
  if (data && typeof data === 'object') {
    const results = (data as Record<string, unknown>).results
    if (Array.isArray(results)) {
      const failed = results.find(item => item && typeof item === 'object' && (item as Record<string, unknown>).success === false) as Record<string, unknown> | undefined
      if (failed) return { message: typeof failed.error === 'string' ? failed.error : 'OfficeCLI batch failed', code: typeof failed.code === 'string' ? failed.code : 'officecli_batch_error' }
    }
  }
  return { message: 'OfficeCLI command failed', code: 'officecli_error' }
}

function results(envelope: OfficeCliEnvelope): OfficeCliNode[] {
  const data = envelope.data
  if (!data || typeof data !== 'object') throw new OfficeCliProcessError('OfficeCLI response data is missing', 'unexpected_output')
  const value = (data as Record<string, unknown>).results
  if (!Array.isArray(value)) throw new OfficeCliProcessError('OfficeCLI response results are missing', 'unexpected_output')
  return value as OfficeCliNode[]
}

function children(node: OfficeCliNode): OfficeCliNode[] {
  return Array.isArray(node.children) ? node.children as OfficeCliNode[] : []
}

function scalar(text: string): string | number | boolean {
  if (/^(?:true|false)$/iu.test(text)) return text.toLowerCase() === 'true'
  const number = Number(text)
  return text.trim() !== '' && Number.isFinite(number) ? number : text
}

function isDateFormat(format: unknown): boolean {
  if (typeof format !== 'string') return false
  const cleaned = format.replace(/"(?:[^"]|"")*"/gu, '').replace(/\[[^\]]*\]/gu, '').replace(/\\./gu, '').toLowerCase()
  return /(^|[^a-z])[dmyhs]+([^a-z]|$)/u.test(cleaned) || cleaned.includes('am/pm')
}

function cellValue(node: OfficeCliNode, format: Readonly<Record<string, unknown>>): SpreadsheetValue {
  const text = typeof node.text === 'string' ? node.text : ''
  const formula = format.formula
  if (typeof formula === 'string' && formula.length > 0) {
    return {
      formula: formula.startsWith('=') ? formula : '=' + formula,
      ...(format.cachedValue === undefined ? {} : { cachedValue: scalar(String(format.cachedValue)) }),
      ...(format.computedValue === undefined ? {} : { computedValue: scalar(String(format.computedValue)) }),
    }
  }
  if (format.empty === true) return null
  const type = typeof format.type === 'string' ? format.type.toLowerCase() : ''
  if (type === 'boolean') return text.toLowerCase() === 'true'
  if (type === 'number') {
    if (isDateFormat(format.numberformat)) {
      const date = new Date(/^\d{4}-\d{2}-\d{2}$/u.test(text) ? text + 'T00:00:00.000Z' : text)
      if (!Number.isNaN(date.getTime())) return date
    }
    const number = Number(text)
    if (Number.isFinite(number)) return number
  }
  return text
}

function parseCell(node: OfficeCliNode): SpreadsheetCell {
  if (typeof node.path !== 'string' || node.type !== 'cell') throw new OfficeCliProcessError('OfficeCLI cell node is malformed', 'unexpected_output')
  const coordinate = node.path.slice(node.path.lastIndexOf('/') + 1).toUpperCase()
  const match = /^([A-Z]{1,3})([1-9]\d*)$/u.exec(coordinate)
  if (!match) throw new OfficeCliProcessError('OfficeCLI returned an invalid cell path', 'unexpected_output')
  let col = 0
  for (const character of match[1]!) col = col * 26 + character.charCodeAt(0) - 64
  const format = node.format && typeof node.format === 'object' && !Array.isArray(node.format) ? node.format as Readonly<Record<string, unknown>> : {}
  return { row: Number(match[2]), col, coordinate, value: cellValue(node, format), displayText: typeof node.text === 'string' ? node.text : '', format }
}

function worksheetFromRange(title: string, envelope: OfficeCliEnvelope): SpreadsheetWorksheet {
  const root = results(envelope)[0]
  if (!root || root.type !== 'range') throw new OfficeCliProcessError('OfficeCLI range result is missing', 'unexpected_output')
  const cells = new Map<string, SpreadsheetCell>()
  for (const node of children(root)) {
    const cell = parseCell(node)
    cells.set(cell.coordinate, cell)
  }
  return { title, cells }
}

export function isFormulaValue(value: unknown): value is SpreadsheetFormula {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && typeof (value as { formula?: unknown }).formula === 'string')
}

export function listWorksheetTitles(workbook: SpreadsheetWorkbook): string[] {
  return workbook.sheets.map(sheet => sheet.title)
}

export function requireWorksheet(workbook: SpreadsheetWorkbook, title: string): SpreadsheetWorksheet {
  const sheet = workbook.sheets.find(candidate => candidate.title === title)
  if (!sheet) throw new Error('Worksheet not found: ' + title)
  return sheet
}

export function getCellByCoord(worksheet: SpreadsheetWorksheet, coordinate: string): SpreadsheetCell | undefined {
  return worksheet.cells.get(coordinate.toUpperCase())
}

export function iterCells(worksheet: SpreadsheetWorksheet): Iterable<SpreadsheetCell> {
  return worksheet.cells.values()
}

export function readCell(workbook: SpreadsheetWorkbook, sheetTitle: string, coordinate: string): SpreadsheetValue {
  return getCellByCoord(requireWorksheet(workbook, sheetTitle), coordinate)?.value ?? null
}

export function readRange(workbook: SpreadsheetWorkbook, sheetTitle: string, range: string): SpreadsheetValue[][] {
  const worksheet = requireWorksheet(workbook, sheetTitle)
  const bounds = rangeBoundaries(range)
  const matrix: SpreadsheetValue[][] = []
  for (let row = bounds.minRow; row <= bounds.maxRow; row += 1) {
    const values: SpreadsheetValue[] = []
    for (let col = bounds.minCol; col <= bounds.maxCol; col += 1) values.push(getCellByCoord(worksheet, tupleToCoordinate(col, row))?.value ?? null)
    matrix.push(values)
  }
  return matrix
}

export class OfficeCliSpreadsheet {
  readonly process: OfficeCliProcess
  private versionVerified = false

  constructor(options: OfficeCliProcessOptions = {}) {
    this.process = new OfficeCliProcess(options)
  }

  async ensureVersion(signal?: AbortSignal): Promise<void> {
    if (this.versionVerified) return
    const result = await this.process.run(['--version'], { signal })
    if (result.exitCode !== 0 || result.stderr.trim() || result.stdout.trim() !== OFFICECLI_VERSION) {
      throw new OfficeCliProcessError('OfficeCLI version does not match the pinned runtime', 'version_mismatch', result.exitCode, result.stdout, result.stderr)
    }
    this.versionVerified = true
  }

  async json(args: readonly string[], options: { readonly cwd?: string; readonly stdin?: string; readonly signal?: AbortSignal; readonly timeoutMs?: number } = {}): Promise<OfficeCliEnvelope> {
    await this.ensureVersion(options.signal)
    const envelope = parseJsonResult(await this.process.run([...args, '--json'], options))
    const data = envelope.data
    if (!data || typeof data !== 'object' || Array.isArray(data) || typeof (data as Record<string, unknown>).outputFile !== 'string') return envelope
    if (!options.cwd) throw new OfficeCliProcessError('OfficeCLI spilled output without a private temp boundary', 'unexpected_output')
    const outputFile = resolve((data as Record<string, unknown>).outputFile as string)
    const allowedRoot = resolve(options.cwd)
    if (dirname(outputFile) !== allowedRoot || !/^officecli_batch_[0-9a-f]{32}\.json$/u.test(basename(outputFile))) {
      throw new OfficeCliProcessError('OfficeCLI spill path escaped the private temp boundary', 'unexpected_output')
    }
    try {
      const bytes = await readFile(outputFile)
      const expectedSize = (data as Record<string, unknown>).outputSize
      if (!Number.isSafeInteger(expectedSize) || expectedSize !== bytes.byteLength || bytes.byteLength > this.process.maximumOutputBytes) {
        throw new OfficeCliProcessError('OfficeCLI spill output size is invalid', 'output_limit')
      }
      const expanded = JSON.parse(bytes.toString('utf8')) as unknown
      if (!expanded || typeof expanded !== 'object' || Array.isArray(expanded)) throw new Error('shape')
      return { ...envelope, data: expanded }
    } catch (error) {
      if (error instanceof OfficeCliProcessError) throw error
      throw new OfficeCliProcessError('OfficeCLI spill output was not one JSON object', 'malformed_stdout')
    } finally {
      await rm(outputFile, { force: true })
    }
  }

  private batchResults(envelope: OfficeCliEnvelope, expected: number): OfficeCliBatchResult[] {
    const data = envelope.data as Record<string, unknown> | undefined
    const batchResults = data?.results
    const summary = data?.summary as Record<string, unknown> | undefined
    if (!Array.isArray(batchResults) || !summary || summary.failed !== 0 || summary.succeeded !== expected || summary.total !== expected) {
      throw new OfficeCliProcessError('OfficeCLI batch summary did not confirm every operation', 'unexpected_output')
    }
    return batchResults as OfficeCliBatchResult[]
  }

  async inspectFile(file: string, path: string, depth = 0, signal?: AbortSignal): Promise<OfficeCliEnvelope> {
    return await this.json(['get', file, path, '--depth', String(depth)], { cwd: dirname(file), signal })
  }

  async validateFile(file: string, signal?: AbortSignal): Promise<void> {
    const envelope = await this.json(['validate', file], { signal })
    const data = envelope.data as Record<string, unknown>
    if (data.count !== 0 || !Array.isArray(data.errors)) throw new OfficeCliProcessError('OfficeCLI validation reported errors', 'validation_failed')
  }

  async batchFile(file: string, items: readonly OfficeCliBatchItem[], signal?: AbortSignal): Promise<OfficeCliBatchResult[]> {
    const envelope = await this.json(['batch', file], { cwd: dirname(file), stdin: JSON.stringify(items), signal })
    return this.batchResults(envelope, items.length)
  }

  async withPrivateWorkbook<T>(bytes: Uint8Array, action: (file: string) => Promise<T>): Promise<T> {
    const root = await mkdtemp(join(tmpdir(), 'misen-officecli-'))
    const file = join(root, 'workbook.xlsx')
    try {
      await writeFile(file, bytes, { flag: 'wx', mode: 0o600 })
      return await action(file)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }

  async openBytes(bytes: Uint8Array, inspectionRange = DEFAULT_INSPECTION_RANGE, signal?: AbortSignal): Promise<SpreadsheetWorkbook> {
    return await this.withPrivateWorkbook(bytes, async file => {
      const root = results(await this.inspectFile(file, '/', 0, signal))[0]
      if (!root || root.type !== 'workbook') throw new OfficeCliProcessError('OfficeCLI workbook result is missing', 'unexpected_output')
      const titles = children(root).map(node => {
        if (node.type !== 'sheet' || typeof node.preview !== 'string') throw new OfficeCliProcessError('OfficeCLI sheet node is malformed', 'unexpected_output')
        return node.preview
      })
      const sheets: SpreadsheetWorksheet[] = []
      for (const title of titles) sheets.push(worksheetFromRange(title, await this.inspectFile(file, '/' + title + '/' + inspectionRange, 1, signal)))
      return { sheets }
    })
  }

  async readBytes(bytes: Uint8Array, sheet?: string, range = 'A1:E20', signal?: AbortSignal): Promise<{ readonly sheets: string[]; readonly values?: SpreadsheetValue[][] }> {
    return await this.withPrivateWorkbook(bytes, async file => {
      if (sheet === undefined) {
        const root = results(await this.inspectFile(file, '/', 0, signal))[0]
        if (!root || root.type !== 'workbook') throw new OfficeCliProcessError('OfficeCLI workbook result is missing', 'unexpected_output')
        return { sheets: children(root).map(node => {
          if (node.type !== 'sheet' || typeof node.preview !== 'string') throw new OfficeCliProcessError('OfficeCLI sheet node is malformed', 'unexpected_output')
          return node.preview
        }) }
      }
      const envelope = await this.json(['batch', file], {
        cwd: dirname(file),
        stdin: JSON.stringify([
          { command: 'get', path: '/', depth: 0 },
          { command: 'get', path: '/' + sheet + '/' + range, depth: 1 },
        ]),
        signal,
      })
      const batchResults = this.batchResults(envelope, 2)
      const root = results({ success: true, data: batchResults[0]?.output })[0]
      if (!root || root.type !== 'workbook') throw new OfficeCliProcessError('OfficeCLI workbook result is missing', 'unexpected_output')
      const sheets = children(root).map(node => {
        if (node.type !== 'sheet' || typeof node.preview !== 'string') throw new OfficeCliProcessError('OfficeCLI sheet node is malformed', 'unexpected_output')
        return node.preview
      })
      if (!sheets.includes(sheet)) throw new Error('Worksheet not found: ' + sheet)
      const worksheet = worksheetFromRange(sheet, { success: true, data: batchResults[1]?.output })
      return { sheets, values: readRange({ sheets: [worksheet] }, sheet, range) }
    })
  }

  async validateAndCopyBytes(bytes: Uint8Array, signal?: AbortSignal): Promise<Uint8Array> {
    return await this.withPrivateWorkbook(bytes, async file => {
      await this.validateFile(file, signal)
      return new Uint8Array(await readFile(file))
    })
  }

  async updateBytes(bytes: Uint8Array, sheet: string, range: string, values: readonly (readonly (string | number | boolean | null | SpreadsheetFormula)[])[], signal?: AbortSignal): Promise<Uint8Array> {
    const bounds = rangeBoundaries(range)
    const items: OfficeCliBatchItem[] = []
    for (let row = 0; row < values.length; row += 1) {
      for (let col = 0; col < values[row]!.length; col += 1) {
        const value = values[row]![col]
        const path = '/' + sheet + '/' + tupleToCoordinate(bounds.minCol + col, bounds.minRow + row)
        if (value === null) items.push({ command: 'set', path, props: { clear: 'true' } })
        else if (isFormulaValue(value)) items.push({ command: 'set', path, props: { formula: value.formula.replace(/^=/u, '') } })
        else if (typeof value === 'number') items.push({ command: 'set', path, props: { value: String(value), type: 'number' } })
        else if (typeof value === 'boolean') items.push({ command: 'set', path, props: { value: String(value).toLowerCase(), type: 'boolean' } })
        else items.push({ command: 'set', path, props: { value, type: 'string' } })
      }
    }
    return await this.withPrivateWorkbook(bytes, async file => {
      await this.batchFile(file, items, signal)
      return new Uint8Array(await readFile(file))
    })
  }
}

let defaultClient: OfficeCliSpreadsheet | undefined
export function officeCli(): OfficeCliSpreadsheet {
  defaultClient ??= new OfficeCliSpreadsheet()
  return defaultClient
}

export async function openSpreadsheetBytes(bytes: Uint8Array, signal?: AbortSignal): Promise<SpreadsheetWorkbook> {
  return await officeCli().openBytes(bytes, DEFAULT_INSPECTION_RANGE, signal)
}

export const titles = listWorksheetTitles
export const values = readRange
