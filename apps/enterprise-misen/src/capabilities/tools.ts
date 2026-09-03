import { Type, type Static } from '@earendil-works/pi-ai'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { WorkspaceBoundary } from '../workspace/boundary.js'
import { OfficeCliDocuments, type PresentationSlideInput, type TextReplacement, type WordParagraphInput } from '../office/officecli.js'
import { validateOfficePackage } from '../office/openxml.js'
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
const BoundedRead = { start: Type.Optional(Type.Integer({ minimum: 1, maximum: 10000 })), end: Type.Optional(Type.Integer({ minimum: 1, maximum: 10000 })) }
const DocumentRead = Type.Object({ document: Type.String(), ...BoundedRead })
const WordParagraph = Type.Object({ text: Type.String({ maxLength: 20000 }), style: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })) }, { additionalProperties: false })
const TextReplacementSchema = Type.Object({ find: Type.String({ minLength: 1, maxLength: 2000 }), replace: Type.String({ maxLength: 20000 }) }, { additionalProperties: false })
const DocumentCreate = Type.Object({ source: Type.Optional(Type.String()), output: Type.String(), paragraphs: Type.Optional(Type.Array(WordParagraph, { maxItems: 500 })), overwrite: Type.Optional(Type.Boolean()) })
const DocumentUpdate = Type.Object({ document: Type.String(), replacements: Type.Optional(Type.Array(TextReplacementSchema, { maxItems: 500 })), appendParagraphs: Type.Optional(Type.Array(WordParagraph, { maxItems: 500 })) })
const SlideLayout = Type.Union(['title', 'blank', 'twoContent', 'titleOnly', 'titleContent', 'section', 'comparison'].map(value => Type.Literal(value)))
const PresentationSlide = Type.Object({ title: Type.String({ maxLength: 2000 }), text: Type.Optional(Type.String({ maxLength: 50000 })), layout: Type.Optional(SlideLayout) }, { additionalProperties: false })
const PresentationRead = Type.Object({ presentation: Type.String(), ...BoundedRead })
const PresentationCreate = Type.Object({ source: Type.Optional(Type.String()), output: Type.String(), slides: Type.Optional(Type.Array(PresentationSlide, { maxItems: 100 })), overwrite: Type.Optional(Type.Boolean()) })
const PresentationUpdate = Type.Object({ presentation: Type.String(), replacements: Type.Optional(Type.Array(TextReplacementSchema, { maxItems: 500 })), appendSlides: Type.Optional(Type.Array(PresentationSlide, { maxItems: 100 })) })

function assertExtension(path: string, extension: '.xlsx' | '.docx' | '.pptx', label: string): void {
  if (!path.toLowerCase().endsWith(extension)) throw new Error(`${label} must use the ${extension} extension`)
}

function readBounds(start: number | undefined, end: number | undefined): { start: number; end: number } {
  const first = start ?? 1
  const last = end ?? Math.min(first + 99, 10000)
  if (last < first || last - first + 1 > 100) throw new Error('read range must contain at most 100 ordered items')
  return { start: first, end: last }
}

function validateMutations(replacements: readonly TextReplacement[], additions: readonly unknown[]): void {
  if (replacements.length + additions.length === 0) throw new Error('at least one document mutation is required')
  if (replacements.length + additions.length > 500) throw new Error('document mutation count exceeds 500')
  for (const replacement of replacements) {
    if (!replacement.find || replacement.find.length > 2000 || replacement.replace.length > 20000) throw new Error('replacement text is outside the allowed bound')
  }
}

function validateCellValue(value: unknown): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return
  if (isFormulaValue(value) && Object.keys(value).length === 1 && value.formula.length > 0 && value.formula.length <= 8192) return
  throw new Error('cell value must be a literal or {formula:string}; cachedValue is not allowed')
}

function tool<P>(name: string, description: string, parameters: any, execute: (params: P, signal?: AbortSignal) => Promise<object>): AgentTool<any> {
  return { name, label: name, description, parameters, executionMode: 'sequential', execute: async (_id, params, signal) => result(await execute(params as P, signal)) }
}

export function enterpriseTools(boundary: WorkspaceBoundary, spreadsheets: OfficeCliSpreadsheet = officeCli(), documents: OfficeCliDocuments = new OfficeCliDocuments(spreadsheets)): AgentTool[] {
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
      assertExtension(p.workbook, '.xlsx', 'workbook')
      const read = await boundary.readFileBytes(p.workbook, MAX_WORKBOOK_BYTES)
      validateDeliverable(read.bytes)
      const workbook = await spreadsheets.readBytes(read.bytes, p.sheet, p.range ?? 'A1:E20', signal)
      return p.sheet
        ? { workbook: boundary.displayPath(read.absolute), sheets: workbook.sheets, sheet: p.sheet, range: p.range ?? 'A1:E20', values: workbook.values }
        : { workbook: boundary.displayPath(read.absolute), sheets: workbook.sheets }
    }),
    tool<Static<typeof Create>>('spreadsheet_create_output', 'Copy an xlsx template to output.', Create, async (p, signal) => {
      assertExtension(p.source, '.xlsx', 'source workbook')
      assertExtension(p.output, '.xlsx', 'output workbook')
      const read = await boundary.readFileBytes(p.source, MAX_WORKBOOK_BYTES)
      validateDeliverable(read.bytes)
      const bytes = await spreadsheets.validateAndCopyBytes(read.bytes, signal)
      validateDeliverable(bytes)
      const output = await boundary.writeOutputFileBytes(p.output, bytes, p.overwrite === true)
      return { source: boundary.displayPath(read.absolute), output: boundary.displayPath(output), bytes: bytes.byteLength }
    }),
    tool<Static<typeof Update>>('spreadsheet_update', 'Update literal cell values or safe formulas in an output workbook. Use {"formula":"=..."} for formulas. A plain string beginning with "=" remains a literal string.', Update, async (p, signal) => {
      assertExtension(p.workbook, '.xlsx', 'workbook')
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
    tool<Static<typeof DocumentRead>>('document_read', 'Read up to 100 ordered Word text elements with stable element paths.', DocumentRead, async (p, signal) => {
      assertExtension(p.document, '.docx', 'document')
      const bounds = readBounds(p.start, p.end)
      const read = await boundary.readFileBytes(p.document, MAX_WORKBOOK_BYTES)
      validateOfficePackage(read.bytes, 'docx')
      return { document: boundary.displayPath(read.absolute), ...bounds, ...await documents.readWordBytes(read.bytes, bounds.start, bounds.end, signal) }
    }),
    tool<Static<typeof DocumentCreate>>('document_create_output', 'Create a Word output from an optional docx template and optional paragraphs.', DocumentCreate, async (p, signal) => {
      assertExtension(p.output, '.docx', 'output document')
      let source: { absolute: string; bytes: Uint8Array } | undefined
      if (p.source) {
        assertExtension(p.source, '.docx', 'source document')
        source = await boundary.readFileBytes(p.source, MAX_WORKBOOK_BYTES)
        validateOfficePackage(source.bytes, 'docx')
      }
      const paragraphs = (p.paragraphs ?? []) as WordParagraphInput[]
      const bytes = await documents.createWordBytes(source?.bytes, paragraphs, signal)
      validateOfficePackage(bytes, 'docx')
      const output = await boundary.writeOutputFileBytes(p.output, bytes, p.overwrite === true)
      return { ...(source ? { source: boundary.displayPath(source.absolute) } : {}), output: boundary.displayPath(output), paragraphs: paragraphs.length, bytes: bytes.byteLength }
    }),
    tool<Static<typeof DocumentUpdate>>('document_update', 'Atomically replace literal text and/or append paragraphs in an output Word document.', DocumentUpdate, async (p, signal) => {
      assertExtension(p.document, '.docx', 'document')
      const replacements = (p.replacements ?? []) as TextReplacement[]
      const appendParagraphs = (p.appendParagraphs ?? []) as WordParagraphInput[]
      validateMutations(replacements, appendParagraphs)
      const read = await boundary.readOutputFileBytes(p.document, MAX_WORKBOOK_BYTES)
      validateOfficePackage(read.bytes, 'docx')
      const bytes = await documents.updateWordBytes(read.bytes, replacements, appendParagraphs, signal)
      validateOfficePackage(bytes, 'docx')
      await boundary.writeOutputFileBytes(p.document, bytes, true)
      return { document: boundary.displayPath(read.absolute), replacements: replacements.length, appendedParagraphs: appendParagraphs.length, bytes: bytes.byteLength }
    }),
    tool<Static<typeof PresentationRead>>('presentation_read', 'Read text from up to 100 ordered PowerPoint slides.', PresentationRead, async (p, signal) => {
      assertExtension(p.presentation, '.pptx', 'presentation')
      const bounds = readBounds(p.start, p.end)
      const read = await boundary.readFileBytes(p.presentation, MAX_WORKBOOK_BYTES)
      validateOfficePackage(read.bytes, 'pptx')
      return { presentation: boundary.displayPath(read.absolute), ...bounds, ...await documents.readPresentationBytes(read.bytes, bounds.start, bounds.end, signal) }
    }),
    tool<Static<typeof PresentationCreate>>('presentation_create_output', 'Create a PowerPoint output from an optional pptx template and optional slides.', PresentationCreate, async (p, signal) => {
      assertExtension(p.output, '.pptx', 'output presentation')
      let source: { absolute: string; bytes: Uint8Array } | undefined
      if (p.source) {
        assertExtension(p.source, '.pptx', 'source presentation')
        source = await boundary.readFileBytes(p.source, MAX_WORKBOOK_BYTES)
        validateOfficePackage(source.bytes, 'pptx')
      }
      const slides = (p.slides ?? []) as PresentationSlideInput[]
      const bytes = await documents.createPresentationBytes(source?.bytes, slides, signal)
      validateOfficePackage(bytes, 'pptx')
      const output = await boundary.writeOutputFileBytes(p.output, bytes, p.overwrite === true)
      return { ...(source ? { source: boundary.displayPath(source.absolute) } : {}), output: boundary.displayPath(output), slides: slides.length, bytes: bytes.byteLength }
    }),
    tool<Static<typeof PresentationUpdate>>('presentation_update', 'Atomically replace literal text and/or append slides in an output PowerPoint presentation.', PresentationUpdate, async (p, signal) => {
      assertExtension(p.presentation, '.pptx', 'presentation')
      const replacements = (p.replacements ?? []) as TextReplacement[]
      const appendSlides = (p.appendSlides ?? []) as PresentationSlideInput[]
      validateMutations(replacements, appendSlides)
      const read = await boundary.readOutputFileBytes(p.presentation, MAX_WORKBOOK_BYTES)
      validateOfficePackage(read.bytes, 'pptx')
      const bytes = await documents.updatePresentationBytes(read.bytes, replacements, appendSlides, signal)
      validateOfficePackage(bytes, 'pptx')
      await boundary.writeOutputFileBytes(p.presentation, bytes, true)
      return { presentation: boundary.displayPath(read.absolute), replacements: replacements.length, appendedSlides: appendSlides.length, bytes: bytes.byteLength }
    }),
  ]
}

export const ENTERPRISE_TOOL_NAMES = [
  'workspace_list_files', 'workspace_read_text',
  'spreadsheet_read', 'spreadsheet_create_output', 'spreadsheet_update',
  'document_read', 'document_create_output', 'document_update',
  'presentation_read', 'presentation_create_output', 'presentation_update',
] as const
