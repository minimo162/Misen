import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const lockBytes = await readFile(new URL('../package-lock.json', import.meta.url))
const lock = JSON.parse(lockBytes.toString('utf8'))
const root = lock.packages['']
const occurrences = []

function packageName(path) {
  return path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length)
}

function purl(name, version) {
  return `pkg:npm/${encodeURIComponent(name).replace('%2F', '/')}@${version}`
}

for (const [path, entry] of Object.entries(lock.packages)) {
  if (path === '' || entry.dev === true) continue
  const name = packageName(path)
  const manifest = JSON.parse(await readFile(new URL(`../${path}/package.json`, import.meta.url), 'utf8'))
  const ref = purl(name, entry.version)
  const component = {
    type: 'library',
    'bom-ref': ref,
    name,
    version: entry.version,
    purl: ref,
    scope: 'required',
  }
  if (typeof manifest.license === 'string') component.licenses = [{ license: { id: manifest.license } }]
  if (typeof entry.integrity === 'string' && entry.integrity.startsWith('sha512-')) {
    component.hashes = [{ alg: 'SHA-512', content: Buffer.from(entry.integrity.slice(7), 'base64').toString('hex').toUpperCase() }]
  }
  if (typeof entry.resolved === 'string') {
    component.externalReferences = [{ type: 'distribution', url: entry.resolved }]
  }
  occurrences.push({ path, name, ref, entry, component })
}

const byName = new Map()
for (const record of occurrences) {
  const matches = byName.get(record.name) ?? []
  matches.push(record)
  byName.set(record.name, matches)
}

const byRef = new Map()
for (const occurrence of occurrences) {
  const existing = byRef.get(occurrence.ref)
  if (existing === undefined) {
    byRef.set(occurrence.ref, { ...occurrence, paths: [occurrence.path] })
    continue
  }
  existing.paths.push(occurrence.path)
}

function resolveDependency(path, name) {
  const candidates = [`${path}/node_modules/${name}`]
  let cursor = path
  for (;;) {
    const marker = cursor.lastIndexOf('/node_modules/')
    if (marker < 0) break
    cursor = cursor.slice(0, marker)
    candidates.push(`${cursor}/node_modules/${name}`)
  }
  candidates.push(`node_modules/${name}`)
  for (const candidate of candidates) {
    const entry = lock.packages[candidate]
    if (entry !== undefined && entry.dev !== true) return purl(name, entry.version)
  }
  return undefined
}

function dependencyRefs(occurrence) {
  const { path, entry } = occurrence
  const names = new Set([
    ...Object.keys(entry.dependencies ?? {}),
    ...Object.keys(entry.optionalDependencies ?? {}),
    ...Object.keys(entry.peerDependencies ?? {}),
  ])
  return [...names].flatMap(name => {
    const ref = resolveDependency(path, name)
    return ref === undefined ? [] : [ref]
  }).sort()
}

const digest = createHash('sha256').update(lockBytes).digest('hex')
const serial = `urn:uuid:${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`
const rootRef = `pkg:npm/${encodeURIComponent(root.name)}@${root.version}`
const bom = {
  bomFormat: 'CycloneDX',
  specVersion: '1.6',
  serialNumber: serial,
  version: 1,
  metadata: {
    component: {
      type: 'application',
      'bom-ref': rootRef,
      name: root.name,
      version: root.version,
      purl: rootRef,
    },
  },
  components: [...byRef.values()].map(record => record.component).sort((left, right) => left['bom-ref'].localeCompare(right['bom-ref'])),
  dependencies: [
    {
      ref: rootRef,
      dependsOn: Object.keys(root.dependencies ?? {}).flatMap(name => {
        const ref = resolveDependency('', name)
        return ref === undefined ? [] : [ref]
      }).sort(),
    },
    ...[...byRef.values()].map(record => ({
      ref: record.ref,
      dependsOn: [...new Set(record.paths.flatMap(path => dependencyRefs({ path, entry: lock.packages[path] })))].sort(),
    })),
  ].sort((left, right) => left.ref.localeCompare(right.ref)),
}

await writeFile(new URL('../evidence/sbom.cdx.json', import.meta.url), `${JSON.stringify(bom, null, 2)}\n`, 'utf8')
console.log(`Wrote complete CycloneDX SBOM with ${byRef.size} unique production package versions from ${occurrences.length} installed locations to ${join('evidence', 'sbom.cdx.json')}`)
