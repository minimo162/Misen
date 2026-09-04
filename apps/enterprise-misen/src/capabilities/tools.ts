import { Type, type Static } from '@earendil-works/pi-ai'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { WorkspaceBoundary } from '../workspace/boundary.js'
import { OfficeCliDocuments } from '../office/officecli.js'
import { OfficeCliVerbs, officeKind, type OfficeMutation } from '../office/officecli-verbs.js'
import { validateOfficePackage } from '../office/openxml.js'
import { DEFAULT_INSPECTION_RANGE, OfficeCliSpreadsheet, officeCli, type OfficeCliBatchItem } from '../spreadsheet/officecli.js'
import { validateDeliverable } from './guards.js'

const MAX_OFFICE_BYTES = 64 * 1024 * 1024
const MAX_IMPORT_BYTES = 32 * 1024 * 1024
const result = (details: object) => ({ content: [{ type: 'text' as const, text: JSON.stringify(details) }], details })
const Path = Type.Object({ path: Type.Optional(Type.String()), extension: Type.Optional(Type.String()) })
const Text = Type.Object({ path: Type.String(), offset: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 0, maximum: 200000 })) })
const Properties = Type.Record(Type.String({ minLength: 1, maxLength: 128 }), Type.String({ maxLength: 50000 }))
const OfficeGet = Type.Object({ file: Type.String({ minLength: 1 }), path: Type.Optional(Type.String({ minLength: 1 })), depth: Type.Optional(Type.Integer({ minimum: 0, maximum: 8 })) })
const OfficeQuery = Type.Object({ file: Type.String({ minLength: 1 }), selector: Type.String({ minLength: 1, maxLength: 2000 }) })
const OfficeInspect = Type.Object({ file: Type.String({ minLength: 1 }), mode: Type.Optional(Type.Union([Type.Literal('validate'), Type.Literal('issues')])) })
const OfficeCreate = Type.Object({ source: Type.Optional(Type.String({ minLength: 1 })), output: Type.String({ minLength: 1 }), overwrite: Type.Optional(Type.Boolean()) })
const OfficeSet = Type.Object({ file: Type.String({ minLength: 1 }), path: Type.String({ minLength: 1 }), properties: Properties })
const Position = { index: Type.Optional(Type.Integer({ minimum: 0, maximum: 100000 })), after: Type.Optional(Type.String({ minLength: 1 })), before: Type.Optional(Type.String({ minLength: 1 })) }
const OfficeAdd = Type.Object({ file: Type.String({ minLength: 1 }), parent: Type.String({ minLength: 1 }), type: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })), from: Type.Optional(Type.String({ minLength: 1 })), ...Position, properties: Type.Optional(Properties) })
const OfficeRemove = Type.Object({ file: Type.String({ minLength: 1 }), path: Type.String({ minLength: 1 }) })
const OfficeMove = Type.Object({ file: Type.String({ minLength: 1 }), path: Type.String({ minLength: 1 }), to: Type.Optional(Type.String({ minLength: 1 })), ...Position })
const OfficeSwap = Type.Object({ file: Type.String({ minLength: 1 }), path: Type.String({ minLength: 1 }), path2: Type.String({ minLength: 1 }) })
const BatchCommand = Type.Union(['get', 'query', 'set', 'add', 'remove', 'move', 'swap', 'validate', 'view'].map(value => Type.Literal(value)))
const BatchItem = Type.Object({
  command: BatchCommand, path: Type.Optional(Type.String()), parent: Type.Optional(Type.String()), type: Type.Optional(Type.String()), from: Type.Optional(Type.String()),
  index: Type.Optional(Type.Integer({ minimum: 0, maximum: 100000 })), after: Type.Optional(Type.String()), before: Type.Optional(Type.String()), to: Type.Optional(Type.String()),
  path2: Type.Optional(Type.String()), selector: Type.Optional(Type.String()), mode: Type.Optional(Type.String()), depth: Type.Optional(Type.Integer({ minimum: 0, maximum: 8 })), props: Type.Optional(Properties),
}, { additionalProperties: false })
const OfficeBatch = Type.Object({ file: Type.String({ minLength: 1 }), items: Type.Array(BatchItem, { minItems: 1, maxItems: 200 }) })
const OfficeImport = Type.Object({ file: Type.String({ minLength: 1 }), parent: Type.String({ minLength: 1 }), source: Type.String({ minLength: 1 }), format: Type.Optional(Type.Union([Type.Literal('csv'), Type.Literal('tsv')])), header: Type.Optional(Type.Boolean()), startCell: Type.Optional(Type.String({ pattern: '^[A-Za-z]{1,3}[1-9][0-9]{0,6}$' })) })

const SpreadsheetRead = Type.Object({ workbook: Type.String(), sheet: Type.Optional(Type.String()), range: Type.Optional(Type.String()) })
const BoundedRead = { start: Type.Optional(Type.Integer({ minimum: 1, maximum: 10000 })), end: Type.Optional(Type.Integer({ minimum: 1, maximum: 10000 })) }
const DocumentRead = Type.Object({ document: Type.String(), ...BoundedRead })
const PresentationRead = Type.Object({ presentation: Type.String(), ...BoundedRead })

function tool<P>(name: string, description: string, parameters: any, execute: (params: P, signal?: AbortSignal) => Promise<object>): AgentTool<any> {
  return { name, label: name, description, parameters, executionMode: 'sequential', execute: async (_id, params, signal) => result(await execute(params as P, signal)) }
}

function readBounds(start: number | undefined, end: number | undefined): { start: number; end: number } {
  const first = start ?? 1
  const last = end ?? Math.min(first + 99, 10000)
  if (last < first || last - first + 1 > 100) throw new Error('read range must contain at most 100 ordered items')
  return { start: first, end: last }
}

function assertPosition(value: { readonly index?: number; readonly after?: string; readonly before?: string }): void {
  if ([value.index, value.after, value.before].filter(item => item !== undefined).length > 1) throw new Error('index, after, and before are mutually exclusive')
}

export function enterpriseTools(boundary: WorkspaceBoundary, spreadsheets: OfficeCliSpreadsheet = officeCli(), documents: OfficeCliDocuments = new OfficeCliDocuments(spreadsheets)): AgentTool[] {
  const verbs = new OfficeCliVerbs(spreadsheets)

  async function readOffice(path: string): Promise<{ readonly absolute: string; readonly bytes: Uint8Array; readonly kind: ReturnType<typeof officeKind> }> {
    const kind = officeKind(path)
    const read = await boundary.readFileBytes(path, MAX_OFFICE_BYTES)
    return { ...read, kind }
  }

  async function mutateOutput(file: string, mutation: OfficeMutation | readonly OfficeCliBatchItem[], signal?: AbortSignal): Promise<object> {
    const kind = officeKind(file)
    const read = await boundary.readOutputFileBytes(file, MAX_OFFICE_BYTES)
    const changed = Array.isArray(mutation) ? await verbs.batch(read.bytes, kind, mutation, signal) : await verbs.mutate(read.bytes, kind, mutation as OfficeMutation, signal)
    await boundary.writeOutputFileBytes(file, changed.bytes, true)
    return { file: boundary.displayPath(read.absolute), bytes: changed.bytes.byteLength, output: changed.output }
  }

  return [
    tool<Static<typeof Path>>('workspace_list_files', 'List workspace files. Omit path for a bounded recursive tree from the workspace root.', Path, async p => {
      const requestedPath = p.path ?? '.'
      try {
        if (p.path === undefined) {
          const listing = await boundary.listFilesRecursive(requestedPath, p.extension)
          return { path: requestedPath, files: listing.files, truncated: listing.truncated }
        }
        const files = await boundary.listFiles(requestedPath)
        if (files.length > 20000) throw new RangeError('file listing exceeds 20000 entries')
        return { path: requestedPath, files: p.extension ? files.filter(path => path.toLowerCase().endsWith(p.extension!.toLowerCase())) : files, truncated: false }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        const candidates = await boundary.siblingDirectories(requestedPath).catch(() => [])
        const message = candidates.length > 0
          ? `フォルダー「${requestedPath}」は見つかりません。候補: ${candidates.join(', ')}`
          : `フォルダー「${requestedPath}」は見つかりません。`
        return { path: requestedPath, files: [], candidates, truncated: false, message }
      }
    }),
    tool<Static<typeof Text>>('workspace_read_text', 'Read a UTF-8 workspace text file.', Text, async p => {
      const read = await boundary.readFileBytes(p.path)
      if (!/\.(txt|md|markdown|json|csv|yaml|yml|log)$/iu.test(read.absolute)) throw new Error('unsupported text extension')
      const all = Buffer.from(read.bytes).toString('utf8')
      const offset = p.offset ?? 0
      const text = all.slice(offset, offset + Math.min(p.limit ?? 200000, 200000))
      return { path: boundary.displayPath(read.absolute), text, truncated: offset + text.length < all.length }
    }),
    tool<Static<typeof OfficeGet>>('office_get', 'Inspect an Office file. For xlsx, omit path to return sheet names and the first sheet values.', OfficeGet, async (p, signal) => {
      const read = await readOffice(p.file)
      if (read.kind === 'xlsx' && p.path === undefined) {
        validateDeliverable(read.bytes)
        return { file: boundary.displayPath(read.absolute), path: '/', data: await spreadsheets.readBytes(read.bytes, undefined, undefined, signal) }
      }
      const path = p.path ?? '/'
      return { file: boundary.displayPath(read.absolute), path, data: await verbs.get(read.bytes, read.kind, path, p.depth ?? 1, signal) }
    }),
    tool<Static<typeof OfficeQuery>>('office_query', 'Query Office elements with an OfficeCLI selector before choosing paths to edit.', OfficeQuery, async (p, signal) => {
      const read = await readOffice(p.file)
      return { file: boundary.displayPath(read.absolute), selector: p.selector, data: await verbs.query(read.bytes, read.kind, p.selector, signal) }
    }),
    tool<Static<typeof OfficeInspect>>('office_inspect', 'Run OfficeCLI validate or view issues without modifying the file.', OfficeInspect, async (p, signal) => {
      const read = await readOffice(p.file)
      const mode = p.mode ?? 'validate'
      return { file: boundary.displayPath(read.absolute), mode, data: await verbs.inspect(read.bytes, read.kind, mode, signal) }
    }),
    tool<Static<typeof OfficeCreate>>('office_create_output', 'Create a blank Office output or copy a workspace template. The destination must be below output. Check the workspace tree first: if the destination already exists, either choose a new name or pass overwrite: true, which asks the user for approval before replacing it.', OfficeCreate, async (p, signal) => {
      const kind = officeKind(p.output)
      let source: { readonly absolute: string; readonly bytes: Uint8Array } | undefined
      if (p.source !== undefined) {
        if (officeKind(p.source) !== kind) throw new Error('source and output Office formats must match')
        source = await boundary.readFileBytes(p.source, MAX_OFFICE_BYTES)
      }
      const bytes = await verbs.create(kind, source?.bytes, signal)
      const output = await boundary.writeOutputFileBytes(p.output, bytes, p.overwrite === true)
      return { ...(source ? { source: boundary.displayPath(source.absolute) } : {}), output: boundary.displayPath(output), bytes: bytes.byteLength }
    }),
    tool<Static<typeof OfficeSet>>('office_set', 'Set OfficeCLI properties on an existing output element. Inspect the exact path first.', OfficeSet, async (p, signal) => {
      if (Object.keys(p.properties).length === 0) throw new Error('office_set requires at least one property')
      return await mutateOutput(p.file, { command: 'set', path: p.path, props: p.properties }, signal)
    }),
    tool<Static<typeof OfficeAdd>>('office_add', 'Add or clone an OfficeCLI element in an existing output file.', OfficeAdd, async (p, signal) => {
      assertPosition(p)
      if ((p.type === undefined) === (p.from === undefined)) throw new Error('office_add requires exactly one of type or from')
      return await mutateOutput(p.file, { command: 'add', parent: p.parent, type: p.type, from: p.from, index: p.index, after: p.after, before: p.before, props: p.properties }, signal)
    }),
    tool<Static<typeof OfficeRemove>>('office_remove', 'Remove an OfficeCLI element from an existing output file.', OfficeRemove, async (p, signal) => await mutateOutput(p.file, { command: 'remove', path: p.path }, signal)),
    tool<Static<typeof OfficeMove>>('office_move', 'Move or reorder an OfficeCLI element in an existing output file.', OfficeMove, async (p, signal) => {
      assertPosition(p)
      return await mutateOutput(p.file, { command: 'move', path: p.path, to: p.to, index: p.index, after: p.after, before: p.before }, signal)
    }),
    tool<Static<typeof OfficeSwap>>('office_swap', 'Swap two OfficeCLI elements in an existing output file.', OfficeSwap, async (p, signal) => await mutateOutput(p.file, { command: 'swap', path: p.path, path2: p.path2 }, signal)),
    tool<Static<typeof OfficeBatch>>('office_batch', 'Atomically run 1 to 200 OfficeCLI items against an existing output file. Every item passes the same deny list.', OfficeBatch, async (p, signal) => await mutateOutput(p.file, p.items as OfficeCliBatchItem[], signal)),
    tool<Static<typeof OfficeImport>>('office_import', 'Import a workspace CSV or TSV into an existing xlsx output.', OfficeImport, async (p, signal) => {
      const format = p.format ?? (p.source.toLowerCase().endsWith('.tsv') ? 'tsv' : 'csv')
      if (!p.source.toLowerCase().endsWith('.' + format)) throw new Error(`office_import source must use the .${format} extension`)
      const output = await boundary.readOutputFileBytes(p.file, MAX_OFFICE_BYTES)
      const source = await boundary.readFileBytes(p.source, MAX_IMPORT_BYTES)
      const changed = await verbs.import(output.bytes, source.bytes, officeKind(p.file), p.parent, format, p.header === true, p.startCell, signal)
      await boundary.writeOutputFileBytes(p.file, changed.bytes, true)
      return { file: boundary.displayPath(output.absolute), source: boundary.displayPath(source.absolute), bytes: changed.bytes.byteLength, output: changed.output }
    }),
    tool<Static<typeof SpreadsheetRead>>('spreadsheet_read', 'Read sheet names and values. Omit sheet to read the first sheet; omitted ranges are bounded to 200 rows by 30 columns.', SpreadsheetRead, async (p, signal) => {
      const read = await boundary.readFileBytes(p.workbook, MAX_OFFICE_BYTES)
      validateDeliverable(read.bytes)
      const workbook = await spreadsheets.readBytes(read.bytes, p.sheet, p.range, signal)
      return { workbook: boundary.displayPath(read.absolute), sheets: workbook.sheets, sheet: workbook.sheet, range: p.range ?? DEFAULT_INSPECTION_RANGE, values: workbook.values }
    }),
    tool<Static<typeof DocumentRead>>('document_read', 'Compatibility alias for reading bounded Word text elements.', DocumentRead, async (p, signal) => {
      const bounds = readBounds(p.start, p.end)
      const read = await boundary.readFileBytes(p.document, MAX_OFFICE_BYTES)
      validateOfficePackage(read.bytes, 'docx')
      return { document: boundary.displayPath(read.absolute), ...bounds, ...await documents.readWordBytes(read.bytes, bounds.start, bounds.end, signal) }
    }),
    tool<Static<typeof PresentationRead>>('presentation_read', 'Compatibility alias for reading bounded PowerPoint slide text.', PresentationRead, async (p, signal) => {
      const bounds = readBounds(p.start, p.end)
      const read = await boundary.readFileBytes(p.presentation, MAX_OFFICE_BYTES)
      validateOfficePackage(read.bytes, 'pptx')
      return { presentation: boundary.displayPath(read.absolute), ...bounds, ...await documents.readPresentationBytes(read.bytes, bounds.start, bounds.end, signal) }
    }),
  ]
}

export const ENTERPRISE_TOOL_NAMES = [
  'workspace_list_files', 'workspace_read_text',
  'office_get', 'office_query', 'office_inspect', 'office_create_output',
  'office_set', 'office_add', 'office_remove', 'office_move', 'office_swap', 'office_batch', 'office_import',
  'spreadsheet_read', 'document_read', 'presentation_read',
] as const
