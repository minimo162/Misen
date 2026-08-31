import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'

import { WorkspaceBoundary } from '../workspace/boundary.js'

type JsonRecord = { [key: string]: JsonValue }

const MAX_LIST_ENTRIES = 20_000
const MAX_TEXT_CHARS = 200_000
const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.markdown', '.json', '.csv', '.yaml', '.yml', '.log'])

const JSON_OBJECT_OUTPUT = {
  schema: { type: 'object', additionalProperties: true } as const,
  render: (_args: unknown, value: JsonRecord) => [{ type: 'text' as const, text: JSON.stringify(value) }],
}

/**
 * Register the general file capabilities used by the first Enterprise PoC.
 * The model receives workspace-relative names only; host paths never cross
 * the tool boundary.
 */
export function createFileCapabilityTools(boundary: WorkspaceBoundary): readonly ToolDefinition[] {
  const listFiles = defineTool({
    name: 'workspace_list_files',
    description: 'List regular files below a workspace-relative directory.',
    parameters: {
      path: {
        type: 'string',
        description: 'Workspace-relative directory. Defaults to the workspace root.',
      },
      extension: {
        type: 'string',
        description: 'Optional extension filter such as .xlsx or .md.',
      },
    },
    output: JSON_OBJECT_OUTPUT,
    async execute(args) {
      const files = await boundary.listFiles(args.path ?? '.')
      const extension = args.extension?.toLocaleLowerCase()
      const filtered = extension === undefined || extension.length === 0
        ? files
        : files.filter(file => file.toLocaleLowerCase().endsWith(extension))
      if (filtered.length > MAX_LIST_ENTRIES) throw new RangeError(`file listing exceeds ${MAX_LIST_ENTRIES} entries`)
      return { files: filtered, count: filtered.length }
    },
  })

  const readText = defineTool({
    name: 'workspace_read_text',
    description: 'Read a UTF-8 text file inside the selected workspace.',
    parameters: {
      path: {
        type: 'string',
        required: true,
        description: 'Workspace-relative text file path.',
      },
      offset: {
        type: 'integer',
        description: 'Optional zero-based character offset.',
      },
      limit: {
        type: 'integer',
        description: 'Optional maximum number of characters.',
      },
    },
    output: JSON_OBJECT_OUTPUT,
    async execute(args, exec) {
      if (exec.signal.aborted) throw exec.signal.reason
      const { absolute, bytes: fileBytes } = await boundary.readFileBytes(args.path)
      const extension = absolute.slice(absolute.lastIndexOf('.')).toLocaleLowerCase()
      if (!TEXT_EXTENSIONS.has(extension)) throw new Error(`workspace_read_text does not support ${extension || 'binary'} files`)
      const fullText = Buffer.from(fileBytes).toString('utf8')
      if (exec.signal.aborted) throw exec.signal.reason
      const offset = args.offset ?? 0
      if (!Number.isInteger(offset) || offset < 0) throw new RangeError('offset must be a non-negative integer')
      if (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 0)) {
        throw new RangeError('limit must be a non-negative integer')
      }
      const requestedLimit = args.limit ?? MAX_TEXT_CHARS
      const effectiveLimit = Math.min(requestedLimit, MAX_TEXT_CHARS)
      const text = fullText.slice(offset, offset + effectiveLimit)
      return {
        path: boundary.displayPath(absolute),
        text,
        bytes: Buffer.byteLength(fullText, 'utf8'),
        offset,
        truncated: offset + text.length < fullText.length,
        maxChars: MAX_TEXT_CHARS,
      }
    },
  })

  return Object.freeze([listFiles, readText])
}
