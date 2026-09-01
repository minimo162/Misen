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

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const productionBaselineSha = '06804c5eb0c8f9e42322d66b11c2f5ae0153da69'
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

async function ensureCleanTarget(target) {
  const parent = dirname(target)
  await mkdir(parent, { recursive: true })
  try {
    const entries = await readdir(target)
    if (entries.length > 0) throw new Error(`output directory must be absent or empty: ${target}`)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}

function git(args) {
  return execFileSync('git', args, { cwd: appRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function quietGitDiff(args) {
  try { execFileSync('git', ['diff', '--quiet', ...args], { cwd: appRoot, stdio: 'ignore' }) }
  catch { throw new Error('packaging repository provenance mismatch') }
}

function verifyPackagingProvenance(sourceSha, packagingSha) {
  if (sourceSha !== productionBaselineSha) throw new Error(`--source-sha must equal frozen production baseline ${productionBaselineSha}`)
  if (git(['rev-parse', 'HEAD']) !== packagingSha) throw new Error('--packaging-sha must equal current HEAD')
  const protectedPaths = ['apps/enterprise-misen/src', 'apps/enterprise-misen/acceptance', 'apps/enterprise-misen/demo', 'apps/enterprise-misen/package-lock.json']
  const packagingPaths = ['apps/enterprise-misen/package.json', 'apps/enterprise-misen/docs/prepared-runtime.md', 'apps/enterprise-misen/scripts/prepare-runtime.mjs', 'apps/enterprise-misen/scripts/verify-prepared-runtime.mjs']
  quietGitDiff([sourceSha, 'HEAD', '--', ...protectedPaths])
  quietGitDiff(['HEAD', '--', ...protectedPaths, ...packagingPaths])
  quietGitDiff(['--cached', 'HEAD', '--', ...protectedPaths, ...packagingPaths])
  if (git(['ls-files', '--others', '--exclude-standard', '--', ...protectedPaths, ...packagingPaths])) throw new Error('untracked production or packaging files reject provenance')
}

async function installProductionDependencies(appDirectory) {
  const packageJson = JSON.parse(await readFile(join(appRoot, 'package.json'), 'utf8'))
  await cp(join(appRoot, 'package.json'), join(appDirectory, 'package.json'))
  await cp(join(appRoot, 'package-lock.json'), join(appDirectory, 'package-lock.json'))
  const npmCli = process.env.npm_execpath
  if (!npmCli) throw new Error('prepare-runtime must be invoked through npm so the packaging npm CLI is explicit')
  execFileSync(process.execPath, [npmCli, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: appDirectory,
    stdio: 'inherit',
  })
  // Package-manager command shims are unnecessary for the server and would
  // broaden the executable surface on the target machine.
  await rm(join(appDirectory, 'node_modules', '.bin'), { recursive: true, force: true })
  // Type declarations are packaging-host metadata and are not loaded by Node.
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
  const files = await walk(target)
  const byExtension = {}
  const executableOrScriptFiles = []
  let totalBytes = 0
  for (const path of files) {
    const name = basename(path)
    const dot = name.lastIndexOf('.')
    const extension = dot < 0 ? '<none>' : name.slice(dot).toLowerCase()
    byExtension[extension] = (byExtension[extension] ?? 0) + 1
    totalBytes += (await stat(path)).size
    if (['.exe', '.dll', '.node', '.cmd', '.bat', '.com', '.ps1'].includes(extension)) {
      executableOrScriptFiles.push(inventoryEntry(path, target))
    }
  }
  return { fileCount: files.length, totalBytes, byExtension, executableOrScriptFiles }
}

async function countInstalledPackages(nodeModules) {
  return (await walk(nodeModules)).filter(path => basename(path) === 'package.json').length
}

function assertRuntimeBoundary(inventory) {
  const forbiddenNames = inventory.executableOrScriptFiles.filter((path) => path !== 'run.cmd')
  if (forbiddenNames.length > 0) throw new Error(`unexpected executable or script files: ${forbiddenNames.join(', ')}`)
  const extensions = inventory.byExtension
  if ((extensions['.node'] ?? 0) !== 0 || (extensions['.dll'] ?? 0) !== 0 || (extensions['.exe'] ?? 0) !== 0) {
    throw new Error('native runtime files are not permitted')
  }
}

async function writeHashes(target) {
  const paths = (await walk(target)).filter((path) => basename(path) !== 'SHA256SUMS.txt')
  const lines = []
  for (const path of paths) lines.push(`${await sha256(path)}  ${inventoryEntry(path, target)}`)
  await writeFile(join(target, 'SHA256SUMS.txt'), `${lines.join('\n')}\n`, 'utf8')
}

export async function prepareRuntime({ output, sourceSha, packagingSha }) {
  const target = resolve(output)
  if (!shaPattern.test(sourceSha)) throw new Error('--source-sha must be a lowercase 40-character Git SHA')
  if (!shaPattern.test(packagingSha)) throw new Error('--packaging-sha must be a lowercase 40-character Git SHA')
  await ensureCleanTarget(target)
  verifyPackagingProvenance(sourceSha, packagingSha)
  await mkdir(target, { recursive: true })

  try {
    const appDirectory = join(target, 'app')
    await mkdir(appDirectory, { recursive: true })
    await copyRuntimeDist(appDirectory)
    await installProductionDependencies(appDirectory)

    const fixtureModule = await import(pathToFileURL(join(appRoot, 'dist', 'demo', 'enterprise-excel', 'fixtures.js')).href)
    await fixtureModule.createEnterpriseFixtureWorkspace(join(target, 'workspace'))
    for (const path of await walk(join(target, 'workspace'))) {
      if (path.toLowerCase().endsWith('.xlsx')) await canonicalizeZipTimestamps(path)
    }

    const launcher = [
      '@echo off',
      'setlocal',
      'set "MISEN_ROOT=%~dp0"',
      'if "%~1"=="" (set "MISEN_WORKSPACE=%MISEN_ROOT%workspace") else set "MISEN_WORKSPACE=%~f1"',
      'node "%MISEN_ROOT%app\\dist\\src\\web\\server.js" "%MISEN_WORKSPACE%"',
      'exit /b %errorlevel%',
      '',
    ].join('\r\n')
    await writeFile(join(target, 'run.cmd'), launcher, 'utf8')

    const lockHash = await sha256(join(appDirectory, 'dependency-lock.json'))
    const productionDependencyPackageCount = await countInstalledPackages(join(appDirectory, 'node_modules'))
    const preliminaryInventory = await buildInventory(target)
    assertRuntimeBoundary(preliminaryInventory)
    const manifest = {
      schemaVersion: 1,
      sourceSha,
      packagingSha,
      node: { requirement: '>=22.19.0', executable: 'node', resolution: 'PATH' },
      launcher: 'run.cmd',
      entrypoint: 'app/dist/src/web/server.js',
      defaultWorkspace: 'workspace',
      requiredPaths: [
        'run.cmd',
        'app/package.json',
        'app/dependency-lock.json',
        'app/dist/src/web/server.js',
        'app/dist/web/assets/client.js',
        'app/dist/web/assets/client.css',
        'app/node_modules',
        'workspace/業務引継ぎ.md',
        'workspace/master.xlsx',
        'workspace/月次管理レポート_template.xlsx',
      ],
      dependencyProvenance: {
        source: 'app/dependency-lock.json',
        sha256: lockHash,
        install: 'npm ci --omit=dev --ignore-scripts --no-audit --no-fund (packaging host only)',
        productionDependencyPackageCount,
      },
      runtimePolicy: {
        installsAtRuntime: false,
        buildsAtRuntime: false,
        downloadsAtRuntime: false,
        powershellFallback: false,
      },
      inventory: { ...preliminaryInventory, scope: 'all distributed files except SHA256SUMS.txt' },
    }
    await writeFile(join(target, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    const finalInventory = await buildInventory(target)
    assertRuntimeBoundary(finalInventory)
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
  if (!args.output || !args['source-sha'] || !args['packaging-sha']) {
    throw new Error('usage: prepare-runtime --output <clean-directory> --source-sha <sha> --packaging-sha <sha>')
  }
  const result = await prepareRuntime({
    output: args.output,
    sourceSha: args['source-sha'],
    packagingSha: args['packaging-sha'],
  })
  console.log(JSON.stringify(result.manifest, null, 2))
}
