import test from 'node:test'
import { strict as assert } from 'node:assert'
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { OfficeCliSpreadsheet } from '../src/spreadsheet/officecli.js'
import { buildOfficeCliInvocation, OfficeCliProcess, OfficeCliProcessError } from '../src/spreadsheet/officecli-process.js'

async function fakeCli() {
  const root = await mkdtemp(join(tmpdir(), 'misen-officecli-process-'))
  const script = join(root, 'fake officecli 日本語.mjs')
  await writeFile(script, `
const args = process.argv.slice(2)
if (args[0] === '--version') { console.log('1.0.147'); process.exit(0) }
const mode = args[0]
if (mode === 'success' || mode === 'echo') console.log(JSON.stringify({success:true,data:{results:[],args}}))
else if (mode === 'nonzero') { console.log(JSON.stringify({success:false,error:{error:'bad workbook',code:'corrupt_file'}})); process.exitCode=7 }
else if (mode === 'malformed') console.log('{bad')
else if (mode === 'stderr') { console.log(JSON.stringify({success:true,data:{results:[]}})); console.error('warning') }
else if (mode === 'unexpected') console.log('[]')
else if (mode === 'large') console.log('x'.repeat(100000))
else if (mode === 'slow') setInterval(() => {}, 1000)
`, 'utf8')
  return { root, script }
}

test('command construction preserves Japanese and spaced arguments without a shell', () => {
  const invocation = buildOfficeCliInvocation('C:\\Program Files\\OfficeCLI\\officecli.exe', ['get', 'C:\\日本語 path\\book.xlsx', '/月次/A1:B2', '--json'])
  assert.deepEqual(invocation.args, ['get', 'C:\\日本語 path\\book.xlsx', '/月次/A1:B2', '--json'])
  assert.equal(invocation.executable, 'C:\\Program Files\\OfficeCLI\\officecli.exe')
})

test('success JSON, non-zero, malformed stdout, stderr diagnostics, and unexpected output are distinct', async () => {
  const fake = await fakeCli()
  try {
    const client = new OfficeCliSpreadsheet({ executable: process.execPath, prefixArgs: [fake.script] })
    const success = await client.json(['echo', 'C:\\日本語 path\\book.xlsx'])
    assert.equal((success.data as any).args[1], 'C:\\日本語 path\\book.xlsx')
    await assert.rejects(client.json(['nonzero']), (error: unknown) => error instanceof OfficeCliProcessError && error.code === 'corrupt_file' && error.exitCode === 7)
    await assert.rejects(client.json(['malformed']), (error: unknown) => error instanceof OfficeCliProcessError && error.code === 'malformed_stdout')
    const warning = await client.json(['stderr'])
    assert.deepEqual(warning.diagnostics, ['warning'])
    await assert.rejects(client.json(['unexpected']), (error: unknown) => error instanceof OfficeCliProcessError && error.code === 'unexpected_output')
  } finally { await rm(fake.root, { recursive: true, force: true }) }
})

test('timeout, cancellation, missing binary, and output limit terminate deterministically', async () => {
  const fake = await fakeCli()
  try {
    const timeout = new OfficeCliProcess({ executable: process.execPath, prefixArgs: [fake.script], timeoutMs: 100 })
    await assert.rejects(timeout.run(['slow']), (error: unknown) => error instanceof OfficeCliProcessError && error.code === 'timeout')
    const controller = new AbortController()
    const pending = new OfficeCliProcess({ executable: process.execPath, prefixArgs: [fake.script], timeoutMs: 5000 }).run(['slow'], { signal: controller.signal })
    setTimeout(() => controller.abort(), 100)
    await assert.rejects(pending, (error: unknown) => error instanceof Error && error.name === 'AbortError')
    await assert.rejects(new OfficeCliProcess({ executable: join(fake.root, 'missing-officecli.exe') }).run(['--version']), (error: unknown) => error instanceof OfficeCliProcessError && error.code === 'missing_binary')
    await assert.rejects(new OfficeCliProcess({ executable: process.execPath, prefixArgs: [fake.script], maximumOutputBytes: 1024 }).run(['large']), (error: unknown) => error instanceof OfficeCliProcessError && error.code === 'output_limit')
  } finally { await rm(fake.root, { recursive: true, force: true }) }
})

test('a cancelled first version check does not poison later OfficeCLI calls', async () => {
  const fake = await fakeCli()
  try {
    const client = new OfficeCliSpreadsheet({ executable: process.execPath, prefixArgs: [fake.script] })
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(client.ensureVersion(controller.signal), (error: unknown) => error instanceof Error && error.name === 'AbortError')
    await client.ensureVersion()
  } finally { await rm(fake.root, { recursive: true, force: true }) }
})

test('private workbook temp path is removed after success and failure', async () => {
  const fake = await fakeCli()
  try {
    const client = new OfficeCliSpreadsheet({ executable: process.execPath, prefixArgs: [fake.script] })
    let successPath = ''
    await client.withPrivateWorkbook(Buffer.from('bytes'), async path => { successPath = path })
    await assert.rejects(access(dirname(successPath)), /ENOENT/u)
    let failurePath = ''
    await assert.rejects(client.withPrivateWorkbook(Buffer.from('bytes'), async path => { failurePath = path; throw new Error('stop') }), /stop/u)
    await assert.rejects(access(dirname(failurePath)), /ENOENT/u)
  } finally { await rm(fake.root, { recursive: true, force: true }) }
})
