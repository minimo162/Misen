import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  createSpreadsheet,
  saveSpreadsheet,
  styleCell,
  writeCell,
  writeRangeValues,
  setSpreadsheetColumnWidth,
  setSpreadsheetRowHeight,
} from '../../src/spreadsheet/engine.js'
import {
  makeAlignment,
  makeBorder,
  makeFont,
  makePatternFill,
  makeSide,
  rgbColor,
} from '@office-kit/xlsx/styles'

/**
 * Synthetic-only fixture data for the first Excel vertical slice.
 *
 * The source data is deliberately kept outside the runtime implementation.
 * The deterministic Phase D replay discovers workbook files through the
 * public tools and reads their labels. July and August therefore exercise the
 * same scripted Agent Loop path without month-specific runtime branches.
 */
export interface CompanyFixture {
  readonly company: string
  readonly revenue: number
  readonly cost: number
  readonly asOf: string
}

export interface MonthFixture {
  readonly month: string
  readonly companies: readonly CompanyFixture[]
}

export const SYNTHETIC_MONTHS: readonly MonthFixture[] = Object.freeze([
  {
    month: '7月',
    companies: [
      { company: 'Alpha', revenue: 1200, cost: 700, asOf: '2024-07-31' },
      { company: 'Beta', revenue: 950, cost: 500, asOf: '2024-07-31' },
      { company: 'Gamma', revenue: 1100, cost: 650, asOf: '2024-07-31' },
    ],
  },
  {
    month: '8月',
    companies: [
      { company: 'Alpha', revenue: 1300, cost: 760, asOf: '2024-08-31' },
      { company: 'Beta', revenue: 1020, cost: 560, asOf: '2024-08-31' },
      { company: 'Gamma', revenue: 1150, cost: 690, asOf: '2024-08-31' },
    ],
  },
])

/** Targets are a master-data concern, not a company-specific code path. */
export const SYNTHETIC_TARGETS: Readonly<Record<string, number>> = Object.freeze({
  Alpha: 400,
  // The threshold sits between July and August Beta profit so both status
  // branches are exercised by the same runtime implementation.
  Beta: 455,
  Gamma: 380,
})

function headingStyle() {
  return {
    font: makeFont({ name: 'Aptos', size: 14, bold: true, color: rgbColor('FFFFFFFF') }),
    fill: makePatternFill({ patternType: 'solid', fgColor: rgbColor('FF1F4E78') }),
    border: makeBorder({
      top: makeSide({ style: 'thin', color: rgbColor('FF17365D') }),
      bottom: makeSide({ style: 'thin', color: rgbColor('FF17365D') }),
      left: makeSide({ style: 'thin', color: rgbColor('FF17365D') }),
      right: makeSide({ style: 'thin', color: rgbColor('FF17365D') }),
    }),
    alignment: makeAlignment({ horizontal: 'center', vertical: 'center', wrapText: true }),
  }
}

function tableHeaderStyle() {
  return {
    font: makeFont({ name: 'Aptos', size: 11, bold: true, color: rgbColor('FF000000') }),
    fill: makePatternFill({ patternType: 'solid', fgColor: rgbColor('FFD9EAF7') }),
    border: makeBorder({
      top: makeSide({ style: 'thin', color: rgbColor('FF7F7F7F') }),
      bottom: makeSide({ style: 'thin', color: rgbColor('FF7F7F7F') }),
      left: makeSide({ style: 'thin', color: rgbColor('FF7F7F7F') }),
      right: makeSide({ style: 'thin', color: rgbColor('FF7F7F7F') }),
    }),
    alignment: makeAlignment({ horizontal: 'center', vertical: 'center' }),
  }
}

function tableBodyStyle(numberFormat?: string) {
  return {
    font: makeFont({ name: 'Aptos', size: 11, color: rgbColor('FF000000') }),
    border: makeBorder({
      top: makeSide({ style: 'thin', color: rgbColor('FFD9D9D9') }),
      bottom: makeSide({ style: 'thin', color: rgbColor('FFD9D9D9') }),
      left: makeSide({ style: 'thin', color: rgbColor('FFD9D9D9') }),
      right: makeSide({ style: 'thin', color: rgbColor('FFD9D9D9') }),
    }),
    alignment: makeAlignment({ horizontal: numberFormat ? 'right' : 'left', vertical: 'center' }),
    ...(numberFormat === undefined ? {} : { numberFormat }),
  }
}

async function makeCompanyWorkbook(path: string, fixture: CompanyFixture): Promise<void> {
  const workbook = createSpreadsheet(['Actuals'])
  writeRangeValues(workbook, 'Actuals', 'A1:B5', [
    ['Company', fixture.company],
    ['Revenue', fixture.revenue],
    ['Cost', fixture.cost],
    ['As of', new Date(`${fixture.asOf}T00:00:00.000Z`)],
    ['Source note', 'Synthetic fixture — input must remain unchanged'],
  ])
  styleCell(workbook, 'Actuals', 'A1', tableHeaderStyle())
  styleCell(workbook, 'Actuals', 'B1', tableBodyStyle())
  for (const coordinate of ['A2', 'A3', 'A4', 'A5']) styleCell(workbook, 'Actuals', coordinate, tableHeaderStyle())
  styleCell(workbook, 'Actuals', 'B2', tableBodyStyle('#,##0'))
  styleCell(workbook, 'Actuals', 'B3', tableBodyStyle('#,##0'))
  styleCell(workbook, 'Actuals', 'B4', tableBodyStyle('yyyy-mm-dd'))
  styleCell(workbook, 'Actuals', 'B5', tableBodyStyle())
  setSpreadsheetColumnWidth(workbook, 'Actuals', 1, 18)
  setSpreadsheetColumnWidth(workbook, 'Actuals', 2, 34)
  setSpreadsheetRowHeight(workbook, 'Actuals', 1, 22)
  await saveSpreadsheet(workbook, path)
}

async function makeMasterWorkbook(path: string): Promise<void> {
  const workbook = createSpreadsheet(['Targets'])
  writeRangeValues(workbook, 'Targets', 'A1:B4', [
    ['Company', 'Minimum profit target'],
    ['Alpha', SYNTHETIC_TARGETS.Alpha],
    ['Beta', SYNTHETIC_TARGETS.Beta],
    ['Gamma', SYNTHETIC_TARGETS.Gamma],
  ])
  for (const coordinate of ['A1', 'B1']) styleCell(workbook, 'Targets', coordinate, tableHeaderStyle())
  for (const row of [2, 3, 4]) {
    styleCell(workbook, 'Targets', `A${row}`, tableBodyStyle())
    styleCell(workbook, 'Targets', `B${row}`, tableBodyStyle('#,##0'))
  }
  setSpreadsheetColumnWidth(workbook, 'Targets', 1, 18)
  setSpreadsheetColumnWidth(workbook, 'Targets', 2, 25)
  await saveSpreadsheet(workbook, path)
}

async function makeReportTemplate(path: string): Promise<void> {
  const workbook = createSpreadsheet(['Report'])
  writeCell(workbook, 'Report', 'A1', 'Monthly Management Report')
  writeCell(workbook, 'Report', 'A2', 'Month')
  writeCell(workbook, 'Report', 'B2', '')
  writeRangeValues(workbook, 'Report', 'A4:E4', [['Company', 'Revenue', 'Cost', 'Profit', 'Status']])
  // Four body rows leave room for the three companies and a future row while
  // keeping the template's formatting visible after a range write.
  writeRangeValues(workbook, 'Report', 'A5:E8', [
    [null, null, null, null, null],
    [null, null, null, null, null],
    [null, null, null, null, null],
    [null, null, null, null, null],
  ])
  writeRangeValues(workbook, 'Report', 'A9:E9', [['Totals', null, null, null, '']])
  writeCell(workbook, 'Report', 'A11', 'Template footer — untouched by the agent')

  styleCell(workbook, 'Report', 'A1', headingStyle())
  styleCell(workbook, 'Report', 'A2', tableHeaderStyle())
  styleCell(workbook, 'Report', 'B2', tableBodyStyle())
  for (const coordinate of ['A4', 'B4', 'C4', 'D4', 'E4']) styleCell(workbook, 'Report', coordinate, tableHeaderStyle())
  for (const row of [5, 6, 7, 8]) {
    styleCell(workbook, 'Report', `A${row}`, tableBodyStyle())
    for (const column of ['B', 'C', 'D']) styleCell(workbook, 'Report', `${column}${row}`, tableBodyStyle('#,##0'))
    styleCell(workbook, 'Report', `E${row}`, tableBodyStyle())
  }
  styleCell(workbook, 'Report', 'A9', tableHeaderStyle())
  for (const column of ['B', 'C', 'D']) styleCell(workbook, 'Report', `${column}9`, tableBodyStyle('#,##0'))
  styleCell(workbook, 'Report', 'E9', tableBodyStyle())
  styleCell(workbook, 'Report', 'A11', tableBodyStyle())
  setSpreadsheetColumnWidth(workbook, 'Report', 1, 18)
  setSpreadsheetColumnWidth(workbook, 'Report', 2, 14)
  setSpreadsheetColumnWidth(workbook, 'Report', 3, 14)
  setSpreadsheetColumnWidth(workbook, 'Report', 4, 14)
  setSpreadsheetColumnWidth(workbook, 'Report', 5, 14)
  setSpreadsheetRowHeight(workbook, 'Report', 1, 28)
  setSpreadsheetRowHeight(workbook, 'Report', 4, 22)
  await saveSpreadsheet(workbook, path)
}

const HANDOFF = `# Monthly management report handoff

## Task purpose

Complete a monthly management report from three company actuals workbooks.
The report is a synthetic technical PoC for a capability-constrained local
agent; it is not a production finance policy.

## Input workbook roles

- Each workbook under a month directory is one company's actuals workbook.
  Its **Actuals** sheet contains the company name, revenue, cost, and as-of date.
- **master.xlsx** contains the company-level minimum profit targets.
- **月次管理レポート_template.xlsx** supplies the output layout
  and formatting.

## Normal business rules

- Profit is revenue minus cost.
- A company is **On target** when profit is at least its master target;
  otherwise its status is **Review**.
- Source workbooks are read-only inputs. The completed report is written under
  the output directory.

## Output template meaning

The report sheet lists each discovered company with revenue, cost, a local
spreadsheet formula, and status. The total row uses formulas over the company rows;
the template footer and existing styles must remain intact.

## Completion criteria

- All three company workbooks are represented.
- Values, formulas, number formats, and template styling are preserved in the
  newly saved output workbook.
- Input workbook hashes are unchanged.
- The same behavior works for both July and August fixture directories without
  changing the runtime code, system prompt, or tool implementation.
`

/**
 * Create the complete synthetic workspace used by the vertical-slice tests.
 * Existing files are overwritten only at these explicitly named fixture paths;
 * no arbitrary workspace path is touched and no child process is started.
 */
export async function createEnterpriseFixtureWorkspace(root: string): Promise<void> {
  await mkdir(root, { recursive: true })
  await mkdir(join(root, 'output'), { recursive: true })
  await writeFile(join(root, '業務引継ぎ.md'), HANDOFF, 'utf8')
  await makeMasterWorkbook(join(root, 'master.xlsx'))
  await makeReportTemplate(join(root, '月次管理レポート_template.xlsx'))

  for (const month of SYNTHETIC_MONTHS) {
    const monthDirectory = join(root, month.month)
    await mkdir(monthDirectory, { recursive: true })
    for (const company of month.companies) {
      await makeCompanyWorkbook(join(monthDirectory, `${company.company}.xlsx`), company)
    }
  }
}

export const HANDOFF_MARKERS = Object.freeze([
  'Task purpose',
  'Input workbook roles',
  'Normal business rules',
  'Output template meaning',
  'Completion criteria',
])
