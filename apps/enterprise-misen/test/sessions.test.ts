import test from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fixture } from '../demo/enterprise-excel/fixtures.js'
import { createDemoServer, type AgentRunner } from '../src/web/server.js'
import { DEFAULT_SESSION_TITLE, LocalSessionStore, MAX_SESSION_TITLE_LENGTH, localSessionDirectory, titleFromFirstUserMessage } from '../src/web/sessions.js'

async function listen(root: string, sessionDirectory: string, runner: AgentRunner, now?: () => Date) {
  const server = createDemoServer(root, runner, undefined, { sessionDirectory, now })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  return { server, base }
}

async function createSession(base: string) {
  const response = await fetch(`${base}/sessions`, { method: 'POST', headers: { origin: base } })
  assert.equal(response.status, 201)
  return response.json() as Promise<{ id: string; title: string }>
}

async function run(base: string, sessionId: string, prompt: string, clientId: string) {
  return fetch(`${base}/run`, {
    method: 'POST',
    redirect: 'manual',
    headers: { origin: base, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ sessionId, prompt, clientId }),
  })
}

async function close(server: ReturnType<typeof createDemoServer>) {
  await new Promise<void>(resolve => server.close(() => resolve()))
}

test('local title is deterministic, single-line, bounded, and needs no Brain request', () => {
  assert.equal(titleFromFirstUserMessage('  8月\n\n 月次\tレポート  '), '8月 月次 レポート')
  const title = titleFromFirstUserMessage('あ'.repeat(100))
  assert.equal(Array.from(title).length, MAX_SESSION_TITLE_LENGTH)
  assert.equal(title.endsWith('…'), true)
  assert.equal(titleFromFirstUserMessage('  '), DEFAULT_SESSION_TITLE)
  assert.equal(localSessionDirectory({ LOCALAPPDATA: 'C:\\Users\\standard\\AppData\\Local' }), 'C:\\Users\\standard\\AppData\\Local\\Misen\\data\\sessions')
})

test('empty history, persistence, ordering, safe reopen, and distinct new chat survive server restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'misen-history-root-'))
  const local = await mkdtemp(join(tmpdir(), 'misen-history-local-'))
  const directory = join(local, 'Misen', 'data', 'sessions')
  await fixture(root)
  let current = new Date('2026-09-03T01:00:00.000Z')
  let providerRuns = 0
  const runner: AgentRunner = async (_root, _prompt, context) => {
    providerRuns += 1
    context?.emit({ type: 'assistant', text: '保存された回答です。', done: true })
    return { tools: [], status: 'COMPLETED' }
  }
  const firstServer = await listen(root, directory, runner, () => current)
  let firstId = ''
  try {
    assert.deepEqual(await (await fetch(`${firstServer.base}/sessions`)).json(), [])
    const first = await createSession(firstServer.base)
    firstId = first.id
    assert.equal(first.title, DEFAULT_SESSION_TITLE)
    assert.equal((await run(firstServer.base, first.id, '  8月\n月次レポートを確認  ', 'history-run-1')).status, 303)
    const reopened = await (await fetch(`${firstServer.base}/sessions/${first.id}`)).json() as any
    assert.equal(reopened.title, '8月 月次レポートを確認')
    assert.deepEqual(reopened.messages.map((message: any) => [message.role, message.text]), [
      ['user', '  8月\n月次レポートを確認  '],
      ['assistant', '保存された回答です。'],
    ])
    assert.equal((await run(firstServer.base, first.id, '偽continuationは禁止', 'history-run-2')).status, 400)
    assert.equal(providerRuns, 1)
  } finally {
    await close(firstServer.server)
  }

  current = new Date('2026-09-03T02:00:00.000Z')
  const restarted = await listen(root, directory, async () => { providerRuns += 1; throw new Error('history must not call Brain') }, () => current)
  try {
    const listAfterRestart = await (await fetch(`${restarted.base}/sessions`)).json() as any[]
    assert.equal(listAfterRestart.length, 1)
    assert.equal(listAfterRestart[0].id, firstId)
    const reopenedAfterRestart = await (await fetch(`${restarted.base}/sessions/${firstId}`)).json() as any
    assert.equal(reopenedAfterRestart.messages[1].text, '保存された回答です。')
    const second = await createSession(restarted.base)
    assert.notEqual(second.id, firstId)
    const newestFirst = await (await fetch(`${restarted.base}/sessions`)).json() as any[]
    assert.deepEqual(newestFirst.map(item => item.id), [second.id, firstId])
    assert.equal(providerRuns, 1, 'list/create/reopen history add zero provider requests')
  } finally {
    await close(restarted.server)
    await rm(root, { recursive: true, force: true })
    await rm(local, { recursive: true, force: true })
  }
})

test('one corrupt session is ignored and runtime/provider secrets are never serialized', async () => {
  const local = await mkdtemp(join(tmpdir(), 'misen-history-corrupt-'))
  const directory = join(local, 'sessions')
  const store = new LocalSessionStore(directory, () => new Date('2026-09-03T03:00:00.000Z'))
  try {
    const valid = await store.create()
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'AAAAAAAAAAAAAAAAAAAAAAAA.json'), '{broken', 'utf8')
    const previous = process.env.OPENAI_API_KEY
    process.env.OPENAI_API_KEY = 'SECRET_MUST_NOT_APPEAR_IN_HISTORY'
    try {
      assert.deepEqual((await store.list()).map(session => session.id), [valid.id])
      assert.doesNotMatch(await readFile(join(directory, `${valid.id}.json`), 'utf8'), /SECRET_MUST_NOT_APPEAR_IN_HISTORY/u)
    } finally {
      if (previous === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = previous
    }
  } finally {
    await rm(local, { recursive: true, force: true })
  }
})

test('artifact metadata reopens only while the exact bounded workspace artifact still exists', async () => {
  const root = await mkdtemp(join(tmpdir(), 'misen-history-artifact-root-'))
  const local = await mkdtemp(join(tmpdir(), 'misen-history-artifact-local-'))
  const directory = join(local, 'sessions')
  await fixture(root)
  const runner: AgentRunner = async () => {
    await writeFile(join(root, 'output', '履歴成果物.xlsx'), 'frozen artifact bytes')
    return { tools: ['spreadsheet_create_output'], status: 'COMPLETED' }
  }
  const firstServer = await listen(root, directory, runner)
  let sessionId = ''
  let oldDownloadId = ''
  try {
    sessionId = (await createSession(firstServer.base)).id
    assert.equal((await run(firstServer.base, sessionId, '成果物を作成', 'artifact-history-1')).status, 303)
    const session = await (await fetch(`${firstServer.base}/sessions/${sessionId}`)).json() as any
    assert.equal(session.artifacts[0].available, true)
    oldDownloadId = session.artifacts[0].id
    assert.equal(await (await fetch(`${firstServer.base}/download/${oldDownloadId}`)).text(), 'frozen artifact bytes')
  } finally {
    await close(firstServer.server)
  }

  await rm(join(root, 'output', '履歴成果物.xlsx'))
  const restarted = await listen(root, directory, async () => { throw new Error('not called') })
  try {
    const reopened = await (await fetch(`${restarted.base}/sessions/${sessionId}`)).json() as any
    assert.deepEqual(reopened.artifacts.map((artifact: any) => ({ filename: artifact.filename, available: artifact.available, id: artifact.id })), [
      { filename: '履歴成果物.xlsx', available: false, id: '' },
    ])
    assert.equal((await fetch(`${restarted.base}/download/${oldDownloadId}`)).status, 404)
  } finally {
    await close(restarted.server)
    await rm(root, { recursive: true, force: true })
    await rm(local, { recursive: true, force: true })
  }
})
