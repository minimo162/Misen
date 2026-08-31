import { strict as assert } from 'node:assert'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { performance } from 'node:perf_hooks'

import { fromFile } from '@office-kit/xlsx/node'
import { loadWorkbook } from '@office-kit/xlsx/io'
import { getCellByCoord } from '@office-kit/xlsx/worksheet'
import { getCellNumberFormat, rgbColor } from '@office-kit/xlsx/styles'
import { getFormulaText, isFormulaValue } from '@office-kit/xlsx/cell'
import {
  createSpreadsheet,
  dateToExcelSerial,
  listWorksheetTitles,
  openSpreadsheet,
  readCell,
  readCellStyle,
  readRange,
  readSpreadsheetBytes,
  requireWorksheet,
  saveSpreadsheet,
  setSpreadsheetColumnWidth,
  setSpreadsheetRowHeight,
  styleCell,
  writeCell,
  writeFormula,
  writeRangeFromAnchor,
  writeRangeValues,
} from '../../src/spreadsheet/engine.js'
import {
  makeAlignment,
  makeBorder,
  makeFont,
  makePatternFill,
  makeSide,
} from '@office-kit/xlsx/styles'

const FIXTURE_DATE = new Date('2024-07-31T00:00:00.000Z')

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

async function makeSyntheticFixture(directory: string): Promise<{
  inputPath: string
  inputHash: string
}> {
  const inputPath = join(directory, 'template.xlsx')
  const workbook = createSpreadsheet(['Input', 'Summary'])

  writeRangeValues(workbook, 'Input', 'A1:H3', [
    ['Metric', 'Value', 'Included', 'As of', 'Formula', undefined, undefined, 'Untouched text'],
    ['Alpha', 10.5, true, FIXTURE_DATE, undefined, undefined, undefined, 'DO NOT TOUCH'],
    ['Beta', 20, false, undefined, undefined, undefined, undefined, 9001],
  ])
  styleCell(workbook, 'Input', 'A1', {
    font: makeFont({ name: 'Arial', size: 14, bold: true, color: rgbColor('FFFFFFFF') }),
    fill: makePatternFill({ patternType: 'solid', fgColor: rgbColor('FF1F4E78') }),
    border: makeBorder({ bottom: makeSide({ style: 'thin', color: rgbColor('FFFF0000') }) }),
    alignment: makeAlignment({ horizontal: 'center', vertical: 'center', wrapText: true }),
    numberFormat: '0.00',
  })
  styleCell(workbook, 'Input', 'D2', { numberFormat: 'yyyy-mm-dd' })
  styleCell(workbook, 'Input', 'B2', { numberFormat: '#,##0.00' })
  writeFormula(workbook, 'Input', 'E2', '=SUM(B2:B3)', 30.5)
  setSpreadsheetColumnWidth(workbook, 'Input', 1, 24)
  setSpreadsheetRowHeight(workbook, 'Input', 1, 30)

  // A second sheet verifies sheet discovery while retaining a separate
  // untouched area that the edit operation must not visit.
  writeCell(workbook, 'Summary', 'A1', 'Summary placeholder')

  await saveSpreadsheet(workbook, inputPath)
  return { inputPath, inputHash: sha256(await readSpreadsheetBytes(inputPath)) }
}

test('Phase B: commodity xlsx opens, edits, preserves, and reopens a synthetic template', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'misen-phase-b-'))
  try {
    const { inputPath, inputHash } = await makeSyntheticFixture(directory)
    const outputPath = join(directory, 'output.xlsx')

    const opened = await openSpreadsheet(inputPath)
    assert.deepEqual(listWorksheetTitles(opened), ['Input', 'Summary'])
    assert.equal(readCell(opened, 'Input', 'A2'), 'Alpha')
    assert.equal(readCell(opened, 'Input', 'C2'), true)
    assert.equal(readCell(opened, 'Input', 'B3'), 20)

    const typedDate = readCell(opened, 'Input', 'D2')
    assert.ok(typedDate instanceof Date, 'date NumberFormat is restored as a Date by the thin seam')
    assert.equal(typedDate?.toISOString(), FIXTURE_DATE.toISOString())

    const initialRange = readRange(opened, 'Input', 'A2:D3')
    assert.equal(initialRange.length, 2)
    assert.equal(initialRange[0]?.[0], 'Alpha')
    assert.equal(initialRange[0]?.[1], 10.5)
    assert.equal(initialRange[0]?.[2], true)
    assert.ok(initialRange[0]?.[3] instanceof Date)
    assert.deepEqual(initialRange[1]?.slice(0, 3), ['Beta', 20, false])

    const originalFormula = readCell(opened, 'Input', 'E2')
    assert.ok(isFormulaValue(originalFormula), 'formula is exposed as the library FormulaValue')
    assert.equal(getFormulaText(getCellByCoord(requireWorksheet(opened, 'Input'), 'E2')!), '=SUM(B2:B3)')
    assert.equal(originalFormula?.cachedValue, 30.5)

    const titleStyle = readCellStyle(opened, 'Input', 'A1')
    assert.equal(titleStyle?.font.name, 'Arial')
    assert.equal(titleStyle?.font.bold, true)
    assert.equal(titleStyle?.fill.kind, 'pattern')
    assert.equal(titleStyle?.fill.patternType, 'solid')
    assert.equal(titleStyle?.fill.fgColor?.rgb, 'FF1F4E78')
    assert.equal(titleStyle?.border.bottom?.style, 'thin')
    assert.equal(titleStyle?.border.bottom?.color?.rgb, 'FFFF0000')
    assert.equal(titleStyle?.alignment.horizontal, 'center')
    assert.equal(titleStyle?.alignment.vertical, 'center')
    assert.equal(titleStyle?.alignment.wrapText, true)
    assert.equal(titleStyle?.numberFormat, '0.00')

    const inputSheet = requireWorksheet(opened, 'Input')
    assert.equal(inputSheet.columnDimensions.get(1)?.width, 24)
    assert.equal(inputSheet.rowDimensions.get(1)?.height, 30)

    // The intended mutation is a general range write. Existing B2 styling is
    // retained by office-kit/xlsx while the adjacent untouched H-column stays
    // byte/value-identical.
    writeRangeValues(opened, 'Input', 'B2:C3', [
      [11.25, false],
      [21.5, true],
    ])
    const extent = writeRangeFromAnchor(opened, 'Input', 'F2', [[1, 2], [3, 4]])
    assert.deepEqual(extent, { minRow: 2, maxRow: 3, minCol: 6, maxCol: 7 })
    writeFormula(opened, 'Input', 'E2', '=SUM(B2:B3)', 32.75)
    await saveSpreadsheet(opened, outputPath)

    const savedSize = (await stat(outputPath)).size
    assert.ok(savedSize > 1_000, `saved xlsx should be non-trivial (${savedSize} bytes)`)
    assert.ok(savedSize < 2_000_000, `synthetic xlsx should remain reasonably small (${savedSize} bytes)`)

    const reopened = await openSpreadsheet(outputPath)
    assert.deepEqual(listWorksheetTitles(reopened), ['Input', 'Summary'])
    assert.deepEqual(readRange(reopened, 'Input', 'B2:C3'), [[11.25, false], [21.5, true]])
    const updatedFormula = readCell(reopened, 'Input', 'E2')
    assert.ok(isFormulaValue(updatedFormula))
    assert.equal(updatedFormula.cachedValue, 32.75)
    assert.equal(getFormulaText(getCellByCoord(requireWorksheet(reopened, 'Input'), 'E2')!), '=SUM(B2:B3)')

    // Date semantics are observable through the public seam, while the raw
    // OOXML representation remains the expected serial + NumberFormat pair.
    const reopenedDate = readCell(reopened, 'Input', 'D2')
    assert.ok(reopenedDate instanceof Date)
    assert.equal(reopenedDate?.toISOString(), FIXTURE_DATE.toISOString())
    const rawReopened = await loadWorkbook(fromFile(outputPath))
    const rawDateCell = getCellByCoord(requireWorksheet(rawReopened, 'Input'), 'D2')!
    assert.equal(typeof rawDateCell.value, 'number')
    assert.equal(rawDateCell.value, dateToExcelSerial(FIXTURE_DATE))
    assert.equal(getCellNumberFormat(rawReopened, rawDateCell), 'yyyy-mm-dd')

    // The title style, number format, and dimensions all survive save/reopen.
    const reopenedTitleStyle = readCellStyle(reopened, 'Input', 'A1')
    assert.deepEqual(reopenedTitleStyle, titleStyle)
    assert.equal(readCellStyle(reopened, 'Input', 'B2')?.numberFormat, '#,##0.00')
    const reopenedSheet = requireWorksheet(reopened, 'Input')
    assert.equal(reopenedSheet.columnDimensions.get(1)?.width, 24)
    assert.equal(reopenedSheet.rowDimensions.get(1)?.height, 30)

    // Untouched cells remain intact and the source template was never mutated.
    assert.equal(readCell(reopened, 'Input', 'H2'), 'DO NOT TOUCH')
    assert.equal(readCell(reopened, 'Input', 'H3'), 9001)
    assert.equal(sha256(await readSpreadsheetBytes(inputPath)), inputHash)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('Phase B: office-kit preserves an independently produced tracked workbook', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'misen-phase-b-external-'))
  const inputPath = resolve(process.cwd(), '../../demo/renketsu-demo/workspace/集計台帳.xlsx')
  try {
    const inputHash = sha256(await readSpreadsheetBytes(inputPath))
    const outputPath = join(directory, 'external-roundtrip.xlsx')
    const workbook = await openSpreadsheet(inputPath)
    assert.deepEqual(listWorksheetTitles(workbook), ['確認事項', '連結台帳'])
    assert.equal(readCell(workbook, '連結台帳', 'A1'), '連結決算デモ台帳（当期入力待ち）')
    assert.equal(readCell(workbook, '連結台帳', 'A4'), 'JP01')

    const headerStyle = readCellStyle(workbook, '連結台帳', 'A3')
    const numericStyle = readCellStyle(workbook, '連結台帳', 'D4')
    const sheet = requireWorksheet(workbook, '連結台帳')
    const columnWidths = [...sheet.columnDimensions.entries()]

    writeCell(workbook, '連結台帳', 'D4', 1234.5)
    await saveSpreadsheet(workbook, outputPath)
    const reopened = await openSpreadsheet(outputPath)
    assert.deepEqual(listWorksheetTitles(reopened), ['確認事項', '連結台帳'])
    assert.equal(readCell(reopened, '連結台帳', 'D4'), 1234.5)
    assert.deepEqual(readCellStyle(reopened, '連結台帳', 'A3'), headerStyle)
    assert.deepEqual(readCellStyle(reopened, '連結台帳', 'D4'), numericStyle)
    assert.deepEqual([...requireWorksheet(reopened, '連結台帳').columnDimensions.entries()], columnWidths)
    assert.equal(readCell(reopened, '確認事項', 'A1'), '確認事項（入力担当記入欄）')
    assert.equal(sha256(await readSpreadsheetBytes(inputPath)), inputHash, 'tracked external fixture must not mutate')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('Phase B: synthetic workbook records deterministic local processing metrics', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'misen-phase-b-metrics-'))
  try {
    const { inputPath } = await makeSyntheticFixture(directory)
    const outputPath = join(directory, 'metrics-output.xlsx')
    const started = performance.now()
    const workbook = await openSpreadsheet(inputPath)
    writeRangeValues(workbook, 'Input', 'B2:B3', [[11], [22]])
    const saved = await saveSpreadsheet(workbook, outputPath)
    const elapsedMs = performance.now() - started
    const inputBytes = (await stat(inputPath)).size
    const outputBytes = (await stat(outputPath)).size

    // Keep the evidence machine-readable without asserting a brittle SLA. The
    // upper bound only catches a hung/catastrophically slow local operation.
    const metrics = { elapsedMs, inputBytes, outputBytes, bytesReportedByWriter: saved.bytes }
    assert.ok(Number.isFinite(metrics.elapsedMs) && metrics.elapsedMs < 5_000)
    assert.equal(metrics.outputBytes, metrics.bytesReportedByWriter)
    assert.ok(metrics.inputBytes > 0 && metrics.outputBytes > 0)
    assert.ok(metrics.outputBytes < 2_000_000)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
