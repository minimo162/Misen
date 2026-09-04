// Issue #93 A: automated launcher test.
//
// A temporary folder plays the role of the read-only share, another one plays %LOCALAPPDATA%.
// A fake prepared runtime (stub server.js, the current node.exe as the bundled runtime, a dummy OfficeCLI)
// is published with scripts/New-Misen.ps1, then Misen起動.cmd is double-click-simulated with cmd.exe:
//   1. first launch        -> copy + SHA-256 verification + activation; settings template created, then server start
//   2. second launch       -> verification only, no copy, server start
//   3. share version bump  -> automatic update on the next launch
//   4. tampered share file -> refused, previous version kept
//   plus: previous version stays on the share, two-generations-back is removed, publish log records re-verification
// Run: node --test launcher/test   (Windows only; needs powershell.exe and cmd.exe)
import test from 'node:test'
import { strict as assert } from 'node:assert'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const windows = process.platform === 'win32'
const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const cmdExe = process.env.ComSpec ?? 'cmd.exe'

function run(file, args, { cwd, env } = {}) {
  return new Promise((resolveRun) => {
    const childEnv = { ...process.env, ...env }
    // Codex's PowerShell 7 runtime contributes an incompatible PSModulePath to Node.
    // Let Windows PowerShell 5.1 rebuild its native module path, as it does on a user double-click.
    delete childEnv.PSModulePath
    // cmd.exe receives its command line verbatim; Node's default quoting would wrap the already quoted `/c` payload again.
    const child = spawn(file, args, { cwd, env: childEnv, windowsHide: true, windowsVerbatimArguments: file === cmdExe, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => resolveRun({ code: -1, stdout, stderr: `${stderr}${error.message}` }))
    child.on('close', (code) => resolveRun({ code, stdout, stderr }))
  })
}

async function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolvePort(port))
    })
  })
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

// The stub replaces app/dist/src/web/server.js. It records how it was started, listens on the manifest
// port, and exits 1.5 s after the launcher's readiness probe first connects so the launcher returns.
function stubServer(version) {
  return `
import { writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
const workspace = process.argv[2]
const port = Number(process.env.MISEN_TEST_PORT)
const marker = process.env.MISEN_TEST_MARKER
const record = { version: ${JSON.stringify(version)}, workspace, cwd: process.cwd(), execPath: process.execPath, officeCli: process.env.MISEN_OFFICECLI_PATH ?? null, noAutoResident: process.env.OFFICECLI_NO_AUTO_RESIDENT ?? null, settingsPath: process.env.MISEN_SETTINGS_PATH ?? null, argv: process.argv.slice(1) }
let exiting = false
const server = createServer((socket) => { socket.destroy(); if (!exiting) { exiting = true; setTimeout(() => process.exit(0), 1500) } })
server.listen(port, '127.0.0.1', () => { writeFileSync(marker, JSON.stringify(record)) })
setTimeout(() => process.exit(3), 20000)
`
}

// Stand-in for app/dist/src/runtime/settings-cli.js: writes a template when the settings file is missing (exit 3).
const stubSettingsCli = `
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
const index = process.argv.indexOf('--settings')
const path = process.argv[index + 1]
if (process.argv[2] === 'ensure' && !existsSync(path)) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, '// template\\n{}\\n'); console.log('template created ' + path); process.exit(3) }
process.exit(0)
`

async function writePreparedRuntime(root, version, { serverSource } = {}) {
  await rm(root, { recursive: true, force: true })
  await mkdir(join(root, 'app', 'dist', 'src', 'web'), { recursive: true })
  await mkdir(join(root, 'app', 'dist', 'src', 'runtime'), { recursive: true })
  await writeFile(join(root, 'app', 'dist', 'src', 'runtime', 'settings-cli.js'), stubSettingsCli, 'utf8')
  await mkdir(join(root, 'app', 'node_modules', 'example-dependency'), { recursive: true })
  await mkdir(join(root, 'runtime', 'node'), { recursive: true })
  await mkdir(join(root, 'runtime', 'officecli'), { recursive: true })
  await mkdir(join(root, 'workspace', 'output'), { recursive: true })
  await writeFile(join(root, 'app', 'dist', 'src', 'web', 'server.js'), serverSource ?? stubServer(version), 'utf8')
  await writeFile(join(root, 'app', 'package.json'), JSON.stringify({ name: '@misen/enterprise-prepared-runtime', version, type: 'module' }), 'utf8')
  await writeFile(join(root, 'app', 'dependency-lock.json'), '{}\n', 'utf8')
  await writeFile(join(root, 'app', 'node_modules', 'example-dependency', 'package.json'), JSON.stringify({ name: 'example-dependency', version: '1.0.0' }), 'utf8')
  await copyFile(process.execPath, join(root, 'runtime', 'node', 'node.exe'))
  await writeFile(join(root, 'runtime', 'node', 'LICENSE'), 'node license\n', 'utf8')
  await writeFile(join(root, 'runtime', 'officecli', 'officecli.exe'), 'not a real officecli\n', 'utf8')
  await writeFile(join(root, 'runtime', 'officecli', 'LICENSE'), 'officecli license\n', 'utf8')
  await writeFile(join(root, 'runtime', 'officecli', 'NOTICE'), 'officecli notice\n', 'utf8')
  await writeFile(join(root, 'workspace', 'AGENTS.md'), '# 作業フォルダーの雛形\n', 'utf8')
  await writeFile(join(root, 'run.cmd'), '@echo off\r\n', 'utf8')
  await writeFile(join(root, 'SHA256SUMS.txt'), '', 'utf8')
  await writeFile(join(root, 'manifest.json'), JSON.stringify({ schemaVersion: 5, applicationVersion: version, buildGitSha: null, node: { version: '24.20.0' }, officeCli: { version: '1.0.147' } }, null, 2), 'utf8')
}

async function publish(preparedRuntime, share, { version, url, clean = false } = {}) {
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(repoRoot, 'scripts', 'New-Misen.ps1'), '-Destination', share, '-PreparedRuntime', preparedRuntime, '-SourceRoot', repoRoot, '-Url', url]
  if (version) args.push('-Version', version)
  if (clean) args.push('-CleanDestination')
  const result = await run(powershell, args, { cwd: repoRoot })
  assert.equal(result.code, 0, `publish failed:\n${result.stdout}\n${result.stderr}`)
  return JSON.parse(await readFile(join(share, '_misen', 'manifest.json'), 'utf8'))
}

async function launch(share, localAppData, { port, marker, syncOnly = false, extraArgs = [] } = {}) {
  await rm(marker, { force: true })
  const args = ['/d', '/s', '/c', `""${join(share, 'Misen起動.cmd')}" -NoBrowser ${syncOnly ? '-SyncOnly ' : ''}${extraArgs.join(' ')}"`]
  const result = await run(cmdExe, args, { cwd: share, env: { LOCALAPPDATA: localAppData, MISEN_NO_PAUSE: '1', MISEN_TEST_PORT: String(port), MISEN_TEST_MARKER: marker } })
  let record = null
  try { record = JSON.parse(await readFile(marker, 'utf8')) } catch {}
  const state = JSON.parse(await readFile(join(localAppData, 'Misen', 'state', 'launch.json'), 'utf8').catch(() => 'null'))
  const current = JSON.parse(await readFile(join(localAppData, 'Misen', 'current.json'), 'utf8').catch(() => 'null'))
  return { ...result, record, state, current }
}

test('Misen起動.cmd: first launch, second launch, version update, and tampered share', { skip: !windows && 'Windows launcher test' }, async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'misen-launcher-test-'))
  const preparedRuntime = join(scratch, 'prepared')
  const share = join(scratch, 'share')
  const localAppData = join(scratch, 'LocalAppData')
  const marker = join(scratch, 'server-start.json')
  const port = await freePort()
  const url = `http://127.0.0.1:${port}/`
  try {
    // --- publish v1.0.0 to the "share" -------------------------------------------------------------
    await writePreparedRuntime(preparedRuntime, '1.0.0')
    const manifest1 = await publish(preparedRuntime, share, { url })
    assert.equal(manifest1.schema, 'misen-distribution/2')
    assert.equal(manifest1.version, '1.0.0')
    assert.equal(manifest1.current, '1.0.0')
    const versionDirOnShare = (version) => join(share, '_misen', 'versions', version)
    assert.equal(manifest1.entry, 'app/dist/src/web/server.js')
    assert.equal(manifest1.files['runtime/node/node.exe'], sha256(await readFile(process.execPath)))
    assert.equal(manifest1.files['app/dist/src/web/server.js'], sha256(await readFile(join(versionDirOnShare('1.0.0'), 'app', 'dist', 'src', 'web', 'server.js'))))
    assert.ok(manifest1.files['launcher/launch.ps1'])
    assert.ok(manifest1.files['workspace/AGENTS.md'])
    assert.ok(!JSON.stringify(manifest1).includes('OPENAI'), 'manifest never carries credentials')
    assert.deepEqual((await readdirSafe(share)).sort(), ['Misen起動.cmd', '_misen'], 'the share root shows only the entry point and the hidden _misen folder')
    assert.match((await run(cmdExe, ['/d', '/s', '/c', `attrib "${join(share, '_misen')}"`])).stdout, /^\s*\S*H\S*\s/u, '_misen carries the hidden attribute')
    for (const name of ['app', 'runtime', 'workspace', 'launcher']) await stat(join(versionDirOnShare('1.0.0'), name))
    await stat(join(share, '_misen', 'publish-log.txt'))

    // Make the share read-only from here on: every launch must succeed without writing to it.
    const shareSnapshot = await snapshotTree(share)

    // --- 1. first launch: download + verify + activate, then stop to let the user fill in settings ---
    const settingsPath = join(localAppData, 'Misen', 'config', 'settings.json')
    const initial = await launch(share, localAppData, { port, marker })
    assert.notEqual(initial.code, 0, 'first launch stops after creating the settings template')
    assert.match(initial.stdout, /SYNC_RESULT phase=activated version=1\.0\.0/u)
    assert.match(initial.stdout, /LLM 接続設定のテンプレートを作成しました/u)
    assert.match(initial.stdout, /LLM 接続設定を記入して保存してから/u)
    await stat(settingsPath)
    assert.equal(initial.record, null, 'server is not started before the settings exist')
    assert.equal(initial.state.phase, 'activated')
    assert.equal(initial.state.verified, true)
    assert.equal(initial.current.version, '1.0.0')
    assert.equal(initial.current.publishId, manifest1.publishId)
    const versionDir = join(localAppData, 'Misen', 'versions', '1.0.0')
    assert.deepEqual(await snapshotTree(share), shareSnapshot, 'share is untouched')
    assert.ok(!(await readdirSafe(share)).includes('config'), 'settings never land in the share')

    // --- 1b. first start with settings present: verified local copy starts the server -------------
    const first = await launch(share, localAppData, { port, marker })
    assert.equal(first.code, 0, `first launch failed:\n${first.stdout}\n${first.stderr}`)
    assert.match(first.stdout, /SYNC_RESULT phase=verified version=1\.0\.0/u)
    assert.equal(first.record.settingsPath.toLowerCase(), settingsPath.toLowerCase(), 'server receives the per-user settings path')
    await stat(join(versionDir, 'app', 'dist', 'src', 'web', 'server.js'))
    await stat(join(versionDir, 'runtime', 'node', 'node.exe'))
    assert.ok(first.record, 'stub server was started')
    assert.equal(first.record.version, '1.0.0')
    assert.equal(first.record.execPath.toLowerCase(), join(versionDir, 'runtime', 'node', 'node.exe').toLowerCase(), 'server runs from the verified local copy, not the share')
    assert.equal(first.record.officeCli.toLowerCase(), join(versionDir, 'runtime', 'officecli', 'officecli.exe').toLowerCase())
    assert.equal(first.record.noAutoResident, '1')
    assert.equal(first.record.workspace.toLowerCase(), join(localAppData, 'Misen', 'workspace').toLowerCase())
    assert.equal(await readFile(join(localAppData, 'Misen', 'workspace', 'AGENTS.md'), 'utf8'), '# 作業フォルダーの雛形\n', 'default workspace seeded from the share template')
    assert.deepEqual(await snapshotTree(share), shareSnapshot, 'share is untouched')

    // --- remembered project: no-argument launch uses projects.json --------------------------------
    const remembered = join(scratch, 'remembered workspace 日本語')
    await mkdir(remembered, { recursive: true })
    const projectsPath = join(localAppData, 'Misen', 'state', 'projects.json')
    await writeFile(projectsPath, JSON.stringify({ schema: 'misen-projects/1', recent: [remembered], last: remembered }), 'utf8')
    const rememberedResult = await launch(share, localAppData, { port, marker })
    assert.equal(rememberedResult.code, 0, `remembered-project launch failed:\n${rememberedResult.stdout}\n${rememberedResult.stderr}`)
    assert.equal(rememberedResult.record.workspace.toLowerCase(), remembered.toLowerCase())
    await stat(join(remembered, 'output'))

    // --- 2. second launch: verification only, no copy -----------------------------------------------
    const sentinel = join(versionDir, 'app', 'local-sentinel.txt')
    await writeFile(sentinel, 'survives a verification-only launch', 'utf8')
    const second = await launch(share, localAppData, { port, marker })
    assert.equal(second.code, 0, `second launch failed:\n${second.stdout}\n${second.stderr}`)
    assert.match(second.stdout, /SYNC_RESULT phase=verified version=1\.0\.0/u)
    assert.equal(second.state.phase, 'verified')
    assert.equal(second.record.version, '1.0.0')
    await stat(sentinel)
    assert.deepEqual(await snapshotTree(share), shareSnapshot, 'share is untouched')

    // --- explicit workspace by drag & drop (first argument is a folder) ----------------------------
    const dropped = join(scratch, 'dropped workspace 日本語')
    await mkdir(dropped, { recursive: true })
    const droppedResult = await run(cmdExe, ['/d', '/s', '/c', `""${join(share, 'Misen起動.cmd')}" "${dropped}" -NoBrowser"`],{ cwd: share, env: { LOCALAPPDATA: localAppData, MISEN_NO_PAUSE: '1', MISEN_TEST_PORT: String(port), MISEN_TEST_MARKER: marker } })
    assert.equal(droppedResult.code, 0, `dropped-folder launch failed:\n${droppedResult.stdout}\n${droppedResult.stderr}`)
    const droppedRecord = JSON.parse(await readFile(marker, 'utf8'))
    assert.equal(droppedRecord.workspace.toLowerCase(), dropped.toLowerCase())
    await stat(join(dropped, 'output'))
    const afterDropProjects = JSON.parse(await readFile(projectsPath, 'utf8'))
    assert.equal(afterDropProjects.last.toLowerCase(), dropped.toLowerCase(), 'drag and drop wins over remembered project')
    assert.equal(afterDropProjects.recent[0].toLowerCase(), dropped.toLowerCase())

    // --- 3. share version bump: next launch updates automatically -----------------------------------
    await writePreparedRuntime(preparedRuntime, '1.1.0')
    const manifest2 = await publish(preparedRuntime, share, { url })
    assert.equal(manifest2.version, '1.1.0')
    assert.equal(manifest2.current, '1.1.0')
    assert.equal(manifest2.previousVersion, '1.0.0')
    await stat(join(versionDirOnShare('1.0.0'), 'app', 'dist', 'src', 'web', 'server.js'))
    await stat(join(versionDirOnShare('1.1.0'), 'app', 'dist', 'src', 'web', 'server.js'))
    assert.deepEqual((await readdirSafe(join(share, '_misen', 'versions'))).sort(), ['1.0.0', '1.1.0'], 'the previous version stays on the share after an update')
    assert.notEqual(manifest2.publishId, manifest1.publishId)
    const third = await launch(share, localAppData, { port, marker })
    assert.equal(third.code, 0, `update launch failed:\n${third.stdout}\n${third.stderr}`)
    assert.match(third.stdout, /SYNC_RESULT phase=activated version=1\.1\.0/u)
    assert.equal(third.current.version, '1.1.0')
    assert.equal(third.current.previousVersion, '1.0.0')
    assert.equal(third.record.version, '1.1.0')
    await stat(join(localAppData, 'Misen', 'versions', '1.1.0', 'app', 'dist', 'src', 'web', 'server.js'))
    await stat(versionDir) // previous version is retained for rollback
    assert.ok(third.record.execPath.toLowerCase().includes('\\versions\\1.1.0\\'), 'double-click switches to the new version')

    // --- 3b. a third publish drops the version two generations back ---------------------------------
    await writePreparedRuntime(preparedRuntime, '1.2.0')
    const manifest3 = await publish(preparedRuntime, share, { url })
    assert.equal(manifest3.previousVersion, '1.1.0')
    assert.deepEqual((await readdirSafe(join(share, '_misen', 'versions'))).sort(), ['1.1.0', '1.2.0'], 'only the current and the previous version remain; 1.0.0 is removed')

    // --- 4. tampered share: refused, previous version kept ------------------------------------------
    await writeFile(join(versionDirOnShare('1.2.0'), 'app', 'dist', 'src', 'web', 'server.js'), stubServer('1.2.0-tampered'), 'utf8')
    const tampered = await launch(share, localAppData, { port, marker })
    assert.notEqual(tampered.code, 0, 'tampered share must not launch')
    assert.match(`${tampered.stdout}${tampered.stderr}`, /SHA-256/u)
    assert.equal(tampered.record, null, 'server was not started from the tampered copy')
    assert.equal(tampered.state.phase, 'rolled_back')
    assert.equal(tampered.current.version, '1.1.0')
    const remaining = await readdirSafe(join(localAppData, 'Misen', 'versions'))
    assert.ok(!remaining.some((name) => name.startsWith('.staging-')), 'no staging directory left behind')
    assert.ok(!remaining.includes('1.2.0'))

    // --- sync-only mode used by administrators to pre-verify ----------------------------------------
    await writePreparedRuntime(preparedRuntime, '1.2.1')
    await publish(preparedRuntime, share, { url })
    const syncOnly = await launch(share, localAppData, { port, marker, syncOnly: true })
    assert.equal(syncOnly.code, 0, `sync-only failed:\n${syncOnly.stdout}\n${syncOnly.stderr}`)
    assert.match(syncOnly.stdout, /SYNC_RESULT phase=activated version=1\.2\.1/u)
    assert.equal(syncOnly.record, null, 'sync-only never starts the server')

    // --- publish log: every publish re-verified the share right after writing it --------------------
    const publishLog = (await readFile(join(share, "_misen", "publish-log.txt"), 'utf8')).trim().split(/\r?\n/u)
    assert.equal(publishLog.length, 4, 'one line per publish (1.0.0, 1.1.0, 1.2.0, 1.2.1)')
    for (const line of publishLog) assert.match(line, /^\d{4}-\d{2}-\d{2}T\S+\tversion=1\.\d\.\d\tpublishId=[0-9a-f]{32}\tfiles=\d+\tverify=OK\tby=/u)
    assert.deepEqual(publishLog.map((line) => line.match(/version=(\S+)/u)[1]), ['1.0.0', '1.1.0', '1.2.0', '1.2.1'])
    assert.ok(!publishLog.join('\n').includes('sk-'), 'the log carries no key material')

    // --- -CleanDestination removes every other version --------------------------------------------
    await writePreparedRuntime(preparedRuntime, '1.3.0')
    await publish(preparedRuntime, share, { url, clean: true })
    assert.deepEqual(await readdirSafe(join(share, '_misen', 'versions')), ['1.3.0'])
    assert.deepEqual((await readdirSafe(share)).sort(), ['Misen起動.cmd', '_misen'])

    // --- review 1: republishing the version current points at is refused and changes nothing --------
    const misenBefore = await snapshotTree(join(share, '_misen'))
    await writePreparedRuntime(preparedRuntime, '1.3.0', { serverSource: stubServer('1.3.0-republished') })
    const sameVersion = await run(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(repoRoot, 'scripts', 'New-Misen.ps1'), '-Destination', share, '-PreparedRuntime', preparedRuntime, '-SourceRoot', repoRoot, '-Url', url, '-Version', '1.3.0', '-CleanDestination'], { cwd: repoRoot })
    assert.notEqual(sameVersion.code, 0, 'same-version republish must stop')
    assert.match(`${sameVersion.stdout}${sameVersion.stderr}`, /版数を上げてから公開してください/u)
    assert.deepEqual(await snapshotTree(join(share, '_misen')), misenBefore, 'version folders, manifest and publish log are unchanged')

    // --- review 2: a current value that is not a plain version name stops launch.ps1 clearly -----------
    const manifestPath = join(share, '_misen', 'manifest.json')
    const goodManifest = await readFile(manifestPath, 'utf8')
    await writeFile(manifestPath, goodManifest.replace(/"current":\s+"1\.3\.0"/u, '"current": "../x"'), 'utf8')
    assert.match(await readFile(manifestPath, 'utf8'), /"current": "\.\.\/x"/u)
    const badCurrent = await run(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(share, '_misen', 'versions', '1.3.0', 'launcher', 'launch.ps1'), '-ShareRoot', share, '-LocalRoot', join(localAppData, 'Misen'), '-SyncOnly', '-NoBrowser'], { cwd: share })
    assert.notEqual(badCurrent.code, 0)
    assert.match(`${badCurrent.stdout}${badCurrent.stderr}`, /current が不正です: \.\.\/x/u)
    const badCurrentCmd = await launch(share, localAppData, { port, marker, syncOnly: true })
    assert.notEqual(badCurrentCmd.code, 0)
    assert.match(badCurrentCmd.stdout, /_misen\\manifest\.json から有効な版を読み取れませんでした/u, 'the .cmd rejects the value before building a path')
    assert.doesNotMatch(badCurrentCmd.stdout, /versions\\\.\./u)

    // --- review 3: a broken manifest.json stops Misen起動.cmd with the same message and no odd path --
    await writeFile(manifestPath, '{ "schema": "misen-distribution/2", "current": ', 'utf8')
    const broken = await launch(share, localAppData, { port, marker, syncOnly: true })
    assert.notEqual(broken.code, 0)
    assert.match(broken.stdout, /_misen\\manifest\.json から有効な版を読み取れませんでした/u)
    assert.doesNotMatch(broken.stdout, /launcher\\launch\.ps1 が見つかりません|ConvertFrom-Json|versions\\\S*launcher/u, 'no PowerShell error text or nonsense path is shown')
    assert.equal(broken.record, null)
    await writeFile(manifestPath, goodManifest, 'utf8')
    const restored = await launch(share, localAppData, { port, marker, syncOnly: true })
    assert.equal(restored.code, 0, `restored manifest failed:\n${restored.stdout}\n${restored.stderr}`)

  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
})

async function readdirSafe(path) {
  const { readdir } = await import('node:fs/promises')
  try { return await readdir(path) } catch { return [] }
}

async function snapshotTree(root) {
  const { readdir } = await import('node:fs/promises')
  const entries = []
  async function visit(directory) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await visit(path)
      else entries.push([path.slice(root.length), sha256(await readFile(path))])
    }
  }
  await visit(root)
  return entries
}
