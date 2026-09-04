/**
 * PDF failures are classified so the Tool result (and the UI detail line) can say
 * exactly why a document was refused instead of leaking parser internals.
 */
export type PdfErrorCode = 'not-pdf' | 'encrypted' | 'damaged' | 'page-range' | 'limit'

export class PdfError extends Error {
  override readonly name = 'PdfError'
  constructor(readonly code: PdfErrorCode, message: string) {
    super(message)
  }
}

const HEADER_WINDOW = 1024

/** Reject anything that does not start with a `%PDF-` header inside the first KiB (ReportBinder's magic check). */
export function assertPdfMagic(bytes: Uint8Array): void {
  const head = Buffer.from(bytes.subarray(0, Math.min(bytes.byteLength, HEADER_WINDOW))).toString('latin1')
  if (!head.includes('%PDF-')) throw new PdfError('not-pdf', 'PDF ではありません（%PDF- ヘッダーがありません）。')
}

export function isPdfPath(path: string): boolean {
  return /\.pdf$/iu.test(path)
}
