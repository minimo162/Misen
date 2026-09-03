// Incremental build for Enterprise Misen (Issue #93 C).
//
// `npm run build` used to run clean -> tsc -> esbuild on every invocation, including every `npm test`.
// This script hashes every build input (sources, tests, tsconfig, lockfile, the client bundler script and
// the Node version) and skips the whole build when the digest matches the stamp written by the last
// successful build. Stale compiled tests whose TypeScript source has been removed or renamed are pruned so
// `node --test dist/test/...` never runs a test that no longer exists. `--force` rebuilds unconditionally;
// `npm run clean` still removes dist entirely.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { access, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const distRoot = join(appRoot, 'dist')
const stampPath = join(distRoot, '.build-stamp.json')
const inputDirectories = ['src', 'test', 'acceptance', 'study', 'demo']
const inputFiles = ['tsconfig.json', 'package.json', 'package-lock.json', 'scripts/build-client.mjs']
const requiredOutputs = ['dist/src/web/server.js', 'dist/web/assets/client.js', 'dist/web/assets/client.css']

async function walk(root, files) {
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return files
    throw error
  }
  entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
  for (const entry of entries) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) await walk(path, files)
    else if (entry.isFile()) files.push(path)
  }
  return files
}

export async function buildInputDigest() {
  const files = []
  for (const directory of inputDirectories) await walk(join(appRoot, directory), files)
  for (const file of inputFiles) files.push(join(appRoot, file))
  const hash = createHash('sha256')
  hash.update(`node:${process.version}\0`)
  for (const path of files) {
    let bytes
    try {
      bytes = await readFile(path)
    } catch (error) {
      if (error?.code === 'ENOENT') continue
      throw error
    }
    hash.update(relative(appRoot, path).replaceAll('\\', '/'))
    hash.update('\0')
    hash.update(bytes)
    hash.update('\0')
  }
  return hash.digest('hex')
}

async function outputsPresent() {
  try {
    await Promise.all(requiredOutputs.map((path) => access(join(appRoot, path))))
    return true
  } catch {
    return false
  }
}

async function readStamp() {
  try {
    return JSON.parse(await readFile(stampPath, 'utf8'))
  } catch {
    return null
  }
}

async function pruneStaleCompiledTests() {
  const sources = new Set()
  for (const path of await walk(join(appRoot, 'test'), [])) {
    const name = relative(join(appRoot, 'test'), path).replaceAll('\\', '/')
    if (name.endsWith('.ts') || name.endsWith('.tsx')) sources.add(name.replace(/\.tsx?$/u, '.js'))
  }
  const removed = []
  for (const path of await walk(join(distRoot, 'test'), [])) {
    const name = relative(join(distRoot, 'test'), path).replaceAll('\\', '/')
    if (name.endsWith('.js') && !sources.has(name)) {
      await rm(path, { force: true })
      removed.push(name)
    }
  }
  return removed
}

function run(file, args) {
  execFileSync(file, args, { cwd: appRoot, stdio: 'inherit', windowsHide: true })
}

export async function ensureBuilt({ force = false, log = console.log } = {}) {
  const started = performance.now()
  const digest = await buildInputDigest()
  const stamp = await readStamp()
  if (!force && stamp?.inputDigest === digest && (await outputsPresent())) {
    log(`[build] skipped: build inputs unchanged since ${stamp.builtAt}`)
    return { skipped: true, ms: Math.round(performance.now() - started) }
  }
  await mkdir(distRoot, { recursive: true })
  run(process.execPath, [join(appRoot, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', join(appRoot, 'tsconfig.json')])
  run(process.execPath, [join(appRoot, 'scripts', 'build-client.mjs')])
  const pruned = await pruneStaleCompiledTests()
  if (pruned.length > 0) log(`[build] pruned stale compiled tests: ${pruned.join(', ')}`)
  await stat(join(appRoot, 'dist', 'src', 'web', 'server.js'))
  await writeFile(stampPath, `${JSON.stringify({ inputDigest: digest, builtAt: new Date().toISOString() }, null, 2)}\n`, 'utf8')
  const ms = Math.round(performance.now() - started)
  log(`[build] completed in ${ms} ms`)
  return { skipped: false, ms }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await ensureBuilt({ force: process.argv.includes('--force') })
}
