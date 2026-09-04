import test from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import { enterpriseTools } from '../src/capabilities/tools.js'
import { DEFAULT_INSPECTION_RANGE, OfficeCliSpreadsheet } from '../src/spreadsheet/officecli.js'
import { WorkspaceBoundary } from '../src/workspace/boundary.js'

const workbookBytes = (): Uint8Array => zipSync({
  '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'),
  'xl/workbook.xml': strToU8('<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Summary" sheetId="1" r:id="rId1"/></sheets></workbook>'),
  'xl/_rels/workbook.xml.rels': strToU8('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/></Relationships>'),
  'xl/worksheets/sheet1.xml': strToU8('<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>売上</t></is></c><c r="B1"><v>100</v></c></row></sheetData></worksheet>'),
})

class ReadFixtureSpreadsheet extends OfficeCliSpreadsheet {
  readonly calls: Array<{ path: string; depth: number }> = []

  override async withPrivateWorkbook<T>(_bytes: Uint8Array, action: (file: string) => Promise<T>): Promise<T> {
    return await action('fixture.xlsx')
  }

  override async inspectFile(_file: string, path: string, depth = 0): Promise<any> {
    this.calls.push({ path, depth })
    if (path === '/') {
      return { success: true, data: { results: [{ type: 'workbook', children: [{ type: 'sheet', preview: 'Summary' }, { type: 'sheet', preview: 'Data' }] }] } }
    }
    return { success: true, data: { results: [{ type: 'range', children: [
      { type: 'cell', path: '/Summary/A1', text: '売上', format: { type: 'string' } },
      { type: 'cell', path: '/Summary/B1', text: '100', format: { type: 'number' } },
    ] }] } }
  }
}

test('workspace_list_files defaults omitted path to a bounded recursive root tree', async () => {
  const root = await mkdtemp(join(tmpdir(), 'misen-read-tree-'))
  try {
    await mkdir(join(root, '7月'), { recursive: true })
    await mkdir(join(root, '8月'), { recursive: true })
    await writeFile(join(root, '7月', 'Alpha.xlsx'), 'x')
    await writeFile(join(root, '8月', 'Alpha.xlsx'), 'x')
    const list = enterpriseTools(new WorkspaceBoundary(root)).find(tool => tool.name === 'workspace_list_files')!
    assert.ok(!((list.parameters as any).required ?? []).includes('path'))
    const result = await list.execute('list-root', {}, undefined) as any
    assert.equal(result.details.path, '.')
    assert.deepEqual(result.details.files, ['7月/Alpha.xlsx', '8月/Alpha.xlsx'])
    assert.equal(result.details.truncated, false)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('workspace_list_files returns real sibling folder candidates for a missing path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'misen-read-candidates-'))
  try {
    await mkdir(join(root, '7月'))
    await mkdir(join(root, '8月'))
    const list = enterpriseTools(new WorkspaceBoundary(root)).find(tool => tool.name === 'workspace_list_files')!
    const result = await list.execute('list-missing', { path: 'August' }, undefined) as any
    assert.deepEqual(result.details.candidates, ['7月', '8月'])
    assert.match(result.details.message, /フォルダー「August」は見つかりません。候補: 7月, 8月/u)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('recursive workspace listing reports truncation after 300 matching files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'misen-read-limit-'))
  try {
    await mkdir(join(root, 'files'))
    await Promise.all(Array.from({ length: 301 }, (_, index) => writeFile(join(root, 'files', `${String(index).padStart(3, '0')}.txt`), 'x')))
    const list = enterpriseTools(new WorkspaceBoundary(root)).find(tool => tool.name === 'workspace_list_files')!
    const result = await list.execute('list-limit', {}, undefined) as any
    assert.equal(result.details.files.length, 300)
    assert.equal(result.details.truncated, true)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('spreadsheet reader returns sheet names and bounded first-sheet values in one Tool result', async () => {
  const root = await mkdtemp(join(tmpdir(), 'misen-read-workbook-'))
  try {
    await writeFile(join(root, 'Alpha.xlsx'), workbookBytes())
    const spreadsheet = new ReadFixtureSpreadsheet()
    const tools = enterpriseTools(new WorkspaceBoundary(root), spreadsheet)
    const read = tools.find(tool => tool.name === 'spreadsheet_read')!
    const result = await read.execute('read-first', { workbook: 'Alpha.xlsx' }, undefined) as any
    assert.deepEqual(result.details, {
      workbook: 'Alpha.xlsx',
      sheets: ['Summary', 'Data'],
      sheet: 'Summary',
      range: DEFAULT_INSPECTION_RANGE,
      values: [['売上', 100]],
    })
    assert.deepEqual(spreadsheet.calls, [{ path: '/', depth: 0 }, { path: `/Summary/${DEFAULT_INSPECTION_RANGE}`, depth: 1 }])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('office_get xlsx defaults omitted path to sheet names and first-sheet values', async () => {
  const root = await mkdtemp(join(tmpdir(), 'misen-office-get-workbook-'))
  try {
    await writeFile(join(root, 'Alpha.xlsx'), workbookBytes())
    const spreadsheet = new ReadFixtureSpreadsheet()
    const get = enterpriseTools(new WorkspaceBoundary(root), spreadsheet).find(tool => tool.name === 'office_get')!
    assert.ok(!((get.parameters as any).required ?? []).includes('path'))
    const result = await get.execute('get-first', { file: 'Alpha.xlsx' }, undefined) as any
    assert.equal(result.details.path, '/')
    assert.deepEqual(result.details.data, {
      sheets: ['Summary', 'Data'],
      sheet: 'Summary',
      range: DEFAULT_INSPECTION_RANGE,
      values: [['売上', 100]],
    })
  } finally { await rm(root, { recursive: true, force: true }) }
})
