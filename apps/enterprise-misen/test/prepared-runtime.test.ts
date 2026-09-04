import test from 'node:test'
import { strict as assert } from 'node:assert'
import { createHash } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const archiveSha256 = '6cac9ffbca8f6a47091e4b5c772e0606049c3871cb67d900c0cedde630e545ba'
const executableSha256 = '5c976096e04e5c2c1f091938926234cc9fbebfe9787ddd149351b3b0ecc707b5'
const licenseSha256 = 'ed34dd8e3f0a78dbaf00d0444ce8e285b015b765379c2e17880455f70370f8e9'
const officeCliExecutableSha256 = '724056e5ff079c3585df79c8afc386f08ef7d5f956cf4e2723534e129aab6e80'
const officeCliLicenseSha256 = '7e282402a5a6db33995fe638bb3fe79013f9884d8f7d15a42e481c1e86aadda1'
const officeCliNoticeSha256 = '3a4715b268e148a8e9566f5e835f766f5c95c3da4d6e5ddd908806a258a2f07b'

test('distribution entrypoint and packaging scripts are explicit', async () => {
  const packageJson = JSON.parse(await readFile('package.json', 'utf8')) as { scripts: Record<string, string> }
  assert.equal(packageJson.scripts.demo, 'npm run build && node dist/src/web/server.js')
  assert.equal(packageJson.scripts['acquire:node-runtime'], 'node scripts/acquire-node-runtime.mjs')
  assert.equal(packageJson.scripts['acquire:officecli-runtime'], 'node scripts/acquire-officecli-runtime.mjs')
  assert.equal(typeof packageJson.scripts['prepare-runtime'], 'string')
  assert.equal(typeof packageJson.scripts['verify:prepared-runtime'], 'string')
  await access('dist/src/web/server.js')
  await assert.rejects(access('dist/web/server.js'), /ENOENT/u)
})

test('OfficeCLI runtime contract pins source, release, binary, and license identities', async () => {
  const module = await import(pathToFileURL(join(process.cwd(), 'scripts', 'officecli-runtime-contract.mjs')).href) as any
  const contract = module.officeCliRuntimeContract
  assert.equal(contract.repository, 'https://github.com/iOfficeAI/OfficeCLI')
  assert.equal(contract.version, '1.0.147')
  assert.equal(contract.tag, 'v1.0.147')
  assert.equal(contract.commit, 'b94f3906fd52d450c64f8e40370e376b9e15079e')
  assert.equal(contract.licenseName, 'Apache-2.0')
  assert.equal(contract.releaseArtifact, 'officecli-win-x64.exe')
  assert.equal(contract.releaseArtifactSha256, officeCliExecutableSha256)
  assert.equal(contract.licenseSha256, officeCliLicenseSha256)
  assert.equal(contract.noticeSha256, officeCliNoticeSha256)
  assert.equal(contract.externalRuntimeRequired, false)
  assert.equal(contract.networkRequiredAtRuntime, false)
  assert.equal(contract.resolution, 'bundled-only')
})

test('Node runtime contract pins the official v24.20.0 Windows x64 identities', async () => {
  const module = await import(pathToFileURL(join(process.cwd(), 'scripts', 'node-runtime-contract.mjs')).href) as any
  assert.deepEqual(module.nodeRuntimeContract, {
    version: '24.20.0',
    releaseName: 'Krypton',
    platform: 'win32',
    arch: 'x64',
    sourceArchive: 'node-v24.20.0-win-x64.zip',
    sourceRelease: 'https://nodejs.org/dist/v24.20.0/',
    sourceArchiveUrl: 'https://nodejs.org/dist/v24.20.0/node-v24.20.0-win-x64.zip',
    shasumsUrl: 'https://nodejs.org/dist/v24.20.0/SHASUMS256.txt',
    archiveSha256,
    executableSha256,
    licenseSha256,
    executable: 'runtime/node/node.exe',
    license: 'runtime/node/LICENSE',
    resolution: 'bundled-only',
    externalRuntimeRequired: false,
  })
})

test('acquisition fails closed before extraction when the official archive hash is wrong', async () => {
  const module = await import(pathToFileURL(join(process.cwd(), 'scripts', 'acquire-node-runtime.mjs')).href) as any
  const root = await mkdtemp(join(tmpdir(), 'misen-node-acquire-negative-'))
  const archive = join(root, 'node-v24.20.0-win-x64.zip')
  const shasums = join(root, 'SHASUMS256.txt')
  const output = join(root, 'output')
  try {
    await writeFile(archive, 'not the official archive', 'utf8')
    await writeFile(shasums, `${archiveSha256}  node-v24.20.0-win-x64.zip\n`, 'utf8')
    await assert.rejects(module.acquireNodeRuntime({ output, archive, shasums }), /archive SHA-256 mismatch/u)
    await assert.rejects(access(output), /ENOENT/u)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('OfficeCLI acquisition rejects a modified release executable and publishes no partial runtime', async () => {
  const module = await import(pathToFileURL(join(process.cwd(), 'scripts', 'acquire-officecli-runtime.mjs')).href) as any
  const root = await mkdtemp(join(tmpdir(), 'misen-officecli-acquire-negative-'))
  const executable = join(root, 'officecli-win-x64.exe')
  const license = join(root, 'LICENSE')
  const notice = join(root, 'NOTICE')
  const output = join(root, 'output')
  try {
    await writeFile(executable, 'modified executable', 'utf8')
    await writeFile(license, 'license', 'utf8')
    await writeFile(notice, 'notice', 'utf8')
    await assert.rejects(module.acquireOfficeCliRuntime({ output, executable, license, notice }), /executable SHA-256 mismatch/u)
    await assert.rejects(access(output), /ENOENT/u)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('prepared-runtime generator requires explicit verified Node and OfficeCLI inputs and a clean target', async () => {
  const module = await import(pathToFileURL(join(process.cwd(), 'scripts', 'prepare-runtime.mjs')).href) as any
  const root = await mkdtemp(join(tmpdir(), 'misen-prepare-contract-'))
  const output = join(root, 'output')
  try {
    await assert.rejects(module.prepareRuntime({ output }), /node-runtime/u)
    await assert.rejects(module.prepareRuntime({ output, nodeRuntime: root }), /officecli-runtime/u)
    await writeFile(join(root, 'marker.txt'), 'preserve', 'utf8')
    await assert.rejects(module.prepareRuntime({ output: root, nodeRuntime: root, officeCliRuntime: root }), /absent or empty/u)
    assert.equal(await readFile(join(root, 'marker.txt'), 'utf8'), 'preserve')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('Git metadata is informational and commit ancestry cannot allow or deny packaging', async () => {
  const prepare = await readFile(join('scripts', 'prepare-runtime.mjs'), 'utf8')
  const verify = await readFile(join('scripts', 'verify-prepared-runtime.mjs'), 'utf8')
  const declaration = await readFile(join('scripts', 'prepare-runtime.d.mts'), 'utf8')
  const combined = `${prepare}\n${verify}\n${declaration}`
  assert.doesNotMatch(combined, /merge-base|is-ancestor|--source-sha|--packaging-sha|preparedRuntimeSourceSha|productBehaviorBaselineSha|packagingSha/u)
  assert.match(prepare, /buildGitSha:\s*informationalBuildGitSha\(\)/u)
  assert.match(prepare, /gitMetadataPolicy:\s*'informational-only'/u)
})

test('hash verification requires exact equality and allows only the launcher and bundled runtimes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'misen-verify-contract-'))
  try {
    const module = await import(pathToFileURL(join(process.cwd(), 'scripts', 'verify-prepared-runtime.mjs')).href) as any
    await mkdir(join(root, 'runtime', 'node'), { recursive: true })
    await mkdir(join(root, 'runtime', 'officecli'), { recursive: true })
    await writeFile(join(root, 'run.cmd'), 'safe', 'utf8')
    await writeFile(join(root, 'runtime', 'node', 'node.exe'), 'approved path only; hash checked separately', 'utf8')
    await writeFile(join(root, 'runtime', 'node', 'LICENSE'), 'license', 'utf8')
    await writeFile(join(root, 'runtime', 'officecli', 'officecli.exe'), 'approved OfficeCLI path; hash checked separately', 'utf8')
    await writeFile(join(root, 'runtime', 'officecli', 'LICENSE'), 'license', 'utf8')
    await writeFile(join(root, 'runtime', 'officecli', 'NOTICE'), 'notice', 'utf8')
    const files = ['run.cmd', 'runtime/node/LICENSE', 'runtime/node/node.exe', 'runtime/officecli/LICENSE', 'runtime/officecli/NOTICE', 'runtime/officecli/officecli.exe']
    const lines: string[] = []
    for (const file of files) lines.push(`${createHash('sha256').update(await readFile(join(root, ...file.split('/')))).digest('hex')}  ${file}`)
    await writeFile(join(root, 'SHA256SUMS.txt'), `${lines.join('\n')}\n`, 'utf8')
    assert.equal(await module.verifyHashes(root), 6)
    assert.deepEqual(await module.findForbiddenNames(root), [])

    await writeFile(join(root, 'runtime', 'anything.exe'), 'unexpected', 'utf8')
    await assert.rejects(module.verifyHashes(root), /unlisted=runtime\/anything\.exe/u)
    assert.equal((await module.findForbiddenNames(root)).some((path: string) => path.endsWith('anything.exe')), true)
    await writeFile(join(root, 'runtime', 'node', 'npm.cmd'), 'forbidden shim', 'utf8')
    assert.equal((await module.findForbiddenNames(root)).some((path: string) => path.endsWith('npm.cmd')), true)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('launcher is an exact quoted bundled-only contract with no bare Node fallback', async () => {
  const module = await import(pathToFileURL(join(process.cwd(), 'scripts', 'verify-prepared-runtime.mjs')).href) as any
  const launcher = module.expectedLauncher() as string
  assert.match(launcher, /set "MISEN_NODE=%MISEN_ROOT%runtime\\node\\node\.exe"/u)
  assert.match(launcher, /if not exist "%MISEN_NODE%"/u)
  assert.match(launcher, /set "MISEN_OFFICECLI_PATH=%MISEN_ROOT%runtime\\officecli\\officecli\.exe"/u)
  assert.match(launcher, /if not exist "%MISEN_OFFICECLI_PATH%"/u)
  assert.match(launcher, /set "OFFICECLI_NO_AUTO_RESIDENT=1"/u)
  assert.match(launcher, /set "OFFICECLI_SKIP_UPDATE=1"/u)
  assert.match(launcher, /"%MISEN_NODE%" "%MISEN_ROOT%app\\dist\\src\\web\\server\.js" "%MISEN_WORKSPACE%"/u)
  assert.doesNotMatch(launcher, /(?:^|\r\n)node\s/iu)
  assert.doesNotMatch(launcher, /npm|npx|corepack|powershell|python/iu)
})

test('manifest verifier rejects modified Node and runtime hash disagreement', async () => {
  const module = await import(pathToFileURL(join(process.cwd(), 'scripts', 'verify-prepared-runtime.mjs')).href) as any
  const root = await mkdtemp(join(tmpdir(), 'misen-manifest-node-negative-'))
  try {
    await mkdir(join(root, 'runtime', 'node'), { recursive: true })
    await writeFile(join(root, 'runtime', 'node', 'node.exe'), 'modified', 'utf8')
    await writeFile(join(root, 'runtime', 'node', 'LICENSE'), 'license', 'utf8')
    await writeFile(join(root, 'run.cmd'), module.expectedLauncher(), 'utf8')
    const manifest = {
      schemaVersion: 5,
      applicationVersion: '0.2.0',
      buildGitSha: 'a'.repeat(40),
      gitMetadataPolicy: 'informational-only',
      launcher: 'run.cmd',
      entrypoint: 'app/dist/src/web/server.js',
      modelVisibleWorkspacePaths: ['workspace/AGENTS.md', 'workspace/.agents/skills/monthly-report/SKILL.md'],
      requiredPaths: ['runtime/node/node.exe', 'runtime/node/LICENSE', 'runtime/officecli/officecli.exe', 'runtime/officecli/LICENSE', 'runtime/officecli/NOTICE', 'workspace/AGENTS.md', 'workspace/.agents/skills/monthly-report/SKILL.md'],
      runtimePolicy: { installsAtRuntime: false, buildsAtRuntime: false, downloadsAtRuntime: false, powershellFallback: false, observerOrStudyCodeDistributed: false, officeCliAutoUpdate: false, officeCliAutoResident: false },
      node: {
        version: '24.20.0', releaseName: 'Krypton', platform: 'win32', arch: 'x64',
        sourceArchive: 'node-v24.20.0-win-x64.zip', sourceRelease: 'https://nodejs.org/dist/v24.20.0/',
        sourceArchiveUrl: 'https://nodejs.org/dist/v24.20.0/node-v24.20.0-win-x64.zip',
        shasumsUrl: 'https://nodejs.org/dist/v24.20.0/SHASUMS256.txt', archiveSha256,
        executable: 'runtime/node/node.exe', executableSha256, license: 'runtime/node/LICENSE',
        licenseSha256, resolution: 'bundled-only', externalRuntimeRequired: false,
      },
      officeCli: {
        schemaVersion: 1,
        repository: 'https://github.com/iOfficeAI/OfficeCLI', version: '1.0.147', tag: 'v1.0.147', commit: 'b94f3906fd52d450c64f8e40370e376b9e15079e',
        licenseName: 'Apache-2.0', platform: 'win32', arch: 'x64', sourceAvailable: true,
        sourceArchiveUrl: 'https://github.com/iOfficeAI/OfficeCLI/archive/refs/tags/v1.0.147.tar.gz',
        releaseArtifact: 'officecli-win-x64.exe', releaseArtifactUrl: 'https://github.com/iOfficeAI/OfficeCLI/releases/download/v1.0.147/officecli-win-x64.exe', releaseArtifactSha256: officeCliExecutableSha256,
        licenseUrl: 'https://raw.githubusercontent.com/iOfficeAI/OfficeCLI/b94f3906fd52d450c64f8e40370e376b9e15079e/LICENSE', licenseSha256: officeCliLicenseSha256,
        noticeUrl: 'https://raw.githubusercontent.com/iOfficeAI/OfficeCLI/b94f3906fd52d450c64f8e40370e376b9e15079e/NOTICE', noticeSha256: officeCliNoticeSha256,
        executable: 'runtime/officecli/officecli.exe', license: 'runtime/officecli/LICENSE', notice: 'runtime/officecli/NOTICE',
        distribution: 'self-contained-single-file', externalRuntimeRequired: false, networkRequiredAtRuntime: false, autoUpdate: false, autoResident: false, resolution: 'bundled-only',
        verifiedVersion: '1.0.147', verifiedReleaseArtifactSha256: true, installsAtRuntime: false, downloadsAtRuntime: false,
      },
    }
    await assert.rejects(module.verifyManifestContract(root, { ...manifest, buildGitSha: 'not-a-sha' }), /informational build Git SHA/u)
    await assert.rejects(module.verifyManifestContract(root, manifest), /executable hash mismatch/u)
    manifest.node.executableSha256 = createHash('sha256').update('modified').digest('hex')
    await assert.rejects(module.verifyManifestContract(root, manifest), /manifest mismatch: executableSha256/u)
  } finally { await rm(root, { recursive: true, force: true }) }
})
