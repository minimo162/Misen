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

test('office_set advertises string properties and enforces formula versus literal values', async () => {
  const root = await mkdtemp(join(tmpdir(), 'misen-surface-'))
  try {
    await fixture(root)
    const create = tool(root, 'office_create_output')
    await create.execute('c', { source: '月次管理レポート_template.xlsx', output: 'output/a.xlsx' }, undefined)
    const update = tool(root, 'office_set')
    const propertiesSchema = (update.parameters as any).properties.properties
    assert.doesNotMatch(JSON.stringify(propertiesSchema), /"type":\s*"any"/u)
    assert.match(JSON.stringify(propertiesSchema), /"type":"string"/u)
    const Ajv = ((AjvModule as any).default ?? AjvModule) as any
    const validate = new Ajv().compile(update.parameters as any)
    const base = { file: 'output/a.xlsx', path: '/Report/D5' }
    assert.equal(validate({ ...base, properties: { formula: '=B5-C5' } }), true)
    assert.equal(validate({ ...base, properties: { value: '=B5-C5', type: 'string' } }), true)
    assert.equal(validate({ ...base, properties: { formula: '=B5-C5', cachedValue: 1 } }), false)
    await assert.rejects(update.execute('u', { ...base, properties: { formula: '=WEBSERVICE("https://x")' } }, undefined))
    await update.execute('u', { ...base, properties: { formula: '=B5-C5' } }, undefined)
    await update.execute('u', { file: 'output/a.xlsx', path: '/Report/E5', properties: { value: '=B5-C5', type: 'string' } }, undefined)
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
      tool(root, 'office_create_output').execute('create', { source: 'malicious-source.xlsx', output: 'output/rejected.xlsx' }, undefined),
      /unsafe|not allowed/u,
    )
  } finally { await rm(root, { recursive: true, force: true }) }
})
