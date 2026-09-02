import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile, copyFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { nodeRuntimeContract, nodeRuntimeInputManifest } from './node-runtime-contract.mjs'

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

async function ensureCleanTarget(target) {
  await mkdir(dirname(target), { recursive: true })
  try {
    const entries = await readdir(target)
    if (entries.length > 0) throw new Error(`output directory must be absent or empty: ${target}`)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}

async function download(url, path) {
  const response = await fetch(url, { redirect: 'error' })
  if (!response.ok) throw new Error(`download failed (${response.status}): ${url}`)
  await writeFile(path, Buffer.from(await response.arrayBuffer()))
}

function verifyPublishedChecksum(shasums) {
  const expected = `${nodeRuntimeContract.archiveSha256}  ${nodeRuntimeContract.sourceArchive}`
  if (!shasums.split(/\r?\n/u).includes(expected)) throw new Error('official SHASUMS256.txt does not contain the pinned archive identity')
}

function expandArchive(archive, destination) {
  const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const script = 'Expand-Archive -LiteralPath $env:MISEN_NODE_ARCHIVE -DestinationPath $env:MISEN_NODE_EXPANDED -Force'
  execFileSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    stdio: 'inherit',
    env: { ...process.env, MISEN_NODE_ARCHIVE: archive, MISEN_NODE_EXPANDED: destination },
  })
}

export async function acquireNodeRuntime({ output, archive, shasums }) {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Node runtime acquisition requires Windows x64')
  const target = resolve(output)
  await ensureCleanTarget(target)
  const scratch = await mkdtemp(join(tmpdir(), 'misen-node-runtime-acquire-'))
  try {
    const archivePath = archive ? resolve(archive) : join(scratch, nodeRuntimeContract.sourceArchive)
    const shasumsPath = shasums ? resolve(shasums) : join(scratch, 'SHASUMS256.txt')
    if (!archive) await download(nodeRuntimeContract.sourceArchiveUrl, archivePath)
    if (!shasums) await download(nodeRuntimeContract.shasumsUrl, shasumsPath)
    const shasumsText = await readFile(shasumsPath, 'utf8')
    verifyPublishedChecksum(shasumsText)
    if (await sha256(archivePath) !== nodeRuntimeContract.archiveSha256) throw new Error('Node source archive SHA-256 mismatch')

    const expanded = join(scratch, 'expanded')
    expandArchive(archivePath, expanded)
    const distributionRoot = join(expanded, `node-v${nodeRuntimeContract.version}-win-x64`)
    const sourceExecutable = join(distributionRoot, 'node.exe')
    const sourceLicense = join(distributionRoot, 'LICENSE')
    await stat(sourceExecutable)
    await stat(sourceLicense)
    if (await sha256(sourceExecutable) !== nodeRuntimeContract.executableSha256) throw new Error('Node executable SHA-256 mismatch')
    if (await sha256(sourceLicense) !== nodeRuntimeContract.licenseSha256) throw new Error('Node LICENSE SHA-256 mismatch')
    const version = execFileSync(sourceExecutable, ['--version'], { encoding: 'utf8' }).trim()
    if (version !== `v${nodeRuntimeContract.version}`) throw new Error(`unexpected Node executable version: ${version}`)

    await mkdir(target, { recursive: true })
    await copyFile(sourceExecutable, join(target, 'node.exe'))
    await copyFile(sourceLicense, join(target, 'LICENSE'))
    const provenance = {
      schemaVersion: 1,
      ...nodeRuntimeContract,
      executable: 'node.exe',
      license: 'LICENSE',
      verifiedAgainstOfficialShasums: true,
    }
    await writeFile(join(target, nodeRuntimeInputManifest), `${JSON.stringify(provenance, null, 2)}\n`, 'utf8')
    return { target, provenance }
  } catch (error) {
    await rm(target, { recursive: true, force: true })
    throw error
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArguments(process.argv.slice(2))
  if (!args.output) throw new Error('usage: acquire-node-runtime --output <clean-directory> [--archive <official-zip>] [--shasums <official-SHASUMS256.txt>]')
  const result = await acquireNodeRuntime({ output: args.output, archive: args.archive, shasums: args.shasums })
  console.log(JSON.stringify(result.provenance, null, 2))
}
