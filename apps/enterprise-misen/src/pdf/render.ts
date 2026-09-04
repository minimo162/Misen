import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { PdfError, assertPdfMagic } from './errors.js'
import { encodePngRgba } from './png.js'

/**
 * Page rendering on PDFium compiled to WebAssembly (no native addon, no DLL,
 * no child process). Only the requested page is rendered, never the whole
 * document (ReportBinder's "render the visible page only" rule), and the
 * bitmap is bounded by a pixel budget (PdfKoseiAssist's scale clamp).
 */
export interface PdfRenderOptions {
  /** 1-based page number. */
  readonly page: number
  /** Scale relative to 72 dpi (default 1.5, clamped to 0.5..3 and to the pixel budget). */
  readonly scale?: number
}

export interface PdfRenderResult {
  readonly page: number
  readonly pageCount: number
  readonly width: number
  readonly height: number
  readonly scale: number
  readonly png: Uint8Array
}

export const DEFAULT_RENDER_SCALE = 1.5
export const MAX_RENDER_SCALE = 3
export const MAX_RENDER_PIXELS = 4_000_000

type PdfiumModule = typeof import('@hyzyla/pdfium')
type PdfiumLibrary = InstanceType<PdfiumModule['PDFiumLibrary']>

const require = createRequire(import.meta.url)
let library: Promise<PdfiumLibrary> | undefined

async function loadLibrary(): Promise<PdfiumLibrary> {
  if (!library) {
    library = (async () => {
      const module = await import('@hyzyla/pdfium') as PdfiumModule
      // The wasm binary is read from the pinned package path; nothing is fetched.
      const wasmPath = require.resolve('@hyzyla/pdfium').replace(/index\.cjs$/u, 'pdfium.wasm')
      const wasm = await readFile(wasmPath)
      return await module.PDFiumLibrary.init({ wasmBinary: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) })
    })()
  }
  return library
}

function classify(error: unknown): PdfError {
  const message = error instanceof Error ? error.message : String(error)
  if (/password/iu.test(message)) return new PdfError('encrypted', 'この PDF はパスワード保護（暗号化）されているため描画できません。')
  if (/security/iu.test(message)) return new PdfError('encrypted', 'この PDF は対応していない保護方式のため描画できません。')
  return new PdfError('damaged', 'この PDF は壊れているか、対応していない形式です。')
}

export async function renderPdfPage(bytes: Uint8Array, options: PdfRenderOptions): Promise<PdfRenderResult> {
  assertPdfMagic(bytes)
  if (!Number.isSafeInteger(options.page) || options.page < 1) throw new PdfError('page-range', 'page は 1 以上の整数で指定してください。')
  const requested = options.scale ?? DEFAULT_RENDER_SCALE
  if (!Number.isFinite(requested) || requested <= 0) throw new PdfError('limit', 'scale は正の数で指定してください。')
  const pdfium = await loadLibrary()
  let document
  try {
    document = await pdfium.loadDocument(Uint8Array.from(bytes))
  } catch (error) {
    throw classify(error)
  }
  try {
    const pageCount = document.getPageCount()
    if (options.page > pageCount) throw new PdfError('page-range', `ページ ${options.page} はありません。この PDF は ${pageCount} ページです。`)
    const page = document.getPage(options.page - 1)
    const { originalWidth, originalHeight } = page.getOriginalSize()
    const budgetScale = Math.sqrt(MAX_RENDER_PIXELS / Math.max(1, originalWidth * originalHeight))
    const scale = Math.max(0.5, Math.min(requested, MAX_RENDER_SCALE, budgetScale))
    const bitmap = await page.render({ scale, render: 'bitmap', colorSpace: 'BGRA', renderFormFields: false })
    // PDFium is invoked with REVERSE_BYTE_ORDER, so the buffer is already RGBA.
    const png = encodePngRgba(bitmap.width, bitmap.height, bitmap.data)
    return { page: options.page, pageCount, width: bitmap.width, height: bitmap.height, scale: Number(scale.toFixed(3)), png }
  } finally {
    document.destroy()
  }
}
