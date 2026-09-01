import test from 'node:test'
import { strict as assert } from 'node:assert'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fixture, PROMPTS } from '../demo/enterprise-excel/fixtures.js'
import { createDemoServer, type DemoRunner } from '../src/web/server.js'

async function start(root: string, runner: DemoRunner) {
  const server = createDemoServer(root, runner)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  return { server, base: `http://127.0.0.1:${address.port}` }
}

test('assistant-ui composition keeps the conversation surface restrained and safe', async () => {
  const source = await readFile(join(process.cwd(), 'src', 'web', 'client.tsx'), 'utf8')
  const styles = await readFile(join(process.cwd(), 'src', 'web', 'client.css'), 'utf8')
  assert.match(source, /useExternalStoreRuntime/)
  assert.match(source, /ThreadPrimitive\.Viewport/)
  assert.match(source, /ThreadPrimitive\.ViewportFooter/)
  assert.match(source, /ThreadPrimitive\.ScrollToBottom/)
  assert.match(source, /className="thread-viewport" autoScroll turnAnchor="bottom"/)
  assert.match(source, /ComposerPrimitive\.Input/)
  assert.match(source, /ComposerPrimitive\.Send/)
  assert.match(source, /optimistic/)
  assert.match(styles, /prefers-reduced-motion/)
  assert.match(source, /Reasoning:\s*HiddenPart/u)
  assert.doesNotMatch(source, /viewportRef|scrollHeight|scrollTop|clientHeight/)
  const composerRegion = styles.match(/\.composer-region\s*\{(?<rules>[^}]*)\}/u)?.groups?.rules ?? ''
  assert.match(composerRegion, /position:\s*sticky/u)
  assert.doesNotMatch(composerRegion, /position:\s*fixed/u)
  assert.match(source, /process-disclosure/)
  assert.match(source, /artifact-row/)
  for (const label of ['ファイル一覧を確認', '引継ぎ資料を確認', 'Excelを確認', 'Excelを作成', 'Excelを更新']) assert.match(source, new RegExp(label, 'u'))
  assert.match(source, /function Icon/u)
  assert.doesNotMatch(source, /[▣↗◌✓↑■›⌄↓]/u)
  assert.doesNotMatch(source, /assistant-cloud|pi-web|Vercel AI SDK/iu)
})

test('SSE preserves the Brain visible final answer instead of overwriting it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'misen-ui-sse-'))
  await fixture(root)
  await writeFile(join(root, 'output', '7月-月次管理レポート.xlsx'), 'xlsx')
  const runner: DemoRunner = async (_root, month, _prompt, context) => {
    context?.emit({ type: 'tool', phase: 'start', id: 't1', name: 'spreadsheet_read', detail: `${month}/Alpha.xlsx` })
    context?.emit({ type: 'assistant', text: '月次' })
    context?.emit({ type: 'tool', phase: 'end', id: 't1', name: 'spreadsheet_read', status: 'success' })
    context?.emit({ type: 'assistant', text: 'Brainが返した最終回答です。', done: true })
    return { output: `output/${month}-月次管理レポート.xlsx`, tools: ['spreadsheet_read'], axes: ['SHEET'], status: 'PASS' }
  }
  const { server, base } = await start(root, runner)
  const stream = await fetch(`${base}/events`)
  const reader = stream.body!.getReader()
  const decoder = new TextDecoder()
  let received = ''
  const done = new Promise<void>((resolve, reject) => {
    const read = async () => {
      try {
        while (true) {
          const chunk = await reader.read()
          if (chunk.done) return resolve()
          received += decoder.decode(chunk.value, { stream: true })
          if (received.includes('"status":"PASS"')) return resolve()
        }
      } catch (error) { reject(error) }
    }
    void read()
  })
  try {
    const response = await fetch(`${base}/run`, { method: 'POST', redirect: 'manual', headers: { origin: base, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ prompt: PROMPTS['7月'], clientId: 'ui-test-1' }) })
    assert.equal(response.status, 303)
    await done
    assert.match(received, /event: user/)
    assert.match(received, /event: tool/)
    assert.match(received, /event: assistant/)
    assert.match(received, /spreadsheet_read/)
    assert.match(received, /Brainが返した最終回答です/u)
    assert.doesNotMatch(received, /月次管理レポートを作成しました/u)
    assert.doesNotMatch(received, /chain.of.thought|provider_payload|api[_-]?key/iu)
  } finally {
    await reader.cancel()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  }
})

test('SSE uses the controlled success fallback only when the Brain emits no visible text', async () => {
  const root = await mkdtemp(join(tmpdir(), 'misen-ui-fallback-'))
  await fixture(root)
  await writeFile(join(root, 'output', '7月-月次管理レポート.xlsx'), 'xlsx')
  const runner: DemoRunner = async (_root, month) => ({ output: `output/${month}-月次管理レポート.xlsx`, tools: [], axes: ['SHEET'], status: 'PASS' })
  const { server, base } = await start(root, runner)
  const stream = await fetch(`${base}/events`)
  const reader = stream.body!.getReader()
  const decoder = new TextDecoder()
  let received = ''
  const done = (async () => {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) return
      received += decoder.decode(chunk.value, { stream: true })
      if (received.includes('"status":"PASS"')) return
    }
  })()
  try {
    const response = await fetch(`${base}/run`, { method: 'POST', redirect: 'manual', headers: { origin: base, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ prompt: PROMPTS['7月'], clientId: 'ui-fallback-1' }) })
    assert.equal(response.status, 303)
    await done
    assert.match(received, /月次管理レポートを作成しました/u)
  } finally {
    await reader.cancel()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  }
})

test('cancel endpoint invokes the current Pi run and never exposes an arbitrary artifact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'misen-ui-cancel-'))
  await fixture(root)
  await writeFile(join(root, 'output', 'safe.xlsx'), 'safe')
  let cancel: (() => void) | undefined
  let released = false
  const runner: DemoRunner = async (_root, month, _prompt, context) => {
    await new Promise<void>(resolve => { cancel = () => { released = true; resolve() }; context?.setCancel(cancel) })
    return { output: `output/${month}-月次管理レポート.xlsx`, tools: [], axes: [], status: 'CANCELLED' }
  }
  const { server, base } = await start(root, runner)
  const stream = await fetch(`${base}/events`)
  const reader = stream.body!.getReader()
  const decoder = new TextDecoder()
  let received = ''
  const watch = (async () => {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      received += decoder.decode(part.value, { stream: true })
      if (received.includes('"status":"CANCELLED"')) break
    }
  })()
  try {
    const run = fetch(`${base}/run`, { method: 'POST', redirect: 'manual', headers: { origin: base, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ prompt: PROMPTS['8月'], clientId: 'ui-cancel-1' }) })
    await new Promise(resolve => setTimeout(resolve, 20))
    const cancelResponse = await fetch(`${base}/cancel`, { method: 'POST', headers: { origin: base } })
    assert.equal(cancelResponse.status, 202)
    await run
    await watch
    assert.equal(released, true)
    assert.match(received, /CANCELLED/)
    const download = await fetch(`${base}/download`)
    assert.equal(download.status, 404)
    const state = await (await fetch(`${base}/state`)).json() as { artifacts: unknown[] }
    assert.deepEqual(state.artifacts, [])
  } finally {
    await reader.cancel()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  }
})
