import test from 'node:test'
import { strict as assert } from 'node:assert'
import { createHash } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { unzipSync, zipSync } from 'fflate'
import { enterpriseTools } from '../src/capabilities/tools.js'
import { OfficeCliDocuments } from '../src/office/officecli.js'
import { inspectOfficePackage, validateOfficePackage } from '../src/office/openxml.js'
import { runOfficeReplay } from '../src/runtime/agent.js'
import { OfficeCliSpreadsheet } from '../src/spreadsheet/officecli.js'
import { discoverOutputArtifacts, snapshotOutputArtifacts } from '../src/web/artifacts.js'
import { WorkspaceBoundary } from '../src/workspace/boundary.js'

const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
const executable = (): string => {
  if (!process.env.MISEN_OFFICECLI_PATH) throw new Error('MISEN_OFFICECLI_PATH is required for OfficeCLI integration tests')
  return process.env.MISEN_OFFICECLI_PATH
}

function tool(root: string, name: string, documents?: OfficeCliDocuments) {
  const spreadsheet = new OfficeCliSpreadsheet({ executable: executable() })
  return enterpriseTools(new WorkspaceBoundary(root), spreadsheet, documents ?? new OfficeCliDocuments(spreadsheet)).find(candidate => candidate.name === name)!
}

test('typed Word and PowerPoint tools create, update, read, and independently inspect Japanese outputs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'misen-word-ppt 日本語 '))
  try {
    await mkdir(join(root, 'output'))
    const boundary = new WorkspaceBoundary(root)
    const before = await snapshotOutputArtifacts(boundary)
    await tool(root, 'document_create_output').execute('word-create', {
      output: 'output/日本語 業務メモ.docx',
      paragraphs: [{ text: '{{表題}}', style: 'Heading1' }, { text: '担当: {{担当者}}' }],
    }, undefined)
    await tool(root, 'document_update').execute('word-update', {
      document: 'output/日本語 業務メモ.docx',
      replacements: [{ find: '{{表題}}', replace: '業務メモ' }, { find: '{{担当者}}', replace: 'ミセン担当' }],
      appendParagraphs: [{ text: '確認済みです。' }],
    }, undefined)
    const word = await tool(root, 'document_read').execute('word-read', { document: 'output/日本語 業務メモ.docx', start: 1, end: 20 }, undefined) as any
    assert.deepEqual(word.details.elements.map((item: any) => item.text), ['業務メモ', '担当: ミセン担当', '確認済みです。'])
    const wordPackage = inspectOfficePackage(await readFile(join(root, 'output', '日本語 業務メモ.docx')), 'docx')
    assert.match(wordPackage.text.join('\n'), /業務メモ[\s\S]*ミセン担当[\s\S]*確認済み/u)

    await tool(root, 'presentation_create_output').execute('ppt-create', {
      output: 'output/日本語 説明資料.pptx',
      slides: [{ title: '{{表題}}', text: '概要', layout: 'titleContent' }],
    }, undefined)
    await tool(root, 'presentation_update').execute('ppt-update', {
      presentation: 'output/日本語 説明資料.pptx',
      replacements: [{ find: '{{表題}}', replace: '月次説明資料' }],
      appendSlides: [{ title: '結論', text: '確認済みです。', layout: 'titleContent' }],
    }, undefined)
    const presentation = await tool(root, 'presentation_read').execute('ppt-read', { presentation: 'output/日本語 説明資料.pptx', start: 1, end: 20 }, undefined) as any
    assert.deepEqual(presentation.details.slides.map((slide: any) => slide.texts), [['月次説明資料', '概要'], ['結論', '確認済みです。']])
    const pptPackage = inspectOfficePackage(await readFile(join(root, 'output', '日本語 説明資料.pptx')), 'pptx')
    assert.match(pptPackage.text.join('\n'), /月次説明資料[\s\S]*結論[\s\S]*確認済み/u)

    const artifacts = await discoverOutputArtifacts(boundary, before, 10)
    assert.deepEqual(artifacts.map(item => item.filename), ['日本語 業務メモ.docx', '日本語 説明資料.pptx'])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('template-based Word and PowerPoint outputs preserve source bytes and style/master parts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'misen-office-template-'))
  try {
    await mkdir(join(root, 'output'))
    const spreadsheet = new OfficeCliSpreadsheet({ executable: executable() })
    const documents = new OfficeCliDocuments(spreadsheet)
    const wordSource = await documents.createWordBytes(undefined, [{ text: '{{会社名}}', style: 'Heading1' }])
    const pptSource = await documents.createPresentationBytes(undefined, [{ title: '{{表題}}', text: '本文', layout: 'titleContent' }])
    await writeFile(join(root, 'テンプレート 文書.docx'), wordSource)
    await writeFile(join(root, 'テンプレート 資料.pptx'), pptSource)
    const wordHash = digest(wordSource)
    const pptHash = digest(pptSource)
    const wordPreservation = inspectOfficePackage(wordSource, 'docx').preservation
    const pptPreservation = inspectOfficePackage(pptSource, 'pptx').preservation

    await tool(root, 'document_create_output').execute('copy-word', { source: 'テンプレート 文書.docx', output: 'output/文書.docx' }, undefined)
    await tool(root, 'document_update').execute('replace-word', { document: 'output/文書.docx', replacements: [{ find: '{{会社名}}', replace: '株式会社ミセン' }] }, undefined)
    await tool(root, 'presentation_create_output').execute('copy-ppt', { source: 'テンプレート 資料.pptx', output: 'output/資料.pptx' }, undefined)
    await tool(root, 'presentation_update').execute('replace-ppt', { presentation: 'output/資料.pptx', replacements: [{ find: '{{表題}}', replace: '経営報告' }] }, undefined)

    assert.equal(digest(await readFile(join(root, 'テンプレート 文書.docx'))), wordHash)
    assert.equal(digest(await readFile(join(root, 'テンプレート 資料.pptx'))), pptHash)
    assert.deepEqual(inspectOfficePackage(await readFile(join(root, 'output', '文書.docx')), 'docx').preservation, wordPreservation)
    assert.deepEqual(inspectOfficePackage(await readFile(join(root, 'output', '資料.pptx')), 'pptx').preservation, pptPreservation)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('malformed, cross-format, active-content, overbroad reads, and failed validation preserve output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'misen-office-failure-'))
  try {
    await mkdir(join(root, 'output'))
    await writeFile(join(root, 'bad.docx'), 'not zip')
    await assert.rejects(tool(root, 'document_create_output').execute('bad', { source: 'bad.docx', output: 'output/bad.docx' }, undefined), /Office|ZIP|docx/u)
    await assert.rejects(access(join(root, 'output', 'bad.docx')), /ENOENT/u)
    await assert.rejects(tool(root, 'document_create_output').execute('cross', { output: 'output/not-word.pptx' }, undefined), /\.docx/u)

    await tool(root, 'document_create_output').execute('create', { output: 'output/good.docx', paragraphs: [{ text: 'before' }] }, undefined)
    const output = join(root, 'output', 'good.docx')
    const before = digest(await readFile(output))
    await assert.rejects(tool(root, 'document_read').execute('wide', { document: 'output/good.docx', start: 1, end: 101 }, undefined), /100/u)
    await assert.rejects(tool(root, 'document_update').execute('missing', { document: 'output/good.docx', replacements: [{ find: 'not present', replace: 'after' }] }, undefined), /replacement/u)
    assert.equal(digest(await readFile(output)), before)
    class InvalidDocuments extends OfficeCliDocuments {
      override async updateWordBytes(): Promise<Uint8Array> { return Buffer.from('partial invalid output') }
    }
    const spreadsheet = new OfficeCliSpreadsheet({ executable: executable() })
    const invalid = enterpriseTools(new WorkspaceBoundary(root), spreadsheet, new InvalidDocuments(spreadsheet)).find(candidate => candidate.name === 'document_update')!
    await assert.rejects(invalid.execute('invalid', { document: 'output/good.docx', replacements: [{ find: 'before', replace: 'after' }] }, undefined), /Office|ZIP|docx/u)
    assert.equal(digest(await readFile(output)), before)

    const entries = unzipSync(await readFile(output))
    const documentXml = entries['word/document.xml']!
    entries['word/document.xml'] = Buffer.from('<w:document><broken></w:document>')
    assert.throws(() => validateOfficePackage(zipSync(entries), 'docx'), /malformed/u)
    entries['word/document.xml'] = documentXml
    const relationships = entries['word/_rels/document.xml.rels']!
    const relationshipXml = Buffer.from(relationships).toString('utf8')
    const escapedRelationshipXml = relationshipXml.replace(/Target="[^"]+"/u, 'Target="../../../../outside.xml"')
    assert.notEqual(escapedRelationshipXml, relationshipXml)
    entries['word/_rels/document.xml.rels'] = Buffer.from(escapedRelationshipXml)
    assert.throws(() => validateOfficePackage(zipSync(entries), 'docx'), /escapes|missing/u)
    entries['word/_rels/document.xml.rels'] = relationships
    entries['word/vbaProject.bin'] = Uint8Array.from([1, 2, 3])
    assert.throws(() => validateOfficePackage(zipSync(entries), 'docx'), /active|embedded/u)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('OfficeCLI batch rollback remains byte-identical for Word and PowerPoint', async () => {
  const root = await mkdtemp(join(tmpdir(), 'misen-office-rollback-'))
  try {
    const client = new OfficeCliSpreadsheet({ executable: executable() })
    const documents = new OfficeCliDocuments(client)
    const pairs = [
      { name: 'word.docx', bytes: await documents.createWordBytes(undefined, [{ text: 'before' }]), first: { command: 'set', path: '/', props: { find: 'before', replace: 'after' } }, bad: { command: 'add', parent: '/missing', type: 'paragraph', props: { text: 'bad' } } },
      { name: 'slides.pptx', bytes: await documents.createPresentationBytes(undefined, [{ title: 'before', text: 'body' }]), first: { command: 'set', path: '/', props: { find: 'before', replace: 'after' } }, bad: { command: 'add', parent: '/missing', type: 'shape', props: { text: 'bad' } } },
    ] as const
    for (const pair of pairs) {
      const file = join(root, pair.name)
      await writeFile(file, pair.bytes)
      const before = digest(pair.bytes)
      await assert.rejects(client.batchFile(file, [pair.first, pair.bad]))
      assert.equal(digest(await readFile(file)), before)
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('public Pi Agent replay exercises the typed Word and PowerPoint paths end to end', async () => {
  for (const kind of ['word', 'powerpoint'] as const) {
    const root = await mkdtemp(join(tmpdir(), `misen-${kind}-agent-`))
    try {
      const replay = await runOfficeReplay(root, kind, kind === 'word' ? '日本語の業務メモをWordで作成して' : '日本語の説明資料をPowerPointで作成して')
      const starts = replay.events.filter(event => event.type === 'tool_execution_start').map(event => event.name)
      assert.deepEqual(starts, kind === 'word'
        ? ['workspace_list_files', 'document_create_output', 'document_update', 'document_read']
        : ['workspace_list_files', 'presentation_create_output', 'presentation_update', 'presentation_read'])
      await access(join(root, replay.output))
      assert.equal(replay.agent.state.errorMessage, undefined)
    } finally { await rm(root, { recursive: true, force: true }) }
  }
})
