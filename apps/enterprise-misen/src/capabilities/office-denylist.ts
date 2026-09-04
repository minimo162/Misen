/**
 * The single policy source for OfficeCLI verbs, elements, and property values.
 * Keep this list data-only enough for tests to enumerate every denied item.
 */
export const DENIED_OFFICE_VERBS = Object.freeze([
  'raw', 'raw-set', 'add-part', 'refresh', 'watch', 'unwatch', 'open', 'close',
  'save', 'dump', 'merge', 'plugins', 'mcp', 'skills', 'install',
] as const)

export const DENIED_OFFICE_ELEMENTS = Object.freeze([
  'ole', 'hyperlink', 'picture', 'media', 'model3d', 'field', 'fieldchar', 'instrtext', 'raw',
] as const)

export const DENIED_OFFICE_PROPERTY_RULES = Object.freeze([
  'unsafe-formula', 'url', 'unc', 'external-workbook', 'external-data-source',
] as const)

export const DENIED_FORMULA_FUNCTIONS = Object.freeze([
  'WEBSERVICE', 'FILTERXML', 'ENCODEURL', 'HYPERLINK', 'RTD',
  'CUBEVALUE', 'CUBEMEMBER', 'CUBESET', 'CUBESETCOUNT', 'CUBERANKEDMEMBER', 'CUBEMEMBERPROPERTY', 'CUBEKPIMEMBER',
  'IMPORTDATA', 'IMPORTXML', 'IMPORTHTML', 'IMPORTRANGE', 'IMPORTFEED', 'IMAGE',
  'CALL', 'REGISTER', 'REGISTER.ID', 'EXEC', 'EVALUATE', 'RUN', 'SEND.KEYS', 'DDE',
  'INDIRECT',
] as const)

const deniedVerbs = new Set<string>(DENIED_OFFICE_VERBS)
const deniedElements = new Set<string>(DENIED_OFFICE_ELEMENTS)
const deniedFunctions = new Set<string>(DENIED_FORMULA_FUNCTIONS)
const elementAliases = new Map<string, string>([['image', 'picture'], ['3dmodel', 'model3d'], ['embeddedobject', 'ole']])
const CELL_REF = /^\$?[A-Z]{1,3}\$?\d{1,7}$/u
const COLUMN_RANGE = /^\$?[A-Z]{1,3}$/u
const ROW_RANGE = /^\$?\d{1,7}$/u
const FUNCTION_PREFIX = /^(?:_XLFN\.|_XLWS\.|_XLPM\.)+/u
const EXTERNAL_SOURCE_KEYS = /^(?:connection(?:id|string)?|external(?:data|source)?|datasource|sourcefile|sourceurl)$/iu

function normalized(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_-]+/gu, '')
}

function bareFormulaName(name: string): string {
  return name.toUpperCase().replace(FUNCTION_PREFIX, '')
}

export function assertAllowedOfficeVerb(value: string): void {
  if (deniedVerbs.has(value.trim().toLowerCase())) throw new Error(`OfficeCLI verb ${value} is not allowed`)
}

export function assertAllowedOfficeElement(value: string | undefined): void {
  if (value === undefined) return
  const name = normalized(value)
  const canonical = elementAliases.get(name) ?? name
  if (deniedElements.has(canonical)) throw new Error(`OfficeCLI element ${value} is not allowed`)
}

/** Formula policy from Issue #120, colocated with the other Office deny lists. */
export function safeOfficeFormula(value: string): string {
  const formula = value.startsWith('=') ? value : '=' + value
  if (formula.length > 8192) throw new Error('formula is too long')
  if (/[\0\r\n|]/u.test(formula)) throw new Error('formula contains a control or DDE character')
  if (/[\[\]]/u.test(formula)) throw new Error('formula contains an external workbook reference')
  if (/(?:https?|ftp|file|smb|mailto):/iu.test(formula)) throw new Error('formula contains a URL')
  const code = formula
    .replace(/"(?:[^"]|"")*"/gu, match => ' '.repeat(match.length))
    .replace(/'(?:[^']|'')*'/gu, match => ' '.repeat(match.length))
  for (const match of code.matchAll(/\b([A-Z_][A-Z0-9_.]*)\s*\(/giu)) {
    const name = bareFormulaName(match[1]!)
    if (deniedFunctions.has(name)) throw new Error('formula function ' + name + ' is not allowed')
  }
  for (const match of code.matchAll(/\b([A-Z_][A-Z0-9_.]*)\b(?!\s*\()/giu)) {
    const raw = match[1]!
    const name = raw.toUpperCase()
    const after = code.slice(match.index! + raw.length).trimStart()
    if (after.startsWith('!') || name === 'TRUE' || name === 'FALSE') continue
    if (CELL_REF.test(name) || COLUMN_RANGE.test(name) || ROW_RANGE.test(name)) continue
    if (deniedFunctions.has(bareFormulaName(raw))) throw new Error('formula name ' + name + ' is not allowed')
  }
  return formula
}

function formulaBody(key: string, value: string): string | undefined {
  if (/formula/iu.test(key)) return value.includes(':=') ? value.slice(value.indexOf(':=') + 1) : value
  if (/^calculatedfield\d*$/iu.test(key) && value.includes(':=')) return value.slice(value.indexOf(':=') + 1)
  return undefined
}

export function assertSafeOfficeProperties(element: string | undefined, properties: Readonly<Record<string, string>>): void {
  const kind = element === undefined ? '' : normalized(element)
  for (const [key, value] of Object.entries(properties)) {
    const formula = formulaBody(key, value)
    if (formula !== undefined) safeOfficeFormula(formula)
    if (/(?:https?|ftp|file|smb|mailto):/iu.test(value)) throw new Error(`Office property ${key} contains a URL`)
    if (value.includes('\\\\')) throw new Error(`Office property ${key} contains a UNC path`)
    if (value.includes('[') || value.includes(']')) throw new Error(`Office property ${key} contains an external workbook reference`)
    if ((kind === 'pivottable' || kind === 'slicer' || kind === 'validation') && EXTERNAL_SOURCE_KEYS.test(key)) {
      throw new Error(`Office element ${element} contains an external data source property`)
    }
  }
}

export interface OfficePolicyItem {
  readonly command: string
  readonly type?: string
  readonly props?: Readonly<Record<string, string>> | readonly string[]
}

function propertyRecord(value: OfficePolicyItem['props']): Readonly<Record<string, string>> {
  if (value === undefined) return {}
  if (!Array.isArray(value)) return value as Readonly<Record<string, string>>
  const result: Record<string, string> = {}
  for (const entry of value) {
    const separator = entry.indexOf('=')
    if (separator <= 0) throw new Error('Office property must use key=value')
    result[entry.slice(0, separator)] = entry.slice(separator + 1)
  }
  return result
}

export function assertAllowedOfficeItem(item: OfficePolicyItem): void {
  assertAllowedOfficeVerb(item.command)
  assertAllowedOfficeElement(item.type)
  assertSafeOfficeProperties(item.type, propertyRecord(item.props))
}
