import { createHash } from 'node:crypto'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { nodeRuntimeContract } from './node-runtime-contract.mjs'

const preparedRuntimeSourceSha = '4eef951bb4f37735dcac2800ccf38a6add5d08e1'
const thinMisenBehaviorBaselineSha = 'f3b772f7765206f75f7296e436d89c6a771b690a'
const productBehaviorBaselineSha = preparedRuntimeSourceSha
const modelVisibleWorkspacePaths = [
  'workspace/AGENTS.md',
  'workspace/.agents/skills/monthly-report/SKILL.md',
]
const allowedExecutableOrScriptPaths = new Set(['run.cmd', nodeRuntimeContract.executable])
const allowedNodeRuntimePaths = new Set([nodeRuntimeContract.executable, nodeRuntimeContract.license])

function parseArguments(argv) {
  const result = {}
  for (let index = 0; index < argv.length; index += 2) {
    if (!argv[index]?.startsWith('--') || argv[index + 1] === undefined) throw new Error('invalid arguments')
    result[argv[index].slice(2)] = argv[index + 1]
  }
  return result
}

async function hash(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

async function walk(root) {
  const files = []
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile()) files.push(path)
      else throw new Error(`unsupported filesystem entry: ${path}`)
    }
  }
  await visit(root)
  return files
}

const relativeName = (root, path) => path.slice(root.length + 1).replaceAll('\\', '/')

export function expectedLauncher() {
  return [
    '@echo off',
    'setlocal',
    'set "MISEN_ROOT=%~dp0"',
    'set "MISEN_NODE=%MISEN_ROOT%runtime\\node\\node.exe"',
    'if not exist "%MISEN_NODE%" (',
    '  echo Misen bundled Node.js runtime is missing. 1>&2',
    '  exit /b 1',
    ')',
    'if "%~1"=="" (set "MISEN_WORKSPACE=%MISEN_ROOT%workspace") else set "MISEN_WORKSPACE=%~f1"',
    '"%MISEN_NODE%" "%MISEN_ROOT%app\\dist\\src\\web\\server.js" "%MISEN_WORKSPACE%"',
    'exit /b %errorlevel%',
    '',
  ].join('\r\n')
}

export async function verifyHashes(root) {
  const lines = (await readFile(join(root, 'SHA256SUMS.txt'), 'utf8')).trim().split(/\r?\n/u)
  const listed = new Set()
  for (const line of lines) {
    const match = /^([0-9a-f]{64})  (.+)$/u.exec(line)
    if (!match) throw new Error(`invalid hash line: ${line}`)
    if (match[2].split('/').includes('..') || /^[A-Za-z]:|^[/\\]/u.test(match[2])) throw new Error('hash path escapes runtime')
    const path = resolve(root, ...match[2].split('/'))
    if (path !== root && !path.startsWith(`${root}\\`) && !path.startsWith(`${root}/`)) throw new Error('hash path escapes runtime')
    if (listed.has(match[2])) throw new Error(`duplicate hash path: ${match[2]}`)
    listed.add(match[2])
    if (await hash(path) !== match[1]) throw new Error(`hash mismatch: ${match[2]}`)
  }
  const actual = new Set((await walk(root)).filter(path => relativeName(root, path) !== 'SHA256SUMS.txt').map(path => relativeName(root, path)))
  const unlisted = [...actual].filter(path => !listed.has(path))
  const absent = [...listed].filter(path => !actual.has(path))
  if (unlisted.length > 0 || absent.length > 0) throw new Error(`hash file-set mismatch: unlisted=${unlisted.join(',')} absent=${absent.join(',')}`)
  return lines.length
}

export async function findForbiddenNames(root) {
  const forbidden = []
  for (const relativePath of [
    ['app', 'dist', 'test'],
    ['app', 'dist', 'acceptance'],
    ['app', 'dist', 'study'],
    ['app', 'node_modules', '.bin'],
    ['app', 'node_modules', 'esbuild'],
    ['app', 'node_modules', 'typescript'],
    ['app', 'node_modules', '@types'],
  ]) {
    try {
      await stat(join(root, ...relativePath))
      forbidden.push(join(root, ...relativePath))
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        if (['test', 'tests', '__tests__', 'coverage'].includes(entry.name.toLowerCase())) forbidden.push(path)
        await visit(path)
      } else {
        const relativePath = relativeName(root, path)
        if (relativePath.startsWith('runtime/node/') && !allowedNodeRuntimePaths.has(relativePath)) forbidden.push(path)
        if (/^(esbuild|tsc|npm|npx|corepack)(\.cmd|\.ps1|\.exe)?$/iu.test(entry.name) || /\.(ts|tsx|mts|cts|map|tsbuildinfo)$/iu.test(entry.name)) forbidden.push(path)
        if (/\.(exe|dll|node|cmd|ps1|bat|com)$/iu.test(entry.name) && !allowedExecutableOrScriptPaths.has(relativePath)) forbidden.push(path)
      }
    }
  }
  await visit(root)
  return [...new Set(forbidden)]
}

async function verifyManifestInventory(root, manifest) {
  const files = (await walk(root)).filter(path => relativeName(root, path) !== 'SHA256SUMS.txt')
  const byExtension = {}
  const executableOrScriptFiles = []
  let totalBytes = 0
  let packageCount = 0
  for (const path of files) {
    const name = basename(path)
    const dot = name.lastIndexOf('.')
    const extension = dot < 0 ? '<none>' : name.slice(dot).toLowerCase()
    byExtension[extension] = (byExtension[extension] ?? 0) + 1
    totalBytes += (await stat(path)).size
    if (['.exe', '.dll', '.node', '.cmd', '.bat', '.com', '.ps1'].includes(extension)) executableOrScriptFiles.push(relativeName(root, path))
    if (name === 'package.json' && relativeName(root, path).startsWith('app/node_modules/')) packageCount++
  }
  const actual = { fileCount: files.length, totalBytes, byExtension, executableOrScriptFiles, scope: 'all distributed files except SHA256SUMS.txt' }
  if (JSON.stringify(actual) !== JSON.stringify(manifest.inventory)) throw new Error('manifest inventory mismatch')
  if (packageCount !== manifest.dependencyProvenance?.productionDependencyPackageCount) throw new Error('production dependency count mismatch')
}

export async function verifyManifestContract(root, manifest) {
  if (manifest.schemaVersion !== 3) throw new Error('unsupported prepared-runtime manifest schema')
  if (manifest.sourceSha !== preparedRuntimeSourceSha) throw new Error('unexpected prepared-runtime source SHA')
  if (manifest.thinMisenBehaviorBaselineSha !== thinMisenBehaviorBaselineSha) throw new Error('unexpected Thin Misen behavior baseline SHA')
  if (manifest.productBehaviorBaselineSha !== productBehaviorBaselineSha) throw new Error('unexpected free-form product behavior baseline SHA')
  if (manifest.entrypoint !== 'app/dist/src/web/server.js' || manifest.launcher !== 'run.cmd') throw new Error('unexpected runtime entrypoint or launcher')
  const expectedNode = {
    version: nodeRuntimeContract.version,
    releaseName: nodeRuntimeContract.releaseName,
    platform: nodeRuntimeContract.platform,
    arch: nodeRuntimeContract.arch,
    sourceArchive: nodeRuntimeContract.sourceArchive,
    sourceRelease: nodeRuntimeContract.sourceRelease,
    sourceArchiveUrl: nodeRuntimeContract.sourceArchiveUrl,
    shasumsUrl: nodeRuntimeContract.shasumsUrl,
    archiveSha256: nodeRuntimeContract.archiveSha256,
    executable: nodeRuntimeContract.executable,
    executableSha256: nodeRuntimeContract.executableSha256,
    license: nodeRuntimeContract.license,
    licenseSha256: nodeRuntimeContract.licenseSha256,
    resolution: 'bundled-only',
    externalRuntimeRequired: false,
  }
  for (const [key, value] of Object.entries(expectedNode)) if (manifest.node?.[key] !== value) throw new Error(`bundled Node manifest mismatch: ${key}`)
  if (manifest.runtimePolicy?.installsAtRuntime !== false || manifest.runtimePolicy?.buildsAtRuntime !== false || manifest.runtimePolicy?.downloadsAtRuntime !== false
    || manifest.runtimePolicy?.powershellFallback !== false || manifest.runtimePolicy?.observerOrStudyCodeDistributed !== false) throw new Error('runtime policy is not fail-closed')
  if (JSON.stringify(manifest.modelVisibleWorkspacePaths) !== JSON.stringify(modelVisibleWorkspacePaths)) throw new Error('model-visible workspace context mismatch')
  if (!Array.isArray(manifest.requiredPaths) || manifest.requiredPaths.length === 0) throw new Error('manifest requiredPaths missing')
  for (const path of [...modelVisibleWorkspacePaths, nodeRuntimeContract.executable, nodeRuntimeContract.license]) if (!manifest.requiredPaths.includes(path)) throw new Error(`required package path missing: ${path}`)
  const executable = join(root, ...nodeRuntimeContract.executable.split('/'))
  const license = join(root, ...nodeRuntimeContract.license.split('/'))
  if (await hash(executable) !== nodeRuntimeContract.executableSha256) throw new Error('bundled Node executable hash mismatch')
  if (await hash(license) !== nodeRuntimeContract.licenseSha256) throw new Error('bundled Node license hash mismatch')
  const version = execFileSync(executable, ['--version'], { encoding: 'utf8' }).trim()
  if (version !== `v${nodeRuntimeContract.version}`) throw new Error(`bundled Node version mismatch: ${version}`)
  if (await readFile(join(root, 'run.cmd'), 'utf8') !== expectedLauncher()) throw new Error('launcher does not match the bundled-only contract')
}

function powershellJson(script) {
  const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const text = execFileSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' }).trim()
  return text ? JSON.parse(text) : null
}

async function poll(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      if (response.ok) return { status: response.status, body: await response.text() }
      lastError = new Error(`HTTP ${response.status}`)
    } catch (error) { lastError = error }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
  }
  throw new Error(`server did not become ready: ${lastError?.message ?? 'timeout'}`)
}

async function stopTree(pid) {
  const taskkill = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe')
  try { execFileSync(taskkill, ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore' }) } catch {}
}

async function observeStartup(root, manifest, mode) {
  const scratch = await mkdtemp(join(tmpdir(), `misen-bundled-node-${mode}-`))
  const pathDirectory = join(scratch, mode === 'fake-path-node' ? 'fake-path-node' : 'empty-path')
  const fakeMarker = join(scratch, 'fake-node-invoked.txt')
  await mkdir(pathDirectory, { recursive: true })
  if (mode === 'fake-path-node') await writeFile(join(pathDirectory, 'node.cmd'), `@echo fake>"${fakeMarker}"\r\nexit /b 91\r\n`, 'utf8')
  const beforeHashes = await readFile(join(root, 'SHA256SUMS.txt'), 'utf8')
  const command = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe')
  const child = spawn(command, ['/d', '/c', join(root, 'run.cmd')], {
    cwd: scratch,
    env: { SystemRoot: process.env.SystemRoot, ComSpec: command, PATHEXT: '.EXE;.CMD', PATH: pathDirectory, TEMP: scratch, TMP: scratch },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let stdout = ''
  let stderr = ''
  let targetNodePid = null
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  try {
    const response = await poll('http://127.0.0.1:8787/', 10_000)
    if (!response.body.includes('Misen')) throw new Error('unexpected Composer response')
    const stateResponse = await fetch('http://127.0.0.1:8787/state')
    const state = await stateResponse.json()
    if (!stateResponse.ok || state.status !== 'idle') throw new Error(`unexpected state response: ${JSON.stringify(state)}`)
    const processRows = powershellJson('@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine) | ConvertTo-Json -Compress')
    const allProcesses = processRows === null ? [] : Array.isArray(processRows) ? processRows : [processRows]
    const descendantIds = new Set([child.pid])
    let changed = true
    while (changed) {
      changed = false
      for (const row of allProcesses) if (descendantIds.has(Number(row.ParentProcessId)) && !descendantIds.has(Number(row.ProcessId))) { descendantIds.add(Number(row.ProcessId)); changed = true }
    }
    const processes = allProcesses.filter(row => Number(row.ProcessId) !== child.pid && descendantIds.has(Number(row.ProcessId)))
    const applicationProcesses = processes.filter(row => row.Name?.toLowerCase() !== 'conhost.exe')
    const nodeProcesses = applicationProcesses.filter(row => row.Name?.toLowerCase() === 'node.exe')
    if (nodeProcesses.length !== 1 || applicationProcesses.length !== 1) throw new Error(`unexpected target process tree: ${JSON.stringify(processes)}`)
    const expectedExecutable = resolve(root, ...manifest.node.executable.split('/')).toLowerCase()
    if (resolve(nodeProcesses[0].ExecutablePath).toLowerCase() !== expectedExecutable) throw new Error(`PATH Node was used instead of bundled Node: ${nodeProcesses[0].ExecutablePath}`)
    targetNodePid = Number(nodeProcesses[0].ProcessId)
    const directChildren = allProcesses.filter(row => Number(row.ParentProcessId) === targetNodePid)
    if (directChildren.length !== 0) throw new Error(`unexpected bundled Node direct child: ${JSON.stringify(directChildren)}`)
    const connectionRows = powershellJson(`@(1..10 | ForEach-Object { Get-NetTCPConnection -OwningProcess ${targetNodePid} -ErrorAction SilentlyContinue | Select-Object State,LocalAddress,LocalPort,RemoteAddress,RemotePort; Start-Sleep -Milliseconds 100 }) | Sort-Object State,LocalAddress,LocalPort,RemoteAddress,RemotePort -Unique | ConvertTo-Json -Compress`)
    const connections = connectionRows === null ? [] : Array.isArray(connectionRows) ? connectionRows : [connectionRows]
    const nonLoopback = connections.filter(row => !['0.0.0.0', '::', '127.0.0.1', '::1'].includes(row.RemoteAddress))
    if (nonLoopback.length > 0) throw new Error(`unexpected outbound connection: ${JSON.stringify(nonLoopback)}`)
    if (!connections.find(row => Number(row.LocalPort) === 8787 && row.LocalAddress === '127.0.0.1')) throw new Error(`expected loopback listener missing: ${JSON.stringify(connections)}`)
    if (beforeHashes !== await readFile(join(root, 'SHA256SUMS.txt'), 'utf8') || await verifyHashes(root) !== manifest.inventory.fileCount) throw new Error('prepared runtime changed during startup')
    try { await stat(fakeMarker); throw new Error('fake PATH Node was invoked') } catch (error) { if (error?.code !== 'ENOENT') throw error }
    return { mode, httpStatus: response.status, stateStatus: state.status, targetProcesses: processes, directChildCount: directChildren.length, targetConnections: connections }
  } finally {
    if (targetNodePid !== null) await stopTree(targetNodePid)
    await stopTree(child.pid)
    if (child.exitCode === null) await new Promise(resolvePromise => child.once('exit', resolvePromise))
    await new Promise(resolvePromise => setTimeout(resolvePromise, 200))
    await rm(scratch, { recursive: true, force: true })
    if (stdout && child.exitCode && child.exitCode !== 0) process.stderr.write(stdout)
    if (stderr && child.exitCode && child.exitCode !== 0) process.stderr.write(stderr)
  }
}

async function verifyMissingBundledNodeFailsClosed(root) {
  const scratch = await mkdtemp(join(tmpdir(), 'misen-missing-bundled-node-'))
  const fakePath = join(scratch, 'fake-path')
  const fakeMarker = join(scratch, 'fake-node-invoked.txt')
  await mkdir(fakePath, { recursive: true })
  await cp(join(root, 'run.cmd'), join(scratch, 'run.cmd'))
  await writeFile(join(fakePath, 'node.cmd'), `@echo fake>"${fakeMarker}"\r\nexit /b 0\r\n`, 'utf8')
  const command = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe')
  try {
    const result = spawnSync(command, ['/d', '/c', join(scratch, 'run.cmd')], {
      cwd: scratch,
      env: { SystemRoot: process.env.SystemRoot, ComSpec: command, PATHEXT: '.EXE;.CMD', PATH: fakePath, TEMP: scratch, TMP: scratch },
      encoding: 'utf8',
      windowsHide: true,
    })
    if (result.status === 0) throw new Error('missing bundled Node did not fail closed')
    try { await stat(fakeMarker); throw new Error('missing bundled Node fell back to PATH') } catch (error) { if (error?.code !== 'ENOENT') throw error }
    return { status: 'PASS', exitCode: result.status, pathFallbackInvoked: false }
  } finally { await rm(scratch, { recursive: true, force: true }) }
}

async function main() {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('prepared-runtime verification requires Windows x64')
  const args = parseArguments(process.argv.slice(2))
  if (!args.runtime) throw new Error('usage: verify-prepared-runtime --runtime <directory>')
  const root = resolve(args.runtime)
  const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'))
  await verifyManifestContract(root, manifest)
  for (const requiredPath of manifest.requiredPaths) await stat(join(root, ...requiredPath.split('/')))
  const hashCount = await verifyHashes(root)
  await verifyManifestInventory(root, manifest)
  const forbidden = await findForbiddenNames(root)
  if (forbidden.length > 0) throw new Error(`development/test/study/unexpected executable artifacts found: ${forbidden.join(', ')}`)
  const noPathNode = await observeStartup(root, manifest, 'no-path-node')
  const fakePathNode = await observeStartup(root, manifest, 'fake-path-node')
  const missingNodeNegative = await verifyMissingBundledNodeFailsClosed(root)
  console.log(JSON.stringify({
    status: 'PASS',
    sourceSha: manifest.sourceSha,
    productBehaviorBaselineSha: manifest.productBehaviorBaselineSha,
    packagingSha: manifest.packagingSha,
    node: manifest.node,
    hashCount,
    startup: [noPathNode, fakePathNode],
    missingNodeNegative,
    networkObservation: 'ten point-in-time stable-startup TCP samples per startup; no non-loopback endpoint observed',
    npmOnTargetPath: false,
    npxOnTargetPath: false,
    corepackOnTargetPath: false,
    observerOrStudyCodeDistributed: false,
  }, null, 2))
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) await main()
