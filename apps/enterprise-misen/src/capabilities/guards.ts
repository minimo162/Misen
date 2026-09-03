import { externalWorkbookSurfaces, inspectOpenXmlWorkbook } from '../spreadsheet/openxml.js'

const allowed = new Set(['ABS', 'AND', 'AVERAGE', 'COUNT', 'COUNTA', 'IF', 'MAX', 'MIN', 'NOT', 'OR', 'ROUND', 'ROUNDDOWN', 'ROUNDUP', 'SUM'])

export function safeFormula(value: string): string {
  const formula = value.startsWith('=') ? value : '=' + value
  if (formula.length > 8192 || /[\0\r\n\[\]{}!|]/u.test(formula) || /\b(?:https?|ftp|file):/iu.test(formula)) throw new Error('formula contains unsafe external or control reference')
  const code = formula.replace(/"(?:[^"]|"")*"/gu, match => ' '.repeat(match.length))
  for (const match of code.matchAll(/\b([A-Z_][A-Z0-9_.]*)\s*\(/giu)) {
    const name = match[1]!.toUpperCase()
    if (!allowed.has(name)) throw new Error('formula function ' + name + ' is not allowed')
  }
  for (const match of code.matchAll(/\b([A-Z_][A-Z0-9_.]*)\b/giu)) {
    const name = match[1]!.toUpperCase()
    if (allowed.has(name) || name === 'TRUE' || name === 'FALSE' || /^[A-Z]{1,3}\d+$/u.test(name)) continue
    throw new Error('formula name ' + name + ' is not allowed')
  }
  return formula
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
