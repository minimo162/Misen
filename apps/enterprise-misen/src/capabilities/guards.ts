import { externalWorkbookSurfaces, inspectOpenXmlWorkbook } from '../spreadsheet/openxml.js'

/**
 * Formula boundary (design 8th edition, Issue #120).
 *
 * The boundary is "no route out of the workbook", not "only a handful of functions".
 * Every function OfficeCLI can evaluate is allowed unless it can reach the network,
 * the host, another workbook, or build such a reference from a string at runtime.
 * Cross-sheet references (Data!A1, '7月'!B2), defined names, array constants and
 * volatile functions (TODAY, NOW, RAND) are ordinary spreadsheet work and pass.
 */
const DENIED_FUNCTIONS = new Set([
  // network / external data
  'WEBSERVICE', 'FILTERXML', 'ENCODEURL', 'HYPERLINK', 'RTD',
  'CUBEVALUE', 'CUBEMEMBER', 'CUBESET', 'CUBESETCOUNT', 'CUBERANKEDMEMBER', 'CUBEMEMBERPROPERTY', 'CUBEKPIMEMBER',
  'IMPORTDATA', 'IMPORTXML', 'IMPORTHTML', 'IMPORTRANGE', 'IMPORTFEED', 'IMAGE',
  // host / macro / legacy execution surfaces
  'CALL', 'REGISTER', 'REGISTER.ID', 'EXEC', 'EVALUATE', 'RUN', 'SEND.KEYS', 'DDE',
  // builds a reference from text at runtime, so the static checks below cannot see it
  'INDIRECT',
])

const CELL_REF = /^\$?[A-Z]{1,3}\$?\d{1,7}$/u
const COLUMN_RANGE = /^\$?[A-Z]{1,3}$/u
const ROW_RANGE = /^\$?\d{1,7}$/u
const FUNCTION_PREFIX = /^(?:_XLFN\.|_XLWS\.|_XLPM\.)+/u

function bareName(name: string): string {
  return name.toUpperCase().replace(FUNCTION_PREFIX, '')
}

export function safeFormula(value: string): string {
  const formula = value.startsWith('=') ? value : '=' + value
  if (formula.length > 8192) throw new Error('formula is too long')
  // Control characters, DDE pipes, and external workbook brackets never belong in a deliverable formula.
  if (/[\0\r\n|]/u.test(formula)) throw new Error('formula contains a control or DDE character')
  if (/[\[\]]/u.test(formula)) throw new Error('formula contains an external workbook reference')
  if (/\b(?:https?|ftp|file|smb|mailto):/iu.test(formula)) throw new Error('formula contains a URL')
  // Blank out string literals and quoted sheet names so their contents are not read as names.
  const code = formula
    .replace(/"(?:[^"]|"")*"/gu, match => ' '.repeat(match.length))
    .replace(/'(?:[^']|'')*'/gu, match => ' '.repeat(match.length))
  for (const match of code.matchAll(/\b([A-Z_][A-Z0-9_.]*)\s*\(/giu)) {
    const name = bareName(match[1]!)
    if (DENIED_FUNCTIONS.has(name)) throw new Error('formula function ' + name + ' is not allowed')
  }
  for (const match of code.matchAll(/\b([A-Z_][A-Z0-9_.]*)\b(?!\s*\()/giu)) {
    const raw = match[1]!
    const name = raw.toUpperCase()
    const after = code.slice(match.index! + raw.length).trimStart()
    if (after.startsWith('!')) continue // sheet name
    if (name === 'TRUE' || name === 'FALSE') continue
    if (CELL_REF.test(name) || COLUMN_RANGE.test(name) || ROW_RANGE.test(name)) continue
    // Defined names are allowed; a name that resolves to an external link is caught by
    // validateDeliverable through the workbook's relationships, not by the text here.
    if (DENIED_FUNCTIONS.has(bareName(raw))) throw new Error('formula name ' + name + ' is not allowed')
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
