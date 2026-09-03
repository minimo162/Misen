import { Type, type Static } from '@earendil-works/pi-ai'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { WorkspaceBoundary } from '../workspace/boundary.js'
import { OfficeCliSpreadsheet, isFormulaValue, officeCli } from '../spreadsheet/officecli.js'
import { rangeBoundaries } from '../spreadsheet/range.js'
import { safeFormula, validateDeliverable } from './guards.js'

const MAX_WORKBOOK_BYTES = 64 * 1024 * 1024
const result = (details: object) => ({ content: [{ type: 'text' as const, text: JSON.stringify(details) }], details })
const Path = Type.Object({ path: Type.Optional(Type.String()), extension: Type.Optional(Type.String()) })
const Text = Type.Object({ path: Type.String(), offset: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 0, maximum: 200000 })) })
const Read = Type.Object({ workbook: Type.String(), sheet: Type.Optional(Type.String()), range: Type.Optional(Type.String()) })
const Create = Type.Object({ source: Type.String(), output: Type.String(), overwrite: Type.Optional(Type.Boolean()) })
const FormulaValue = Type.Object({ formula: Type.String({ minLength: 1, maxLength: 8192 }) }, { additionalProperties: false })
const LiteralValue = Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null()])
const CellValue = Type.Union([LiteralValue, FormulaValue])
const Update = Type.Object({ workbook: Type.String(), sheet: Type.String(), range: Type.String(), values: Type.Array(Type.Array(CellValue)) })

function validateCellValue(value: unknown): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return
  if (isFormulaValue(value) && Object.keys(value).length === 1 && value.formula.length > 0 && value.formula.length <= 8192) return
  throw new Error('cell value must be a literal or {formula:string}; cachedValue is not allowed')
}

function tool<P>(name: string, description: string, parameters: any, execute: (params: P, signal?: AbortSignal) => Promise<object>): AgentTool<any> {
  return { name, label: name, description, parameters, executionMode: 'sequential', execute: async (_id, params, signal) => result(await execute(params as P, signal)) }
}

export function enterpriseTools(boundary: WorkspaceBoundary, spreadsheets: OfficeCliSpreadsheet = officeCli()): AgentTool[] {
  return [
    tool<Static<typeof Path>>('workspace_list_files', 'List regular files below the selected workspace.', Path, async p => {
      const files = await boundary.listFiles(p.path)
      if (files.length > 20000) throw new RangeError('file listing exceeds 20000 entries')
      return { files: p.extension ? files.filter(path => path.toLowerCase().endsWith(p.extension!.toLowerCase())) : files }
    }),
    tool<Static<typeof Text>>('workspace_read_text', 'Read a UTF-8 workspace text file.', Text, async p => {
      const read = await boundary.readFileBytes(p.path)
      if (!/\.(txt|md|markdown|json|csv|yaml|yml|log)$/iu.test(read.absolute)) throw new Error('unsupported text extension')
      const all = Buffer.from(read.bytes).toString('utf8')
      const offset = p.offset ?? 0
      const text = all.slice(offset, offset + Math.min(p.limit ?? 200000, 200000))
      return { path: boundary.displayPath(read.absolute), text, truncated: offset + text.length < all.length }
    }),
    tool<Static<typeof Read>>('spreadsheet_read', 'Read workbook sheets or a rectangular range.', Read, async (p, signal) => {
      const read = await boundary.readFileBytes(p.workbook, MAX_WORKBOOK_BYTES)
      validateDeliverable(read.bytes)
      const workbook = await spreadsheets.readBytes(read.bytes, p.sheet, p.range ?? 'A1:E20', signal)
      return p.sheet
        ? { workbook: boundary.displayPath(read.absolute), sheets: workbook.sheets, sheet: p.sheet, range: p.range ?? 'A1:E20', values: workbook.values }
        : { workbook: boundary.displayPath(read.absolute), sheets: workbook.sheets }
    }),
    tool<Static<typeof Create>>('spreadsheet_create_output', 'Copy an xlsx template to output.', Create, async (p, signal) => {
      const read = await boundary.readFileBytes(p.source, MAX_WORKBOOK_BYTES)
      validateDeliverable(read.bytes)
      const bytes = await spreadsheets.validateAndCopyBytes(read.bytes, signal)
      validateDeliverable(bytes)
      const output = await boundary.writeOutputFileBytes(p.output, bytes, p.overwrite === true)
      return { source: boundary.displayPath(read.absolute), output: boundary.displayPath(output), bytes: bytes.byteLength }
    }),
    tool<Static<typeof Update>>('spreadsheet_update', 'Update literal cell values or safe formulas in an output workbook. Use {"formula":"=..."} for formulas. A plain string beginning with "=" remains a literal string.', Update, async (p, signal) => {
      if (p.values.length === 0 || p.values.some(row => row.length !== p.values[0]!.length) || p.values.length * p.values[0]!.length > 10000) throw new Error('values must be a bounded rectangular matrix')
      for (const row of p.values) for (const value of row) validateCellValue(value)
      const bounds = rangeBoundaries(p.range)
      const rows = bounds.maxRow - bounds.minRow + 1
      const columns = bounds.maxCol - bounds.minCol + 1
      if (rows !== p.values.length || columns !== p.values[0]!.length) throw new Error('values dimensions must exactly match range')
      const safeValues = p.values.map(row => row.map(value => isFormulaValue(value) ? { formula: safeFormula(value.formula) } : value))
      const read = await boundary.readOutputFileBytes(p.workbook, MAX_WORKBOOK_BYTES)
      validateDeliverable(read.bytes)
      const bytes = await spreadsheets.updateBytes(read.bytes, p.sheet, p.range, safeValues, signal)
      validateDeliverable(bytes)
      await boundary.writeOutputFileBytes(p.workbook, bytes, true)
      return { workbook: boundary.displayPath(read.absolute), range: p.range, bytes: bytes.byteLength }
    }),
  ]
}

export const ENTERPRISE_TOOL_NAMES = ['workspace_list_files', 'workspace_read_text', 'spreadsheet_read', 'spreadsheet_create_output', 'spreadsheet_update'] as const
