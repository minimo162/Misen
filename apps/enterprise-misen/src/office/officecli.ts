import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { OfficeCliProcessError } from '../spreadsheet/officecli-process.js'
import { OfficeCliSpreadsheet, officeCli, type OfficeCliBatchItem } from '../spreadsheet/officecli.js'
import type { OfficeDocumentKind } from './openxml.js'

export interface WordParagraphInput {
  readonly text: string
  readonly style?: string
}

export interface PresentationSlideInput {
  readonly title: string
  readonly text?: string
  readonly layout?: 'title' | 'blank' | 'twoContent' | 'titleOnly' | 'titleContent' | 'section' | 'comparison'
}

export interface TextReplacement {
  readonly find: string
  readonly replace: string
}

export interface WordTextElement {
  readonly path: string
  readonly type: string
  readonly text: string
}

export interface PresentationSlideText {
  readonly index: number
  readonly path: string
  readonly texts: readonly string[]
}

const MAX_RESULT_JSON_CHARS = 200_000

function ensureBoundedResult(value: unknown): void {
  if (JSON.stringify(value).length > MAX_RESULT_JSON_CHARS) throw new OfficeCliProcessError('OfficeCLI document result exceeds the model-facing bound', 'output_limit')
}

function batchItems(replacements: readonly TextReplacement[]): OfficeCliBatchItem[] {
  return replacements.map(replacement => ({ command: 'set', path: '/', props: { find: replacement.find, replace: replacement.replace } }))
}

function requireReplacementMatches(receipts: readonly { readonly output?: unknown }[], replacements: number): void {
  for (let index = 0; index < replacements; index += 1) {
    const output = receipts[index]?.output
    const match = typeof output === 'string' ? /\(([1-9]\d*) matched\)$/u.exec(output) : undefined
    if (!match) throw new OfficeCliProcessError('OfficeCLI did not confirm a requested text replacement', 'replacement_not_found')
  }
}

export class OfficeCliDocuments {
  constructor(readonly client: OfficeCliSpreadsheet = officeCli()) {}

  private async withPrivateFile<T>(kind: OfficeDocumentKind, bytes: Uint8Array | undefined, action: (file: string) => Promise<T>): Promise<T> {
    const root = await mkdtemp(join(tmpdir(), `misen-office-${kind}-`))
    const file = join(root, kind === 'docx' ? 'document.docx' : 'presentation.pptx')
    try {
      if (bytes) await writeFile(file, bytes, { flag: 'wx', mode: 0o600 })
      return await action(file)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }

  async readWordBytes(bytes: Uint8Array, start: number, end: number, signal?: AbortSignal): Promise<{ readonly totalElements: number; readonly elements: readonly WordTextElement[] }> {
    return await this.withPrivateFile('docx', bytes, async file => {
      const envelope = await this.client.json(['view', file, 'text', '--start', String(start), '--end', String(end)], { cwd: dirname(file), signal })
      const data = envelope.data as Record<string, unknown> | undefined
      if (!data || !Number.isSafeInteger(data.totalElements) || !Array.isArray(data.elements)) throw new OfficeCliProcessError('OfficeCLI Word text result is malformed', 'unexpected_output')
      if ((data.totalElements as number) < 0 || data.elements.length > end - start + 1) throw new OfficeCliProcessError('OfficeCLI Word text result exceeds the requested range', 'unexpected_output')
      const elements = data.elements.map(item => {
        const value = item as Record<string, unknown>
        if (typeof value.path !== 'string' || typeof value.type !== 'string' || typeof value.text !== 'string') throw new OfficeCliProcessError('OfficeCLI Word element is malformed', 'unexpected_output')
        return { path: value.path, type: value.type, text: value.text }
      })
      const result = { totalElements: data.totalElements as number, elements }
      ensureBoundedResult(result)
      return result
    })
  }

  async readPresentationBytes(bytes: Uint8Array, start: number, end: number, signal?: AbortSignal): Promise<{ readonly totalSlides: number; readonly slides: readonly PresentationSlideText[] }> {
    return await this.withPrivateFile('pptx', bytes, async file => {
      const envelope = await this.client.json(['view', file, 'text', '--start', String(start), '--end', String(end)], { cwd: dirname(file), signal })
      const data = envelope.data as Record<string, unknown> | undefined
      if (!data || !Number.isSafeInteger(data.totalSlides) || !Array.isArray(data.slides)) throw new OfficeCliProcessError('OfficeCLI PowerPoint text result is malformed', 'unexpected_output')
      if ((data.totalSlides as number) < 0 || data.slides.length > end - start + 1) throw new OfficeCliProcessError('OfficeCLI PowerPoint text result exceeds the requested range', 'unexpected_output')
      const slides = data.slides.map(item => {
        const value = item as Record<string, unknown>
        if (!Number.isSafeInteger(value.index) || typeof value.path !== 'string' || !Array.isArray(value.texts) || value.texts.some(text => typeof text !== 'string')) throw new OfficeCliProcessError('OfficeCLI PowerPoint slide is malformed', 'unexpected_output')
        return { index: value.index as number, path: value.path, texts: value.texts as string[] }
      })
      const result = { totalSlides: data.totalSlides as number, slides }
      ensureBoundedResult(result)
      return result
    })
  }

  async createWordBytes(source: Uint8Array | undefined, paragraphs: readonly WordParagraphInput[], signal?: AbortSignal): Promise<Uint8Array> {
    return await this.withPrivateFile('docx', source, async file => {
      if (!source) await this.client.json(['create', file, '--type', 'docx', '--locale', 'ja-JP'], { cwd: dirname(file), signal })
      if (paragraphs.length > 0) await this.client.batchFile(file, paragraphs.map(paragraph => ({ command: 'add', parent: '/body', type: 'paragraph', props: { text: paragraph.text, ...(paragraph.style ? { style: paragraph.style } : {}) } })), signal)
      await this.client.validateFile(file, signal)
      return new Uint8Array(await readFile(file))
    })
  }

  async updateWordBytes(bytes: Uint8Array, replacements: readonly TextReplacement[], appendParagraphs: readonly WordParagraphInput[], signal?: AbortSignal): Promise<Uint8Array> {
    return await this.withPrivateFile('docx', bytes, async file => {
      const items: OfficeCliBatchItem[] = [
        ...batchItems(replacements),
        ...appendParagraphs.map(paragraph => ({ command: 'add', parent: '/body', type: 'paragraph', props: { text: paragraph.text, ...(paragraph.style ? { style: paragraph.style } : {}) } })),
      ]
      const receipts = await this.client.batchFile(file, items, signal)
      requireReplacementMatches(receipts, replacements.length)
      await this.client.validateFile(file, signal)
      return new Uint8Array(await readFile(file))
    })
  }

  async createPresentationBytes(source: Uint8Array | undefined, slides: readonly PresentationSlideInput[], signal?: AbortSignal): Promise<Uint8Array> {
    return await this.withPrivateFile('pptx', source, async file => {
      if (!source) await this.client.json(['create', file, '--type', 'pptx'], { cwd: dirname(file), signal })
      if (slides.length > 0) await this.client.batchFile(file, slides.map(slide => ({ command: 'add', parent: '/', type: 'slide', props: { title: slide.title, ...(slide.text === undefined ? {} : { text: slide.text }), ...(slide.layout ? { layout: slide.layout } : {}) } })), signal)
      await this.client.validateFile(file, signal)
      return new Uint8Array(await readFile(file))
    })
  }

  async updatePresentationBytes(bytes: Uint8Array, replacements: readonly TextReplacement[], appendSlides: readonly PresentationSlideInput[], signal?: AbortSignal): Promise<Uint8Array> {
    return await this.withPrivateFile('pptx', bytes, async file => {
      const items: OfficeCliBatchItem[] = [
        ...batchItems(replacements),
        ...appendSlides.map(slide => ({ command: 'add', parent: '/', type: 'slide', props: { title: slide.title, ...(slide.text === undefined ? {} : { text: slide.text }), ...(slide.layout ? { layout: slide.layout } : {}) } })),
      ]
      const receipts = await this.client.batchFile(file, items, signal)
      requireReplacementMatches(receipts, replacements.length)
      await this.client.validateFile(file, signal)
      return new Uint8Array(await readFile(file))
    })
  }
}

let defaultDocuments: OfficeCliDocuments | undefined
export function officeCliDocuments(): OfficeCliDocuments {
  defaultDocuments ??= new OfficeCliDocuments()
  return defaultDocuments
}
