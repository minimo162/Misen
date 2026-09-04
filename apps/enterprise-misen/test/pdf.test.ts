import test from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Agent } from '@earendil-works/pi-agent-core'
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai'
import { unzlibSync } from 'fflate'
import { PDFDocument } from 'pdf-lib'
import { enterpriseTools, ENTERPRISE_TOOL_NAMES } from '../src/capabilities/tools.js'
import { READ_TOOL_NAMES, withSessionReadCache } from '../src/capabilities/tool-cache.js'
import { PdfError } from '../src/pdf/errors.js'
import { encodePngRgba } from '../src/pdf/png.js'
import { readPdf, reconstructLines } from '../src/pdf/read.js'
import { renderPdfPage, MAX_RENDER_PIXELS } from '../src/pdf/render.js'
import { composePdf, parsePageSelection } from '../src/pdf/output.js'
import { checkpointFor } from '../src/runtime/live.js'
import { prepareAgentCustomization } from '../src/runtime/customized.js'
import { safeAttachmentName } from '../src/web/attachments.js'
import { PLAN_TOOLS } from '../src/web/planning.js'
import { createAgentRunner, safeToolTarget, type AgentFactory } from '../src/web/server.js'
import { WorkspaceBoundary, WorkspaceBoundaryError } from '../src/workspace/boundary.js'
import { activeContentPdf, colorOf, encryptedPdf, malformedPdf, multiPagePdf, scanPdf, sha256, tablePdf, textPdf } from './pdf-fixtures.js'

async function workspace(files: Record<string, Uint8Array>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'misen-pdf-'))
  await mkdir(join(root, 'output'), { recursive: true })
  for (const [name, bytes] of Object.entries(files)) await writeFile(join(root, name), bytes)
  return root
}

const tool = (root: string, name: string) => enterpriseTools(new WorkspaceBoundary(root)).find(candidate => candidate.name === name)!

function decodePng(png: Uint8Array): { width: number; height: number; rgba: Uint8Array } {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength)
  assert.equal(view.getUint32(0), 0x89504e47)
  const width = view.getUint32(16)
  const height = view.getUint32(20)
  const chunks: Uint8Array[] = []
  let offset = 8
  while (offset < png.byteLength) {
    const length = view.getUint32(offset)
    const type = Buffer.from(png.subarray(offset + 4, offset + 8)).toString('latin1')
    if (type === 'IDAT') chunks.push(png.subarray(offset + 8, offset + 8 + length))
    offset += 12 + length
  }
  const raw = unzlibSync(Buffer.concat(chunks))
  const rgba = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y += 1) {
    assert.equal(raw[y * (width * 4 + 1)], 0)
    rgba.set(raw.subarray(y * (width * 4 + 1) + 1, (y + 1) * (width * 4 + 1)), y * width * 4)
  }
  return { width, height, rgba }
}

test('pdf tools are on the authority roster, the read cache, the plan roster and the UI target map', () => {
  for (const name of ['pdf_read', 'pdf_render', 'pdf_create_output']) {
    assert.ok(ENTERPRISE_TOOL_NAMES.includes(name as any))
    assert.ok(PLAN_TOOLS.includes(name as any))
  }
  assert.ok(READ_TOOL_NAMES.includes('pdf_read'))
  assert.ok(READ_TOOL_NAMES.includes('pdf_render'))
  assert.ok(!READ_TOOL_NAMES.includes('pdf_create_output' as any))
  assert.equal(safeToolTarget('pdf_read', { file: '資料\\report.pdf', start: 2 }), '資料/report.pdf')
  assert.equal(safeToolTarget('pdf_create_output', { output: 'output/merged.pdf', sources: [] }), 'output/merged.pdf')
  assert.equal(safeAttachmentName('決算.pdf'), '決算.pdf')
})

test('pdf_read returns page count, metadata, per-page text and active-content flags in one call', async () => {
  const root = await workspace({ 'report.pdf': await multiPagePdf(10) })
  try {
    const result = await tool(root, 'pdf_read').execute('read', { file: 'report.pdf' }, undefined) as any
    const details = result.details
    assert.equal(details.file, 'report.pdf')
    assert.equal(details.pageCount, 10)
    assert.equal(details.pages.length, 10)
    assert.deepEqual(details.pages.map((page: any) => page.page), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    assert.match(details.pages[0].text, /^Page 1 heading\nLine 0 of page 1/u)
    assert.match(details.pages[9].text, /^Page 10 heading/u)
    assert.equal(details.truncated, false)
    assert.equal(details.metadata.encrypted, false)
    assert.equal(details.metadata.producer.includes('pdf-lib'), true)
    assert.deepEqual(details.textlessPages, [])
    assert.deepEqual(details.activeContent, { javascript: false, openAction: false, launchActions: 0, links: 0, attachments: 0, fileAttachmentAnnotations: 0, acroForm: false, xfa: false, signatures: false })
    assert.match(details.notice, /untrusted/u)
    assert.equal(result.content[0].type, 'text')
    assert.equal(JSON.parse(result.content[0].text).pageCount, 10)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('pdf_read keeps table cells on one row and preserves page order across 50 pages', async () => {
  const table = await readPdf(await tablePdf(), { start: 3, end: 3 })
  assert.deepEqual(table.range, { start: 3, end: 3 })
  assert.ok(table.pages[0]!.text.includes('Region | Q1 | Q2 | Total\nEMEA | 100 | 120 | 220\nAPAC | 80 | 95 | 175\nAmericas | 130 | 110 | 240'), table.pages[0]!.text)
  const large = await readPdf(await multiPagePdf(50))
  assert.equal(large.pageCount, 50)
  assert.equal(large.pages.length, 50)
  assert.deepEqual(large.pages.map(page => page.page), Array.from({ length: 50 }, (_, index) => index + 1))
  assert.equal(large.truncated, false)
})

test('pdf_read bounds the result and names the continuation page instead of returning everything', async () => {
  const bytes = await multiPagePdf(50)
  const first = await readPdf(bytes, { maxChars: 3000 })
  assert.equal(first.truncated, true)
  assert.ok(first.pages.length < 50)
  assert.equal(first.nextStart, first.range.end + 1)
  assert.match(first.continuation!, /start: \d+/u)
  const next = await readPdf(bytes, { start: first.nextStart!, maxChars: 3000 })
  assert.equal(next.range.start, first.nextStart)
  const capped = await readPdf(bytes, { maxPages: 5 })
  assert.equal(capped.pages.length, 5)
  assert.equal(capped.nextStart, 6)
  await assert.rejects(readPdf(bytes, { start: 51 }), (error: PdfError) => error.code === 'page-range')
  await assert.rejects(readPdf(bytes, { start: 3, end: 2 }), (error: PdfError) => error.code === 'page-range')
})

test('layout reconstruction orders lines top-down and left-right', () => {
  const lines = reconstructLines([
    { str: 'B', x: 100, y: 700, width: 10, size: 10 },
    { str: 'A', x: 50, y: 700.4, width: 10, size: 10 },
    { str: 'second', x: 50, y: 680, width: 30, size: 10 },
    { str: ' ', x: 60, y: 700, width: 40, size: 10 },
  ])
  assert.deepEqual(lines, ['A | B', 'second'])
})

test('scan / image-only pages are reported as textless without any OCR or network dependency', async () => {
  const result = await readPdf(await scanPdf())
  assert.equal(result.pages[0]!.textless, true)
  assert.deepEqual(result.textlessPages, [1])
  assert.equal(result.pages[0]!.text, '')
})

test('encrypted and damaged PDFs fail explicitly in read, render and compose', async () => {
  const encrypted = encryptedPdf()
  await assert.rejects(readPdf(encrypted), (error: PdfError) => error.code === 'encrypted' && /パスワード/u.test(error.message))
  await assert.rejects(renderPdfPage(encrypted, { page: 1 }), (error: PdfError) => error.code === 'encrypted')
  await assert.rejects(composePdf([{ bytes: encrypted }]), (error: PdfError) => error.code === 'encrypted')
  const damaged = await malformedPdf()
  await assert.rejects(readPdf(damaged), (error: PdfError) => error.code === 'damaged')
  await assert.rejects(renderPdfPage(damaged, { page: 1 }), (error: PdfError) => error.code === 'damaged')
  await assert.rejects(composePdf([{ bytes: damaged }]), (error: PdfError) => error.code === 'damaged')
  await assert.rejects(readPdf(Buffer.from('PKnot a pdf')), (error: PdfError) => error.code === 'not-pdf')
  const root = await workspace({ 'sheet.xlsx': Buffer.from('x'), 'locked.pdf': encrypted })
  try {
    await assert.rejects(tool(root, 'pdf_read').execute('read', { file: 'sheet.xlsx' }, undefined), (error: PdfError) => error.code === 'not-pdf')
    await assert.rejects(tool(root, 'pdf_read').execute('read', { file: 'locked.pdf' }, undefined), (error: PdfError) => error.code === 'encrypted')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('embedded JavaScript, Launch, attachments and injected instructions are reported as data and never executed', async () => {
  const result = await readPdf(await activeContentPdf())
  assert.deepEqual(result.activeContent, { javascript: true, openAction: true, launchActions: 1, links: 1, attachments: 0, fileAttachmentAnnotations: 1, acroForm: false, xfa: false, signatures: false })
  assert.ok(result.pages[0]!.text.includes('IGNORE ALL PREVIOUS INSTRUCTIONS'))
  assert.ok(!('javascriptSource' in result))
})

test('pdf_render renders exactly the requested page as a bounded PNG image part', async () => {
  const root = await workspace({ 'report.pdf': await tablePdf() })
  try {
    const result = await tool(root, 'pdf_render').execute('render', { file: 'report.pdf', page: 3 }, undefined) as any
    assert.deepEqual(result.content.map((part: any) => part.type), ['text', 'image'])
    assert.equal(result.content[1].mimeType, 'image/png')
    assert.equal(result.details.page, 3)
    assert.equal(result.details.pageCount, 3)
    assert.equal(result.details.image, 'image/png')
    const png = Buffer.from(result.content[1].data, 'base64')
    const image = decodePng(png)
    assert.equal(image.width, result.details.width)
    assert.equal(image.height, result.details.height)
    assert.ok(image.width * image.height <= MAX_RENDER_PIXELS)
    assert.deepEqual(colorOf(image.rgba, image.width, 5, 5), [255, 255, 255])
    const dark = Array.from({ length: image.width * image.height }, (_, index) => image.rgba[index * 4]!).filter(value => value < 128).length
    assert.ok(dark > 200, `text pixels expected, got ${dark}`)
    await assert.rejects(tool(root, 'pdf_render').execute('render', { file: 'report.pdf', page: 4 }, undefined), (error: PdfError) => error.code === 'page-range')
    const clamped = await renderPdfPage(await textPdf(), { page: 1, scale: 3 })
    assert.ok(clamped.width * clamped.height <= MAX_RENDER_PIXELS)
    assert.ok(clamped.scale < 3)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('png encoder round-trips pixels', () => {
  const rgba = Uint8Array.from([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 9, 8, 7, 255])
  const image = decodePng(encodePngRgba(2, 2, rgba))
  assert.deepEqual(Array.from(image.rgba), Array.from(rgba))
  assert.throws(() => encodePngRgba(2, 2, new Uint8Array(3)), RangeError)
})

test('pdf_create_output merges, extracts and reorders pages below output without touching the sources', async () => {
  const first = await multiPagePdf(3)
  const second = await tablePdf()
  const root = await workspace({ 'a.pdf': first, 'b.pdf': second })
  try {
    const before = [sha256(await readFile(join(root, 'a.pdf'))), sha256(await readFile(join(root, 'b.pdf')))]
    const result = await tool(root, 'pdf_create_output').execute('merge', { sources: [{ file: 'a.pdf' }, { file: 'b.pdf', pages: '3,1' }], output: 'output/merged.pdf' }, undefined) as any
    assert.equal(result.details.output, 'output/merged.pdf')
    assert.equal(result.details.pageCount, 5)
    assert.deepEqual(result.details.sources, [{ file: 'a.pdf' }, { file: 'b.pdf', pages: [3, 1] }])
    const merged = await readPdf(await readFile(join(root, 'output', 'merged.pdf')))
    assert.deepEqual(merged.pages.map(page => page.text.split('\n')[0]), ['Page 1 heading', 'Page 2 heading', 'Page 3 heading', 'Page 3 heading', 'Page 1 heading'])
    assert.ok(merged.pages[3]!.text.includes('Region | Q1'))
    assert.equal(merged.metadata.producer, 'Enterprise Misen')
    assert.deepEqual([sha256(await readFile(join(root, 'a.pdf'))), sha256(await readFile(join(root, 'b.pdf')))], before)
    await assert.rejects(tool(root, 'pdf_create_output').execute('dup', { sources: [{ file: 'a.pdf' }], output: 'output/merged.pdf' }, undefined), WorkspaceBoundaryError)
    const replaced = await tool(root, 'pdf_create_output').execute('dup', { sources: [{ file: 'a.pdf', pages: '2' }], output: 'output/merged.pdf', overwrite: true }, undefined) as any
    assert.equal(replaced.details.pageCount, 1)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('pdf output is refused outside output, for non-pdf names, for Office tools, and for bad page selections', async () => {
  const root = await workspace({ 'a.pdf': await textPdf() })
  try {
    const create = tool(root, 'pdf_create_output')
    await assert.rejects(create.execute('escape', { sources: [{ file: 'a.pdf' }], output: 'copy.pdf' }, undefined), WorkspaceBoundaryError)
    await assert.rejects(create.execute('escape', { sources: [{ file: 'a.pdf' }], output: '../copy.pdf' }, undefined), WorkspaceBoundaryError)
    await assert.rejects(create.execute('escape', { sources: [{ file: 'a.pdf' }], output: 'output/copy.xlsx' }, undefined), (error: PdfError) => error.code === 'not-pdf')
    await assert.rejects(create.execute('range', { sources: [{ file: 'a.pdf', pages: '2' }], output: 'output/copy.pdf' }, undefined), (error: PdfError) => error.code === 'page-range')
    await assert.rejects(tool(root, 'office_create_output').execute('office', { output: 'output/copy.pdf' }, undefined))
    assert.equal(sha256(await readFile(join(root, 'a.pdf'))), sha256(await textPdf()))
    assert.deepEqual(parsePageSelection('1-2, 4,6-', 7), [1, 2, 4, 6, 7])
    assert.throws(() => parsePageSelection('0', 3), (error: PdfError) => error.code === 'page-range')
    assert.throws(() => parsePageSelection('x', 3), (error: PdfError) => error.code === 'page-range')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('composed output carries no document or annotation actions from its sources', async () => {
  const composed = await composePdf([{ bytes: await activeContentPdf() }])
  assert.equal(composed.removedAnnotations, 3)
  const inspected = await readPdf(composed.bytes)
  assert.deepEqual(inspected.activeContent, { javascript: false, openAction: false, launchActions: 0, links: 1, attachments: 0, fileAttachmentAnnotations: 0, acroForm: false, xfa: false, signatures: false })
  const raw = Buffer.from(composed.bytes).toString('latin1')
  assert.doesNotMatch(raw, /\/OpenAction|\/JavaScript|\/Launch|\/EmbeddedFile|\/FileAttachment|\/AA\b/u)
  assert.equal((await PDFDocument.load(composed.bytes)).getPageCount(), 1)
})

test('pdf_create_output with overwrite is a checkpoint, and pdf reads are cached per session', async () => {
  assert.equal(checkpointFor('pdf_create_output', { output: 'output/merged.pdf', overwrite: true })?.verb, '上書き')
  assert.equal(checkpointFor('pdf_create_output', { output: 'output/merged.pdf' }), undefined)
  assert.equal(checkpointFor('pdf_read', { file: 'a.pdf' }), undefined)
  const root = await workspace({ 'a.pdf': await textPdf() })
  try {
    const [read] = withSessionReadCache([tool(root, 'pdf_read')])
    const first = await read!.execute('r1', { file: 'a.pdf' }) as any
    const second = await read!.execute('r2', { file: 'a.pdf' }) as any
    assert.equal(first.details.cached, undefined)
    assert.equal(second.details.cached, true)
  } finally { await rm(root, { recursive: true, force: true }) }
})

async function replay(root: string, responses: any[]) {
  const faux = fauxProvider({ provider: 'misen-pdf-replay', models: [{ id: 'gpt-5.6-luna', reasoning: true, input: ['text', 'image'] }] })
  const models = createModels()
  models.setProvider(faux.provider)
  faux.setResponses(responses)
  const factory: AgentFactory = async workspaceRoot => {
    const customization = await prepareAgentCustomization(workspaceRoot)
    const model = models.getModel('misen-pdf-replay', 'gpt-5.6-luna')!
    return new Agent({
      initialState: { systemPrompt: customization.systemPrompt, model, thinkingLevel: 'medium', tools: [...customization.tools] },
      streamFn: models.streamSimple.bind(models),
      toolExecution: 'sequential',
      beforeToolCall: customization.hooks.beforeToolCall,
      afterToolCall: customization.hooks.afterToolCall,
    })
  }
  const events: any[] = []
  const result = await createAgentRunner(factory)(root, 'このPDFを読んで要約して', { emit: event => events.push(event), setCancel: () => undefined })
  return { result, events }
}

test('replay: "read and summarize this PDF" completes with one pdf_read; a layout check adds one pdf_render', async () => {
  const root = await workspace({ '決算.pdf': await tablePdf() })
  try {
    const summary = await replay(root, [
      fauxAssistantMessage(fauxToolCall('pdf_read', { file: '決算.pdf' }, { id: 'read' })),
      fauxAssistantMessage('3 ページの決算資料です。3 ページ目に地域別の表があります。'),
    ])
    assert.equal(summary.result.status, 'COMPLETED')
    assert.deepEqual(summary.result.tools, ['pdf_read'])
    assert.ok(summary.events.some(event => event.type === 'tool' && event.phase === 'end' && event.name === 'pdf_read' && event.status === 'success'))
    const visual = await replay(root, [
      fauxAssistantMessage(fauxToolCall('pdf_read', { file: '決算.pdf' }, { id: 'read' })),
      fauxAssistantMessage(fauxToolCall('pdf_render', { file: '決算.pdf', page: 3 }, { id: 'render' })),
      fauxAssistantMessage('3 ページ目の表は 4 列で、レイアウトは崩れていません。'),
    ])
    assert.equal(visual.result.status, 'COMPLETED')
    assert.deepEqual(visual.result.tools, ['pdf_read', 'pdf_render'])
    assert.ok(visual.events.some(event => event.type === 'tool' && event.phase === 'start' && event.name === 'pdf_render' && event.target === '決算.pdf'))
  } finally { await rm(root, { recursive: true, force: true }) }
})
