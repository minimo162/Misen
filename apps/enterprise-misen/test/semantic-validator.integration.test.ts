import test from 'node:test'
import { strict as assert } from 'node:assert'
import { createHash } from 'node:crypto'
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fixture, PROMPTS, SYNTHETIC_MONTHS } from '../demo/enterprise-excel/fixtures.js'
import { AXIS_NAMES, snapshotOutputScope, validateReport, type OutputScopeSnapshot } from '../src/acceptance/validator.js'
import { runReplay } from '../src/runtime/agent.js'
import { officeCli, type OfficeCliBatchItem } from '../src/spreadsheet/engine.js'
import { rangeBoundaries, tupleToCoordinate } from '../src/spreadsheet/range.js'

const scenario = SYNTHETIC_MONTHS[0]!
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

async function hashes(root: string) {
  const paths = ['master.xlsx', '月次管理レポート_template.xlsx', ...scenario.companies.map(company => `${scenario.month}/${company.company}.xlsx`)]
  return new Map(await Promise.all(paths.map(async path => [path, digest(await readFile(join(root, path)))] as const)))
}

type Baseline = { root: string; before: Map<string, string>; outputBefore: OutputScopeSnapshot; output: string }

// Issue #93 C: the July replay (fixture + faux Pi Agent run through OfficeCLI) costs roughly 14 s. It used to be
// repeated for every variant below (11 replays). The replay is deterministic, so it is produced once per test
// process and each case works on a private copy of the replayed workspace. Input hashes and the pre-run output
// snapshot are relative to the workspace root, so they remain valid for the copy.
let baselinePromise: Promise<Baseline> | undefined
function baseline(): Promise<Baseline> {
  baselinePromise ??= (async () => {
    const root = await mkdtemp(join(tmpdir(), 'misen-semantic-baseline-'))
    await fixture(root)
    const before = await hashes(root)
    const outputBefore = await snapshotOutputScope(root)
    const replay = await runReplay(root, '7月', PROMPTS['7月'])
    return { root, before, outputBefore, output: replay.output }
  })()
  return baselinePromise
}

async function prepared() {
  const base = await baseline()
  const root = await mkdtemp(join(tmpdir(), 'misen-semantic-validator-'))
  await cp(base.root, root, { recursive: true })
  return { root, before: base.before, outputBefore: base.outputBefore, outputPath: join(root, base.output) }
}

test.after(async () => {
  if (baselinePromise) await rm((await baselinePromise).root, { recursive: true, force: true })
})

function rangeItems(sheet: string, range: string, values: readonly (readonly (string | number | boolean | null)[])[]): OfficeCliBatchItem[] {
  const bounds = rangeBoundaries(range)
  const items: OfficeCliBatchItem[] = []
  for (let row = 0; row < values.length; row += 1) for (let col = 0; col < values[row]!.length; col += 1) {
    const value = values[row]![col]
    const path = '/' + sheet + '/' + tupleToCoordinate(bounds.minCol + col, bounds.minRow + row)
    if (value === null) items.push({ command: 'set', path, props: { clear: 'true' } })
    else items.push({ command: 'set', path, props: { value: String(value), type: typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'boolean' : 'string' } })
  }
  return items
}

async function mutate(path: string, items: readonly OfficeCliBatchItem[]) {
  await officeCli().batchFile(path, items)
  await officeCli().validateFile(path)
}

test('Decision 441 grades company/value rows as a set, not fixture order', async () => {
  const state = await prepared()
  try {
    await mutate(state.outputPath, [
      ...rangeItems('Report', 'A5:C7', [['Gamma', 1100, 650], ['Alpha', 1200, 700], ['Beta', 950, 500]]),
      ...rangeItems('Report', 'E5:E7', [['On target'], ['On target'], ['Review']]),
    ])
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
  ] as const
  for (const variant of variants) {
    const state = await prepared()
    try {
      await mutate(state.outputPath, rangeItems('Report', 'A5:C7', variant.rows))
      const result = await validateReport(state.root, scenario, state.before, state.outputBefore)
      assert.equal(result.axes.ROWS.status, 'FAIL', variant.name)
      assert.deepEqual(Object.keys(result.axes), [...AXIS_NAMES], 'all business axes are still graded')
    } finally { await rm(state.root, { recursive: true, force: true }) }
  }
})

test('Decision 441 ordinary mismatches return a complete non-fail-fast axis matrix', async () => {
  const state = await prepared()
  try {
    await mutate(state.outputPath, [...rangeItems('Report', 'B2:B2', [['2024-08']]), ...rangeItems('Report', 'E5:E5', [['Review']])])
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
    await mutate(state.outputPath, [...rangeItems('Report', 'D5:D5', [[500]]), ...rangeItems('Report', 'B9:B9', [[3250]])])
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
    await mutate(state.outputPath, [{ command: 'add', parent: '/', type: 'sheet', props: { name: 'Notes' } }])
    const result = await validateReport(state.root, scenario, state.before, state.outputBefore)
    assert.equal(result.axes.SHEET.status, 'PASS')
    assert.match(result.diagnostics.join('\n'), /extra sheets: Notes/u)
  } finally { await rm(state.root, { recursive: true, force: true }) }
})

test('Decision 441 derives preservation from the actual template and detects footer/style drift', async () => {
  // This case mutates the template before the replay, so it needs its own replay rather than the shared baseline.
  const root = await mkdtemp(join(tmpdir(), 'misen-template-derived-'))
  try {
    await fixture(root)
    const templatePath = join(root, '月次管理レポート_template.xlsx')
    await mutate(templatePath, [{ command: 'set', path: '/Report/A11', props: { font: 'Calibri', size: '12pt', bold: 'true', 'font.color': '123456' } }])
    const before = await hashes(root)
    const outputBefore = await snapshotOutputScope(root)
    const replay = await runReplay(root, '7月', PROMPTS['7月'])
    const baselineResult = await validateReport(root, scenario, before, outputBefore)
    assert.equal(baselineResult.passed, true, JSON.stringify(baselineResult.axes))

    await mutate(join(root, replay.output), rangeItems('Report', 'A11:A11', [['changed footer']]))
    const footer = await validateReport(root, scenario, before, outputBefore)
    assert.equal(footer.axes.FOOTER.status, 'FAIL')

    await mutate(join(root, replay.output), [
      ...rangeItems('Report', 'A11:A11', [['Template footer — untouched by the agent']]),
      { command: 'set', path: '/Report/B5', props: { font: 'Courier New', size: '9pt' } },
    ])
    const format = await validateReport(root, scenario, before, outputBefore)
    assert.equal(format.axes.FORMAT.status, 'FAIL')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('Decision 441 rejects template row-height and column-width drift', async () => {
  const state = await prepared()
  try {
    await mutate(state.outputPath, [{ command: 'set', path: '/Report/row[1]', props: { height: '99' } }])
    const row = await validateReport(state.root, scenario, state.before, state.outputBefore)
    assert.equal(row.axes.FORMAT.status, 'FAIL')

    await mutate(state.outputPath, [
      { command: 'set', path: '/Report/row[1]', props: { height: '28' } },
      { command: 'set', path: '/Report/col[A]', props: { width: '99' } },
    ])
    const column = await validateReport(state.root, scenario, state.before, state.outputBefore)
    assert.equal(column.axes.FORMAT.status, 'FAIL')
  } finally { await rm(state.root, { recursive: true, force: true }) }
})
