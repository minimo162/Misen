import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { officeCliRuntimeContract, officeCliRuntimeInputManifest } from './officecli-runtime-contract.mjs'

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

async function bytesFrom(path, url) {
  if (path) return await readFile(resolve(path))
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok) throw new Error('download failed with HTTP ' + response.status + ': ' + url)
  return Buffer.from(await response.arrayBuffer())
}

async function ensureCleanTarget(target) {
  try {
    const entries = await readdir(target)
    if (entries.length > 0) throw new Error('output directory must be absent or empty: ' + target)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}

export async function acquireOfficeCliRuntime({ output, executable, license, notice }) {
  const target = resolve(output)
  await ensureCleanTarget(target)
  const staging = join(dirname(target), '.' + basename(target) + '.officecli-acquire-' + process.pid + '-' + Date.now())
  try {
    await mkdir(staging, { recursive: false })
    const [executableBytes, licenseBytes, noticeBytes] = await Promise.all([
      bytesFrom(executable, officeCliRuntimeContract.releaseArtifactUrl),
      bytesFrom(license, officeCliRuntimeContract.licenseUrl),
      bytesFrom(notice, officeCliRuntimeContract.noticeUrl),
    ])
    if (sha256(executableBytes) !== officeCliRuntimeContract.releaseArtifactSha256) throw new Error('OfficeCLI executable SHA-256 mismatch')
    if (sha256(licenseBytes) !== officeCliRuntimeContract.licenseSha256) throw new Error('OfficeCLI LICENSE SHA-256 mismatch')
    if (sha256(noticeBytes) !== officeCliRuntimeContract.noticeSha256) throw new Error('OfficeCLI NOTICE SHA-256 mismatch')
    const executablePath = join(staging, 'officecli.exe')
    await writeFile(executablePath, executableBytes, { flag: 'wx', mode: 0o755 })
    await writeFile(join(staging, 'LICENSE'), licenseBytes, { flag: 'wx' })
    await writeFile(join(staging, 'NOTICE'), noticeBytes, { flag: 'wx' })
    const version = execFileSync(executablePath, ['--version'], {
      encoding: 'utf8',
      env: { ...process.env, OFFICECLI_NO_AUTO_RESIDENT: '1', OFFICECLI_SKIP_UPDATE: '1' },
      windowsHide: true,
    }).trim()
    if (version !== officeCliRuntimeContract.version) throw new Error('OfficeCLI executable version mismatch: ' + version)
    const provenance = {
      schemaVersion: 1,
      ...officeCliRuntimeContract,
      verifiedVersion: version,
      verifiedReleaseArtifactSha256: true,
      installsAtRuntime: false,
      downloadsAtRuntime: false,
    }
    await writeFile(join(staging, officeCliRuntimeInputManifest), JSON.stringify(provenance, null, 2) + '\n', 'utf8')
    await rename(staging, target)
    return { target, provenance }
  } catch (error) {
    await rm(staging, { recursive: true, force: true })
    throw error
  }
}

function parseArguments(argv) {
  const result = {}
  for (let index = 0; index < argv.length; index += 2) {
    if (!argv[index]?.startsWith('--') || argv[index + 1] === undefined) throw new Error('invalid arguments')
    result[argv[index].slice(2)] = argv[index + 1]
  }
  return result
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const args = parseArguments(process.argv.slice(2))
  if (!args.output) throw new Error('usage: acquire-officecli-runtime --output <clean-directory> [--executable <file> --license <file> --notice <file>]')
  console.log(JSON.stringify((await acquireOfficeCliRuntime(args)).provenance, null, 2))
}
