import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { JsonValidator } from '@cyclonedx/cyclonedx-library/Validation'
import { Version } from '@cyclonedx/cyclonedx-library/Spec'

const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'))
const packages = Object.entries(lock.packages)
  .filter(([path]) => path.startsWith('node_modules/'))
  .map(([path, value]) => ({
    type: 'library',
    'bom-ref': `${path.slice('node_modules/'.length)}@${value.version}`,
    name: path.slice('node_modules/'.length),
    version: value.version,
    licenses: [{ license: { name: value.license ?? 'UNKNOWN' } }],
    properties: [
      { name: 'misen:package-lock-path', value: path },
      { name: 'misen:has-install-script', value: String(Boolean(value.hasInstallScript)) },
    ],
  }))
  .sort((a, b) => a.name.localeCompare(b.name))

const out = {
  bomFormat: 'CycloneDX',
  specVersion: '1.6',
  serialNumber: 'urn:uuid:4d697365-6e2d-4f53-8342-4f4d2d302e32',
  version: 1,
  metadata: { component: { type: 'application', name: '@misen/enterprise-runtime-poc', version: '0.2.0' } },
  components: packages,
}

const validator = new JsonValidator(Version.v1dot6)
const serialized = JSON.stringify(out, null, 2) + '\n'
const validationError = await validator.validate(serialized)
if (validationError !== null) throw new Error(`official CycloneDX 1.6 validation failed: ${String(validationError)}`)
const invalidControl = structuredClone(out)
invalidControl.components[0].type = 'invalid-control-type'
if (await validator.validate(JSON.stringify(invalidControl)) === null) throw new Error('official CycloneDX validator negative control failed')
const evidence = new URL('../evidence/', import.meta.url)
await mkdir(evidence, { recursive: true })
await writeFile(new URL('sbom.cdx.json', evidence), serialized)
console.log(`SBOM ${packages.length} resolved packages; official CycloneDX 1.6 schema PASS; negative control PASS`)
