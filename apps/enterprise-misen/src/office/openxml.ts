import { createHash } from 'node:crypto'
import { posix } from 'node:path'
import { unzipSync } from 'fflate'
import { XMLParser, XMLValidator } from 'fast-xml-parser'

export type OfficeDocumentKind = 'docx' | 'pptx'

export interface OfficePackageRelationship {
  readonly source: string
  readonly type: string
  readonly target: string
  readonly targetMode?: string
}

export interface OfficePackageSnapshot {
  readonly kind: OfficeDocumentKind
  readonly entries: readonly string[]
  readonly relationships: readonly OfficePackageRelationship[]
  readonly text: readonly string[]
  readonly preservation: Readonly<Record<string, string>>
}

const MAX_PACKAGE_BYTES = 64 * 1024 * 1024
const MAX_UNCOMPRESSED_BYTES = 256 * 1024 * 1024
const MAX_PACKAGE_ENTRIES = 10_000
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
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

function unzip(bytes: Uint8Array): Readonly<Record<string, Uint8Array>> {
  if (bytes.byteLength < 22 || bytes.byteLength > MAX_PACKAGE_BYTES) throw new Error('Office package size is outside the allowed bound')
  let expanded = 0
  let entries: Readonly<Record<string, Uint8Array>>
  try {
    entries = unzipSync(bytes, {
      filter(file) {
        expanded += file.originalSize
        if (expanded > MAX_UNCOMPRESSED_BYTES) throw new Error('expanded size exceeds the allowed bound')
        return true
      },
    })
  } catch (error) {
    throw new Error('invalid Office ZIP package: ' + (error instanceof Error ? error.message : String(error)))
  }
  const names = Object.keys(entries)
  if (names.length > MAX_PACKAGE_ENTRIES) throw new Error('Office package entry count exceeds the allowed bound')
  for (const name of names) {
    if (!name || name.includes('\\') || name.startsWith('/') || name.split('/').some(segment => segment === '..')) {
      throw new Error('Office package contains an invalid part name')
    }
  }
  return entries
}

function parseXml(entries: Readonly<Record<string, Uint8Array>>, name: string): XmlRecord {
  const bytes = entries[name]
  if (!bytes) throw new Error('required OpenXML part is missing: ' + name)
  try {
    const xml = Buffer.from(bytes).toString('utf8')
    return parser.parse(xml) as XmlRecord
  } catch (error) {
    throw new Error('malformed OpenXML part ' + name + ': ' + (error instanceof Error ? error.message : String(error)))
  }
}

function validateXmlPart(entries: Readonly<Record<string, Uint8Array>>, name: string): void {
  const validation = XMLValidator.validate(Buffer.from(entries[name]!).toString('utf8'))
  if (validation !== true) throw new Error('malformed OpenXML part ' + name + ': ' + validation.err.msg)
}

function resolvedRelationshipTarget(relationship: OfficePackageRelationship, entries: Readonly<Record<string, Uint8Array>>): string {
  let target: string
  try {
    target = decodeURIComponent(relationship.target)
  } catch {
    throw new Error('Office relationship contains malformed escaping')
  }
  if (target.includes('\\')) throw new Error('Office relationship contains an invalid target')
  const relative = target.replace(/^\/+/, '')
  const bases = relationship.source ? [posix.dirname(relationship.source), '.'] : ['.']
  const candidates = bases.map(base => posix.normalize(posix.join(base, relative)))
    .filter(resolved => resolved && resolved !== '..' && !resolved.startsWith('../') && !posix.isAbsolute(resolved))
  if (candidates.length === 0) {
    throw new Error('Office relationship escapes the package namespace')
  }
  return candidates.find(candidate => entries[candidate]) ?? candidates[0]!
}

function relationshipSource(name: string): string {
  if (name === '_rels/.rels') return ''
  const directory = posix.dirname(name)
  return posix.normalize(posix.join(posix.dirname(directory), posix.basename(name, '.rels')))
}

function relationships(entries: Readonly<Record<string, Uint8Array>>): OfficePackageRelationship[] {
  const result: OfficePackageRelationship[] = []
  for (const name of Object.keys(entries).filter(value => value === '_rels/.rels' || /(?:^|\/)_rels\/[^/]+\.rels$/u.test(value)).sort()) {
    const source = relationshipSource(name)
    const root = parseXml(entries, name).Relationships
    for (const item of array<XmlRecord>(root?.Relationship)) {
      result.push({
        source,
        type: String(item['@_Type'] ?? ''),
        target: String(item['@_Target'] ?? ''),
        ...(item['@_TargetMode'] === undefined ? {} : { targetMode: String(item['@_TargetMode']) }),
      })
    }
  }
  return result
}

function collectText(value: unknown, key: string | undefined, output: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectText(item, key, output)
    return
  }
  if (!value || typeof value !== 'object') {
    if (key === 't' && (typeof value === 'string' || typeof value === 'number')) output.push(String(value))
    return
  }
  if (key === 't') {
    const text = (value as XmlRecord)['#text']
    if (typeof text === 'string' || typeof text === 'number') output.push(String(text))
    return
  }
  for (const [childKey, child] of Object.entries(value as XmlRecord)) collectText(child, childKey, output)
}

function preservation(entries: Readonly<Record<string, Uint8Array>>, kind: OfficeDocumentKind): Readonly<Record<string, string>> {
  const keep = kind === 'docx'
    ? /^(?:word\/(?:styles|settings|numbering|fontTable)\.xml|word\/theme\/[^/]+\.xml)$/u
    : /^ppt\/(?:slideMasters|slideLayouts|theme)\/[^/]+\.xml$/u
  return Object.fromEntries(Object.keys(entries).filter(name => keep.test(name)).sort().map(name => [name, sha256(entries[name]!)]))
}

export function inspectOfficePackage(bytes: Uint8Array, kind: OfficeDocumentKind): OfficePackageSnapshot {
  const entries = unzip(bytes)
  for (const name of Object.keys(entries).filter(value => /\.(?:xml|rels)$/iu.test(value))) validateXmlPart(entries, name)
  const mainPart = kind === 'docx' ? 'word/document.xml' : 'ppt/presentation.xml'
  const expectedType = kind === 'docx'
    ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'
    : 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml'
  const contentTypes = parseXml(entries, '[Content_Types].xml').Types
  const overrides = array<XmlRecord>(contentTypes?.Override)
  const defaults = array<XmlRecord>(contentTypes?.Default)
  const mainTypeDeclared = overrides.some(item => String(item['@_PartName'] ?? '').replace(/^\//u, '') === mainPart && String(item['@_ContentType'] ?? '') === expectedType)
    || defaults.some(item => String(item['@_Extension'] ?? '').toLowerCase() === mainPart.slice(mainPart.lastIndexOf('.') + 1) && String(item['@_ContentType'] ?? '') === expectedType)
  if (!entries[mainPart] || !mainTypeDeclared) {
    throw new Error(`Office package is not a ${kind} document`)
  }
  const rels = relationships(entries)
  if (!rels.some(item => item.source === '' && item.type.endsWith('/officeDocument') && item.target.replace(/^\//u, '') === mainPart)) throw new Error('Office package root relationship is incomplete')
  const unsafeEntry = Object.keys(entries).find(name => /(?:vbaProject\.bin$|\/(?:embeddings|activeX)\/)/iu.test(name))
  if (unsafeEntry) throw new Error('active or embedded Office content is not allowed: ' + unsafeEntry)
  const unsafeRelationship = rels.find(item => !item.type.toLowerCase().endsWith('/hyperlink') && (
    item.targetMode?.toLowerCase() === 'external'
    || /\/(?:oleObject|package|attachedTemplate)$/iu.test(item.type)
    || /^[a-z][a-z0-9+.-]*:/iu.test(item.target)
    || /^(?:\\\\|\/\/|[a-z]:[\\/])/iu.test(item.target)
  ))
  if (unsafeRelationship) throw new Error('external Office relationship is not allowed: ' + unsafeRelationship.target)
  for (const relationship of rels.filter(item => !item.type.toLowerCase().endsWith('/hyperlink'))) {
    const target = resolvedRelationshipTarget(relationship, entries)
    if (!entries[target]) throw new Error('Office relationship target is missing: ' + target)
  }
  const text: string[] = []
  const textParts = Object.keys(entries).filter(name => kind === 'docx'
    ? /^word\/(?:document|header\d+|footer\d+|footnotes|endnotes|comments)\.xml$/u.test(name)
    : /^ppt\/(?:slides\/slide\d+|notesSlides\/notesSlide\d+)\.xml$/u.test(name))
  for (const name of textParts.sort()) collectText(parseXml(entries, name), undefined, text)
  return { kind, entries: Object.keys(entries).sort(), relationships: rels, text, preservation: preservation(entries, kind) }
}

export function validateOfficePackage(bytes: Uint8Array, kind: OfficeDocumentKind): void {
  inspectOfficePackage(bytes, kind)
}
