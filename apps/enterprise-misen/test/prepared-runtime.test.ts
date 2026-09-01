import test from 'node:test'
import { strict as assert } from 'node:assert'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const distributionSource = 'df2859c471fac035be062703f59f69e07d55b208'
const behaviorBaseline = 'f3b772f7765206f75f7296e436d89c6a771b690a'

test('distribution entrypoint is the emitted server and demo invokes that exact path', async () => {
  const packageJson = JSON.parse(await readFile('package.json', 'utf8')) as { scripts: Record<string, string> }
  assert.equal(packageJson.scripts.demo, 'npm run build && node dist/src/web/server.js')
  assert.equal(typeof packageJson.scripts['study:checkpoint'], 'string')
  assert.equal(typeof packageJson.scripts['prepare-runtime'], 'string')
  await access('dist/src/web/server.js')
  await assert.rejects(access('dist/web/server.js'), /ENOENT/u)
})

test('prepared-runtime generator binds current distribution source while preserving nonempty targets', async () => {
  const module = await import(pathToFileURL(join(process.cwd(), 'scripts', 'prepare-runtime.mjs')).href) as { prepareRuntime(options: { output: string; sourceSha: string; packagingSha: string }): Promise<unknown> }
  const prepareRuntime = module.prepareRuntime
  const root = await mkdtemp(join(tmpdir(), 'misen-prepare-contract-'))
  const output = join(root, 'output')
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  try {
    await assert.rejects(prepareRuntime({ output, sourceSha: 'invalid', packagingSha: head }), /source-sha/u)
    await assert.rejects(prepareRuntime({ output, sourceSha: behaviorBaseline, packagingSha: head }), /frozen prepared-runtime source/u)
    await writeFile(join(root, 'marker.txt'), 'preserve', 'utf8')
    await assert.rejects(prepareRuntime({ output: root, sourceSha: distributionSource, packagingSha: head }), /absent or empty/u)
    assert.equal(await readFile(join(root, 'marker.txt'), 'utf8'), 'preserve')
    await assert.rejects(prepareRuntime({ output, sourceSha: distributionSource, packagingSha: distributionSource }), /current HEAD/u)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('hash verification requires exact file-set equality and forbids native or study surfaces', async () => {
  const root = await mkdtemp(join(tmpdir(), 'misen-verify-contract-'))
  try {
    const module = await import(pathToFileURL(join(process.cwd(), 'scripts', 'verify-prepared-runtime.mjs')).href) as {
      verifyHashes(root: string): Promise<number>
      findForbiddenNames(root: string): Promise<string[]>
    }
    await mkdir(join(root, 'app'), { recursive: true })
    await writeFile(join(root, 'app', 'server.js'), 'safe', 'utf8')
    const digest = createHash('sha256').update('safe').digest('hex')
    await writeFile(join(root, 'SHA256SUMS.txt'), `${digest}  app/server.js\n`, 'utf8')
    assert.equal(await module.verifyHashes(root), 1)
    await writeFile(join(root, 'evil.node'), 'unlisted', 'utf8')
    await assert.rejects(module.verifyHashes(root), /unlisted=evil\.node/u)
    assert.equal((await module.findForbiddenNames(root)).some(path => path.endsWith('evil.node')), true)
    await mkdir(join(root, 'app', 'dist', 'study'), { recursive: true })
    await writeFile(join(root, 'app', 'dist', 'study', 'observer.js'), 'not distributed', 'utf8')
    assert.equal((await module.findForbiddenNames(root)).some(path => path.includes(join('app', 'dist', 'study'))), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
