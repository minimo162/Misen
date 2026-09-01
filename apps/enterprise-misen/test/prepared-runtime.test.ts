import test from 'node:test'
import { strict as assert } from 'node:assert'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const baseline = '06804c5eb0c8f9e42322d66b11c2f5ae0153da69'

test('distribution entrypoint is the emitted server and demo invokes that exact path', async () => {
  const packageJson = JSON.parse(await readFile('package.json', 'utf8')) as { scripts: Record<string, string> }
  assert.equal(packageJson.scripts.demo, 'npm run build && node dist/src/web/server.js')
  await access('dist/src/web/server.js')
  await assert.rejects(access('dist/web/server.js'), /ENOENT/u)
})

test('prepared-runtime generator rejects invalid provenance and preserves nonempty targets', async () => {
  const module = await import(pathToFileURL(join(process.cwd(), 'scripts', 'prepare-runtime.mjs')).href) as { prepareRuntime(options: { output: string; sourceSha: string; packagingSha: string }): Promise<unknown> }
  const prepareRuntime = module.prepareRuntime
  const root = await mkdtemp(join(tmpdir(), 'misen-prepare-contract-'))
  const output = join(root, 'output')
  try {
    await assert.rejects(prepareRuntime({ output, sourceSha: 'invalid', packagingSha: baseline }), /source-sha/u)
    await writeFile(join(root, 'marker.txt'), 'preserve', 'utf8')
    await assert.rejects(prepareRuntime({ output: root, sourceSha: baseline, packagingSha: baseline }), /absent or empty/u)
    assert.equal(await readFile(join(root, 'marker.txt'), 'utf8'), 'preserve')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
