import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import {
  getCellByCoord,
  getDataExtent,
  iterCells,
  listHyperlinks,
  setCellByCoord,
} from '@office-kit/xlsx/worksheet'
import { getCoordinate, getFormulaText, isFormulaValue, type CellValue, type FormulaValue } from '@office-kit/xlsx/cell'
import { boundariesToRangeString, rangeBoundaries, tupleToCoordinate } from '@office-kit/xlsx/utils'
import { iterWorksheets } from '@office-kit/xlsx/workbook'

import {
  listWorksheetTitles,
  openSpreadsheetBytes,
  readRange,
  requireWorksheet,
  serializeSpreadsheet,
  type SpreadsheetWorkbook,
  writeFormula,
  writeRangeValues,
} from '../spreadsheet/engine.js'
import { WorkspaceBoundary } from '../workspace/boundary.js'

type JsonRecord = { [key: string]: JsonValue }

const JSON_OBJECT_OUTPUT = {
  schema: { type: 'object', additionalProperties: true } as const,
  render: (_args: unknown, value: JsonRecord) => [{ type: 'text' as const, text: JSON.stringify(value) }],
}

// Keep model-visible range payloads bounded; callers can request another
// range when reasoning genuinely needs more workbook context.
const MAX_BATCH_CELLS = 10_000
const MAX_FORMULA_CHARS = 8_192
const SAFE_FORMULA_FUNCTIONS = new Set([
  'ABS', 'AND', 'AVERAGE', 'COUNT', 'COUNTA', 'IF', 'MAX', 'MIN', 'NOT', 'OR',
  'ROUND', 'ROUNDDOWN', 'ROUNDUP', 'SUM',
])

function isRecord(value: JsonValue): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Keep model-authored formulas inside the current workbook/sheet and a small,
 * deterministic function subset. This is a capability guard, not a formula
 * evaluator: Office Kit remains the spreadsheet engine.
 */
function safeFormula(value: string): string {
  const formula = value.startsWith('=') ? value : `=${value}`
  if (formula.length > MAX_FORMULA_CHARS) throw new RangeError(`formula exceeds ${MAX_FORMULA_CHARS} characters`)
  if (/[\0\r\n\[\]{}!|]/u.test(formula)) {
    throw new Error('formula must not contain external, cross-sheet, DDE, or control references')
  }
  if (/\b(?:https?|ftp|file):/iu.test(formula)) throw new Error('formula must not contain a network or file URI')
  const code = formula.replace(/"(?:[^"]|"")*"/gu, literal => ' '.repeat(literal.length))
  for (const match of code.matchAll(/\b([A-Z_][A-Z0-9_.]*)\s*\(/giu)) {
    const name = match[1]?.toLocaleUpperCase()
    if (name === undefined || !SAFE_FORMULA_FUNCTIONS.has(name)) {
      throw new Error(`formula function ${name ?? 'unknown'} is not allowed`)
    }
  }
  for (const match of code.matchAll(/\b([A-Z_][A-Z0-9_.]*)\b/giu)) {
    const name = match[1]?.toLocaleUpperCase()
    if (name === undefined) continue
    if (SAFE_FORMULA_FUNCTIONS.has(name) || name === 'TRUE' || name === 'FALSE' || /^[A-Z]{1,3}\d+$/u.test(name)) continue
    throw new Error(`formula name ${name} is not allowed`)
  }
  return formula
}

/**
 * Validate formulas already present in a workbook before it can become a
 * deliverable. Source templates and existing outputs are untrusted inputs to
 * the capability just like model-authored values; an untouched unsafe formula
 * must not be carried through a create or update operation.
 */
function relationshipLooksExternal(type: string, target: string): boolean {
  const normalizedType = type.toLocaleLowerCase()
  const trimmedTarget = target.trim()
  const normalizedTarget = trimmedTarget.replace(/^\/+/, '').toLocaleLowerCase()
  // The public relsExtras model preserves unrecognised relationship records;
  // fail closed for any explicit URI/host-file target as well as the known
  // external-link/data-connection families. Office Kit does not retain
  // TargetMode on relsExtras, so the target itself is part of this boundary.
  if (/^[a-z][a-z0-9+.-]*:/iu.test(trimmedTarget)) return true
  if (/^(?:\\\\|\/\/)/u.test(trimmedTarget)) return true
  if (/^[a-z]:[\\/]/iu.test(trimmedTarget)) return true
  if (/(?:^|\/)external(?:link)?(?:$|[\/#])/u.test(normalizedType)) return true
  if (/(?:^|\/)connections?(?:$|[\/#])/u.test(normalizedType)) return true
  if (/(?:^|\/)querytable(?:$|[\/#])/u.test(normalizedType)) return true
  if (/(?:^|\/)(?:externalLinks?|connections(?:\.xml)?|queryTables?)(?:\/|$)/u.test(normalizedTarget)) return true
  return false
}

function validateExternalWorkbookSurface(workbook: SpreadsheetWorkbook): void {
  if (workbook.externalReferences !== undefined && workbook.externalReferences.length > 0) {
    throw new Error('external workbook references are not allowed in deliverables')
  }

  for (const rawPath of workbook.passthrough?.keys() ?? []) {
    const path = rawPath.replace(/^\/+/, '').toLocaleLowerCase()
    if (path === 'xl/connections.xml' || path.startsWith('xl/externallinks/') || path.startsWith('xl/querytables/')) {
      throw new Error(`external workbook passthrough is not allowed: ${rawPath}`)
    }
  }

  for (const relationship of workbook.workbookRelsExtras ?? []) {
    if (relationshipLooksExternal(relationship.type, relationship.target)) {
      throw new Error(`external workbook relationship is not allowed: ${relationship.type}`)
    }
  }

  for (const sheet of iterWorksheets(workbook)) {
    for (const hyperlink of listHyperlinks(sheet)) {
      // A location-only hyperlink stays inside this workbook and is safe to
      // carry through. Any target is a worksheet relationship to an external
      // URL or file, including relative targets.
      if (hyperlink.target !== undefined && hyperlink.target.length > 0) {
        throw new Error(`external hyperlink target is not allowed at ${sheet.title}!${hyperlink.ref}`)
      }
    }
    for (const relationship of sheet.relsExtras ?? []) {
      if (relationshipLooksExternal(relationship.type, relationship.target)) {
        throw new Error(`external worksheet relationship is not allowed at ${sheet.title}: ${relationship.type}`)
      }
    }
  }
}

function validateDeliverableWorkbook(workbook: SpreadsheetWorkbook): void {
  for (const sheet of iterWorksheets(workbook)) {
    for (const cell of iterCells(sheet)) {
      if (!isFormulaValue(cell.value)) continue
      try {
        safeFormula(cell.value.formula)
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        throw new Error(`unsafe existing formula at ${sheet.title}!${getCoordinate(cell)}: ${detail}`)
      }
    }
  }
  validateExternalWorkbookSurface(workbook)
}

/** Convert the xlsx value union to lossless JSON suitable for a model result. */
function toJsonCellValue(value: CellValue): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value
  }
  if (value instanceof Date) return { kind: 'date', value: value.toISOString() }
  if (isFormulaValue(value)) {
    const result: JsonRecord = { kind: 'formula', formula: value.formula }
    if (value.cachedValue !== undefined) result.cachedValue = value.cachedValue
    return result
  }
  if (value.kind === 'duration') return { kind: 'duration', ms: value.ms }
  if (value.kind === 'error') return { kind: 'error', code: value.code }
  if (value.kind === 'rich-text') {
    // Rich-text runs are already JSON-shaped in the public office-kit model.
    return { kind: 'rich-text', runs: JSON.parse(JSON.stringify(value.runs)) as JsonValue }
  }
  return null
}

function fromJsonCellValue(value: JsonValue): CellValue {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value
  }
  if (!isRecord(value)) throw new TypeError('spreadsheet values must be scalar JSON values')
  if (value.kind === 'date' && typeof value.value === 'string') {
    const date = new Date(value.value)
    if (Number.isNaN(date.getTime())) throw new TypeError('invalid date value')
    return date
  }
  if (value.kind === 'formula' && typeof value.formula === 'string') {
    if (value.cachedValue !== undefined) throw new TypeError('model-supplied formula cachedValue is not allowed')
    return {
      kind: 'formula',
      formula: safeFormula(value.formula),
      t: 'normal',
    } satisfies FormulaValue
  }
  throw new TypeError('unsupported spreadsheet cell value')
}

function formulaAt(value: JsonValue): { formula: string } | undefined {
  if (typeof value === 'string' && value.startsWith('=')) return { formula: safeFormula(value) }
  if (!isRecord(value) || value.kind !== 'formula' || typeof value.formula !== 'string') return undefined
  if (value.cachedValue !== undefined) throw new TypeError('model-supplied formula cachedValue is not allowed')
  return { formula: safeFormula(value.formula) }
}

function matrix(value: JsonValue): JsonValue[][] {
  if (!Array.isArray(value) || value.some(row => !Array.isArray(row))) {
    throw new TypeError('values must be a rectangular array of rows')
  }
  const rows = value as JsonValue[][]
  const width = rows[0]?.length ?? 0
  if (width === 0 || rows.some(row => row.length !== width)) throw new TypeError('values must be non-empty and rectangular')
  return rows
}

/**
 * General workbook capabilities backed by the thin office-kit/xlsx seam.
 * Inputs and outputs use workspace-relative names and range-sized batches;
 * business-specific procedures are intentionally not represented here.
 */
export function createSpreadsheetCapabilityTools(boundary: WorkspaceBoundary): readonly ToolDefinition[] {
  const read = defineTool({
    name: 'spreadsheet_read',
    description: 'Read worksheet names or a rectangular cell range from an xlsx workbook.',
    parameters: {
      workbook: { type: 'string', required: true, description: 'Workspace-relative .xlsx path.' },
      sheet: { type: 'string', description: 'Worksheet title when reading cell values.' },
      range: { type: 'string', description: 'A1-style range; omitted to read the sheet data extent.' },
    },
    output: JSON_OBJECT_OUTPUT,
    async execute(args) {
      const { absolute, bytes } = await boundary.readFileBytes(args.workbook)
      const workbook = await openSpreadsheetBytes(bytes)
      const sheets = listWorksheetTitles(workbook)
      if (args.sheet === undefined) return { workbook: boundary.displayPath(absolute), sheets, range: null, values: null }

      const worksheet = requireWorksheet(workbook, args.sheet)
      const extent = getDataExtent(worksheet)
      const selectedRange = args.range ?? (extent === undefined ? undefined : boundariesToRangeString(extent))
      if (selectedRange === undefined) {
        return { workbook: boundary.displayPath(absolute), sheets, sheet: args.sheet, range: null, values: [] }
      }
      const bounds = rangeBoundaries(selectedRange)
      if ((bounds.maxRow - bounds.minRow + 1) * (bounds.maxCol - bounds.minCol + 1) > MAX_BATCH_CELLS) {
        throw new RangeError(`range exceeds ${MAX_BATCH_CELLS} cells`)
      }
      const values = readRange(workbook, args.sheet, selectedRange)
      return {
        workbook: boundary.displayPath(absolute),
        sheets,
        sheet: args.sheet,
        range: selectedRange,
        values: values.map(row => row.map(toJsonCellValue)),
      }
    },
  })

  const createOutput = defineTool({
    name: 'spreadsheet_create_output',
    description: 'Copy an xlsx workbook into workspace/output as a new deliverable.',
    parameters: {
      source: { type: 'string', required: true, description: 'Workspace-relative source .xlsx path.' },
      output: { type: 'string', required: true, description: 'Workspace-relative output/.xlsx destination.' },
      overwrite: { type: 'boolean', description: 'Allow replacing an existing output file.' },
    },
    output: JSON_OBJECT_OUTPUT,
    async execute(args) {
      const { absolute: source, bytes: sourceBytes } = await boundary.readFileBytes(args.source)
      if (!/\.xlsx$/iu.test(source)) throw new Error('source workbook must use the .xlsx extension')
      const workbook = await openSpreadsheetBytes(sourceBytes)
      validateDeliverableWorkbook(workbook)
      const outputBytes = await serializeSpreadsheet(workbook)
      const destination = await boundary.writeOutputFileBytes(args.output, outputBytes, args.overwrite === true)
      return {
        source: boundary.displayPath(source),
        output: boundary.displayPath(destination),
        sheets: listWorksheetTitles(workbook),
        bytes: outputBytes.byteLength,
      }
    },
  })

  const update = defineTool({
    name: 'spreadsheet_update',
    description: 'Apply one rectangular batch of values or formulas to an output workbook.',
    parameters: {
      workbook: { type: 'string', required: true, description: 'Workspace-relative output/.xlsx path.' },
      sheet: { type: 'string', required: true, description: 'Worksheet title.' },
      range: { type: 'string', required: true, description: 'A1-style rectangular range matching values.' },
      values: { type: 'array', items: { type: 'json' }, required: true, description: 'Rectangular rows of scalar values or formula objects.' },
    },
    output: JSON_OBJECT_OUTPUT,
    async execute(args) {
      const { absolute, bytes } = await boundary.readOutputFileBytes(args.workbook)
      const bounds = rangeBoundaries(args.range)
      const area = (bounds.maxRow - bounds.minRow + 1) * (bounds.maxCol - bounds.minCol + 1)
      if (area > MAX_BATCH_CELLS) throw new RangeError(`range exceeds ${MAX_BATCH_CELLS} cells`)
      const rows = matrix(args.values)
      const expectedRows = bounds.maxRow - bounds.minRow + 1
      const expectedCols = bounds.maxCol - bounds.minCol + 1
      if (rows.length !== expectedRows || rows.some(row => row.length !== expectedCols)) {
        throw new RangeError('values dimensions must exactly match range')
      }

      const workbook = await openSpreadsheetBytes(bytes)
      validateDeliverableWorkbook(workbook)
      // Materialise scalar values first so office-kit retains existing styles;
      // formula cells are installed immediately afterwards through its public
      // formula setter, preserving the same style IDs.
      const cellValues = rows.map(row => row.map(fromJsonCellValue))
      writeRangeValues(workbook, args.sheet, args.range, cellValues)
      for (let row = 0; row < rows.length; row += 1) {
        for (let col = 0; col < rows[row]!.length; col += 1) {
          const formula = formulaAt(rows[row]![col]!)
          if (formula === undefined) continue
          const coordinate = tupleToCoordinate(bounds.minCol + col, bounds.minRow + row)
          const cell = getCellByCoord(requireWorksheet(workbook, args.sheet), coordinate) ?? setCellByCoord(requireWorksheet(workbook, args.sheet), coordinate, null)
          writeFormula(workbook, args.sheet, coordinate, getFormulaText(cell) ?? formula.formula)
        }
      }
      validateDeliverableWorkbook(workbook)
      const outputBytes = await serializeSpreadsheet(workbook)
      await boundary.writeOutputFileBytes(args.workbook, outputBytes, true)
      return {
        workbook: boundary.displayPath(absolute),
        sheet: args.sheet,
        range: args.range,
        rows: rows.length,
        columns: rows[0]!.length,
        bytes: outputBytes.byteLength,
      }
    },
  })

  return Object.freeze([read, createOutput, update])
}
