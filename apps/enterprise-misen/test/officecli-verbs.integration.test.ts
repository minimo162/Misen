import test from 'node:test'
import { strict as assert } from 'node:assert'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fixture } from '../demo/enterprise-excel/fixtures.js'
import { DENIED_OFFICE_ELEMENTS, DENIED_OFFICE_PROPERTY_RULES, DENIED_OFFICE_VERBS } from '../src/capabilities/office-denylist.js'
import { enterpriseTools } from '../src/capabilities/tools.js'
import { OfficeCliSpreadsheet } from '../src/spreadsheet/officecli.js'
import { WorkspaceBoundary } from '../src/workspace/boundary.js'

const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
const executable = (): string => {
  if (!process.env.MISEN_OFFICECLI_PATH) throw new Error('MISEN_OFFICECLI_PATH is required for OfficeCLI integration tests')
  return process.env.MISEN_OFFICECLI_PATH
}

const rosters = new Map<string, ReturnType<typeof enterpriseTools>>()
function tools(root: string) {
  let roster = rosters.get(root)
  if (!roster) {
    roster = enterpriseTools(new WorkspaceBoundary(root), new OfficeCliSpreadsheet({ executable: executable() }))
    rosters.set(root, roster)
  }
  return (name: string) => {
    const candidate = roster.find(tool => tool.name === name)
    if (!candidate) throw new Error('missing tool: ' + name)
    return candidate
  }
}

async function invoke(root: string, name: string, params: object): Promise<any> {
  return await tools(root)(name).execute(`${name}-test`, params, undefined)
}

test('Office deny-list rejects every verb, element, and property rule before output changes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'misen-office-denylist-'))
  try {
    await fixture(root)
    const source = join(root, '月次管理レポート_template.xlsx')
    const sourceHash = digest(await readFile(source))
    await invoke(root, 'office_create_output', { source: '月次管理レポート_template.xlsx', output: 'output/policy.xlsx' })
    const output = join(root, 'output', 'policy.xlsx')
    const before = digest(await readFile(output))

    for (const command of DENIED_OFFICE_VERBS) {
      await assert.rejects(invoke(root, 'office_batch', { file: 'output/policy.xlsx', items: [{ command }] }))
      assert.equal(digest(await readFile(output)), before, command)
    }
    for (const type of DENIED_OFFICE_ELEMENTS) {
      await assert.rejects(invoke(root, 'office_add', { file: 'output/policy.xlsx', parent: '/Report', type }))
      assert.equal(digest(await readFile(output)), before, type)
    }
    const propertyCases: Record<typeof DENIED_OFFICE_PROPERTY_RULES[number], { readonly tool: string; readonly params: object }> = {
      'unsafe-formula': { tool: 'office_set', params: { file: 'output/policy.xlsx', path: '/Report/A1', properties: { formula: '=WEBSERVICE("x")' } } },
      url: { tool: 'office_set', params: { file: 'output/policy.xlsx', path: '/Report/A1', properties: { value: 'https://example.invalid' } } },
      unc: { tool: 'office_set', params: { file: 'output/policy.xlsx', path: '/Report/A1', properties: { value: '\\\\server\\share' } } },
      'external-workbook': { tool: 'office_set', params: { file: 'output/policy.xlsx', path: '/Report/A1', properties: { formula: '[Book.xlsx]Sheet1!A1' } } },
      'external-data-source': { tool: 'office_add', params: { file: 'output/policy.xlsx', parent: '/Report', type: 'pivottable', properties: { connection: 'FinanceWarehouse' } } },
    }
    for (const rule of DENIED_OFFICE_PROPERTY_RULES) {
      const item = propertyCases[rule]
      await assert.rejects(invoke(root, item.tool, item.params))
      assert.equal(digest(await readFile(output)), before, rule)
    }
    await assert.rejects(invoke(root, 'office_add', { file: 'output/policy.xlsx', parent: '/Report', type: 'row', properties: { c1: 'unsupported' } }), /rejected one or more properties/u)
    assert.equal(digest(await readFile(output)), before, 'unsupported OfficeCLI properties fail closed')
    assert.equal(digest(await readFile(source)), sourceHash, 'deny-list attempts do not modify the source template')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('Excel formatting, row and column insertion, table, conditional format, chart, and pivot round-trip', async () => {
  const root = await mkdtemp(join(tmpdir(), 'misen-office-excel-verbs-'))
  try {
    await fixture(root)
    const source = join(root, '月次管理レポート_template.xlsx')
    const sourceHash = digest(await readFile(source))
    await invoke(root, 'office_create_output', { source: '月次管理レポート_template.xlsx', output: 'output/surfaces.xlsx' })
    await invoke(root, 'office_set', { file: 'output/surfaces.xlsx', path: '/Report/D5:D7', properties: { bold: 'true', 'font.color': 'FF0000', numFmt: '#,##0' } })
    await invoke(root, 'office_add', { file: 'output/surfaces.xlsx', parent: '/Report', type: 'row', index: 8 })
    await invoke(root, 'office_set', { file: 'output/surfaces.xlsx', path: '/Report/A8', properties: { value: 'Inserted row', type: 'string' } })
    await invoke(root, 'office_add', { file: 'output/surfaces.xlsx', parent: '/Report', type: 'col', index: 6, properties: { width: '14' } })
    const formatting = await invoke(root, 'office_get', { file: 'output/surfaces.xlsx', path: '/Report/D5:D7', depth: 1 })
    assert.match(JSON.stringify(formatting.details), /FF0000|#FF0000/iu)
    assert.match(JSON.stringify((await invoke(root, 'office_get', { file: 'output/surfaces.xlsx', path: '/Report/row[8]', depth: 1 })).details), /Inserted row/u)
    assert.match(JSON.stringify((await invoke(root, 'office_get', { file: 'output/surfaces.xlsx', path: '/Report/col[F]', depth: 0 })).details), /14/u)

    await invoke(root, 'office_create_output', { output: 'output/analytics.xlsx' })
    await invoke(root, 'office_batch', { file: 'output/analytics.xlsx', items: [
      { command: 'set', path: '/Sheet1/A1', props: { value: 'Region', type: 'string' } },
      { command: 'set', path: '/Sheet1/B1', props: { value: 'Month', type: 'string' } },
      { command: 'set', path: '/Sheet1/C1', props: { value: 'Amount', type: 'string' } },
      { command: 'set', path: '/Sheet1/A2', props: { value: 'East', type: 'string' } },
      { command: 'set', path: '/Sheet1/B2', props: { value: '7月', type: 'string' } },
      { command: 'set', path: '/Sheet1/C2', props: { value: '100', type: 'number' } },
      { command: 'set', path: '/Sheet1/A3', props: { value: 'West', type: 'string' } },
      { command: 'set', path: '/Sheet1/B3', props: { value: '8月', type: 'string' } },
      { command: 'set', path: '/Sheet1/C3', props: { value: '-20', type: 'number' } },
      { command: 'set', path: '/Sheet1/A4', props: { value: 'East', type: 'string' } },
      { command: 'set', path: '/Sheet1/B4', props: { value: '8月', type: 'string' } },
      { command: 'set', path: '/Sheet1/C4', props: { value: '140', type: 'number' } },
      { command: 'add', parent: '/Sheet1', type: 'table', props: { ref: 'A1:C4', name: 'SalesData', style: 'medium2' } },
      { command: 'add', parent: '/Sheet1', type: 'cf', props: { type: 'cellIs', ref: 'C2:C4', operator: 'lessThan', value: '0', fill: 'FFCCCC' } },
      { command: 'add', parent: '/Sheet1', type: 'chart', props: { chartType: 'line', dataRange: 'B1:C4', title: '推移', anchor: 'E2:L18' } },
      { command: 'add', parent: '/Sheet1', type: 'pivottable', props: { source: 'Sheet1!A1:C4', position: 'N2', rows: 'Region', cols: 'Month', values: 'Amount:sum', name: 'SalesPivot' } },
    ] })
    for (const selector of ['table', 'cf', 'chart', 'pivottable']) {
      const queried = await invoke(root, 'office_query', { file: 'output/analytics.xlsx', selector })
      assert.match(JSON.stringify(queried.details).toLowerCase(), new RegExp(selector === 'cf' ? 'conditional|cf' : selector))
    }
    await invoke(root, 'office_inspect', { file: 'output/surfaces.xlsx', mode: 'validate' })
    await invoke(root, 'office_inspect', { file: 'output/analytics.xlsx', mode: 'validate' })
    assert.equal(digest(await readFile(source)), sourceHash)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('Word heading and table, PowerPoint slide, and CSV import round-trip inside output only', async () => {
  const root = await mkdtemp(join(tmpdir(), 'misen-office-cross-format-'))
  try {
    await fixture(root)
    const template = join(root, '月次管理レポート_template.xlsx')
    const templateHash = digest(await readFile(template))

    await invoke(root, 'office_create_output', { output: 'output/report.docx' })
    await invoke(root, 'office_batch', { file: 'output/report.docx', items: [
      { command: 'add', parent: '/body', type: 'paragraph', props: { text: '月次報告', style: 'Heading1' } },
      { command: 'add', parent: '/body', type: 'table', props: { data: '項目,値;売上,100;費用,70', style: 'medium2' } },
    ] })
    const word = JSON.stringify((await invoke(root, 'office_get', { file: 'output/report.docx', path: '/body', depth: 4 })).details)
    assert.match(word, /月次報告/u)
    assert.match(word, /Heading1/u)
    assert.match(word, /売上/u)

    await invoke(root, 'office_create_output', { output: 'output/report.pptx' })
    await invoke(root, 'office_add', { file: 'output/report.pptx', parent: '/', type: 'slide', properties: { title: '月次報告', text: '確認済み', layout: 'titleContent' } })
    const slide = JSON.stringify((await invoke(root, 'office_get', { file: 'output/report.pptx', path: '/slide[1]', depth: 3 })).details)
    assert.match(slide, /月次報告/u)
    assert.match(slide, /確認済み/u)

    await invoke(root, 'office_create_output', { output: 'output/import.xlsx' })
    await writeFile(join(root, 'data.csv'), '項目,値\n売上,100\n費用,70\n', 'utf8')
    await invoke(root, 'office_import', { file: 'output/import.xlsx', parent: '/Sheet1', source: 'data.csv', format: 'csv', header: true })
    assert.match(JSON.stringify((await invoke(root, 'office_get', { file: 'output/import.xlsx', path: '/Sheet1/A1:B3', depth: 1 })).details), /売上/u)
    await assert.rejects(invoke(root, 'office_set', { file: '月次管理レポート_template.xlsx', path: '/Report/A1', properties: { value: 'mutate source' } }), /output/u)
    await invoke(root, 'office_inspect', { file: 'output/report.docx', mode: 'validate' })
    await invoke(root, 'office_inspect', { file: 'output/report.pptx', mode: 'validate' })
    assert.equal(digest(await readFile(template)), templateHash)
    assert.deepEqual((await new WorkspaceBoundary(root).listFiles('output')).sort(), ['output/import.xlsx', 'output/report.docx', 'output/report.pptx'].sort())
  } finally { await rm(root, { recursive: true, force: true }) }
})
