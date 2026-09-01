import test from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { request } from 'node:http'
import { fixture, PROMPTS } from '../demo/enterprise-excel/fixtures.js'
import { createDemoServer, encodeRfc5987Value, liveDemoRunner, textFromAssistantMessage, type DemoRunner } from '../src/web/server.js'

async function start(root: string, runner: DemoRunner) {
  const server = createDemoServer(root, runner)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  return { server, base: 'http://127.0.0.1:' + port }
}

async function run(base: string, prompt: string, clientId: string) {
  return fetch(base + '/run', {
    method: 'POST',
    redirect: 'manual',
    headers: { origin: base, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ prompt, clientId }),
  })
}

test('RFC 5987 artifact filenames encode Unicode and attr-char punctuation', () => {
  assert.equal(encodeRfc5987Value("7月's (final).xlsx"), '7%E6%9C%88%27s%20%28final%29.xlsx')
})

test('assistant visible text preserves actual newlines and legitimate backslashes exactly', () => {
  const visible = 'line1\n\nline2\nC:\\Users\\example\nliteral \\n\ncode containing \\\\ backslash'
  assert.equal(textFromAssistantMessage({ role: 'assistant', content: [{ type: 'text', text: visible }] }), visible)
  assert.equal(textFromAssistantMessage({ role: 'toolResult', content: [{ type: 'text', text: '{"workbook":"output/report.xlsx"}' }] }), '')
  assert.equal(textFromAssistantMessage({ role: 'assistant', content: [{ type: 'reasoning', text: 'private' }] }), '')
})

test('loopback HTTP server validates requests and serves only an opaque validated artifact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'misen-web-'))
  await fixture(root)
  await writeFile(join(root, 'output', '7月-月次管理レポート.xlsx'), 'xlsx')
  const runner: DemoRunner = async (_root, month) => ({ output: 'output/' + month + '-月次管理レポート.xlsx', tools: ['spreadsheet_read'], axes: ['SHEET', 'MONTH'] })
  const { server, base } = await start(root, runner)
  try {
    assert.equal(liveDemoRunner.name, 'liveDemoRunner')
    assert.equal((await fetch(base + '/')).status, 200)
    const badHost = await new Promise<number>(resolve => { const req = request({ host: '127.0.0.1', port: new URL(base).port, path: '/', headers: { host: 'evil:1' } }, response => resolve(response.statusCode ?? 0)); req.end() })
    assert.equal(badHost, 400)
    assert.equal((await fetch(base + '/run', { method: 'POST', headers: { origin: 'http://evil', 'content-type': 'application/x-www-form-urlencoded' }, body: 'prompt=x' })).status, 400)
    assert.equal((await fetch(base + '/run', { method: 'POST', headers: { origin: base, 'content-type': 'application/x-www-form-urlencoded' }, body: 'x=' + 'a'.repeat(9000) })).status, 400)
    assert.equal((await fetch(base + '/run', { method: 'POST', headers: { origin: base, 'content-type': 'application/x-www-form-urlencoded' }, body: 'prompt=x' })).status, 400)
    assert.equal((await run(base, PROMPTS['7月'], 'opaque-1')).status, 303)
    const state = await (await fetch(base + '/state')).json() as any
    assert.equal(state.status, 'PASS')
    assert.deepEqual(state.axes, ['SHEET', 'MONTH'])
    assert.deepEqual(state.tools, ['spreadsheet_read'])
    assert.equal(state.artifacts.length, 1)
    assert.match(state.artifacts[0].id, /^[A-Za-z0-9_-]{24}$/u)
    assert.equal(state.artifacts[0].runId, 'opaque-1')
    assert.equal(JSON.stringify(state).includes('output/'), false)
    const download = await fetch(base + '/download/' + state.artifacts[0].id)
    assert.equal(download.status, 200)
    assert.match(download.headers.get('content-disposition') ?? '', /filename\*=UTF-8''7%E6%9C%88-%E6%9C%88%E6%AC%A1%E7%AE%A1%E7%90%86%E3%83%AC%E3%83%9D%E3%83%BC%E3%83%88\.xlsx/u)
    assert.equal(await download.text(), 'xlsx')
    assert.equal((await fetch(base + '/download/AAAAAAAAAAAAAAAAAAAAAAAA')).status, 404)
    assert.equal((await fetch(base + '/download?path=../master.xlsx')).status, 404)
    assert.equal((await run(base, PROMPTS['7月'], 'opaque-1')).status, 400)
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  }
})

test('SSE preserves actual newlines and literal backslashes without exposing a raw output path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'misen-web-events-'))
  await fixture(root)
  await writeFile(join(root, 'output', 'validated.xlsx'), 'xlsx')
  const visible = 'line1\n\nline2\nC:\\Users\\example\nliteral \\n'
  const runner: DemoRunner = async (_root, _month, _prompt, context) => {
    context?.emit({ type: 'assistant', text: visible })
    return { output: 'output/validated.xlsx', tools: [], axes: ['SHEET:PASS'], status: 'PASS' }
  }
  const { server, base } = await start(root, runner)
  const controller = new AbortController()
  try {
    const stream = await fetch(base + '/events', { signal: controller.signal })
    const reader = stream.body!.getReader()
    let received = ''
    const readUntilTerminal = async () => {
      while (!received.includes('"status":"PASS"')) {
        const chunk = await reader.read()
        if (chunk.done) break
        received += new TextDecoder().decode(chunk.value)
      }
    }
    const requestRun = run(base, PROMPTS['7月'], 'newline-1')
    await readUntilTerminal()
    await requestRun
    const assistantData = [...received.matchAll(/event: assistant\ndata: ([^\n]+)\n\n/gu)].map(match => JSON.parse(match[1]!) as { text: string })
    assert.deepEqual(assistantData.map(event => event.text), [visible])
    assert.doesNotMatch(received, /provider_payload|chain.of.thought|api[_-]?key/iu)
    assert.doesNotMatch(received, /"output":"output\//u)
  } finally {
    controller.abort()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  }
})

test('two successful runs retain distinct turn-scoped artifacts and failures add none', async () => {
  const root = await mkdtemp(join(tmpdir(), 'misen-artifact-history-'))
  await fixture(root)
  let invocation = 0
  let releaseSecond: (() => void) | undefined
  const runner: DemoRunner = async () => {
    invocation += 1
    if (invocation === 2) await new Promise<void>(resolve => { releaseSecond = resolve })
    if (invocation === 3) return { output: 'output/fail.xlsx', tools: [], axes: [], status: 'FAIL' }
    if (invocation === 4) return { output: 'output/cancelled.xlsx', tools: [], axes: [], status: 'CANCELLED' }
    const filename = invocation === 1 ? 'July.xlsx' : 'August.xlsx'
    await writeFile(join(root, 'output', filename), invocation === 1 ? 'workbook-A' : 'workbook-B')
    return { output: 'output/' + filename, tools: [], axes: ['SHEET:PASS'], status: 'PASS' }
  }
  const { server, base } = await start(root, runner)
  try {
    assert.equal((await run(base, PROMPTS['7月'], 'run-july')).status, 303)
    const stateAfterJuly = await (await fetch(base + '/state')).json() as any
    assert.equal(stateAfterJuly.artifacts.length, 1)

    const augustRun = run(base, PROMPTS['8月'], 'run-august')
    while (!releaseSecond) await new Promise(resolve => setTimeout(resolve, 5))
    const stateDuringAugust = await (await fetch(base + '/state')).json() as any
    assert.equal(stateDuringAugust.status, 'running')
    assert.deepEqual(stateDuringAugust.artifacts, stateAfterJuly.artifacts)
    releaseSecond()
    assert.equal((await augustRun).status, 303)

    const completed = await (await fetch(base + '/state')).json() as any
    assert.equal(completed.artifacts.length, 2)
    assert.equal(completed.artifacts[0].runId, 'run-july')
    assert.equal(completed.artifacts[1].runId, 'run-august')
    assert.equal(await (await fetch(base + '/download/' + completed.artifacts[0].id)).text(), 'workbook-A')
    assert.equal(await (await fetch(base + '/download/' + completed.artifacts[1].id)).text(), 'workbook-B')
    assert.equal((await fetch(base + '/download/BBBBBBBBBBBBBBBBBBBBBBBB')).status, 404)
    assert.equal((await fetch(base + '/download/../../master.xlsx')).status, 404)

    assert.equal((await run(base, PROMPTS['7月'], 'run-fail')).status, 303)
    assert.equal((await (await fetch(base + '/state')).json() as any).artifacts.length, 2)
    assert.equal((await run(base, PROMPTS['8月'], 'run-cancelled')).status, 303)
    assert.equal((await (await fetch(base + '/state')).json() as any).artifacts.length, 2)
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  }
})
