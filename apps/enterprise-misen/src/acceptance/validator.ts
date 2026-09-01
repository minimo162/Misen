import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { getFormulaText, isFormulaValue } from '@office-kit/xlsx/cell'
import { getCellByCoord, getColumnDimension, getRowDimension, iterCells, type Worksheet } from '@office-kit/xlsx/worksheet'
import type { Workbook } from '@office-kit/xlsx/workbook'
import type { MonthFixture } from '../../demo/enterprise-excel/fixtures.js'
import { validateDeliverable } from '../capabilities/guards.js'
import { listWorksheetTitles, openSpreadsheetBytes, readCell, readCellStyle, requireWorksheet } from '../spreadsheet/engine.js'
import { verifyProfitFormula, verifyStatusFormula, verifyTotalFormula } from './formula.js'

const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
export interface ReportingPeriod { readonly year: number; readonly month: number }
export const AXIS_NAMES = ['SHEET', 'MONTH', 'ROWS', 'PROFIT_FORMULAS', 'STATUS', 'TOTAL', 'FOOTER', 'FORMAT'] as const
export type AxisName = typeof AXIS_NAMES[number]
export interface AxisResult { readonly status: 'PASS' | 'FAIL'; readonly evidence: unknown }
export interface ValidationResult { readonly period: ReportingPeriod; readonly output: string; readonly passed: boolean; readonly axes: Readonly<Record<AxisName, AxisResult>>; readonly diagnostics: readonly string[] }

export function parseReportPeriod(value: unknown, source: ReportingPeriod) {
  let normalized: ReportingPeriod | undefined
  if (value instanceof Date && !Number.isNaN(value.getTime())) normalized = { year: value.getUTCFullYear(), month: value.getUTCMonth() + 1 }
  else if (typeof value === 'string') {
    const monthOnly = /^(?<month>[1-9]|1[0-2])月$/u.exec(value)
    const yearMonth = /^(?<year>\d{4})年(?<month>[1-9]|1[0-2])月$/u.exec(value)
    const separated = /^(?<year>\d{4})(?:-|\/)(?<month>0?[1-9]|1[0-2])$/u.exec(value)
    const match = monthOnly ?? yearMonth ?? separated
    if (match?.groups) normalized = { year: match.groups.year ? Number(match.groups.year) : source.year, month: Number(match.groups.month) }
  }
  if (!normalized || normalized.year !== source.year || normalized.month !== source.month) throw new Error('report MONTH mismatch')
  return normalized
}

export function deriveSourcePeriod(values: readonly unknown[]): ReportingPeriod {
  if (values.length !== 3) throw new Error('exactly three source periods required')
  const periods = values.map(value => { if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new Error('unparseable source As-of'); return { year: value.getUTCFullYear(), month: value.getUTCMonth() + 1 } })
  const first = periods[0]!
  if (periods.some(value => value.year !== first.year || value.month !== first.month)) throw new Error('source reporting periods differ')
  return first
}

export type OutputScopeSnapshot = ReadonlyMap<string, string>
export async function snapshotOutputScope(root: string): Promise<OutputScopeSnapshot> { const entries = await readdir(join(root, 'output'), { withFileTypes: true }); const snapshot = new Map<string, string>(); for (const entry of entries) { if (!entry.isFile()) throw new Error('output scope contains a non-file entry'); snapshot.set(entry.name, digest(await readFile(join(root, 'output', entry.name)))) } return snapshot }

type SourceFact = { company: string; revenue: number; cost: number; asOf: unknown; target: number }
type Layout = { sheet: string; headerRow: number; totalRow: number; footerRows: number[]; monthCell: string; columns: Record<'Company' | 'Revenue' | 'Cost' | 'Profit' | 'Status', number> }
const columnName = (column: number) => { let value = column, result = ''; while (value > 0) { value--; result = String.fromCharCode(65 + value % 26) + result; value = Math.floor(value / 26) } return result }
const coordinate = (column: number, row: number) => `${columnName(column)}${row}`
const equal = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right)
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error)

function findTemplateLayout(workbook: Workbook): Layout {
  for (const sheet of listWorksheetTitles(workbook)) {
    const worksheet = requireWorksheet(workbook, sheet)
    const rows = new Map<number, Map<string, number>>()
    for (const cell of iterCells(worksheet)) { if (typeof cell.value !== 'string') continue; const row = rows.get(cell.row) ?? new Map<string, number>(); row.set(cell.value, cell.col); rows.set(cell.row, row) }
    for (const [headerRow, labels] of rows) {
      const required = ['Company', 'Revenue', 'Cost', 'Profit', 'Status'] as const
      if (!required.every(label => labels.has(label))) continue
      const companyColumn = labels.get('Company')!
      const totalCell = [...iterCells(worksheet)].find(cell => cell.col === companyColumn && cell.row > headerRow && cell.value === 'Totals')
      const monthLabel = [...iterCells(worksheet)].find(cell => cell.value === 'Month')
      if (!totalCell || !monthLabel) throw new Error('template layout incomplete')
      const footerRows = [...new Set([...iterCells(worksheet)].filter(cell => cell.row > totalCell.row && cell.value !== null).map(cell => cell.row))]
      return { sheet, headerRow, totalRow: totalCell.row, footerRows, monthCell: coordinate(monthLabel.col + 1, monthLabel.row), columns: Object.fromEntries(required.map(label => [label, labels.get(label)!])) as Layout['columns'] }
    }
  }
  throw new Error('template report layout unavailable')
}

function grade(fn: () => unknown, observed?: unknown): AxisResult { try { return { status: 'PASS', evidence: fn() } } catch (error) { return { status: 'FAIL', evidence: { error: errorMessage(error), ...(observed === undefined ? {} : { observed }) } } } }
function formulaText(worksheet: Worksheet, cellCoordinate: string): string { const cell = getCellByCoord(worksheet, cellCoordinate); if (!cell || !isFormulaValue(cell.value)) throw new Error(`${cellCoordinate} must be a formula`); return getFormulaText(cell) }
function cellRepresentation(worksheet: Worksheet | undefined, cellCoordinate: string): unknown { const cell = worksheet ? getCellByCoord(worksheet, cellCoordinate) : undefined; return isFormulaValue(cell?.value) ? { formula: getFormulaText(cell!) } : cell?.value ?? null }

async function sourceFacts(root: string, scenario: MonthFixture): Promise<{ facts: SourceFact[]; period: ReportingPeriod }> {
  const facts: Omit<SourceFact, 'target'>[] = []
  for (const company of scenario.companies) {
    const workbook = await openSpreadsheetBytes(await readFile(join(root, scenario.month, `${company.company}.xlsx`)))
    const companyName = readCell(workbook, 'Actuals', 'B1'), revenue = readCell(workbook, 'Actuals', 'B2'), cost = readCell(workbook, 'Actuals', 'B3')
    if (typeof companyName !== 'string' || companyName.length === 0 || typeof revenue !== 'number' || !Number.isFinite(revenue) || typeof cost !== 'number' || !Number.isFinite(cost)) throw new Error('invalid source company facts')
    facts.push({ company: companyName, revenue, cost, asOf: readCell(workbook, 'Actuals', 'B4') })
  }
  const master = await openSpreadsheetBytes(await readFile(join(root, 'master.xlsx')))
  const targets = new Map<string, number>()
  const targetSheet = requireWorksheet(master, listWorksheetTitles(master)[0]!)
  for (const cell of iterCells(targetSheet)) if (cell.col === 1 && cell.row > 1 && typeof cell.value === 'string') { const target = getCellByCoord(targetSheet, coordinate(2, cell.row))?.value; if (typeof target === 'number') targets.set(cell.value, target) }
  return { facts: facts.map(fact => { const target = targets.get(fact.company); if (target === undefined) throw new Error(`master target missing: ${fact.company}`); return { ...fact, target } }), period: deriveSourcePeriod(facts.map(fact => fact.asOf)) }
}

export async function validateReport(root: string, scenario: MonthFixture, before: ReadonlyMap<string, string>, outputBefore: OutputScopeSnapshot): Promise<ValidationResult> {
  const { facts, period } = await sourceFacts(root, scenario)
  for (const [file, hash] of before) if (digest(await readFile(join(root, file))) !== hash) throw new Error(`input hash changed: ${file}`)
  const outputAfter = await snapshotOutputScope(root)
  for (const [name, hash] of outputBefore) if (outputAfter.get(name) !== hash) throw new Error(`pre-existing output changed: ${name}`)
  const created = [...outputAfter.keys()].filter(name => !outputBefore.has(name))
  if (created.length !== 1) throw new Error('new output count')
  const name = created[0]!
  if (!/\.xlsx$/iu.test(name)) throw new Error('new output is not xlsx')
  const output = `output/${name}`
  const workbook = await openSpreadsheetBytes(await readFile(join(root, output)))
  validateDeliverable(workbook)
  const template = await openSpreadsheetBytes(await readFile(join(root, '月次管理レポート_template.xlsx')))
  const layout = findTemplateLayout(template)
  const diagnostics: string[] = []
  const titles = listWorksheetTitles(workbook)
  const extraSheets = titles.filter(title => title !== layout.sheet)
  if (extraSheets.length) diagnostics.push(`extra sheets: ${extraSheets.join(', ')}`)
  const outputSheet = titles.includes(layout.sheet) ? requireWorksheet(workbook, layout.sheet) : undefined
  const templateSheet = requireWorksheet(template, layout.sheet)
  const dataRows = Array.from({ length: layout.totalRow - layout.headerRow - 1 }, (_, index) => layout.headerRow + 1 + index)
  const actualRows = outputSheet ? dataRows.filter(row => getCellByCoord(outputSheet, coordinate(layout.columns.Company, row))?.value != null).map(row => ({ row, company: getCellByCoord(outputSheet, coordinate(layout.columns.Company, row))?.value, revenue: getCellByCoord(outputSheet, coordinate(layout.columns.Revenue, row))?.value, cost: getCellByCoord(outputSheet, coordinate(layout.columns.Cost, row))?.value })) : []
  const expectedByCompany = new Map(facts.map(fact => [fact.company, fact]))
  const rowsByCompany = new Map<string, typeof actualRows>()
  for (const row of actualRows) if (typeof row.company === 'string') rowsByCompany.set(row.company, [...(rowsByCompany.get(row.company) ?? []), row])
  const monthActual = outputSheet ? getCellByCoord(outputSheet, layout.monthCell)?.value ?? null : null
  const expectedRows = facts.map(({ company, revenue, cost }) => ({ company, revenue, cost }))
  const profitObserved = facts.map(fact => { const row = rowsByCompany.get(fact.company)?.[0]?.row; return { company: fact.company, row: row ?? null, value: row ? cellRepresentation(outputSheet, coordinate(layout.columns.Profit, row)) : null } })
  const statusObserved = facts.map(fact => { const row = rowsByCompany.get(fact.company)?.[0]?.row; return { company: fact.company, row: row ?? null, value: row ? cellRepresentation(outputSheet, coordinate(layout.columns.Status, row)) : null } })
  const totalObserved = (['Revenue', 'Cost', 'Profit'] as const).map(key => ({ column: key, value: cellRepresentation(outputSheet, coordinate(layout.columns[key], layout.totalRow)) }))

  const axes = {} as Record<AxisName, AxisResult>
  axes.SHEET = grade(() => { if (!outputSheet) throw new Error(`template report sheet missing: ${layout.sheet}`); for (const [label, column] of Object.entries(layout.columns)) if (getCellByCoord(outputSheet, coordinate(column, layout.headerRow))?.value !== label) throw new Error(`report header mismatch: ${label}`); return { reportSheet: layout.sheet, extraSheets } }, { expectedReportSheet: layout.sheet, actualSheets: titles })
  axes.MONTH = grade(() => { if (!outputSheet) throw new Error('report sheet unavailable'); return { actual: monthActual, normalized: parseReportPeriod(monthActual, period), expected: period } }, { actual: monthActual, expected: period })
  axes.ROWS = grade(() => {
    const duplicates = [...rowsByCompany].filter(([, rows]) => rows.length !== 1).map(([company]) => company)
    const missing = facts.filter(fact => (rowsByCompany.get(fact.company)?.length ?? 0) !== 1).map(fact => fact.company)
    const unknown = actualRows.filter(row => typeof row.company !== 'string' || !expectedByCompany.has(row.company)).map(row => row.company)
    if (duplicates.length || missing.length || unknown.length || actualRows.length !== facts.length) throw new Error(`company set mismatch: missing=${missing.join(',')} duplicate=${duplicates.join(',')} unknown=${unknown.join(',')}`)
    for (const row of actualRows) { const expected = expectedByCompany.get(row.company as string)!; if (row.revenue !== expected.revenue || row.cost !== expected.cost) throw new Error(`company/value association mismatch: ${row.company}`) }
    return { companies: actualRows.map(row => ({ company: row.company, revenue: row.revenue, cost: row.cost, row: row.row })) }
  }, { actual: actualRows, expected: expectedRows })
  axes.PROFIT_FORMULAS = grade(() => { if (!outputSheet) throw new Error('report sheet unavailable'); const checked: unknown[] = []; for (const fact of facts) { const rows = rowsByCompany.get(fact.company) ?? []; if (rows.length !== 1) throw new Error(`company row unavailable: ${fact.company}`); const row = rows[0]!.row; const formula = formulaText(outputSheet, coordinate(layout.columns.Profit, row)); verifyProfitFormula(formula, row, columnName(layout.columns.Revenue), columnName(layout.columns.Cost), fact.revenue, fact.cost); checked.push({ company: fact.company, row, formula }) } return checked }, profitObserved)
  axes.STATUS = grade(() => { if (!outputSheet) throw new Error('report sheet unavailable'); const checked: unknown[] = []; for (const fact of facts) { const rows = rowsByCompany.get(fact.company) ?? []; if (rows.length !== 1) throw new Error(`company row unavailable: ${fact.company}`); const row = rows[0]!.row; const cell = getCellByCoord(outputSheet, coordinate(layout.columns.Status, row)); const sourceProfit = fact.revenue - fact.cost, expected = sourceProfit >= fact.target ? 'On target' : 'Review'; if (isFormulaValue(cell?.value)) { const formula = getFormulaText(cell!); verifyStatusFormula(formula, row, columnName(layout.columns.Profit), columnName(layout.columns.Revenue), columnName(layout.columns.Cost), fact.target, sourceProfit); checked.push({ company: fact.company, representation: 'formula', formula }) } else { if (cell?.value !== expected) throw new Error(`status mismatch: ${fact.company}`); checked.push({ company: fact.company, representation: 'literal', value: cell.value }) } } return checked }, statusObserved)
  axes.TOTAL = grade(() => { if (!outputSheet) throw new Error('report sheet unavailable'); const companyRows = actualRows.filter(row => typeof row.company === 'string' && expectedByCompany.has(row.company)).map(row => row.row); if (companyRows.length !== facts.length) throw new Error('company rows unavailable for total'); const checked: unknown[] = []; for (const key of ['Revenue', 'Cost', 'Profit'] as const) { const column = columnName(layout.columns[key]); const formula = formulaText(outputSheet, coordinate(layout.columns[key], layout.totalRow)); const sourceValues = actualRows.map(row => { const fact = expectedByCompany.get(row.company as string)!; return key === 'Revenue' ? fact.revenue : key === 'Cost' ? fact.cost : fact.revenue - fact.cost }); verifyTotalFormula(formula, column, companyRows, sourceValues); checked.push({ column: key, formula, rows: companyRows }) } return checked }, totalObserved)
  axes.FOOTER = grade(() => { if (!outputSheet) throw new Error('report sheet unavailable'); const checked: unknown[] = []; for (const row of layout.footerRows) for (let column = 1; column <= Math.max(...Object.values(layout.columns)); column++) { const expected = getCellByCoord(templateSheet, coordinate(column, row))?.value ?? null; if (expected === null) continue; const actual = getCellByCoord(outputSheet, coordinate(column, row))?.value ?? null; if (!equal(actual, expected)) throw new Error(`footer mismatch: ${coordinate(column, row)}`); checked.push({ cell: coordinate(column, row), value: actual }) } return checked })
  axes.FORMAT = grade(() => { if (!outputSheet) throw new Error('report sheet unavailable'); const maxColumn = Math.max(...Object.values(layout.columns)), maxRow = Math.max(layout.totalRow, ...layout.footerRows); for (let row = 1; row <= maxRow; row++) for (let column = 1; column <= maxColumn; column++) { const cell = coordinate(column, row); if (!equal(readCellStyle(workbook, layout.sheet, cell), readCellStyle(template, layout.sheet, cell))) throw new Error(`template style mismatch: ${cell}`) } for (let row = 1; row <= maxRow; row++) if (!equal(getRowDimension(outputSheet, row), getRowDimension(templateSheet, row))) throw new Error(`template row dimension mismatch: ${row}`); for (let column = 1; column <= maxColumn; column++) if (!equal(getColumnDimension(outputSheet, column), getColumnDimension(templateSheet, column))) throw new Error(`template column dimension mismatch: ${column}`); return { comparedCells: maxRow * maxColumn, rows: maxRow, columns: maxColumn } })
  const passed = AXIS_NAMES.every(axis => axes[axis].status === 'PASS')
  return { period, output, passed, axes, diagnostics }
}
