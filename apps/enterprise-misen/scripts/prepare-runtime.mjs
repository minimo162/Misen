import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  cp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { nodeRuntimeContract, nodeRuntimeInputManifest } from './node-runtime-contract.mjs'
import { officeCliRuntimeContract, officeCliRuntimeInputManifest } from './officecli-runtime-contract.mjs'
import { allowedWasmDirectories } from './wasm-runtime-contract.mjs'

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const shaPattern = /^[0-9a-f]{40}$/
const allowedDistRoots = Object.freeze([
  ['src'],
  ['demo', 'enterprise-excel', 'fixtures.js'],
  ['web', 'assets'],
])

function parseArguments(argv) {
  const values = {}
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!key?.startsWith('--') || value === undefined) throw new Error(`invalid argument near ${key ?? '<end>'}`)
    values[key.slice(2)] = value
  }
  return values
}

async function sha256(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

async function canonicalizeZipTimestamps(path) {
  const bytes = Buffer.from(await readFile(path))
  let eocd = -1
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65_557); offset--) {
    if (bytes.readUInt32LE(offset) === 0x06054b50) { eocd = offset; break }
  }
  if (eocd < 0) throw new Error(`ZIP end record missing: ${path}`)
  const entries = bytes.readUInt16LE(eocd + 10)
  let central = bytes.readUInt32LE(eocd + 16)
  const fixedDosTime = 0
  const fixedDosDate = ((2020 - 1980) << 9) | (1 << 5) | 1
  for (let index = 0; index < entries; index++) {
    if (bytes.readUInt32LE(central) !== 0x02014b50) throw new Error(`invalid ZIP central directory: ${path}`)
    bytes.writeUInt16LE(fixedDosTime, central + 12)
    bytes.writeUInt16LE(fixedDosDate, central + 14)
    const local = bytes.readUInt32LE(central + 42)
    if (bytes.readUInt32LE(local) !== 0x04034b50) throw new Error(`invalid ZIP local header: ${path}`)
    bytes.writeUInt16LE(fixedDosTime, local + 10)
    bytes.writeUInt16LE(fixedDosDate, local + 12)
    central += 46 + bytes.readUInt16LE(central + 28) + bytes.readUInt16LE(central + 30) + bytes.readUInt16LE(central + 32)
  }
  await writeFile(path, bytes)
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

async function ensureDirectory(path) {
  try {
    const info = await stat(path)
    if (!info.isDirectory()) throw new Error(`parent path is not a directory: ${path}`)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    await mkdir(path, { recursive: true })
  }
}

async function ensureCleanTarget(target) {
  const parent = dirname(target)
  await ensureDirectory(parent)
  try {
    const entries = await readdir(target)
    if (entries.length > 0) throw new Error(`output directory must be absent or empty: ${target}`)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}

function informationalBuildGitSha() {
  try {
    const value = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: appRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    return shaPattern.test(value) ? value : null
  } catch {
    return null
  }
}

async function verifiedNodeRuntimeInput(nodeRuntime) {
  const root = resolve(nodeRuntime)
  const provenance = JSON.parse(await readFile(join(root, nodeRuntimeInputManifest), 'utf8'))
  const exact = {
    schemaVersion: 1,
    version: nodeRuntimeContract.version,
    releaseName: nodeRuntimeContract.releaseName,
    platform: nodeRuntimeContract.platform,
    arch: nodeRuntimeContract.arch,
    sourceArchive: nodeRuntimeContract.sourceArchive,
    sourceRelease: nodeRuntimeContract.sourceRelease,
    sourceArchiveUrl: nodeRuntimeContract.sourceArchiveUrl,
    shasumsUrl: nodeRuntimeContract.shasumsUrl,
    archiveSha256: nodeRuntimeContract.archiveSha256,
    executableSha256: nodeRuntimeContract.executableSha256,
    licenseSha256: nodeRuntimeContract.licenseSha256,
    executable: 'node.exe',
    license: 'LICENSE',
    resolution: nodeRuntimeContract.resolution,
    externalRuntimeRequired: false,
    verifiedAgainstOfficialShasums: true,
  }
  for (const [key, value] of Object.entries(exact)) if (provenance[key] !== value) throw new Error(`Node runtime provenance mismatch: ${key}`)
  const executable = join(root, 'node.exe')
  const license = join(root, 'LICENSE')
  if (await sha256(executable) !== nodeRuntimeContract.executableSha256) throw new Error('Node runtime executable SHA-256 mismatch')
  if (await sha256(license) !== nodeRuntimeContract.licenseSha256) throw new Error('Node runtime license SHA-256 mismatch')
  const version = execFileSync(executable, ['--version'], { encoding: 'utf8' }).trim()
  if (version !== `v${nodeRuntimeContract.version}`) throw new Error(`Node runtime version mismatch: ${version}`)
  return { root, provenance }
}

async function copyNodeRuntime(target, nodeRuntime) {
  const verified = await verifiedNodeRuntimeInput(nodeRuntime)
  const destination = join(target, 'runtime', 'node')
  await mkdir(destination, { recursive: true })
  await cp(join(verified.root, 'node.exe'), join(destination, 'node.exe'))
  await cp(join(verified.root, 'LICENSE'), join(destination, 'LICENSE'))
  return verified.provenance
}

async function verifiedOfficeCliRuntimeInput(officeCliRuntime) {
  const root = resolve(officeCliRuntime)
  const provenance = JSON.parse(await readFile(join(root, officeCliRuntimeInputManifest), 'utf8'))
  const exact = { schemaVersion: 1, ...officeCliRuntimeContract, verifiedVersion: officeCliRuntimeContract.version, verifiedReleaseArtifactSha256: true, installsAtRuntime: false, downloadsAtRuntime: false }
  for (const [key, value] of Object.entries(exact)) if (provenance[key] !== value) throw new Error(`OfficeCLI runtime provenance mismatch: ${key}`)
  const executable = join(root, 'officecli.exe')
  const license = join(root, 'LICENSE')
  const notice = join(root, 'NOTICE')
  if (await sha256(executable) !== officeCliRuntimeContract.releaseArtifactSha256) throw new Error('OfficeCLI executable SHA-256 mismatch')
  if (await sha256(license) !== officeCliRuntimeContract.licenseSha256) throw new Error('OfficeCLI LICENSE SHA-256 mismatch')
  if (await sha256(notice) !== officeCliRuntimeContract.noticeSha256) throw new Error('OfficeCLI NOTICE SHA-256 mismatch')
  const version = execFileSync(executable, ['--version'], { encoding: 'utf8', env: { ...process.env, OFFICECLI_NO_AUTO_RESIDENT: '1', OFFICECLI_SKIP_UPDATE: '1' }, windowsHide: true }).trim()
  if (version !== officeCliRuntimeContract.version) throw new Error(`OfficeCLI version mismatch: ${version}`)
  return { root, provenance }
}

async function copyOfficeCliRuntime(target, officeCliRuntime) {
  const verified = await verifiedOfficeCliRuntimeInput(officeCliRuntime)
  const destination = join(target, 'runtime', 'officecli')
  await mkdir(destination, { recursive: true })
  await cp(join(verified.root, 'officecli.exe'), join(destination, 'officecli.exe'))
  await cp(join(verified.root, 'LICENSE'), join(destination, 'LICENSE'))
  await cp(join(verified.root, 'NOTICE'), join(destination, 'NOTICE'))
  return verified.provenance
}

async function installProductionDependencies(appDirectory) {
  const packageJson = JSON.parse(await readFile(join(appRoot, 'package.json'), 'utf8'))
  await cp(join(appRoot, 'package.json'), join(appDirectory, 'package.json'))
  await cp(join(appRoot, 'package-lock.json'), join(appDirectory, 'package-lock.json'))
  const npmCli = process.env.npm_execpath
  if (!npmCli) throw new Error('prepare-runtime must be invoked through npm so the packaging npm CLI is explicit')
  // --omit=optional keeps pdfjs-dist's optional native canvas (@napi-rs/canvas) out of the runtime; Misen never renders with pdf.js.
  execFileSync(process.execPath, [npmCli, 'ci', '--omit=dev', '--omit=optional', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: appDirectory,
    stdio: 'inherit',
  })
  await rm(join(appDirectory, 'node_modules', '.bin'), { recursive: true, force: true })
  await rm(join(appDirectory, 'node_modules', '@types'), { recursive: true, force: true })
  await pruneDependencyDevelopmentArtifacts(join(appDirectory, 'node_modules'))
  await rename(join(appDirectory, 'package-lock.json'), join(appDirectory, 'dependency-lock.json'))
  const runtimePackage = {
    name: '@misen/enterprise-prepared-runtime',
    version: packageJson.version,
    private: true,
    type: 'module',
    engines: packageJson.engines,
    dependencies: packageJson.dependencies,
  }
  await writeFile(join(appDirectory, 'package.json'), `${JSON.stringify(runtimePackage, null, 2)}\n`, 'utf8')
}

async function pruneDependencyDevelopmentArtifacts(root) {
  const developmentDirectories = new Set(['test', 'tests', '__tests__', 'coverage'])
  const developmentSuffixes = ['.ts', '.tsx', '.mts', '.cts', '.map', '.tsbuildinfo']
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        if (developmentDirectories.has(entry.name.toLowerCase())) await rm(path, { recursive: true, force: true })
        else await visit(path)
      } else if (entry.isFile() && developmentSuffixes.some((suffix) => entry.name.toLowerCase().endsWith(suffix))) {
        await rm(path, { force: true })
      }
    }
  }
  await visit(root)
}

async function copyRuntimeDist(appDirectory) {
  const distTarget = join(appDirectory, 'dist')
  await mkdir(distTarget, { recursive: true })
  for (const components of allowedDistRoots) {
    const source = join(appRoot, 'dist', ...components)
    const destination = join(distTarget, ...components)
    await mkdir(dirname(destination), { recursive: true })
    await cp(source, destination, { recursive: true })
  }
  await stat(join(distTarget, 'src', 'web', 'server.js'))
}

function inventoryEntry(path, root) {
  return relative(root, path).replaceAll('\\', '/')
}

async function buildInventory(target) {
  const files = []
  for (const path of await walk(target)) files.push(path)
  const byExtension = {}
  const executableOrScriptFiles = []
  let totalBytes = 0
  for (const path of files) {
    const name = basename(path)
    const dot = name.lastIndexOf('.')
    const extension = dot < 0 ? '<none>' : name.slice(dot).toLowerCase()
    byExtension[extension] = (byExtension[extension] ?? 0) + 1
    totalBytes += (await stat(path)).size
    if (['.exe', '.dll', '.node', '.cmd', '.bat', '.com', '.ps1'].includes(extension)) executableOrScriptFiles.push(inventoryEntry(path, target))
  }
  return { fileCount: files.length, totalBytes, byExtension, executableOrScriptFiles }
}

async function countInstalledPackages(nodeModules) {
  return (await walk(nodeModules)).filter(path => basename(path) === 'package.json').length
}

function assertRuntimeBoundary(inventory, wasmFiles) {
  const allowed = new Set(['run.cmd', nodeRuntimeContract.executable, officeCliRuntimeContract.executable])
  const forbiddenNames = inventory.executableOrScriptFiles.filter((path) => !allowed.has(path))
  if (forbiddenNames.length > 0) throw new Error(`unexpected executable or script files: ${forbiddenNames.join(', ')}`)
  const extensions = inventory.byExtension
  if ((extensions['.node'] ?? 0) !== 0 || (extensions['.dll'] ?? 0) !== 0 || (extensions['.exe'] ?? 0) !== 2) throw new Error('native runtime inventory must contain exactly the approved Node and OfficeCLI executables')
  const strayWasm = wasmFiles.filter((path) => !allowedWasmDirectories.some((directory) => path.startsWith(directory)))
  if (strayWasm.length > 0) throw new Error(`unexpected WebAssembly files: ${strayWasm.join(', ')}`)
}

async function wasmInventory(target) {
  return (await walk(target)).map((path) => inventoryEntry(path, target)).filter((path) => path.toLowerCase().endsWith('.wasm'))
}

async function writeHashes(target) {
  const paths = (await walk(target)).filter((path) => basename(path) !== 'SHA256SUMS.txt')
  const lines = []
  for (const path of paths) lines.push(`${await sha256(path)}  ${inventoryEntry(path, target)}`)
  await writeFile(join(target, 'SHA256SUMS.txt'), `${lines.join('\n')}\n`, 'utf8')
}

export async function prepareRuntime({ output, nodeRuntime, officeCliRuntime }) {
  const target = resolve(output)
  if (!nodeRuntime) throw new Error('--node-runtime is required')
  if (!officeCliRuntime) throw new Error('--officecli-runtime is required')
  await ensureCleanTarget(target)
  await mkdir(target, { recursive: true })

  try {
    const appDirectory = join(target, 'app')
    await mkdir(appDirectory, { recursive: true })
    await copyRuntimeDist(appDirectory)
    await installProductionDependencies(appDirectory)
    await copyNodeRuntime(target, nodeRuntime)
    const officeCliProvenance = await copyOfficeCliRuntime(target, officeCliRuntime)

    const fixtureModule = await import(pathToFileURL(join(appRoot, 'dist', 'demo', 'enterprise-excel', 'fixtures.js')).href)
    await fixtureModule.createEnterpriseFixtureWorkspace(join(target, 'workspace'))
    for (const path of await walk(join(target, 'workspace'))) if (path.toLowerCase().endsWith('.xlsx')) await canonicalizeZipTimestamps(path)

    const launcher = [
      '@echo off',
      'setlocal',
      'set "MISEN_ROOT=%~dp0"',
      'set "MISEN_NODE=%MISEN_ROOT%runtime\\node\\node.exe"',
      'set "MISEN_OFFICECLI_PATH=%MISEN_ROOT%runtime\\officecli\\officecli.exe"',
      'if not exist "%MISEN_NODE%" (',
      '  echo Misen bundled Node.js runtime is missing. 1>&2',
      '  exit /b 1',
      ')',
      'if not exist "%MISEN_OFFICECLI_PATH%" (',
      '  echo Misen bundled OfficeCLI runtime is missing. 1>&2',
      '  exit /b 1',
      ')',
      'set "OFFICECLI_NO_AUTO_RESIDENT=1"',
      'set "OFFICECLI_SKIP_UPDATE=1"',
      'if "%~1"=="" (set "MISEN_WORKSPACE=%MISEN_ROOT%workspace") else set "MISEN_WORKSPACE=%~f1"',
      '"%MISEN_NODE%" "%MISEN_ROOT%app\\dist\\src\\web\\server.js" "%MISEN_WORKSPACE%"',
      'exit /b %errorlevel%',
      '',
    ].join('\r\n')
    await writeFile(join(target, 'run.cmd'), launcher, 'utf8')

    const lockHash = await sha256(join(appDirectory, 'dependency-lock.json'))
    const applicationVersion = JSON.parse(await readFile(join(appDirectory, 'package.json'), 'utf8')).version
    const productionDependencyPackageCount = await countInstalledPackages(join(appDirectory, 'node_modules'))
    const preliminaryInventory = await buildInventory(target)
    const wasmFiles = await wasmInventory(target)
    assertRuntimeBoundary(preliminaryInventory, wasmFiles)
    const manifest = {
      schemaVersion: 5,
      applicationVersion,
      buildGitSha: informationalBuildGitSha(),
      gitMetadataPolicy: 'informational-only',
      node: {
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
        resolution: nodeRuntimeContract.resolution,
        externalRuntimeRequired: false,
      },
      officeCli: officeCliProvenance,
      launcher: 'run.cmd',
      entrypoint: 'app/dist/src/web/server.js',
      defaultWorkspace: 'workspace',
      modelVisibleWorkspacePaths: [
        'workspace/AGENTS.md',
        'workspace/.agents/skills/monthly-report/SKILL.md',
      ],
      requiredPaths: [
        'run.cmd',
        nodeRuntimeContract.executable,
        nodeRuntimeContract.license,
        officeCliRuntimeContract.executable,
        officeCliRuntimeContract.license,
        officeCliRuntimeContract.notice,
        'app/package.json',
        'app/dependency-lock.json',
        'app/dist/src/web/server.js',
        'app/dist/src/web/artifacts.js',
        'app/dist/src/web/sessions.js',
        'app/dist/web/assets/client.js',
        'app/dist/web/assets/client.css',
        'app/node_modules',
        'workspace/AGENTS.md',
        'workspace/.agents/skills/monthly-report/SKILL.md',
        'workspace/業務引継ぎ.md',
        'workspace/master.xlsx',
        'workspace/月次管理レポート_template.xlsx',
      ],
      dependencyProvenance: {
        source: 'app/dependency-lock.json',
        sha256: lockHash,
        install: 'npm ci --omit=dev --omit=optional --ignore-scripts --no-audit --no-fund (packaging host only)',
        productionDependencyPackageCount,
      },
      runtimePolicy: {
        installsAtRuntime: false,
        buildsAtRuntime: false,
        downloadsAtRuntime: false,
        powershellFallback: false,
        observerOrStudyCodeDistributed: false,
        officeCliAutoUpdate: false,
        officeCliAutoResident: false,
        nativeAddons: false,
        webAssemblyModules: wasmFiles,
      },
      inventory: { ...preliminaryInventory, scope: 'all distributed files except SHA256SUMS.txt' },
    }
    await writeFile(join(target, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    const finalInventory = await buildInventory(target)
    assertRuntimeBoundary(finalInventory, await wasmInventory(target))
    manifest.inventory = { ...finalInventory, scope: 'all distributed files except SHA256SUMS.txt' }
    await writeFile(join(target, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    await writeHashes(target)
    return { target, manifest }
  } catch (error) {
    await rm(target, { recursive: true, force: true })
    throw error
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArguments(process.argv.slice(2))
  if (!args.output || !args['node-runtime'] || !args['officecli-runtime']) throw new Error('usage: prepare-runtime --output <clean-directory> --node-runtime <verified-node-input> --officecli-runtime <verified-officecli-input>')
  const result = await prepareRuntime({ output: args.output, nodeRuntime: args['node-runtime'], officeCliRuntime: args['officecli-runtime'] })
  console.log(JSON.stringify(result.manifest, null, 2))
}
