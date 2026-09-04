import { stat } from 'node:fs/promises'
import { extname, isAbsolute } from 'node:path'
import { WorkspaceBoundary } from '../workspace/boundary.js'

export const MAX_WORKSPACE_TREE_ENTRIES = 300
export const MAX_WORKSPACE_TREE_BYTES = 16 * 1024
export const MAX_REFERENCED_DOCUMENTS_BYTES = 32 * 1024

const utf8 = new TextDecoder('utf-8', { fatal: true })
const DOCUMENT_EXTENSIONS = new Set(['.md', '.txt'])

export interface WorkspaceTreeEntry {
  readonly path: string
  readonly bytes: number
  readonly modifiedAt: string
}

export interface WorkspaceTree {
  readonly entries: readonly WorkspaceTreeEntry[]
  readonly truncated: boolean
}

export interface ReferencedDocument {
  readonly path: string
  readonly content?: string
  readonly omitted?: 'missing-or-invalid' | 'total-limit'
}

export async function loadWorkspaceTree(boundary: WorkspaceBoundary): Promise<WorkspaceTree> {
  const listing = await boundary.listFilesRecursive('.', undefined, MAX_WORKSPACE_TREE_ENTRIES + 1, 1024 * 1024)
  const entries: WorkspaceTreeEntry[] = []
  let truncated = listing.truncated
  for (const path of listing.files) {
    if (entries.length >= MAX_WORKSPACE_TREE_ENTRIES) { truncated = true; break }
    const absolute = await boundary.resolveFile(path)
    const info = await stat(absolute)
    const candidate = { path, bytes: info.size, modifiedAt: info.mtime.toISOString() }
    if (Buffer.byteLength(JSON.stringify({ entries: [...entries, candidate], truncated: false }, null, 2), 'utf8') > MAX_WORKSPACE_TREE_BYTES) { truncated = true; break }
    entries.push(candidate)
  }
  return Object.freeze({ entries: Object.freeze(entries), truncated })
}

function referencedPaths(instructions: string): string[] {
  const found = new Set<string>()
  const candidates = instructions.matchAll(/(?:^|[\s`('"\[])((?:\.\.\/|\.\/)?[^\s`'"()<>{}\[\]]+?\.(?:md|txt))(?=$|[\s`)'"\].,;:])/gimu)
  for (const match of candidates) {
    const path = match[1]!.replaceAll('\\', '/')
    if (isAbsolute(path) || path.startsWith('../') || path.includes('://') || path === 'AGENTS.md') continue
    if (!DOCUMENT_EXTENSIONS.has(extname(path).toLowerCase())) continue
    found.add(path.startsWith('./') ? path.slice(2) : path)
  }
  return [...found].sort((left, right) => left.localeCompare(right))
}

export async function loadReferencedDocuments(boundary: WorkspaceBoundary, instructions?: string): Promise<readonly ReferencedDocument[]> {
  if (!instructions) return Object.freeze([])
  const documents: ReferencedDocument[] = []
  let loadedBytes = 0
  for (const path of referencedPaths(instructions)) {
    try {
      const absolute = await boundary.resolveFile(path)
      const info = await stat(absolute)
      if (loadedBytes + info.size > MAX_REFERENCED_DOCUMENTS_BYTES) {
        documents.push(Object.freeze({ path, omitted: 'total-limit' }))
        continue
      }
      const { bytes } = await boundary.readFileBytes(path, MAX_REFERENCED_DOCUMENTS_BYTES)
      const content = utf8.decode(bytes)
      loadedBytes += bytes.byteLength
      documents.push(Object.freeze({ path, content }))
    } catch {
      documents.push(Object.freeze({ path, omitted: 'missing-or-invalid' }))
    }
  }
  return Object.freeze(documents)
}
