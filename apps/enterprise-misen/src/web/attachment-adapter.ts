import type { Attachment, AttachmentAdapter, CompleteAttachment, PendingAttachment } from '@assistant-ui/react'

export const ATTACHMENT_ACCEPT = '.xlsx,.docx,.pptx,.csv,.md,.txt'
export const MAX_ATTACHMENT_BYTES = 64 * 1024 * 1024

const supported = new Set(ATTACHMENT_ACCEPT.split(','))

function validate(file: File): void {
  const extension = `.${file.name.split('.').at(-1)?.toLocaleLowerCase() ?? ''}`
  if (!supported.has(extension)) throw new Error(`このファイル形式は持ち込めません。対応形式: ${ATTACHMENT_ACCEPT.replaceAll(',', ' ')}`)
  if (file.size > MAX_ATTACHMENT_BYTES) throw new Error('ファイルは 64 MB 以下にしてください。')
}

export const misenAttachmentAdapter: AttachmentAdapter = {
  accept: ATTACHMENT_ACCEPT,
  async add({ file }): Promise<PendingAttachment> {
    validate(file)
    return { id: globalThis.crypto.randomUUID(), type: 'document', name: file.name, contentType: file.type || 'application/octet-stream', file, status: { type: 'requires-action', reason: 'composer-send' } }
  },
  async remove(_attachment: Attachment): Promise<void> { /* not uploaded until Send */ },
  async send(attachment: PendingAttachment): Promise<CompleteAttachment> {
    validate(attachment.file)
    const response = await fetch('/attachments', {
      method: 'POST',
      headers: { origin: globalThis.location.origin, 'content-type': 'application/octet-stream', 'x-misen-filename': encodeURIComponent(attachment.name) },
      body: attachment.file,
    })
    const result = await response.json().catch(() => ({ error: 'ファイルを持ち込めませんでした。' })) as { error?: string; name?: string; path?: string }
    if (!response.ok || !result.name || !result.path) throw new Error(result.error ?? 'ファイルを持ち込めませんでした。')
    return { ...attachment, name: result.name, status: { type: 'complete' }, content: [{ type: 'text', text: `持ち込んだファイル: ${result.path}` }] }
  },
}
