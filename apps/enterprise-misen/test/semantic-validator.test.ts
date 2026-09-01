import test from 'node:test'
import { strict as assert } from 'node:assert'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addWorksheet } from '@office-kit/xlsx/workbook'
import { makeFont, rgbColor } from '@office-kit/xlsx/styles'
import { fixture, PROMPTS, SYNTHETIC_MONTHS } from '../demo/enterprise-excel/fixtures.js'
import { AXIS_NAMES, snapshotOutputScope, validateReport } from '../src/acceptance/validator.js'
import { runReplay } from '../src/runtime/agent.js'
import {
  openSpreadsheetBytes,
  serializeSpreadsheet,
  setSpreadsheetColumnWidth,
  setSpreadsheetRowHeight,
  styleCell,
  writeCell,
  writeRangeValues,
} from '../src/spreadsheet/engine.js'

const scenario = SYNTHETIC_MONTHS[0]!
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

async function hashes(root: string) {
  const paths = ['master.xlsx', '月次管理レポート_template.xlsx', ...scenario.companies.map(company => `${scenario.month}/${company.company}.xlsx`)]
  return new Map(await Promise.all(paths.map(async path => [path, digest(await readFile(join(root, path)))] as const)))
}

async function prepared() {
  const root = await mkdtemp(join(tmpdir(), 'misen-semantic-validator-'))
  await fixture(root)
  const before = await hashes(root)
  const outputBefore = await snapshotOutputScope(root)
  const replay = await runReplay(root, '7月', PROMPTS['7月'])
  const outputPath = join(root, replay.output)
  return { root, before, outputBefore, outputPath }
}

async function mutate(path: string, update: (workbook: Awaited<ReturnType<typeof openSpreadsheetBytes>>) => void) {
  const workbook = await openSpreadsheetBytes(await readFile(path))
  update(workbook)
  await writeFile(path, await serializeSpreadsheet(workbook))
}

test('Decision 441 grades company/value rows as a set, not fixture order', async () => {
  const state = await prepared()
  try {
    await mutate(state.outputPath, workbook => {
      writeRangeValues(workbook, 'Report', 'A5:C7', [
        ['Gamma', 1100, 650],
        ['Alpha', 1200, 700],
        ['Beta', 950, 500],
      ])
      writeRangeValues(workbook, 'Report', 'E5:E7', [['On target'], ['On target'], ['Review']])
    })
    const result = await validateReport(state.root, scenario, state.before, state.outputBefore)
    assert.equal(result.passed, true, JSON.stringify(result.axes))
    assert.equal(result.axes.ROWS.status, 'PASS')
  } finally { await rm(state.root, { recursive: true, force: true }) }
})

test('Decision 441 ROWS rejects wrong association, duplicate, missing, and unknown company', async () => {
  const variants = [
    { name: 'association', rows: [['Alpha', 1100, 650], ['Beta', 950, 500], ['Gamma', 1200, 700]] },
    { name: 'duplicate', rows: [['Alpha', 1200, 700], ['Alpha', 950, 500], ['Gamma', 1100, 650]] },
    { name: 'missing', rows: [['Alpha', 1200, 700], ['Beta', 950, 500], ['', 0, 0]] },
    { name: 'unknown', rows: [['Alpha', 1200, 700], ['Beta', 950, 500], ['Delta', 1100, 650]] },
  ]
  for (const variant of variants) {
    const state = await prepared()
    try {
      await mutate(state.outputPath, workbook => writeRangeValues(workbook, 'Report', 'A5:C7', variant.rows))
      const result = await validateReport(state.root, scenario, state.before, state.outputBefore)
      assert.equal(result.axes.ROWS.status, 'FAIL', variant.name)
      assert.deepEqual(Object.keys(result.axes), [...AXIS_NAMES], 'all business axes are still graded')
    } finally { await rm(state.root, { recursive: true, force: true }) }
  }
})

test('Decision 441 ordinary mismatches return a complete non-fail-fast axis matrix', async () => {
  const state = await prepared()
  try {
    await mutate(state.outputPath, workbook => {
      writeCell(workbook, 'Report', 'B2', '2024-08')
      writeCell(workbook, 'Report', 'E5', 'Review')
    })
    const result = await validateReport(state.root, scenario, state.before, state.outputBefore)
    assert.equal(result.passed, false)
    assert.equal(result.axes.MONTH.status, 'FAIL')
    assert.equal(result.axes.STATUS.status, 'FAIL')
    assert.equal(result.axes.TOTAL.status, 'PASS')
    assert.equal(result.axes.FOOTER.status, 'PASS')
    assert.equal(result.axes.FORMAT.status, 'PASS')
  } finally { await rm(state.root, { recursive: true, force: true }) }
})

test('Decision 441 requires formula mechanisms for Profit and Total at validator level', async () => {
  const state = await prepared()
  try {
    await mutate(state.outputPath, workbook => {
      writeCell(workbook, 'Report', 'D5', 500)
      writeCell(workbook, 'Report', 'B9', 3250)
    })
    const result = await validateReport(state.root, scenario, state.before, state.outputBefore)
    assert.equal(result.axes.PROFIT_FORMULAS.status, 'FAIL')
    assert.equal(result.axes.TOTAL.status, 'FAIL')
    assert.equal(result.axes.FOOTER.status, 'PASS')
    assert.equal(result.axes.FORMAT.status, 'PASS')
  } finally { await rm(state.root, { recursive: true, force: true }) }
})

test('Decision 441 permits harmless extra sheets while preserving the required report sheet', async () => {
  const state = await prepared()
  try {
    await mutate(state.outputPath, workbook => { addWorksheet(workbook, 'Notes') })
    const result = await validateReport(state.root, scenario, state.before, state.outputBefore)
    assert.equal(result.axes.SHEET.status, 'PASS')
    assert.match(result.diagnostics.join('\n'), /extra sheets: Notes/u)
  } finally { await rm(state.root, { recursive: true, force: true }) }
})

test('Decision 441 derives preservation from the actual template and detects footer/style drift', async () => {
  const root = await mkdtemp(join(tmpdir(), 'misen-template-derived-'))
  try {
    await fixture(root)
    const templatePath = join(root, '月次管理レポート_template.xlsx')
    await mutate(templatePath, workbook => styleCell(workbook, 'Report', 'A11', { font: makeFont({ name: 'Calibri', size: 12, bold: true, color: rgbColor('FF123456') }) }))
    const before = await hashes(root)
    const outputBefore = await snapshotOutputScope(root)
    const replay = await runReplay(root, '7月', PROMPTS['7月'])
    const baseline = await validateReport(root, scenario, before, outputBefore)
    assert.equal(baseline.passed, true, JSON.stringify(baseline.axes))

    await mutate(join(root, replay.output), workbook => writeCell(workbook, 'Report', 'A11', 'changed footer'))
    const footer = await validateReport(root, scenario, before, outputBefore)
    assert.equal(footer.axes.FOOTER.status, 'FAIL')

    await mutate(join(root, replay.output), workbook => {
      writeCell(workbook, 'Report', 'A11', 'Template footer — untouched by the agent')
      styleCell(workbook, 'Report', 'B5', { font: makeFont({ name: 'Courier New', size: 9 }) })
    })
    const format = await validateReport(root, scenario, before, outputBefore)
    assert.equal(format.axes.FORMAT.status, 'FAIL')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('Decision 441 rejects template row-height and column-width drift', async () => {
  const state = await prepared()
  try {
    await mutate(state.outputPath, workbook => setSpreadsheetRowHeight(workbook, 'Report', 1, 99))
    const row = await validateReport(state.root, scenario, state.before, state.outputBefore)
    assert.equal(row.axes.FORMAT.status, 'FAIL')

    await mutate(state.outputPath, workbook => {
      setSpreadsheetRowHeight(workbook, 'Report', 1, 28)
      setSpreadsheetColumnWidth(workbook, 'Report', 1, 99)
    })
    const column = await validateReport(state.root, scenario, state.before, state.outputBefore)
    assert.equal(column.axes.FORMAT.status, 'FAIL')
  } finally { await rm(state.root, { recursive: true, force: true }) }
})
