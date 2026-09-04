import { PDFDocument, PDFName, PDFDict, PDFArray, PDFRef, type PDFObject } from 'pdf-lib'
import { PdfError, assertPdfMagic } from './errors.js'

/**
 * PDF deliverables on pdf-lib (pure JS). Stage 1 exposes one verb: compose a
 * new document from page ranges of workspace PDFs. That single verb covers
 * copy, merge, page extraction and reordering, so there is exactly one write
 * path. Sources are never modified; the result is sanitized so no document or
 * annotation action (JavaScript, Launch, form submission, attachments) is
 * carried into the deliverable.
 */
export interface PdfComposeSource {
  readonly bytes: Uint8Array
  /** 1-based page numbers in output order; omitted means every page. */
  readonly pages?: readonly number[]
  readonly label?: string
}

export interface PdfComposeResult {
  readonly bytes: Uint8Array
  readonly pageCount: number
  readonly removedAnnotations: number
}

export const MAX_COMPOSED_PAGES = 2000
const ALLOWED_ACTIONS = new Set(['URI', 'GoTo', 'Named'])
const REMOVED_ANNOTATION_SUBTYPES = new Set(['FileAttachment', 'RichMedia', '3D', 'Screen', 'Movie', 'Sound', 'Widget'])

/** Parse "1-3,5,8-" style page selections against a known page count. */
export function parsePageSelection(selection: string, pageCount: number): number[] {
  const pages: number[] = []
  for (const part of selection.split(',')) {
    const token = part.trim()
    if (token.length === 0) continue
    const match = /^(\d+)?(-)?(\d+)?$/u.exec(token)
    if (!match || (match[1] === undefined && match[3] === undefined)) throw new PdfError('page-range', `ページ指定「${token}」を解釈できません。例: 1-3,5`)
    const from = match[1] !== undefined ? Number(match[1]) : 1
    const to = match[2] === undefined ? from : match[3] !== undefined ? Number(match[3]) : pageCount
    if (from < 1 || to < from || to > pageCount) throw new PdfError('page-range', `ページ指定「${token}」は範囲外です（1〜${pageCount}）。`)
    for (let page = from; page <= to; page += 1) pages.push(page)
    if (pages.length > MAX_COMPOSED_PAGES) throw new PdfError('limit', `1 回に扱えるのは ${MAX_COMPOSED_PAGES} ページまでです。`)
  }
  if (pages.length === 0) throw new PdfError('page-range', 'ページ指定が空です。')
  return pages
}

function classify(error: unknown): PdfError {
  const name = error && typeof error === 'object' ? (error as { name?: string }).name : undefined
  const message = error instanceof Error ? error.message : String(error)
  if (name === 'EncryptedPDFError' || /encrypt/iu.test(message)) return new PdfError('encrypted', 'この PDF はパスワード保護（暗号化）されているため成果物の元にできません。')
  return new PdfError('damaged', 'この PDF は壊れているか、対応していない形式です。')
}

async function loadSource(bytes: Uint8Array): Promise<PDFDocument> {
  assertPdfMagic(bytes)
  try {
    return await PDFDocument.load(bytes, { ignoreEncryption: false, updateMetadata: false, throwOnInvalidObject: false })
  } catch (error) {
    throw classify(error)
  }
}

function actionSubtype(document: PDFDocument, action: PDFObject | undefined): string | undefined {
  const resolved = action instanceof PDFRef ? document.context.lookup(action) : action
  if (!(resolved instanceof PDFDict)) return undefined
  const subtype = resolved.get(PDFName.of('S'))
  return subtype instanceof PDFName ? subtype.decodeText() : undefined
}

/** Remove document-level actions and any annotation that could trigger an action or carry a file. */
export function sanitizeComposedDocument(document: PDFDocument): number {
  const catalog = document.catalog
  for (const key of ['OpenAction', 'AA', 'AcroForm', 'Collection']) catalog.delete(PDFName.of(key))
  const names = catalog.lookup(PDFName.of('Names'))
  if (names instanceof PDFDict) for (const key of ['JavaScript', 'EmbeddedFiles']) names.delete(PDFName.of(key))
  let removed = 0
  for (const page of document.getPages()) {
    page.node.delete(PDFName.of('AA'))
    const annots = page.node.lookup(PDFName.of('Annots'))
    if (!(annots instanceof PDFArray)) continue
    const kept = document.context.obj([]) as PDFArray
    for (const entry of annots.asArray()) {
      const annotation = entry instanceof PDFRef ? document.context.lookup(entry) : entry
      if (!(annotation instanceof PDFDict)) { removed += 1; continue }
      const subtype = annotation.get(PDFName.of('Subtype'))
      const subtypeName = subtype instanceof PDFName ? subtype.decodeText() : ''
      const action = actionSubtype(document, annotation.get(PDFName.of('A')))
      const hasAdditional = annotation.has(PDFName.of('AA'))
      const hasFile = annotation.has(PDFName.of('FS'))
      if (REMOVED_ANNOTATION_SUBTYPES.has(subtypeName) || hasAdditional || hasFile || (action !== undefined && !ALLOWED_ACTIONS.has(action))) { removed += 1; continue }
      kept.push(entry)
    }
    if (kept.size() === 0) page.node.delete(PDFName.of('Annots'))
    else page.node.set(PDFName.of('Annots'), kept)
  }
  return removed
}

export async function composePdf(sources: readonly PdfComposeSource[]): Promise<PdfComposeResult> {
  if (sources.length === 0) throw new PdfError('page-range', '元にする PDF を 1 つ以上指定してください。')
  const output = await PDFDocument.create({ updateMetadata: true })
  output.setProducer('Enterprise Misen')
  output.setCreator('Enterprise Misen')
  let total = 0
  for (const source of sources) {
    const document = await loadSource(source.bytes)
    const count = document.getPageCount()
    const pages = source.pages ?? Array.from({ length: count }, (_, index) => index + 1)
    for (const page of pages) if (!Number.isSafeInteger(page) || page < 1 || page > count) throw new PdfError('page-range', `${source.label ?? 'PDF'} にページ ${page} はありません（1〜${count}）。`)
    total += pages.length
    if (total > MAX_COMPOSED_PAGES) throw new PdfError('limit', `1 回に扱えるのは ${MAX_COMPOSED_PAGES} ページまでです。`)
    const copied = await output.copyPages(document, pages.map(page => page - 1))
    for (const page of copied) output.addPage(page)
  }
  const removedAnnotations = sanitizeComposedDocument(output)
  // Detached objects (removed annotations, their actions and embedded files) would still be
  // serialized as unreachable objects. Copy the sanitized pages into a fresh document so only
  // objects reachable from the kept pages are written.
  const clean = await PDFDocument.create({ updateMetadata: true })
  clean.setProducer('Enterprise Misen')
  clean.setCreator('Enterprise Misen')
  for (const page of await clean.copyPages(output, output.getPageIndices())) clean.addPage(page)
  sanitizeComposedDocument(clean)
  const bytes = await clean.save({ useObjectStreams: false, updateFieldAppearances: false })
  return { bytes, pageCount: clean.getPageCount(), removedAnnotations }
}
