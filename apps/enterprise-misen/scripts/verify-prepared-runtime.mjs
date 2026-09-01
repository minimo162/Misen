import { createHash } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { cp, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const preparedRuntimeSourceSha = 'df2859c471fac035be062703f59f69e07d55b208'
const thinMisenBehaviorBaselineSha = 'f3b772f7765206f75f7296e436d89c6a771b690a'
const modelVisibleWorkspacePaths = [
  'workspace/AGENTS.md',
  'workspace/.agents/skills/monthly-report/SKILL.md',
]

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
    entries.sort((left, right) => left.name.localeCompare(right.name, 'en'))
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

export async function verifyHashes(root) {
  const lines = (await readFile(join(root, 'SHA256SUMS.txt'), 'utf8')).trim().split(/\r?\n/)
  const listed = new Set()
  for (const line of lines) {
    const match = /^([0-9a-f]{64})  (.+)$/.exec(line)
    if (!match) throw new Error(`invalid hash line: ${line}`)
    const path = resolve(root, ...match[2].split('/'))
    if (path !== root && !path.startsWith(`${root}\\`) && !path.startsWith(`${root}/`)) throw new Error('hash path escapes runtime')
    if (listed.has(match[2])) throw new Error(`duplicate hash path: ${match[2]}`)
    listed.add(match[2])
    if (await hash(path) !== match[1]) throw new Error(`hash mismatch: ${match[2]}`)
  }
  const actual = new Set((await walk(root)).filter(path => relativeName(root, path) !== 'SHA256SUMS.txt').map(path => relativeName(root, path)))
  const missing = [...actual].filter(path => !listed.has(path))
  const absent = [...listed].filter(path => !actual.has(path))
  if (missing.length > 0 || absent.length > 0) throw new Error(`hash file-set mismatch: unlisted=${missing.join(',')} absent=${absent.join(',')}`)
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
      } else if (/^(esbuild|tsc|npm|npx)(\.cmd|\.ps1|\.exe)?$/i.test(entry.name) || /\.(ts|tsx|mts|cts|map|tsbuildinfo)$/i.test(entry.name)
        || (/\.(exe|dll|node|cmd|ps1|bat|com)$/i.test(entry.name) && resolve(path) !== resolve(root, 'run.cmd'))) forbidden.push(path)
    }
  }
  await visit(root)
  return forbidden
}

async function verifyManifestInventory(root, manifest) {
  const files = (await walk(root)).filter(path => relativeName(root, path) !== 'SHA256SUMS.txt')
  const byExtension = {}
  const executableOrScriptFiles = []
  let totalBytes = 0
  let packageCount = 0
  for (const path of files) {
    const name = basename(path), dot = name.lastIndexOf('.'), extension = dot < 0 ? '<none>' : name.slice(dot).toLowerCase()
    byExtension[extension] = (byExtension[extension] ?? 0) + 1
    totalBytes += (await stat(path)).size
    if (['.exe', '.dll', '.node', '.cmd', '.bat', '.com', '.ps1'].includes(extension)) executableOrScriptFiles.push(relativeName(root, path))
    if (name === 'package.json' && relativeName(root, path).startsWith('app/node_modules/')) packageCount++
  }
  const actual = { fileCount: files.length, totalBytes, byExtension, executableOrScriptFiles, scope: 'all distributed files except SHA256SUMS.txt' }
  if (JSON.stringify(actual) !== JSON.stringify(manifest.inventory)) throw new Error('manifest inventory mismatch')
  if (packageCount !== manifest.dependencyProvenance?.productionDependencyPackageCount) throw new Error('production dependency count mismatch')
}

function verifyManifestContract(manifest) {
  if (manifest.schemaVersion !== 2) throw new Error('unsupported prepared-runtime manifest schema')
  if (manifest.sourceSha !== preparedRuntimeSourceSha) throw new Error('unexpected prepared-runtime source SHA')
  if (manifest.thinMisenBehaviorBaselineSha !== thinMisenBehaviorBaselineSha) throw new Error('unexpected Thin Misen behavior baseline SHA')
  if (manifest.entrypoint !== 'app/dist/src/web/server.js') throw new Error('unexpected runtime entrypoint')
  if (manifest.runtimePolicy?.installsAtRuntime !== false || manifest.runtimePolicy?.buildsAtRuntime !== false || manifest.runtimePolicy?.downloadsAtRuntime !== false
    || manifest.runtimePolicy?.powershellFallback !== false || manifest.runtimePolicy?.observerOrStudyCodeDistributed !== false) {
    throw new Error('runtime policy is not fail-closed')
  }
  if (JSON.stringify(manifest.modelVisibleWorkspacePaths) !== JSON.stringify(modelVisibleWorkspacePaths)) throw new Error('model-visible workspace context mismatch')
  if (!Array.isArray(manifest.requiredPaths) || manifest.requiredPaths.length === 0) throw new Error('manifest requiredPaths missing')
  for (const path of modelVisibleWorkspacePaths) if (!manifest.requiredPaths.includes(path)) throw new Error(`required model-visible path missing: ${path}`)
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
    } catch (error) {
      lastError = error
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100))
  }
  throw new Error(`server did not become ready: ${lastError?.message ?? 'timeout'}`)
}

async function main() {
  if (process.platform !== 'win32') throw new Error('Phase A launcher verification requires Windows')
  const args = parseArguments(process.argv.slice(2))
  if (!args.runtime) throw new Error('usage: verify-prepared-runtime --runtime <directory>')
  const root = resolve(args.runtime)
  const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'))
  verifyManifestContract(manifest)
  await stat(join(root, ...manifest.entrypoint.split('/')))
  for (const requiredPath of manifest.requiredPaths) await stat(join(root, ...requiredPath.split('/')))
  const hashCount = await verifyHashes(root)
  await verifyManifestInventory(root, manifest)
  const forbidden = await findForbiddenNames(root)
  if (forbidden.length > 0) throw new Error(`development/test/study artifacts found: ${forbidden.join(', ')}`)

  const scratch = await mkdtemp(join(tmpdir(), 'misen-prepared-verify-'))
  const approvedNodeDirectory = join(scratch, 'approved-node')
  await cp(dirname(process.execPath), approvedNodeDirectory, {
    recursive: true,
    filter: (source) => source === dirname(process.execPath) || source.toLowerCase().endsWith('node.exe'),
  })
  const beforeHashes = await readFile(join(root, 'SHA256SUMS.txt'), 'utf8')
  const command = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe')
  const child = spawn(command, ['/d', '/c', join(root, 'run.cmd')], {
    cwd: scratch,
    env: {
      SystemRoot: process.env.SystemRoot,
      ComSpec: command,
      PATHEXT: '.EXE;.CMD',
      PATH: approvedNodeDirectory,
      TEMP: scratch,
      TMP: scratch,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let stdout = ''
  let stderr = ''
  let targetNodePid = null
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.on('data', (chunk) => { stderr += chunk })

  try {
    const response = await poll('http://127.0.0.1:8787/', 10_000)
    if (!response.body.includes('Misen')) throw new Error('unexpected Composer response')
    const stateResponse = await fetch('http://127.0.0.1:8787/state')
    const state = await stateResponse.json()
    if (!stateResponse.ok || state.status !== 'idle' || !Array.isArray(state.tools) || !Array.isArray(state.axes) || !Array.isArray(state.artifacts)) throw new Error(`unexpected deterministic state response: ${JSON.stringify(state)}`)
    const processRows = powershellJson(`@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine) | ConvertTo-Json -Compress`)
    const allProcesses = processRows === null ? [] : Array.isArray(processRows) ? processRows : [processRows]
    const descendantIds = new Set([child.pid])
    let changed = true
    while (changed) {
      changed = false
      for (const row of allProcesses) if (descendantIds.has(Number(row.ParentProcessId)) && !descendantIds.has(Number(row.ProcessId))) { descendantIds.add(Number(row.ProcessId)); changed = true }
    }
    const processes = allProcesses.filter(row => Number(row.ProcessId) !== child.pid && descendantIds.has(Number(row.ProcessId)))
    const applicationProcesses = processes.filter((row) => row.Name?.toLowerCase() !== 'conhost.exe')
    const nodeProcesses = applicationProcesses.filter((row) => row.Name?.toLowerCase() === 'node.exe')
    if (nodeProcesses.length !== 1 || applicationProcesses.length !== 1) throw new Error(`unexpected target process tree: ${JSON.stringify(processes)}`)
    targetNodePid = Number(nodeProcesses[0].ProcessId)
    const connectionRows = powershellJson(`@(1..10 | ForEach-Object { Get-NetTCPConnection -OwningProcess ${targetNodePid} -ErrorAction SilentlyContinue | Select-Object State,LocalAddress,LocalPort,RemoteAddress,RemotePort; Start-Sleep -Milliseconds 100 }) | Sort-Object State,LocalAddress,LocalPort,RemoteAddress,RemotePort -Unique | ConvertTo-Json -Compress`)
    const connections = connectionRows === null ? [] : Array.isArray(connectionRows) ? connectionRows : [connectionRows]
    const nonLoopback = connections.filter((row) => !['0.0.0.0', '::', '127.0.0.1', '::1'].includes(row.RemoteAddress))
    if (nonLoopback.length > 0) throw new Error(`unexpected outbound connection: ${JSON.stringify(nonLoopback)}`)
    const listener = connections.find((row) => Number(row.LocalPort) === 8787 && row.LocalAddress === '127.0.0.1')
    if (!listener) throw new Error(`expected loopback listener missing: ${JSON.stringify(connections)}`)
    if (beforeHashes !== await readFile(join(root, 'SHA256SUMS.txt'), 'utf8') || hashCount !== await verifyHashes(root)) {
      throw new Error('prepared runtime changed during startup')
    }
    console.log(JSON.stringify({
      status: 'PASS',
      sourceSha: manifest.sourceSha,
      thinMisenBehaviorBaselineSha: manifest.thinMisenBehaviorBaselineSha,
      httpStatus: response.status,
      stateStatus: state.status,
      hashCount,
      targetProcesses: processes,
      targetConnections: connections,
      networkObservation: 'ten stable-startup TCP samples over one second; no non-loopback endpoint observed',
      pathEntries: [approvedNodeDirectory],
      npmOnPath: false,
      tscOnPath: false,
      esbuildOnPath: false,
      observerOrStudyCodeDistributed: false,
    }, null, 2))
  } finally {
    const taskkill = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe')
    try {
      if (targetNodePid !== null) execFileSync(taskkill, ['/pid', String(targetNodePid), '/t', '/f'], { stdio: 'ignore' })
    } catch {}
    try { execFileSync(taskkill, ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' }) } catch {}
    if (child.exitCode === null) await new Promise((resolvePromise) => child.once('exit', resolvePromise))
    for (let attempt = 0; attempt < 10; attempt++) {
      try { await rm(scratch, { recursive: true, force: true }); break }
      catch (error) {
        if (attempt === 9) throw error
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 100))
      }
    }
    if (stdout && child.exitCode && child.exitCode !== 0) process.stderr.write(stdout)
    if (stderr && child.exitCode && child.exitCode !== 0) process.stderr.write(stderr)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) await main()
