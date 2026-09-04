import { externalWorkbookSurfaces, inspectOpenXmlWorkbook } from '../spreadsheet/openxml.js'
import { safeOfficeFormula } from './office-denylist.js'

/**
 * Formula boundary (design 8th edition, Issue #120).
 *
 * The boundary is "no route out of the workbook", not "only a handful of functions".
 * Every function OfficeCLI can evaluate is allowed unless it can reach the network,
 * the host, another workbook, or build such a reference from a string at runtime.
 * Cross-sheet references (Data!A1, '7月'!B2), defined names, array constants and
 * volatile functions (TODAY, NOW, RAND) are ordinary spreadsheet work and pass.
 */
export function safeFormula(value: string): string {
  return safeOfficeFormula(value)
}

/** Independent OOXML inspection rejects carried links and unsafe formulas. */
export function validateDeliverable(bytes: Uint8Array): void {
  const snapshot = inspectOpenXmlWorkbook(bytes)
  const external = externalWorkbookSurfaces(snapshot)
  if (external.length > 0) throw new Error('external workbook relationship is not allowed: ' + external[0])
  for (const sheet of snapshot.sheets) {
    for (const [coordinate, formula] of Object.entries(sheet.formulas)) {
      try {
        safeFormula(formula)
      } catch (error) {
        throw new Error('unsafe formula at ' + sheet.name + '!' + coordinate + ': ' + (error instanceof Error ? error.message : String(error)))
      }
    }
  }
}
