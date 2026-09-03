import test from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { unzipSync, zipSync } from 'fflate'
import { fixture } from '../demo/enterprise-excel/fixtures.js'
import { enterpriseTools } from '../src/capabilities/tools.js'
import { validateDeliverable } from '../src/capabilities/guards.js'
import { WorkspaceBoundary } from '../src/workspace/boundary.js'
import { isFormulaValue, officeCli, openSpreadsheetBytes, readCell } from '../src/spreadsheet/engine.js'
import * as AjvModule from 'ajv'

const tool = (root: string, name: string) => enterpriseTools(new WorkspaceBoundary(root)).find(candidate => candidate.name === name)!

test('spreadsheet_update advertises and enforces literal versus structured formula values', async () => {
  const root = await mkdtemp(join(tmpdir(), 'misen-surface-'))
  try {
    await fixture(root)
    const create = tool(root, 'spreadsheet_create_output')
    await create.execute('c', { source: '月次管理レポート_template.xlsx', output: 'output/a.xlsx' }, undefined)
    const update = tool(root, 'spreadsheet_update')
    const valuesSchema = (update.parameters as any).properties.values.items.items
    assert.doesNotMatch(JSON.stringify(valuesSchema), /"type":\s*"any"/u)
    assert.match(JSON.stringify(valuesSchema), /"formula"/u)
    assert.match(update.description, /plain string beginning with "=" remains a literal string/u)
    const Ajv = ((AjvModule as any).default ?? AjvModule) as any
    const validate = new Ajv().compile(update.parameters as any)
    const base = { workbook: 'output/a.xlsx', sheet: 'Report', range: 'D5:D5' }
    assert.equal(validate({ ...base, values: [[{ formula: '=B5-C5' }]] }), true)
    assert.equal(validate({ ...base, values: [['=B5-C5']] }), true)
    assert.equal(validate({ ...base, values: [[{ formula: '=B5-C5', cachedValue: 1 }]] }), false)
    await assert.rejects(update.execute('u', { workbook: 'output/a.xlsx', sheet: 'Report', range: 'D5:D5', values: [[{ formula: '=WEBSERVICE("https://x")' }]] }, undefined))
    await assert.rejects(update.execute('u', { workbook: 'output/a.xlsx', sheet: 'Report', range: 'D5:D5', values: [[{ formula: '=SUM(B5:C5)', cachedValue: 1 }]] }, undefined))
    await update.execute('u', { workbook: 'output/a.xlsx', sheet: 'Report', range: 'D5:D5', values: [[{ formula: '=B5-C5' }]] }, undefined)
    await update.execute('u', { workbook: 'output/a.xlsx', sheet: 'Report', range: 'E5:E5', values: [['=B5-C5']] }, undefined)
    const saved = await openSpreadsheetBytes(await readFile(join(root, 'output', 'a.xlsx')))
    const structured = readCell(saved, 'Report', 'D5')
    assert.ok(isFormulaValue(structured))
    assert.equal(structured.formula, '=B5-C5')
    assert.equal(readCell(saved, 'Report', 'E5'), '=B5-C5')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('carried external workbook surfaces fail closed and ordinary internal parts remain permitted', async () => {
  const root = await mkdtemp(join(tmpdir(), 'misen-carried-surface-openxml-'))
  try {
    await fixture(root)
    const bytes = new Uint8Array(await readFile(join(root, '月次管理レポート_template.xlsx')))
    assert.doesNotThrow(() => validateDeliverable(bytes))
    const entries = unzipSync(bytes)
    entries['xl/externalLinks/externalLink1.xml'] = Buffer.from('<?xml version="1.0"?><externalLink xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"/>')
    assert.throws(() => validateDeliverable(zipSync(entries)), /external workbook relationship/u)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('serialized malicious source workbook is rejected by production create-output tool', async () => {
  const root = await mkdtemp(join(tmpdir(), 'misen-carried-surface-'))
  try {
    await fixture(root)
    const malicious = join(root, 'malicious-source.xlsx')
    await import('node:fs/promises').then(fs => fs.copyFile(join(root, '月次管理レポート_template.xlsx'), malicious))
    await officeCli().batchFile(malicious, [{ command: 'set', path: '/Report/A1', props: { formula: 'WEBSERVICE("https://example.invalid")' } }])
    await assert.rejects(
      tool(root, 'spreadsheet_create_output').execute('create', { source: 'malicious-source.xlsx', output: 'output/rejected.xlsx' }, undefined),
      /unsafe|not allowed/u,
    )
  } finally { await rm(root, { recursive: true, force: true }) }
})
