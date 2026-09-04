import test from 'node:test'
import { strict as assert } from 'node:assert'
import { createHash } from 'node:crypto'
import { link, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ENTERPRISE_TOOL_NAMES } from '../src/capabilities/tools.js'
import { safeFormula } from '../src/capabilities/guards.js'
import { DENIED_OFFICE_ELEMENTS, DENIED_OFFICE_PROPERTY_RULES, DENIED_OFFICE_VERBS, assertAllowedOfficeElement, assertAllowedOfficeItem, assertAllowedOfficeVerb, assertSafeOfficeProperties } from '../src/capabilities/office-denylist.js'
import { WorkspaceBoundary } from '../src/workspace/boundary.js'

test('authority roster exposes OfficeCLI verbs and only compatibility read aliases', () => {
  assert.deepEqual(ENTERPRISE_TOOL_NAMES, [
    'workspace_list_files', 'workspace_read_text', 'office_get', 'office_query', 'office_inspect', 'office_create_output',
    'office_set', 'office_add', 'office_remove', 'office_move', 'office_swap', 'office_batch', 'office_import',
    'pdf_read', 'pdf_render', 'pdf_create_output',
    'spreadsheet_read', 'document_read', 'presentation_read',
  ])
  for (const retired of ['spreadsheet_create_output', 'spreadsheet_update', 'document_create_output', 'document_update', 'presentation_create_output', 'presentation_update']) assert.ok(!ENTERPRISE_TOOL_NAMES.includes(retired as any))
})

test('formula boundary remains deny-list based', () => {
  for (const bad of ['=WEBSERVICE("x")', '=HYPERLINK("https://example.com")', '=INDIRECT("A1")', '=_xlfn.WEBSERVICE("x")', '=SUM([Book.xlsx]Sheet1!A1)', "='[Book.xlsx]Sheet1'!A1", '=cmd|x', '="a"&"https://x"', '=CALL("kernel32")', '=RTD("p",,"t")']) assert.throws(() => safeFormula(bad), bad)
  for (const good of ['=SUM(A1:A3)', '=SUMIFS(Data!C:C,Data!A:A,"Alpha",Data!B:B,">=2026-08-01")', '=IFERROR(XLOOKUP($A2,Master!$A:$A,Master!$D:$D),0)', '=INDEX(B:B,MATCH("Beta",A:A,0))', "=SUM('7月'!B2:B10)", '=EOMONTH(TODAY(),0)', '=TEXT(B2,"#,##0")', '=_xlfn.XLOOKUP(A1,B:B,C:C)', '=ROUND(売上合計/12,0)', '=IF(AND(B2>0,C2<>""),B2*1.1,0)', '={1,2,3}']) assert.equal(safeFormula(good), good, good)
})

test('every denied OfficeCLI verb is rejected from the single list', () => {
  for (const verb of DENIED_OFFICE_VERBS) assert.throws(() => assertAllowedOfficeVerb(verb), /not allowed/u)
})

test('every denied OfficeCLI element and dangerous alias is rejected from the single list', () => {
  for (const element of DENIED_OFFICE_ELEMENTS) assert.throws(() => assertAllowedOfficeElement(element), /not allowed/u)
  for (const alias of ['image', '3dmodel', 'embeddedobject']) assert.throws(() => assertAllowedOfficeElement(alias), /not allowed/u)
})

test('every denied Office property rule is exercised', () => {
  const cases: Record<typeof DENIED_OFFICE_PROPERTY_RULES[number], () => void> = {
    'unsafe-formula': () => assertSafeOfficeProperties('cell', { formula: '=WEBSERVICE("x")' }),
    url: () => assertSafeOfficeProperties('shape', { text: 'https://example.invalid' }),
    unc: () => assertSafeOfficeProperties('table', { source: '\\\\server\\share\\data.csv' }),
    'external-workbook': () => assertSafeOfficeProperties('cell', { formula: '[Book.xlsx]Sheet1!A1' }),
    'external-data-source': () => assertSafeOfficeProperties('pivottable', { connection: 'FinanceWarehouse' }),
  }
  assert.deepEqual(Object.keys(cases), [...DENIED_OFFICE_PROPERTY_RULES])
  for (const rule of DENIED_OFFICE_PROPERTY_RULES) assert.throws(cases[rule])
  for (const element of ['slicer', 'validation']) assert.throws(() => assertSafeOfficeProperties(element, { dataSource: 'external' }), /external data source/u)
  assert.doesNotThrow(() => assertAllowedOfficeItem({ command: 'add', type: 'pivottable', props: { source: 'Data!A1:D20', values: 'Amount:sum' } }))
})

test('resource boundary rejects traversal absolute and NUL', async () => {
  const boundary = new WorkspaceBoundary(process.cwd())
  for (const path of ['../x', 'C:\\x', 'a\0b']) await assert.rejects(boundary.readFileBytes(path))
})

test('output-only boundary allows supported Office types and rejects non-output, unsupported extension, and overwrite false', async () => {
  const root = await mkdtemp(join(tmpdir(), 'misen-boundary-'))
  try {
    await mkdir(join(root, 'output')); await writeFile(join(root, 'input.xlsx'), 'a')
    const boundary = new WorkspaceBoundary(root)
    await assert.rejects(boundary.writeOutputFileBytes('input.xlsx', Buffer.from('x')))
    await assert.rejects(boundary.writeOutputFileBytes('output/a.txt', Buffer.from('x')))
    for (const extension of ['xlsx', 'docx', 'pptx']) await boundary.writeOutputFileBytes(`output/a.${extension}`, Buffer.from(extension))
    await assert.rejects(boundary.writeOutputFileBytes('output/a.xlsx', Buffer.from('two')))
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('symlink is rejected or explicitly skipped when Windows denies creation', async t => {
  const root = await mkdtemp(join(tmpdir(), 'misen-link-'))
  try {
    await writeFile(join(root, 'x.txt'), 'x')
    try { await symlink(join(root, 'x.txt'), join(root, 'link.txt')) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') { t.skip('Windows EPERM: symlink fixture unavailable'); return }
      throw error
    }
    await assert.rejects(new WorkspaceBoundary(root).readFileBytes('link.txt'))
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('output reads reject an intra-workspace junction outside the output scope', async t => {
  const root = await mkdtemp(join(tmpdir(), 'misen-output-scope-'))
  try {
    await mkdir(join(root, 'private')); await writeFile(join(root, 'private', 'hidden.xlsx'), 'hidden')
    try { await symlink(join(root, 'private'), join(root, 'output'), 'junction') } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') { t.skip('Windows EPERM: junction fixture unavailable'); return }
      throw error
    }
    await assert.rejects(new WorkspaceBoundary(root).readOutputFileBytes('output/hidden.xlsx'), /output|symlink/u)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('secret sentinel and high impact tools are absent', () => {
  const source = JSON.stringify(ENTERPRISE_TOOL_NAMES)
  assert.ok(!source.includes('SENTINEL_SECRET'))
  for (const forbidden of ['shell', 'bash', 'network', 'web', 'mcp', 'subagent', 'plugin', 'delete']) assert.ok(!ENTERPRISE_TOOL_NAMES.includes(forbidden as any))
})

test('hardlink is rejected or explicitly skipped', async t => {
  const root = await mkdtemp(join(tmpdir(), 'misen-hardlink-'))
  try {
    await writeFile(join(root, 'x.txt'), 'x')
    try { await link(join(root, 'x.txt'), join(root, 'hard.txt')) } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EPERM' || code === 'EACCES') { t.skip(`hardlink unavailable: ${code}`); return }
      throw error
    }
    await assert.rejects(new WorkspaceBoundary(root).readFileBytes('hard.txt'))
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('injected atomic replacement failure preserves prior output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'misen-rename-'))
  class Fail extends WorkspaceBoundary { protected override async commitTemporaryFile(): Promise<void> { throw new Error('injected rename failure') } }
  try {
    await mkdir(join(root, 'output')); await writeFile(join(root, 'output', 'old.xlsx'), 'old')
    const old = await readFile(join(root, 'output', 'old.xlsx'))
    await assert.rejects(new Fail(root).writeOutputFileBytes('output/old.xlsx', Buffer.from('new'), true))
    assert.equal(createHash('sha256').update(await readFile(join(root, 'output', 'old.xlsx'))).digest('hex'), createHash('sha256').update(old).digest('hex'))
  } finally { await rm(root, { recursive: true, force: true }) }
})
