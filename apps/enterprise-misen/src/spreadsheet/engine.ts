import { readFile } from 'node:fs/promises'

/**
 * Misen's spreadsheet source of truth is OfficeCLI. This module keeps the
 * small normalized read model stable for Agent tools, Acceptance, and studies.
 */
export {
  OfficeCliSpreadsheet,
  getCellByCoord,
  isFormulaValue,
  iterCells,
  listWorksheetTitles,
  officeCli,
  openSpreadsheetBytes,
  readCell,
  readRange,
  requireWorksheet,
  titles,
  values,
  type OfficeCliBatchItem,
  type SpreadsheetCell,
  type SpreadsheetFormula,
  type SpreadsheetLiteral,
  type SpreadsheetValue,
  type SpreadsheetWorkbook,
  type SpreadsheetWorksheet,
} from './officecli.js'

export async function readSpreadsheetBytes(path: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(path))
}
