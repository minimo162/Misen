import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { JsonValidator } from '@cyclonedx/cyclonedx-library/Validation'
import { Version } from '@cyclonedx/cyclonedx-library/Spec'
import { nodeRuntimeContract } from './node-runtime-contract.mjs'
import { officeCliRuntimeContract } from './officecli-runtime-contract.mjs'

const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'))
const packages = Object.entries(lock.packages)
  // Production-optional packages (pdfjs-dist's native canvas) are excluded from every prepared runtime by `--omit=optional`.
  .filter(([path, value]) => path.startsWith('node_modules/') && !(value.optional === true && value.dev !== true))
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
  .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)

const nodeRuntime = {
  type: 'framework',
  'bom-ref': `nodejs-host-runtime@${nodeRuntimeContract.version}-win-x64`,
  name: 'Node.js',
  version: nodeRuntimeContract.version,
  description: 'Bundled Windows x64 host runtime for Enterprise Misen; not a model-facing capability',
  hashes: [{ alg: 'SHA-256', content: nodeRuntimeContract.executableSha256 }],
  licenses: [{ license: { name: 'Node.js distribution LICENSE (MIT plus bundled third-party notices)' } }],
  externalReferences: [{ type: 'distribution', url: nodeRuntimeContract.sourceArchiveUrl }],
  properties: [
    { name: 'misen:component-role', value: 'host-runtime' },
    { name: 'misen:platform', value: 'windows' },
    { name: 'misen:architecture', value: nodeRuntimeContract.arch },
    { name: 'misen:release-name', value: nodeRuntimeContract.releaseName },
    { name: 'misen:source-release', value: nodeRuntimeContract.sourceRelease },
    { name: 'misen:source-archive', value: nodeRuntimeContract.sourceArchive },
    { name: 'misen:source-archive-sha256', value: nodeRuntimeContract.archiveSha256 },
    { name: 'misen:bundled-executable', value: nodeRuntimeContract.executable },
    { name: 'misen:bundled-license', value: nodeRuntimeContract.license },
    { name: 'misen:bundled-license-sha256', value: nodeRuntimeContract.licenseSha256 },
    { name: 'misen:resolution', value: nodeRuntimeContract.resolution },
  ],
}

const officeCliRuntime = {
  type: 'application',
  'bom-ref': `officecli@${officeCliRuntimeContract.version}-win-x64`,
  name: 'OfficeCLI',
  version: officeCliRuntimeContract.version,
  description: 'Bundled Office document process engine behind Misen typed spreadsheet, Word, and PowerPoint capabilities',
  hashes: [{ alg: 'SHA-256', content: officeCliRuntimeContract.releaseArtifactSha256 }],
  licenses: [{ license: { id: officeCliRuntimeContract.licenseName } }],
  externalReferences: [
    { type: 'vcs', url: `${officeCliRuntimeContract.repository}#${officeCliRuntimeContract.commit}` },
    { type: 'distribution', url: officeCliRuntimeContract.releaseArtifactUrl },
  ],
  properties: [
    { name: 'misen:component-role', value: 'office-engine' },
    { name: 'misen:platform', value: 'windows' },
    { name: 'misen:architecture', value: officeCliRuntimeContract.arch },
    { name: 'misen:release-tag', value: officeCliRuntimeContract.tag },
    { name: 'misen:source-commit', value: officeCliRuntimeContract.commit },
    { name: 'misen:bundled-executable', value: officeCliRuntimeContract.executable },
    { name: 'misen:bundled-license', value: officeCliRuntimeContract.license },
    { name: 'misen:bundled-license-sha256', value: officeCliRuntimeContract.licenseSha256 },
    { name: 'misen:bundled-notice', value: officeCliRuntimeContract.notice },
    { name: 'misen:bundled-notice-sha256', value: officeCliRuntimeContract.noticeSha256 },
    { name: 'misen:runtime-network-required', value: String(officeCliRuntimeContract.networkRequiredAtRuntime) },
    { name: 'misen:resolution', value: officeCliRuntimeContract.resolution },
  ],
}

const out = {
  bomFormat: 'CycloneDX',
  specVersion: '1.6',
  serialNumber: 'urn:uuid:4d697365-6e2d-4f53-8342-4f4d2d302e32',
  version: 1,
  metadata: { component: { type: 'application', name: '@misen/enterprise-runtime-poc', version: '0.2.0' } },
  components: [...packages, nodeRuntime, officeCliRuntime],
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
console.log(`SBOM ${packages.length} npm packages + bundled Node.js and OfficeCLI runtime components; official CycloneDX 1.6 schema PASS; negative control PASS`)
