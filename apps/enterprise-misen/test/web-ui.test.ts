import test from 'node:test'
import { strict as assert } from 'node:assert'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fixture } from '../demo/enterprise-excel/fixtures.js'
import { createDemoServer, type AgentRunner } from '../src/web/server.js'

async function start(root: string, runner: AgentRunner) {
  const server = createDemoServer(root, runner, undefined, { sessionDirectory: join(root, '.test-data', 'sessions') })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  return { server, base: `http://127.0.0.1:${address.port}` }
}

async function runSession(base: string, prompt: string, clientId: string) {
  const created = await fetch(`${base}/sessions`, { method: 'POST', headers: { origin: base } })
  assert.equal(created.status, 201)
  const session = await created.json() as { id: string }
  return fetch(`${base}/run`, { method: 'POST', redirect: 'manual', headers: { origin: base, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ prompt, clientId, sessionId: session.id }) })
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
  assert.match(source, /aria-label="会話履歴"/u)
  assert.match(source, /新しいチャット/u)
  assert.match(source, /このPCにのみ保存/u)
  assert.match(source, /過去の会話は閲覧のみです/u)
  assert.match(source, /fetch\('\/sessions'\)/u)
  assert.match(styles, /\.history-panel/u)
  assert.match(styles, /@media \(max-width: 760px\)/u)
  for (const label of ['ファイル一覧を確認', '業務ガイドを確認', 'Excelを確認', 'Excelを作成', 'Excelを更新']) assert.match(source, new RegExp(label, 'u'))
  assert.match(source, /function Icon/u)
  assert.doesNotMatch(source, /[▣↗◌✓↑■›⌄↓]/u)
  assert.doesNotMatch(source, /assistant-cloud|pi-web|Vercel AI SDK/iu)
})

test('SSE preserves the Brain visible final answer instead of overwriting it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'misen-ui-sse-'))
  await fixture(root)
  const runner: AgentRunner = async (_root, _prompt, context) => {
    context?.emit({ type: 'tool', phase: 'start', id: 't1', name: 'spreadsheet_read', detail: '8月/Alpha.xlsx' })
    context?.emit({ type: 'assistant', text: '月次' })
    context?.emit({ type: 'tool', phase: 'end', id: 't1', name: 'spreadsheet_read', status: 'success' })
    context?.emit({ type: 'assistant', text: 'Brainが返した最終回答です。', done: true })
    return { tools: ['spreadsheet_read'], status: 'COMPLETED' }
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
          if (received.includes('"status":"COMPLETED"')) return resolve()
        }
      } catch (error) { reject(error) }
    }
    void read()
  })
  try {
    const response = await runSession(base, '8月の利益状況を説明して', 'ui-test-1')
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
  const runner: AgentRunner = async () => ({ tools: [], status: 'COMPLETED' })
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
      if (received.includes('"status":"COMPLETED"')) return
    }
  })()
  try {
    const response = await runSession(base, '自由形式の質問', 'ui-fallback-1')
    assert.equal(response.status, 303)
    await done
    assert.match(received, /処理が完了しました/u)
    assert.doesNotMatch(received, /PASS|月次管理レポートを作成しました/u)
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
  let markRunnerStarted!: () => void
  const runnerStarted = new Promise<void>(resolve => { markRunnerStarted = resolve })
  const runner: AgentRunner = async (_root, _prompt, context) => {
    await new Promise<void>(resolve => {
      cancel = () => { released = true; resolve() }
      context?.setCancel(cancel)
      markRunnerStarted()
    })
    return { tools: [], status: 'CANCELLED' }
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
    const run = runSession(base, 'この処理を開始して', 'ui-cancel-1')
    await runnerStarted
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
