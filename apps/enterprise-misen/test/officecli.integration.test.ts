import test from 'node:test'
import { strict as assert } from 'node:assert'
import { createHash } from 'node:crypto'
import { access, copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fixture } from '../demo/enterprise-excel/fixtures.js'
import { enterpriseTools } from '../src/capabilities/tools.js'
import { WorkspaceBoundary } from '../src/workspace/boundary.js'
import { OfficeCliSpreadsheet, isFormulaValue } from '../src/spreadsheet/officecli.js'
import { OFFICECLI_COMMIT, OFFICECLI_RELEASE_ARTIFACT, OFFICECLI_VERSION, OFFICECLI_WINDOWS_X64_SHA256 } from '../src/spreadsheet/officecli-process.js'
import { inspectOpenXmlWorkbook, preservationSnapshot } from '../src/spreadsheet/openxml.js'

const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const executable = () => {
  if (!process.env.MISEN_OFFICECLI_PATH) throw new Error('MISEN_OFFICECLI_PATH is required for OfficeCLI integration tests')
  return process.env.MISEN_OFFICECLI_PATH
}

test('pinned OfficeCLI Windows x64 identity is the executable under test', async () => {
  assert.equal(OFFICECLI_VERSION, '1.0.147')
  assert.equal(OFFICECLI_COMMIT, 'b94f3906fd52d450c64f8e40370e376b9e15079e')
  assert.equal(OFFICECLI_RELEASE_ARTIFACT, 'officecli-win-x64.exe')
  assert.equal(digest(await readFile(executable())), OFFICECLI_WINDOWS_X64_SHA256)
  await new OfficeCliSpreadsheet({ executable: executable() }).ensureVersion()
})

test('OfficeCLI reads sheets, typed values, dates, formulas, Japanese, and bounded ranges', async () => {
  const root = await mkdtemp(join(tmpdir(), 'misen-officecli-read 日本語 '))
  try {
    await fixture(root)
    const client = new OfficeCliSpreadsheet({ executable: executable() })
    const company = await client.readBytes(await readFile(join(root, '7月', 'Alpha.xlsx')), 'Actuals', 'A1:B5')
    assert.deepEqual(company.sheets, ['Actuals'])
    assert.deepEqual(company.values?.slice(0, 3), [['Company', 'Alpha'], ['Revenue', 1200], ['Cost', 700]])
    assert.ok(company.values?.[3]?.[1] instanceof Date)
    assert.equal((company.values![3]![1] as Date).toISOString(), '2024-07-31T00:00:00.000Z')

    const output = join(root, 'output', '日本語 formula.xlsx')
    await copyFile(join(root, '月次管理レポート_template.xlsx'), output)
    await client.batchFile(output, [
      { command: 'set', path: '/Report/B2', props: { value: '7月', type: 'string' } },
      { command: 'set', path: '/Report/B5', props: { value: '1200', type: 'number' } },
      { command: 'set', path: '/Report/C5', props: { value: '700', type: 'number' } },
      { command: 'set', path: '/Report/D5', props: { formula: 'B5-C5' } },
      { command: 'set', path: '/Report/E5', props: { value: '=B5-C5', type: 'string' } },
    ])
    const readback = await client.readBytes(await readFile(output), 'Report', 'B2:E5')
    const formula = readback.values![3]![2]
    assert.ok(isFormulaValue(formula))
    assert.equal(formula.formula, '=B5-C5')
    assert.equal(formula.cachedValue, 500)
    assert.equal(readback.values![3]![3], '=B5-C5')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('OfficeCLI creates workbooks and adds/removes Japanese sheets without an Office installation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'misen-officecli-create 日本語 '))
  const file = join(root, '新規 workbook.xlsx')
  try {
    const client = new OfficeCliSpreadsheet({ executable: executable() })
    await client.json(['create', file, '--type', 'xlsx', '--locale', 'ja'])
    await client.batchFile(file, [
      { command: 'add', parent: '/', type: 'sheet', props: { name: '月次' } },
      { command: 'remove', path: '/Sheet1' },
      { command: 'set', path: '/月次/A1', props: { value: '会社', type: 'string', merge: 'A1:B1' } },
      { command: 'set', path: '/月次/A2', props: { value: '10', type: 'number' } },
      { command: 'set', path: '/月次/B2', props: { formula: 'A2*2' } },
      { command: 'set', path: '/月次/row[1]', props: { height: '24' } },
      { command: 'set', path: '/月次/col[A]', props: { width: '18' } },
    ])
    await client.validateFile(file)
    const workbook = await client.openBytes(await readFile(file), 'A1:B2')
    assert.deepEqual(workbook.sheets.map(sheet => sheet.title), ['月次'])
    const snapshot = inspectOpenXmlWorkbook(await readFile(file)).sheets[0]!
    assert.deepEqual(snapshot.mergedCells, ['A1:B1'])
    assert.equal(snapshot.formulas.B2, '=A2*2')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('template update is source-preserving, style-preserving, and atomic on OfficeCLI failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'misen-officecli-preserve-'))
  try {
    await fixture(root)
    const client = new OfficeCliSpreadsheet({ executable: executable() })
    const source = join(root, '月次管理レポート_template.xlsx')
    const sourceBytes = new Uint8Array(await readFile(source))
    const output = join(root, 'output', 'report.xlsx')
    await copyFile(source, output)
    const expected = preservationSnapshot(inspectOpenXmlWorkbook(sourceBytes), 'Report', 'A1:E11')
    await client.batchFile(output, [
      { command: 'set', path: '/Report/A5', props: { value: 'Alpha', type: 'string' } },
      { command: 'set', path: '/Report/B5', props: { value: '1200', type: 'number' } },
      { command: 'set', path: '/Report/C5', props: { value: '700', type: 'number' } },
      { command: 'set', path: '/Report/D5', props: { formula: 'B5-C5' } },
    ])
    assert.equal(digest(await readFile(source)), digest(sourceBytes))
    assert.deepEqual(preservationSnapshot(inspectOpenXmlWorkbook(await readFile(output)), 'Report', 'A1:E11'), expected)

    const beforeFailure = digest(await readFile(output))
    await assert.rejects(client.batchFile(output, [
      { command: 'set', path: '/Report/B2', props: { value: 'changed', type: 'string' } },
      { command: 'set', path: '/Missing/A1', props: { value: 'fail', type: 'string' } },
    ]), /Sheet not found/u)
    assert.equal(digest(await readFile(output)), beforeFailure)
    const leftovers = (await import('node:fs/promises')).readdir(root + '/output').then(names => names.filter(name => name.includes('.batch-')))
    assert.deepEqual(await leftovers, [])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('invalid ranges, malformed workbooks, and post-update validation failures preserve existing output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'misen-officecli-failure-'))
  try {
    await fixture(root)
    const boundary = new WorkspaceBoundary(root)
    const client = new OfficeCliSpreadsheet({ executable: executable() })
    const create = enterpriseTools(boundary, client).find(tool => tool.name === 'office_create_output')!
    const update = enterpriseTools(boundary, client).find(tool => tool.name === 'office_set')!
    await create.execute('create', { source: '月次管理レポート_template.xlsx', output: 'output/report.xlsx' }, undefined)
    const output = join(root, 'output', 'report.xlsx')
    const before = digest(await readFile(output))
    await assert.rejects(update.execute('bad-range', { file: 'output/report.xlsx', path: '/Report/A0', properties: { value: '1', type: 'number' } }, undefined), /invalid|range|path/u)
    assert.equal(digest(await readFile(output)), before)

    await writeFile(join(root, 'malformed.xlsx'), 'not an xlsx', 'utf8')
    await assert.rejects(create.execute('malformed', { source: 'malformed.xlsx', output: 'output/bad.xlsx' }, undefined), /invalid|xlsx|ZIP/u)
    await assert.rejects(access(join(root, 'output', 'bad.xlsx')), /ENOENT/u)

    class InvalidResultClient extends OfficeCliSpreadsheet {
      override async validateFile(): Promise<void> { throw new Error('injected post-update validation failure') }
    }
    const invalidUpdate = enterpriseTools(boundary, new InvalidResultClient({ executable: executable() })).find(tool => tool.name === 'office_set')!
    await assert.rejects(invalidUpdate.execute('invalid-result', { file: 'output/report.xlsx', path: '/Report/B2', properties: { value: '7月', type: 'string' } }, undefined), /validation failure/u)
    assert.equal(digest(await readFile(output)), before)
  } finally { await rm(root, { recursive: true, force: true }) }
})
