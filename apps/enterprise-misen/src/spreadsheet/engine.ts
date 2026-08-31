import { readFile, writeFile } from 'node:fs/promises'

import { fromBuffer, fromFile } from '@office-kit/xlsx/node'
import { loadWorkbook, workbookToBytes } from '@office-kit/xlsx/io'
import {
  addWorksheet,
  createWorkbook,
  getSheet,
  sheetNames,
  type Workbook,
} from '@office-kit/xlsx/workbook'
import {
  getCellByCoord,
  getRangeValues,
  iterCells,
  setCellByCoord,
  setRangeValues,
  setColumnWidth,
  setRowHeight,
  writeRange,
  type Worksheet,
} from '@office-kit/xlsx/worksheet'
import { setFormula } from '@office-kit/xlsx/cell'
import {
  getCellAlignment,
  getCellBorder,
  getCellFill,
  getCellFont,
  getCellNumberFormat,
  setCellStyle,
} from '@office-kit/xlsx/styles'
import type { Cell, CellValue } from '@office-kit/xlsx/cell'
import type { Alignment } from '@office-kit/xlsx/styles'
import type { Border } from '@office-kit/xlsx/styles'
import type { Fill } from '@office-kit/xlsx/styles'
import type { Font } from '@office-kit/xlsx/styles'
import { dateToExcel, excelToDate } from '@office-kit/xlsx/utils'

/**
 * A deliberately thin Node-facing seam around the commodity xlsx library.
 *
 * The Workbook/Worksheet/Cell value objects remain the public data model; this
 * module only supplies path I/O, sheet lookup, and the handful of range
 * operations needed by the agent capability. It does not calculate formulas,
 * implement an OOXML writer, or launch an external process.
 */
export type SpreadsheetWorkbook = Workbook
export type SpreadsheetWorksheet = Worksheet
export type SpreadsheetCell = Cell
export type SpreadsheetValue = CellValue

/**
 * Excel stores dates as serial numbers plus a date-like NumberFormat. The
 * pinned library intentionally exposes the serial on load, so the thin seam
 * restores the native Date value for callers while retaining the serial and
 * NumberFormat when the workbook is saved again.
 */
export function excelSerialToDate(serial: number, date1904 = false): Date {
  if (!Number.isFinite(serial)) throw new RangeError(`Invalid Excel date serial: ${serial}`)
  return excelToDate(serial, { epoch: date1904 ? 'mac' : 'windows' })
}

/** Convert a UTC Date to the workbook's Excel serial representation. */
export function dateToExcelSerial(value: Date, date1904 = false): number {
  if (Number.isNaN(value.getTime())) throw new RangeError('Invalid Date')
  return dateToExcel(value, { epoch: date1904 ? 'mac' : 'windows' })
}

/**
 * Detect the date/time format family without treating quoted literals or
 * bracketed conditions as date tokens. This is intentionally conservative:
 * callers can still observe the original NumberFormat if a workbook uses an
 * unusual custom format that is not recognisable here.
 */
export function isDateNumberFormat(format: string): boolean {
  let normalized = format
    .replace(/"(?:[^"]|"")*"/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\\./g, '')
    .replace(/_.?/g, '')
    .replace(/\*.?/g, '')
    .toLowerCase()
  // Excel's AM/PM marker is a time format even though it has no h token.
  if (normalized.includes('am/pm')) return true
  // Date tokens are d/m/y; h/s identify times. Avoid matching the letters in
  // arbitrary words such as "General" by requiring token boundaries.
  normalized = normalized.replace(/[a-z]+/g, (token) => token)
  return /(^|[^a-z])[dmyhs]+([^a-z]|$)/.test(normalized)
}

/** Rehydrate date-formatted numeric cells in-place after a library load. */
export function restoreDateValues(workbook: Workbook): Workbook {
  for (const sheetRef of workbook.sheets) {
    if (sheetRef.kind !== 'worksheet') continue
    for (const cell of iterCells(sheetRef.sheet)) {
      if (typeof cell.value !== 'number') continue
      const numberFormat = getCellNumberFormat(workbook, cell)
      if (!isDateNumberFormat(numberFormat)) continue
      cell.value = excelSerialToDate(cell.value, workbook.date1904)
    }
  }
  return workbook
}

/** Open and parse an xlsx file in-process. */
export async function openSpreadsheet(path: string): Promise<Workbook> {
  return restoreDateValues(await loadWorkbook(fromFile(path)))
}

/** Open an in-memory xlsx payload in-process (useful for deterministic tests). */
export async function openSpreadsheetBytes(bytes: Uint8Array): Promise<Workbook> {
  return restoreDateValues(await loadWorkbook(fromBuffer(bytes)))
}

/** Create an empty workbook and add the requested worksheet titles. */
export function createSpreadsheet(titles: readonly string[] = ['Sheet1']): Workbook {
  const workbook = createWorkbook()
  for (const title of titles) addWorksheet(workbook, title)
  return workbook
}

/** Resolve a worksheet by title, throwing a useful capability error if absent. */
export function requireWorksheet(workbook: Workbook, title: string): Worksheet {
  const worksheet = getSheet(workbook, title)
  if (!worksheet) throw new Error(`Worksheet not found: ${title}`)
  return worksheet
}

/** List workbook worksheet titles in tab order. */
export function listWorksheetTitles(workbook: Workbook): string[] {
  return sheetNames(workbook)
}

/** Read one cell by A1 coordinate. */
export function readCell(workbook: Workbook, sheetTitle: string, coordinate: string): CellValue | null {
  const cell = getCellByCoord(requireWorksheet(workbook, sheetTitle), coordinate)
  return cell?.value ?? null
}

/** Read a dense rectangular range. Empty coordinates are returned as null. */
export function readRange(workbook: Workbook, sheetTitle: string, range: string): (CellValue | null)[][] {
  return getRangeValues(requireWorksheet(workbook, sheetTitle), range)
}

/** Set one cell value by A1 coordinate. */
export function writeCell(
  workbook: Workbook,
  sheetTitle: string,
  coordinate: string,
  value: CellValue,
): Cell {
  return setCellByCoord(requireWorksheet(workbook, sheetTitle), coordinate, value)
}

/** Set a rectangular block; existing cell styles are retained by the library. */
export function writeRangeValues(
  workbook: Workbook,
  sheetTitle: string,
  range: string,
  values: ReadonlyArray<ReadonlyArray<CellValue | null | undefined>>,
): void {
  setRangeValues(requireWorksheet(workbook, sheetTitle), range, values)
}

/** Write a rectangular block from an A1 anchor and return the changed extent. */
export function writeRangeFromAnchor(
  workbook: Workbook,
  sheetTitle: string,
  startCoordinate: string,
  values: ReadonlyArray<ReadonlyArray<CellValue | undefined>>,
): { minRow: number; maxRow: number; minCol: number; maxCol: number } | undefined {
  return writeRange(requireWorksheet(workbook, sheetTitle), startCoordinate, values)
}

/** Write a formula and optional cached value without evaluating it locally. */
export function writeFormula(
  workbook: Workbook,
  sheetTitle: string,
  coordinate: string,
  formula: string,
  cachedValue?: number | string | boolean,
): Cell {
  const worksheet = requireWorksheet(workbook, sheetTitle)
  const cell = getCellByCoord(worksheet, coordinate) ?? setCellByCoord(worksheet, coordinate, null)
  const canonicalFormula = formula.startsWith('=') ? formula : `=${formula}`
  if (cachedValue === undefined) setFormula(cell, canonicalFormula)
  else setFormula(cell, canonicalFormula, { cachedValue })
  return cell
}

/** Apply one or more style axes to a cell. */
export function styleCell(
  workbook: Workbook,
  sheetTitle: string,
  coordinate: string,
  style: {
    font?: Font
    fill?: Fill
    border?: Border
    alignment?: Alignment
    numberFormat?: string
  },
): void {
  const worksheet = requireWorksheet(workbook, sheetTitle)
  const cell = getCellByCoord(worksheet, coordinate) ?? setCellByCoord(worksheet, coordinate, null)
  setCellStyle(workbook, cell, style)
}

/** Read the four style axes and number format for a cell. */
export function readCellStyle(workbook: Workbook, sheetTitle: string, coordinate: string): {
  font: Font
  fill: Fill
  border: Border
  alignment: Alignment
  numberFormat: string
} | undefined {
  const cell = getCellByCoord(requireWorksheet(workbook, sheetTitle), coordinate)
  if (!cell) return undefined
  return {
    font: getCellFont(workbook, cell),
    fill: getCellFill(workbook, cell),
    border: getCellBorder(workbook, cell),
    alignment: getCellAlignment(workbook, cell),
    numberFormat: getCellNumberFormat(workbook, cell),
  }
}

/** Set a column width while retaining all other worksheet metadata. */
export function setSpreadsheetColumnWidth(
  workbook: Workbook,
  sheetTitle: string,
  column: number,
  width: number,
): void {
  setColumnWidth(requireWorksheet(workbook, sheetTitle), column, width)
}

/** Set a row height while retaining all other worksheet metadata. */
export function setSpreadsheetRowHeight(
  workbook: Workbook,
  sheetTitle: string,
  row: number,
  height: number,
): void {
  setRowHeight(requireWorksheet(workbook, sheetTitle), row, height)
}

/** Serialize and save a workbook through Node's in-process filesystem API. */
export async function saveSpreadsheet(workbook: Workbook, path: string): Promise<{ bytes: number }> {
  const bytes = await serializeSpreadsheet(workbook)
  await writeFile(path, bytes)
  return { bytes: bytes.byteLength }
}

/** Serialize through the commodity writer without opening a filesystem path. */
export async function serializeSpreadsheet(workbook: Workbook): Promise<Uint8Array> {
  return workbookToBytes(workbook)
}

/** Read raw bytes for an independent hash/preservation assertion. */
export async function readSpreadsheetBytes(path: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(path))
}
