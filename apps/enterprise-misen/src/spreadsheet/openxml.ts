import { createHash } from 'node:crypto'
import { posix } from 'node:path'
import { unzipSync } from 'fflate'
import { XMLParser } from 'fast-xml-parser'
import { rangeBoundaries, splitCoordinate } from './range.js'

const MAX_PACKAGE_BYTES = 64 * 1024 * 1024
const MAX_UNCOMPRESSED_BYTES = 256 * 1024 * 1024
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  processEntities: false,
  removeNSPrefix: true,
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: false,
})

type XmlRecord = Record<string, any>
const array = <T>(value: T | readonly T[] | undefined): T[] => value === undefined ? [] : Array.isArray(value) ? [...value] as T[] : [value as T]
const text = (value: unknown): string => typeof value === 'string' || typeof value === 'number' ? String(value) : value && typeof value === 'object' && typeof (value as XmlRecord)['#text'] !== 'undefined' ? String((value as XmlRecord)['#text']) : ''
const sha256 = (bytes: Uint8Array | undefined): string => createHash('sha256').update(bytes ?? new Uint8Array()).digest('hex')

export interface OpenXmlRelationship {
  readonly source: string
  readonly id: string
  readonly type: string
  readonly target: string
  readonly targetMode?: string
}

export interface OpenXmlSheetSnapshot {
  readonly name: string
  readonly id: string
  readonly part: string
  readonly cellStyles: Readonly<Record<string, string>>
  readonly formulas: Readonly<Record<string, string>>
  readonly rows: readonly Readonly<Record<string, string>>[]
  readonly columns: readonly Readonly<Record<string, string>>[]
  readonly mergedCells: readonly string[]
}

export interface OpenXmlWorkbookSnapshot {
  readonly entries: readonly string[]
  readonly relationships: readonly OpenXmlRelationship[]
  readonly sheets: readonly OpenXmlSheetSnapshot[]
  readonly stylesSha256: string
}

function parseXml(entries: Readonly<Record<string, Uint8Array>>, name: string): XmlRecord {
  const bytes = entries[name]
  if (!bytes) throw new Error('required OpenXML part is missing: ' + name)
  try {
    return parser.parse(Buffer.from(bytes).toString('utf8')) as XmlRecord
  } catch (error) {
    throw new Error('malformed OpenXML part ' + name + ': ' + (error instanceof Error ? error.message : String(error)))
  }
}

function unzip(bytes: Uint8Array): Readonly<Record<string, Uint8Array>> {
  if (bytes.byteLength < 22 || bytes.byteLength > MAX_PACKAGE_BYTES) throw new Error('xlsx package size is outside the allowed bound')
  let expanded = 0
  try {
    return unzipSync(bytes, {
      filter(file) {
        expanded += file.originalSize
        if (expanded > MAX_UNCOMPRESSED_BYTES) throw new Error('xlsx expanded size exceeds the allowed bound')
        return true
      },
    })
  } catch (error) {
    throw new Error('invalid xlsx ZIP package: ' + (error instanceof Error ? error.message : String(error)))
  }
}

function relationshipSource(name: string): string {
  const directory = posix.dirname(name)
  const base = posix.basename(name, '.rels')
  if (name === '_rels/.rels') return ''
  return posix.normalize(posix.join(posix.dirname(directory), base))
}

function relationships(entries: Readonly<Record<string, Uint8Array>>): OpenXmlRelationship[] {
  const result: OpenXmlRelationship[] = []
  for (const name of Object.keys(entries).filter(value => /(?:^|\/)_rels\/[^/]+\.rels$/u.test(value)).sort()) {
    const source = relationshipSource(name)
    const root = parseXml(entries, name).Relationships
    for (const item of array<XmlRecord>(root?.Relationship)) {
      result.push({
        source,
        id: String(item['@_Id'] ?? ''),
        type: String(item['@_Type'] ?? ''),
        target: String(item['@_Target'] ?? ''),
        ...(item['@_TargetMode'] === undefined ? {} : { targetMode: String(item['@_TargetMode']) }),
      })
    }
  }
  return result
}

function targetPart(source: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1)
  return posix.normalize(posix.join(posix.dirname(source), target))
}

function sheetSnapshot(entries: Readonly<Record<string, Uint8Array>>, name: string, id: string, part: string): OpenXmlSheetSnapshot {
  const worksheet = parseXml(entries, part).worksheet
  if (!worksheet || typeof worksheet !== 'object') throw new Error('invalid worksheet part: ' + part)
  const cellStyles: Record<string, string> = {}
  const formulas: Record<string, string> = {}
  const rows: Readonly<Record<string, string>>[] = []
  for (const row of array<XmlRecord>(worksheet.sheetData?.row)) {
    const attrs = Object.fromEntries(Object.entries(row).filter(([key]) => key.startsWith('@_')).map(([key, value]) => [key.slice(2), String(value)]))
    rows.push(attrs)
    for (const cell of array<XmlRecord>(row.c)) {
      const coordinate = String(cell['@_r'] ?? '').toUpperCase()
      if (!coordinate) continue
      cellStyles[coordinate] = String(cell['@_s'] ?? '0')
      const formula = text(cell.f)
      if (formula) formulas[coordinate] = formula.startsWith('=') ? formula : '=' + formula
    }
  }
  const columns = array<XmlRecord>(worksheet.cols?.col).map(column => Object.fromEntries(Object.entries(column).filter(([key]) => key.startsWith('@_')).map(([key, value]) => [key.slice(2), String(value)])))
  const mergedCells = array<XmlRecord>(worksheet.mergeCells?.mergeCell).map(item => String(item['@_ref'] ?? '')).filter(Boolean).sort()
  return { name, id, part, cellStyles, formulas, rows, columns, mergedCells }
}

export function inspectOpenXmlWorkbook(bytes: Uint8Array): OpenXmlWorkbookSnapshot {
  const entries = unzip(bytes)
  parseXml(entries, '[Content_Types].xml')
  const rels = relationships(entries)
  const workbook = parseXml(entries, 'xl/workbook.xml').workbook
  if (!workbook || typeof workbook !== 'object') throw new Error('invalid xl/workbook.xml')
  const workbookRels = rels.filter(item => item.source === 'xl/workbook.xml')
  const sheets = array<XmlRecord>(workbook.sheets?.sheet).map(item => {
    const name = String(item['@_name'] ?? '')
    const id = String(item['@_r:id'] ?? item['@_id'] ?? '')
    const relationship = workbookRels.find(candidate => candidate.id === id)
    if (!name || !id || !relationship) throw new Error('workbook sheet relationship is incomplete')
    return sheetSnapshot(entries, name, id, targetPart('xl/workbook.xml', relationship.target))
  })
  if (sheets.length === 0) throw new Error('xlsx workbook has no worksheets')
  return {
    entries: Object.keys(entries).sort(),
    relationships: rels,
    sheets,
    stylesSha256: sha256(entries['xl/styles.xml']),
  }
}

export function externalWorkbookSurfaces(snapshot: OpenXmlWorkbookSnapshot): string[] {
  const result = snapshot.entries.filter(name => /^xl\/(?:externalLinks\/|connections\.xml$|queryTables\/)/iu.test(name))
  for (const relationship of snapshot.relationships) {
    const target = relationship.target.trim()
    if (
      relationship.targetMode?.toLowerCase() === 'external'
      || /(external|connection|querytable)/iu.test(relationship.type)
      || /^[a-z][a-z0-9+.-]*:/iu.test(target)
      || /^(?:\\\\|\/\/)/u.test(target)
      || /^[a-z]:[\\/]/iu.test(target)
    ) result.push(relationship.source + ' -> ' + target)
  }
  return [...new Set(result)].sort()
}

export function preservationSnapshot(snapshot: OpenXmlWorkbookSnapshot, sheetName: string, range: string): unknown {
  const sheet = snapshot.sheets.find(candidate => candidate.name === sheetName)
  if (!sheet) throw new Error('OpenXML sheet not found: ' + sheetName)
  const bounds = rangeBoundaries(range)
  const within = (coordinate: string) => {
    const cell = splitCoordinate(coordinate)
    return cell.row >= bounds.minRow && cell.row <= bounds.maxRow && cell.col >= bounds.minCol && cell.col <= bounds.maxCol
  }
  return {
    sheet: { name: sheet.name, id: sheet.id, part: sheet.part },
    stylesSha256: snapshot.stylesSha256,
    cellStyles: Object.fromEntries(Object.entries(sheet.cellStyles).filter(([coordinate]) => within(coordinate)).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)),
    rows: sheet.rows.filter(row => {
      const number = Number(row.r)
      return number >= bounds.minRow && number <= bounds.maxRow
    }),
    columns: sheet.columns,
    mergedCells: sheet.mergedCells,
  }
}
