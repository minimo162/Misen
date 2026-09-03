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

test('distribution entrypoint and packaging scripts are explicit', async () => {
  const packageJson = JSON.parse(await readFile('package.json', 'utf8')) as { scripts: Record<string, string> }
  assert.equal(packageJson.scripts.demo, 'npm run build && node dist/src/web/server.js')
  assert.equal(packageJson.scripts['acquire:node-runtime'], 'node scripts/acquire-node-runtime.mjs')
  assert.equal(typeof packageJson.scripts['prepare-runtime'], 'string')
  assert.equal(typeof packageJson.scripts['verify:prepared-runtime'], 'string')
  await access('dist/src/web/server.js')
  await assert.rejects(access('dist/web/server.js'), /ENOENT/u)
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

test('prepared-runtime generator requires an explicit verified Node input and clean target', async () => {
  const module = await import(pathToFileURL(join(process.cwd(), 'scripts', 'prepare-runtime.mjs')).href) as any
  const root = await mkdtemp(join(tmpdir(), 'misen-prepare-contract-'))
  const output = join(root, 'output')
  try {
    await assert.rejects(module.prepareRuntime({ output }), /node-runtime/u)
    await writeFile(join(root, 'marker.txt'), 'preserve', 'utf8')
    await assert.rejects(module.prepareRuntime({ output: root, nodeRuntime: root }), /absent or empty/u)
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

test('hash verification requires exact equality and executable policy allows only run.cmd plus bundled node.exe', async () => {
  const root = await mkdtemp(join(tmpdir(), 'misen-verify-contract-'))
  try {
    const module = await import(pathToFileURL(join(process.cwd(), 'scripts', 'verify-prepared-runtime.mjs')).href) as any
    await mkdir(join(root, 'runtime', 'node'), { recursive: true })
    await writeFile(join(root, 'run.cmd'), 'safe', 'utf8')
    await writeFile(join(root, 'runtime', 'node', 'node.exe'), 'approved path only; hash checked separately', 'utf8')
    await writeFile(join(root, 'runtime', 'node', 'LICENSE'), 'license', 'utf8')
    const files = ['run.cmd', 'runtime/node/LICENSE', 'runtime/node/node.exe']
    const lines: string[] = []
    for (const file of files) lines.push(`${createHash('sha256').update(await readFile(join(root, ...file.split('/')))).digest('hex')}  ${file}`)
    await writeFile(join(root, 'SHA256SUMS.txt'), `${lines.join('\n')}\n`, 'utf8')
    assert.equal(await module.verifyHashes(root), 3)
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
      schemaVersion: 4,
      applicationVersion: '0.2.0',
      buildGitSha: 'a'.repeat(40),
      gitMetadataPolicy: 'informational-only',
      launcher: 'run.cmd',
      entrypoint: 'app/dist/src/web/server.js',
      modelVisibleWorkspacePaths: ['workspace/AGENTS.md', 'workspace/.agents/skills/monthly-report/SKILL.md'],
      requiredPaths: ['runtime/node/node.exe', 'runtime/node/LICENSE', 'workspace/AGENTS.md', 'workspace/.agents/skills/monthly-report/SKILL.md'],
      runtimePolicy: { installsAtRuntime: false, buildsAtRuntime: false, downloadsAtRuntime: false, powershellFallback: false, observerOrStudyCodeDistributed: false },
      node: {
        version: '24.20.0', releaseName: 'Krypton', platform: 'win32', arch: 'x64',
        sourceArchive: 'node-v24.20.0-win-x64.zip', sourceRelease: 'https://nodejs.org/dist/v24.20.0/',
        sourceArchiveUrl: 'https://nodejs.org/dist/v24.20.0/node-v24.20.0-win-x64.zip',
        shasumsUrl: 'https://nodejs.org/dist/v24.20.0/SHASUMS256.txt', archiveSha256,
        executable: 'runtime/node/node.exe', executableSha256, license: 'runtime/node/LICENSE',
        licenseSha256, resolution: 'bundled-only', externalRuntimeRequired: false,
      },
    }
    await assert.rejects(module.verifyManifestContract(root, { ...manifest, buildGitSha: 'not-a-sha' }), /informational build Git SHA/u)
    await assert.rejects(module.verifyManifestContract(root, manifest), /executable hash mismatch/u)
    manifest.node.executableSha256 = createHash('sha256').update('modified').digest('hex')
    await assert.rejects(module.verifyManifestContract(root, manifest), /manifest mismatch: executableSha256/u)
  } finally { await rm(root, { recursive: true, force: true }) }
})
