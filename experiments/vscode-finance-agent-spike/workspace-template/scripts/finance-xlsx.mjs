import { readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { extname, isAbsolute, join, normalize, relative, resolve } from 'node:path'
import { fromFile } from '@office-kit/xlsx/node'
import { loadWorkbook, workbookToBytes } from '@office-kit/xlsx/io'
import { getFormulaText, isFormulaValue, setFormula } from '@office-kit/xlsx/cell'
import { getCellByCoord, iterCells, setCellByCoord } from '@office-kit/xlsx/worksheet'
import { getSheet, sheetNames } from '@office-kit/xlsx/workbook'
import { getCellNumberFormat } from '@office-kit/xlsx/styles'
import { excelToDate } from '@office-kit/xlsx/utils'

const root = process.cwd()
const usage = `Usage:
  node scripts/finance-xlsx.mjs inspect
  node scripts/finance-xlsx.mjs build <plan.json>
  node scripts/finance-xlsx.mjs verify <output.xlsx>

Plan shape:
{
  "month": "7月",
  "output": "output/monthly-report-2024-07.xlsx",
  "rows": [
    { "company": "...", "revenue": 0, "cost": 0, "target": 0 }
  ]
}`

function fail(message) {
  throw new Error(message)
}

function sheet(workbook, title) {
  const value = getSheet(workbook, title)
  if (!value) fail(`worksheet not found: ${title}`)
  return value
}

function cellValue(workbook, cell) {
  if (isFormulaValue(cell.value)) {
    return { formula: getFormulaText(cell), cachedValue: cell.value.cachedValue ?? null }
  }
  if (typeof cell.value === 'number') {
    const numberFormat = getCellNumberFormat(workbook, cell)
    if (/(^|[^a-z])[dmyhs]+([^a-z]|$)/i.test(numberFormat)) {
      return { date: excelToDate(cell.value, { epoch: workbook.date1904 ? 'mac' : 'windows' }).toISOString(), serial: cell.value }
    }
  }
  return cell.value
}

async function open(path) {
  return loadWorkbook(fromFile(path))
}

function summarize(workbook) {
  return sheetNames(workbook).map(title => ({
    sheet: title,
    cells: [...iterCells(sheet(workbook, title))]
      .filter(cell => cell.value !== null && cell.value !== undefined && cell.value !== '')
      .map(cell => ({ row: cell.row, column: cell.col, value: cellValue(workbook, cell) })),
  }))
}

async function discoverXlsx(directory) {
  const result = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'output') continue
    const path = join(directory, entry.name)
    if (entry.isDirectory()) result.push(...await discoverXlsx(path))
    else if (entry.isFile() && extname(entry.name).toLowerCase() === '.xlsx') result.push(path)
  }
  return result
}

function ensureFinite(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${label} must be a finite number`)
  return value
}

function safeOutputPath(candidate) {
  if (typeof candidate !== 'string' || candidate.length === 0 || isAbsolute(candidate)) fail('output must be a relative path')
  const outputRoot = resolve(root, 'output')
  const path = resolve(root, normalize(candidate))
  const rel = relative(outputRoot, path)
  if (rel.startsWith('..') || isAbsolute(rel) || extname(path).toLowerCase() !== '.xlsx') fail('output must be a .xlsx file under output/')
  return path
}

function safeWorkspaceFile(candidate, label) {
  if (typeof candidate !== 'string' || candidate.length === 0 || isAbsolute(candidate)) fail(`${label} must be a relative workspace path`)
  const path = resolve(root, normalize(candidate))
  const rel = relative(root, path)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) fail(`${label} must stay inside the workspace`)
  return path
}

function put(worksheet, coordinate, value) {
  return setCellByCoord(worksheet, coordinate, value)
}

function formula(worksheet, coordinate, text, cachedValue) {
  const cell = getCellByCoord(worksheet, coordinate) ?? put(worksheet, coordinate, null)
  setFormula(cell, text.startsWith('=') ? text : `=${text}`, { cachedValue })
}

async function inspect() {
  const paths = (await discoverXlsx(root)).sort()
  const workbooks = []
  for (const path of paths) {
    workbooks.push({ path: relative(root, path).replaceAll('\\', '/'), sheets: summarize(await open(path)) })
  }
  console.log(JSON.stringify({ workbooks }, null, 2))
}

async function build(planPath) {
  if (!planPath) fail('build requires a plan.json path')
  const plan = JSON.parse(await readFile(safeWorkspaceFile(planPath, 'plan'), 'utf8'))
  if (typeof plan.month !== 'string' || !/^(?:[1-9]|1[0-2])月$/u.test(plan.month)) fail('month must be 1月 through 12月')
  if (!Array.isArray(plan.rows) || plan.rows.length === 0 || plan.rows.length > 4) fail('rows must contain one to four companies')
  const companies = new Set()
  const rows = plan.rows.map((row, index) => {
    if (!row || typeof row !== 'object') fail(`rows[${index}] must be an object`)
    if (typeof row.company !== 'string' || row.company.trim().length === 0) fail(`rows[${index}].company is required`)
    if (companies.has(row.company)) fail(`duplicate company: ${row.company}`)
    companies.add(row.company)
    const revenue = ensureFinite(row.revenue, `${row.company}.revenue`)
    const cost = ensureFinite(row.cost, `${row.company}.cost`)
    const target = ensureFinite(row.target, `${row.company}.target`)
    const profit = revenue - cost
    return { company: row.company, revenue, cost, target, profit, status: profit >= target ? 'On target' : 'Review' }
  })

  const outputPath = safeOutputPath(plan.output)
  try {
    await stat(outputPath)
    fail(`refusing to overwrite existing output: ${relative(root, outputPath)}`)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }

  const templatePath = join(root, '月次管理レポート_template.xlsx')
  const workbook = await open(templatePath)
  const report = sheet(workbook, 'Report')
  put(report, 'B2', plan.month)
  rows.forEach((row, index) => {
    const number = index + 5
    put(report, `A${number}`, row.company)
    put(report, `B${number}`, row.revenue)
    put(report, `C${number}`, row.cost)
    formula(report, `D${number}`, `=B${number}-C${number}`, row.profit)
    put(report, `E${number}`, row.status)
  })
  const firstRow = 5
  const lastRow = firstRow + rows.length - 1
  formula(report, 'B9', `=SUM(B${firstRow}:B${lastRow})`, rows.reduce((sum, row) => sum + row.revenue, 0))
  formula(report, 'C9', `=SUM(C${firstRow}:C${lastRow})`, rows.reduce((sum, row) => sum + row.cost, 0))
  formula(report, 'D9', `=SUM(D${firstRow}:D${lastRow})`, rows.reduce((sum, row) => sum + row.profit, 0))

  await writeFile(outputPath, await workbookToBytes(workbook), { flag: 'wx' })
  const reopened = await open(outputPath)
  console.log(JSON.stringify({
    output: relative(root, outputPath).replaceAll('\\', '/'),
    bytes: (await stat(outputPath)).size,
    sheets: sheetNames(reopened),
    rows: rows.map(({ target, ...row }) => row),
  }, null, 2))
}

async function verify(candidate) {
  if (!candidate) fail('verify requires an output .xlsx path')
  const path = safeOutputPath(candidate)
  const workbook = await open(path)
  console.log(JSON.stringify({
    output: relative(root, path).replaceAll('\\', '/'),
    bytes: (await stat(path)).size,
    workbook: summarize(workbook),
  }, null, 2))
}

const [command, argument] = process.argv.slice(2)
if (!command || command === 'help' || command === '--help' || command === '-h') console.log(usage)
else if (command === 'inspect') await inspect()
else if (command === 'build') await build(argument)
else if (command === 'verify') await verify(argument)
else fail(`unknown command: ${command}\n${usage}`)
