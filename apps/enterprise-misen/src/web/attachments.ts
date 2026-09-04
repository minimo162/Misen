import { createHash, randomUUID } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { extname } from 'node:path'
import { WorkspaceBoundary } from '../workspace/boundary.js'

export const MAX_ATTACHMENT_BYTES = 64 * 1024 * 1024
export const ATTACHMENT_EXTENSIONS = ['.xlsx', '.docx', '.pptx', '.pdf', '.csv', '.md', '.txt'] as const
const allowed = new Set<string>(ATTACHMENT_EXTENSIONS)

export class AttachmentImportError extends Error {
  constructor(readonly status: number, message: string) { super(message); this.name = 'AttachmentImportError' }
}

export function safeAttachmentName(input: string): string {
  const decoded = input.normalize('NFC').split(/[\\/]/u).at(-1) ?? ''
  const extension = extname(decoded).toLocaleLowerCase()
  if (!allowed.has(extension)) throw new AttachmentImportError(415, `このファイル形式は持ち込めません。対応形式: ${ATTACHMENT_EXTENSIONS.join(' ')}`)
  const stem = decoded.slice(0, -extension.length).replace(/[^\p{L}\p{N} ._-]+/gu, '_').replace(/[. ]+$/u, '').replace(/^[. ]+/u, '').slice(0, 100)
  return `${stem || 'file'}${extension}`
}

export async function readAttachmentRequest(request: IncomingMessage): Promise<Uint8Array> {
  const declared = Number(request.headers['content-length'] ?? 0)
  if (Number.isFinite(declared) && declared > MAX_ATTACHMENT_BYTES) throw new AttachmentImportError(413, 'ファイルは 64 MB 以下にしてください。')
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk)
    size += bytes.byteLength
    if (size > MAX_ATTACHMENT_BYTES) throw new AttachmentImportError(413, 'ファイルは 64 MB 以下にしてください。')
    chunks.push(bytes)
  }
  return Uint8Array.from(Buffer.concat(chunks))
}

export async function importAttachment(boundary: WorkspaceBoundary, requestedName: string, bytes: Uint8Array) {
  const safeName = safeAttachmentName(requestedName)
  const id = randomUUID()
  const path = await boundary.writeImportedInputFile(safeName, bytes)
  return { id, name: path.split('/').at(-1)!, path, size: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') }
}
