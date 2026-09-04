import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, extname, join } from 'node:path'
import { assertAllowedOfficeItem, assertAllowedOfficeVerb, type OfficePolicyItem } from '../capabilities/office-denylist.js'
import { validateDeliverable } from '../capabilities/guards.js'
import { OfficeCliSpreadsheet, officeCli, type OfficeCliBatchItem } from '../spreadsheet/officecli.js'
import { validateOfficePackage, type OfficeDocumentKind } from './openxml.js'

export type OfficeFileKind = 'xlsx' | OfficeDocumentKind
export const OFFICE_MUTATING_VERBS = Object.freeze(['set', 'add', 'remove', 'move', 'swap'] as const)
export const OFFICE_BATCH_COMMANDS = Object.freeze(['get', 'query', 'set', 'add', 'remove', 'move', 'swap', 'validate', 'view'] as const)
const batchCommands = new Set<string>(OFFICE_BATCH_COMMANDS)

export interface OfficeMutation extends OfficeCliBatchItem {
  readonly command: typeof OFFICE_MUTATING_VERBS[number]
}

export function officeKind(path: string): OfficeFileKind {
  const extension = extname(path).toLowerCase()
  if (extension === '.xlsx') return 'xlsx'
  if (extension === '.docx') return 'docx'
  if (extension === '.pptx') return 'pptx'
  throw new Error('Office file must use the .xlsx, .docx, or .pptx extension')
}

export function validateOfficeBytes(bytes: Uint8Array, kind: OfficeFileKind): void {
  if (kind === 'xlsx') validateDeliverable(bytes)
  else validateOfficePackage(bytes, kind)
}

export class OfficeCliVerbs {
  constructor(readonly client: OfficeCliSpreadsheet = officeCli()) {}

  private assertPropertiesApplied(receipts: readonly { readonly output?: unknown }[]): void {
    for (const receipt of receipts) {
      if (typeof receipt.output === 'string' && /\bUNSUPPORTED props?:/iu.test(receipt.output)) throw new Error('OfficeCLI rejected one or more properties')
      if (!receipt.output || typeof receipt.output !== 'object' || Array.isArray(receipt.output)) continue
      const unsupported = (receipt.output as Record<string, unknown>).unsupported_properties
      if (Array.isArray(unsupported) && unsupported.length > 0) throw new Error('OfficeCLI rejected properties: ' + unsupported.join(', '))
    }
  }

  private async withPrivateFile<T>(kind: OfficeFileKind, bytes: Uint8Array | undefined, action: (file: string, root: string) => Promise<T>): Promise<T> {
    const root = await mkdtemp(join(tmpdir(), 'misen-officecli-verbs-'))
    const file = join(root, `document.${kind}`)
    try {
      if (bytes !== undefined) await writeFile(file, bytes, { flag: 'wx', mode: 0o600 })
      return await action(file, root)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }

  async get(bytes: Uint8Array, kind: OfficeFileKind, path: string, depth: number, signal?: AbortSignal): Promise<unknown> {
    validateOfficeBytes(bytes, kind)
    return await this.withPrivateFile(kind, bytes, async file => (await this.client.json(['get', file, path, '--depth', String(depth)], { cwd: dirname(file), signal })).data)
  }

  async query(bytes: Uint8Array, kind: OfficeFileKind, selector: string, signal?: AbortSignal): Promise<unknown> {
    validateOfficeBytes(bytes, kind)
    return await this.withPrivateFile(kind, bytes, async file => (await this.client.json(['query', file, selector], { cwd: dirname(file), signal })).data)
  }

  async inspect(bytes: Uint8Array, kind: OfficeFileKind, mode: 'validate' | 'issues', signal?: AbortSignal): Promise<unknown> {
    validateOfficeBytes(bytes, kind)
    return await this.withPrivateFile(kind, bytes, async file => {
      if (mode === 'validate') {
        await this.client.validateFile(file, signal)
        return { errors: [], count: 0 }
      }
      return (await this.client.json(['view', file, 'issues'], { cwd: dirname(file), signal })).data
    })
  }

  async create(kind: OfficeFileKind, source: Uint8Array | undefined, signal?: AbortSignal): Promise<Uint8Array> {
    if (source !== undefined) validateOfficeBytes(source, kind)
    return await this.withPrivateFile(kind, source, async file => {
      if (source === undefined) {
        const args = ['create', file, '--type', kind]
        if (kind !== 'pptx') args.push('--locale', 'ja-JP')
        await this.client.json(args, { cwd: dirname(file), signal })
      }
      await this.client.validateFile(file, signal)
      const result = new Uint8Array(await readFile(file))
      validateOfficeBytes(result, kind)
      return result
    })
  }

  async mutate(bytes: Uint8Array, kind: OfficeFileKind, item: OfficeMutation, signal?: AbortSignal): Promise<{ readonly bytes: Uint8Array; readonly output: unknown }> {
    assertAllowedOfficeItem(item)
    validateOfficeBytes(bytes, kind)
    return await this.withPrivateFile(kind, bytes, async file => {
      const output = await this.client.batchFile(file, [item], signal)
      this.assertPropertiesApplied(output)
      await this.client.validateFile(file, signal)
      const result = new Uint8Array(await readFile(file))
      validateOfficeBytes(result, kind)
      return { bytes: result, output }
    })
  }

  async batch(bytes: Uint8Array, kind: OfficeFileKind, items: readonly OfficeCliBatchItem[], signal?: AbortSignal): Promise<{ readonly bytes: Uint8Array; readonly output: unknown }> {
    if (items.length === 0 || items.length > 200) throw new Error('OfficeCLI batch must contain 1 to 200 items')
    for (const item of items) {
      if (!batchCommands.has(item.command)) throw new Error(`OfficeCLI batch command ${item.command} is not exposed`)
      assertAllowedOfficeItem(item as OfficePolicyItem)
    }
    validateOfficeBytes(bytes, kind)
    return await this.withPrivateFile(kind, bytes, async file => {
      const output = await this.client.batchFile(file, items, signal)
      this.assertPropertiesApplied(output)
      await this.client.validateFile(file, signal)
      const result = new Uint8Array(await readFile(file))
      validateOfficeBytes(result, kind)
      return { bytes: result, output }
    })
  }

  async import(bytes: Uint8Array, source: Uint8Array, kind: OfficeFileKind, parent: string, format: 'csv' | 'tsv', header: boolean, startCell: string | undefined, signal?: AbortSignal): Promise<{ readonly bytes: Uint8Array; readonly output: unknown }> {
    if (kind !== 'xlsx') throw new Error('office_import supports xlsx outputs only')
    assertAllowedOfficeVerb('import')
    validateOfficeBytes(bytes, kind)
    return await this.withPrivateFile(kind, bytes, async (file, root) => {
      const sourceFile = join(root, `import.${format}`)
      await writeFile(sourceFile, source, { flag: 'wx', mode: 0o600 })
      const args = ['import', file, parent, '--file', sourceFile, '--format', format]
      if (header) args.push('--header')
      if (startCell) args.push('--start-cell', startCell)
      const output = (await this.client.json(args, { cwd: root, signal })).data
      await this.client.validateFile(file, signal)
      const result = new Uint8Array(await readFile(file))
      validateOfficeBytes(result, kind)
      return { bytes: result, output }
    })
  }
}
