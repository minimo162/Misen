import test from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdir, mkdtemp, readFile, rm, symlink, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { request } from 'node:http'
import { fixture, PROMPTS } from '../demo/enterprise-excel/fixtures.js'
import { MAX_ARTIFACT_BYTES, MAX_SESSION_ARTIFACTS, snapshotOutputArtifacts } from '../src/web/artifacts.js'
import { createDemoServer, encodeRfc5987Value, liveAgentRunner, textFromAssistantMessage, type AgentRunner, type ArtifactObserver, type DemoServerOptions } from '../src/web/server.js'
import { MAX_ATTACHMENT_BYTES } from '../src/web/attachments.js'
import { WorkspaceBoundary } from '../src/workspace/boundary.js'

async function start(root: string, runner: AgentRunner, artifactObserver?: ArtifactObserver, options: DemoServerOptions = {}) {
  const server = createDemoServer(root, runner, artifactObserver, { sessionDirectory: join(root, '.test-data', 'sessions'), ...options })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  return { server, base: 'http://127.0.0.1:' + port }
}

test('file import accepts only supported bounded files, numbers duplicates, and writes metadata audit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'misen-import-'))
  await mkdir(join(root, 'output'))
  const auditPath = join(root, '.test-data', 'audit.jsonl')
  let receivedPrompt = ''
  const { server, base } = await start(root, async (_root, prompt) => { receivedPrompt = prompt; return { tools: [], status: 'COMPLETED' } }, undefined, { auditPath, brainIdentity: async () => ({ provider: 'test', model: 'test-model' }) })
  const upload = (name: string, body: BodyInit) => fetch(base + '/attachments', { method: 'POST', headers: { origin: base, 'content-type': 'application/octet-stream', 'x-misen-filename': encodeURIComponent(name) }, body })
  try {
    const invalid = await upload('malware.exe', 'x')
    assert.equal(invalid.status, 415)
    assert.match(await invalid.text(), /このファイル形式は持ち込めません/u)
    const tooLarge = await new Promise<number>((resolve, reject) => {
      const target = new URL(base)
      const req = request({ host: target.hostname, port: target.port, path: '/attachments', method: 'POST', headers: { origin: base, 'x-misen-filename': 'large.xlsx', 'content-length': String(MAX_ATTACHMENT_BYTES + 1) } }, response => { response.resume(); response.on('end', () => resolve(response.statusCode ?? 0)) })
      req.on('error', reject); req.end()
    })
    assert.equal(tooLarge, 413)
    const first = await upload('危険<>名.xlsx', 'first')
    const second = await upload('危険<>名.xlsx', 'second')
    assert.equal(first.status, 201); assert.equal(second.status, 201)
    const firstValue = await first.json() as { name: string; path: string; size: number; sha256: string }
    const secondValue = await second.json() as { name: string; path: string }
    assert.equal(firstValue.path, 'input/危険_名.xlsx')
    assert.equal(secondValue.path, 'input/危険_名 (2).xlsx')
    assert.equal(await readFile(join(root, firstValue.path), 'utf8'), 'first')
    assert.match(firstValue.sha256, /^[0-9a-f]{64}$/u)
    const created = await fetch(base + '/sessions', { method: 'POST', headers: { origin: base } }); const session = await created.json() as { id: string }
    const runWithImport = await fetch(base + '/run', { method: 'POST', redirect: 'manual', headers: { origin: base, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ prompt: '確認してください。', imports: JSON.stringify([firstValue.path]), clientId: 'attachment-run', sessionId: session.id }) })
    assert.equal(runWithImport.status, 303)
    assert.match(receivedPrompt, /確認してください。\n\n持ち込んだファイル.*input\/危険_名\.xlsx/su)
    const stored = await (await fetch(base + '/sessions/' + session.id)).json() as { messages: { text: string }[] }
    assert.equal(stored.messages[0]?.text, '確認してください。', 'internal input path is not rendered as user prose')
    const audit = (await readFile(auditPath, 'utf8')).trim().split(/\r?\n/u).map(line => JSON.parse(line))
    assert.deepEqual(audit.map(item => item.event), ['file.imported', 'file.imported'])
    assert.equal(audit[0].filename, '危険_名.xlsx'); assert.equal(audit[0].size, 5)
    assert.equal(JSON.stringify(audit).includes('first'), false, 'audit never stores file contents')
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  }
})

test('project endpoints reject arbitrary and UNC paths, use injected picker, block active switching, and audit folder names only', async () => {
  const root = await mkdtemp(join(tmpdir(), 'misen-project-a-'))
  const picked = await mkdtemp(join(tmpdir(), 'misen-project-b-'))
  await mkdir(join(root, 'output')); await mkdir(join(picked, 'output'))
  const projectStatePath = join(root, '.test-data', 'projects.json')
  const auditPath = join(root, '.test-data', 'audit.jsonl')
  let release!: () => void
  let began!: () => void
  const started = new Promise<void>(resolve => { began = resolve })
  const runner: AgentRunner = async runRoot => { assert.equal(runRoot.toLowerCase(), picked.toLowerCase()); began(); await new Promise<void>(resolve => { release = resolve }); await writeFile(join(runRoot, 'output', 'project-result.xlsx'), 'result'); return { tools: [], status: 'COMPLETED' } }
  const { server, base } = await start(root, runner, undefined, { projectStatePath, auditPath, pickFolder: async () => picked, openFolder: async () => undefined, brainIdentity: async () => ({ provider: 'local', model: 'model-a' }) })
  const postJson = (path: string, value?: object) => fetch(base + path, { method: 'POST', headers: { origin: base, ...(value ? { 'content-type': 'application/json' } : {}) }, ...(value ? { body: JSON.stringify(value) } : {}) })
  try {
    const initial = await (await fetch(base + '/project')).json() as any
    assert.equal(initial.name, root.split(/[\\/]/u).at(-1)); assert.equal(initial.provider, 'local'); assert.equal(initial.model, 'model-a')
    assert.equal((await postJson('/project/select', { path: join(root, 'not-remembered') })).status, 400)
    const unc = await postJson('/project/select', { path: '\\\\server\\share' })
    assert.equal(unc.status, 400); assert.match(await unc.text(), /共有フォルダーは直接使えません/u)
    assert.equal((await postJson('/project/pick')).status, 200)
    const selected = await (await fetch(base + '/project')).json() as any
    assert.equal(selected.current.toLowerCase(), picked.toLowerCase()); assert.equal(selected.recent.length, 2)
    const created = await fetch(base + '/sessions', { method: 'POST', headers: { origin: base } }); const session = await created.json() as { id: string }
    const runPromise = fetch(base + '/run', { method: 'POST', redirect: 'manual', headers: { origin: base, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ prompt: '実行', clientId: 'project-run', sessionId: session.id }) })
    await started
    const blocked = await postJson('/project/select', { path: root })
    assert.equal(blocked.status, 409); assert.match(await blocked.text(), /処理が終わってから/u)
    release(); assert.equal((await runPromise).status, 303)
    assert.equal(await readFile(join(picked, 'output', 'project-result.xlsx'), 'utf8'), 'result')
    assert.equal((await postJson('/project/select', { path: root })).status, 200)
    assert.equal((await postJson('/approval', { mode: 'session-auto' })).status, 200)
    assert.equal((await (await fetch(base + '/project')).json() as any).approvalMode, 'session-auto')
    assert.equal((await fetch(base + '/sessions', { method: 'POST', headers: { origin: base } })).status, 201)
    assert.equal((await (await fetch(base + '/project')).json() as any).approvalMode, 'confirm', 'new session does not inherit automatic approval')
    const records = (await readFile(auditPath, 'utf8')).trim().split(/\r?\n/u).map(line => JSON.parse(line))
    assert.deepEqual(records.map(item => item.event), ['project.switched', 'project.switched', 'approval.changed'])
    assert.equal(JSON.stringify(records).includes(picked), false, 'project audit stores only folder names')
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
    await Promise.all([rm(root, { recursive: true, force: true }), rm(picked, { recursive: true, force: true })])
  }
})

async function run(base: string, prompt: string, clientId: string) {
  const created = await fetch(base + '/sessions', { method: 'POST', headers: { origin: base } })
  if (created.status !== 201) return created
  const session = await created.json() as { id: string }
  return fetch(base + '/run', {
    method: 'POST',
    redirect: 'manual',
    headers: { origin: base, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ prompt, clientId, sessionId: session.id }),
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
  let receivedPrompt = ''
  const runner: AgentRunner = async (_root, prompt) => {
    receivedPrompt = prompt
    await writeFile(join(root, 'output', '自由形式.xlsx'), 'xlsx')
    return { tools: ['spreadsheet_read'], status: 'COMPLETED' }
  }
  const { server, base } = await start(root, runner)
  try {
    assert.equal(typeof liveAgentRunner, 'function')
    assert.equal((await fetch(base + '/')).status, 200)
    const badHost = await new Promise<number>(resolve => { const req = request({ host: '127.0.0.1', port: new URL(base).port, path: '/', headers: { host: 'evil:1' } }, response => resolve(response.statusCode ?? 0)); req.end() })
    assert.equal(badHost, 400)
    assert.equal((await fetch(base + '/run', { method: 'POST', headers: { origin: 'http://evil', 'content-type': 'application/x-www-form-urlencoded' }, body: 'prompt=x' })).status, 400)
    assert.equal((await fetch(base + '/run', { method: 'POST', headers: { origin: base, 'content-type': 'application/x-www-form-urlencoded' }, body: 'x=' + 'a'.repeat(9000) })).status, 400)
    assert.equal((await run(base, '   ', 'empty-1')).status, 400)
    assert.equal((await run(base, '任意の依頼', 'bad id')).status, 400)
    const prompt = '8月の3社で利益が最大の会社を教えて'
    assert.ok(!Object.values(PROMPTS).includes(prompt as any))
    assert.equal((await run(base, prompt, 'opaque-1')).status, 303)
    assert.equal(receivedPrompt, prompt)
    const state = await (await fetch(base + '/state')).json() as any
    assert.equal(state.status, 'COMPLETED')
    assert.deepEqual(state.axes, [])
    assert.deepEqual(state.tools, ['spreadsheet_read'])
    assert.equal(state.artifacts.length, 1)
    assert.match(state.artifacts[0].id, /^[A-Za-z0-9_-]{24}$/u)
    assert.equal(state.artifacts[0].runId, 'opaque-1')
    assert.equal(JSON.stringify(state).includes('output/'), false)
    const download = await fetch(base + '/download/' + state.artifacts[0].id)
    assert.equal(download.status, 200)
    assert.match(download.headers.get('content-disposition') ?? '', /filename\*=UTF-8''%E8%87%AA%E7%94%B1%E5%BD%A2%E5%BC%8F\.xlsx/u)
    assert.equal(await download.text(), 'xlsx')
    assert.equal((await fetch(base + '/download/AAAAAAAAAAAAAAAAAAAAAAAA')).status, 404)
    assert.equal((await fetch(base + '/download?path=../master.xlsx')).status, 404)
    assert.equal((await run(base, PROMPTS['7月'], 'opaque-1')).status, 400)
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  }
})

test('opaque artifact publishing serves Word and PowerPoint with correct filenames and MIME types', async () => {
  const root = await mkdtemp(join(tmpdir(), 'misen-web-office-'))
  await mkdir(join(root, 'output'))
  const runner: AgentRunner = async () => {
    await writeFile(join(root, 'output', '日本語 文書.docx'), 'docx-bytes')
    await writeFile(join(root, 'output', '日本語 資料.pptx'), 'pptx-bytes')
    return { tools: ['document_create_output', 'presentation_create_output'], status: 'COMPLETED' }
  }
  const { server, base } = await start(root, runner)
  try {
    assert.equal((await run(base, 'WordとPowerPointを作成して', 'office-artifacts-1')).status, 303)
    const state = await (await fetch(base + '/state')).json() as any
    assert.deepEqual(state.artifacts.map((artifact: any) => artifact.filename), ['日本語 文書.docx', '日本語 資料.pptx'])
    const word = await fetch(base + '/download/' + state.artifacts[0].id)
    assert.equal(word.headers.get('content-type'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
    assert.match(word.headers.get('content-disposition') ?? '', /filename="document\.docx"/u)
    assert.match(word.headers.get('content-disposition') ?? '', /filename\*=UTF-8''%E6%97%A5%E6%9C%AC%E8%AA%9E%20%E6%96%87%E6%9B%B8\.docx/u)
    assert.equal(await word.text(), 'docx-bytes')
    const presentation = await fetch(base + '/download/' + state.artifacts[1].id)
    assert.equal(presentation.headers.get('content-type'), 'application/vnd.openxmlformats-officedocument.presentationml.presentation')
    assert.match(presentation.headers.get('content-disposition') ?? '', /filename="presentation\.pptx"/u)
    assert.equal(await presentation.text(), 'pptx-bytes')
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  }
})

test('SSE preserves actual newlines and literal backslashes without exposing a raw output path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'misen-web-events-'))
  await fixture(root)
  const visible = 'line1\n\nline2\nC:\\Users\\example\nliteral \\n'
  const runner: AgentRunner = async (_root, _prompt, context) => {
    context?.emit({ type: 'assistant', text: visible })
    return { tools: [], status: 'COMPLETED' }
  }
  const { server, base } = await start(root, runner)
  const controller = new AbortController()
  try {
    const stream = await fetch(base + '/events', { signal: controller.signal })
    const reader = stream.body!.getReader()
    let received = ''
    const readUntilTerminal = async () => {
      while (!received.includes('"status":"COMPLETED"')) {
        const chunk = await reader.read()
        if (chunk.done) break
        received += new TextDecoder().decode(chunk.value)
      }
    }
    const requestRun = run(base, '業務引継ぎを要約して', 'newline-1')
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

test('separate conversations retain their own bounded artifacts and failures add none', async () => {
  const root = await mkdtemp(join(tmpdir(), 'misen-artifact-history-'))
  await fixture(root)
  let invocation = 0
  let releaseSecond: (() => void) | undefined
  const runner: AgentRunner = async () => {
    invocation += 1
    if (invocation === 2) await new Promise<void>(resolve => { releaseSecond = resolve })
    if (invocation === 3) return { tools: [], status: 'FAIL' }
    if (invocation === 4) return { tools: [], status: 'CANCELLED' }
    const filename = invocation === 1 ? 'July.xlsx' : 'August.xlsx'
    await writeFile(join(root, 'output', filename), invocation === 1 ? 'workbook-A' : 'workbook-B')
    return { tools: [], status: 'COMPLETED' }
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
    assert.deepEqual(stateDuringAugust.artifacts, [])
    assert.equal((await run(base, '同時実行は拒否される', 'parallel-run')).status, 400)
    const stateAfterRejection = await (await fetch(base + '/state')).json() as any
    assert.equal(stateAfterRejection.status, 'running')
    assert.equal(stateAfterRejection.runId, 'run-august')
    releaseSecond()
    assert.equal((await augustRun).status, 303)

    const completed = await (await fetch(base + '/state')).json() as any
    assert.equal(completed.artifacts.length, 1)
    assert.equal(completed.artifacts[0].runId, 'run-august')
    assert.equal(await (await fetch(base + '/download/' + completed.artifacts[0].id)).text(), 'workbook-B')
    const history = await (await fetch(base + '/sessions')).json() as any[]
    const july = await (await fetch(base + '/sessions/' + history.find(session => session.title.startsWith('7月'))!.id)).json() as any
    assert.equal(july.artifacts[0].runId, 'run-july')
    assert.equal(await (await fetch(base + '/download/' + july.artifacts[0].id)).text(), 'workbook-A')
    assert.equal((await fetch(base + '/download/BBBBBBBBBBBBBBBBBBBBBBBB')).status, 404)
    assert.equal((await fetch(base + '/download/../../master.xlsx')).status, 404)

    assert.equal((await run(base, PROMPTS['7月'], 'run-fail')).status, 303)
    assert.equal((await (await fetch(base + '/state')).json() as any).artifacts.length, 0)
    assert.equal((await run(base, PROMPTS['8月'], 'run-cancelled')).status, 303)
    assert.equal((await (await fetch(base + '/state')).json() as any).artifacts.length, 0)
  } finally {
    releaseSecond?.()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  }
})

test('single-active admission is reserved before a slow request body is read', async () => {
  const root = await mkdtemp(join(tmpdir(), 'misen-web-slow-admission-'))
  await fixture(root)
  let invocations = 0
  const runner: AgentRunner = async () => { invocations += 1; return { tools: [], status: 'COMPLETED' } }
  const { server, base } = await start(root, runner)
  const target = new URL(base)
  try {
    const session = await (await fetch(base + '/sessions', { method: 'POST', headers: { origin: base } })).json() as { id: string }
    const body = new URLSearchParams({ prompt: 'slow request', clientId: 'slow-request', sessionId: session.id }).toString()
    const slowStatus = new Promise<number>((resolve, reject) => {
      const slow = request({
        host: target.hostname,
        port: target.port,
        path: '/run',
        method: 'POST',
        headers: {
          origin: base,
          'content-type': 'application/x-www-form-urlencoded',
          'content-length': Buffer.byteLength(body),
        },
      }, response => { response.resume(); response.on('end', () => resolve(response.statusCode ?? 0)) })
      slow.on('error', reject)
      slow.flushHeaders()
      setTimeout(() => slow.end(body), 50)
    })
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal((await run(base, 'must be rejected', 'interleaved-request')).status, 400)
    assert.equal(await slowStatus, 303)
    assert.equal(invocations, 1)
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  }
})

test('cancellation during the pre-run artifact snapshot prevents Agent startup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'misen-web-snapshot-cancel-'))
  await fixture(root)
  let releaseSnapshot!: () => void
  let markSnapshotStarted!: () => void
  const snapshotStarted = new Promise<void>(resolve => { markSnapshotStarted = resolve })
  const snapshotRelease = new Promise<void>(resolve => { releaseSnapshot = resolve })
  let runnerInvoked = false
  const runner: AgentRunner = async () => { runnerInvoked = true; return { tools: [], status: 'COMPLETED' } }
  const observer: ArtifactObserver = {
    snapshot: async () => { markSnapshotStarted(); await snapshotRelease; return new Map() },
    discover: async () => [],
  }
  const { server, base } = await start(root, runner, observer)
  try {
    const pendingRun = run(base, 'snapshot中に停止', 'snapshot-cancel')
    await snapshotStarted
    assert.equal((await fetch(base + '/cancel', { method: 'POST', headers: { origin: base } })).status, 202)
    releaseSnapshot()
    assert.equal((await pendingRun).status, 303)
    assert.equal(runnerInvoked, false)
    const state = await (await fetch(base + '/state')).json() as any
    assert.equal(state.status, 'CANCELLED')
    assert.equal(state.runId, 'snapshot-cancel')
  } finally {
    releaseSnapshot()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  }
})

test('cancellation during post-run artifact discovery suppresses publication', async () => {
  const root = await mkdtemp(join(tmpdir(), 'misen-web-discovery-cancel-'))
  await fixture(root)
  let releaseDiscovery!: () => void
  let markDiscoveryStarted!: () => void
  const discoveryStarted = new Promise<void>(resolve => { markDiscoveryStarted = resolve })
  const discoveryRelease = new Promise<void>(resolve => { releaseDiscovery = resolve })
  let runnerInvoked = false
  const runner: AgentRunner = async () => { runnerInvoked = true; return { tools: [], status: 'COMPLETED' } }
  const observer: ArtifactObserver = {
    snapshot: async () => new Map(),
    discover: async () => {
      markDiscoveryStarted()
      await discoveryRelease
      return [{ path: 'output/late.xlsx', filename: 'late.xlsx', bytes: Uint8Array.from([1, 2, 3]) }]
    },
  }
  const { server, base } = await start(root, runner, observer)
  try {
    const pendingRun = run(base, '成果物を作って', 'discovery-cancel')
    await discoveryStarted
    assert.equal((await fetch(base + '/cancel', { method: 'POST', headers: { origin: base } })).status, 202)
    releaseDiscovery()
    assert.equal((await pendingRun).status, 303)
    assert.equal(runnerInvoked, true)
    const state = await (await fetch(base + '/state')).json() as any
    assert.equal(state.status, 'CANCELLED')
    assert.deepEqual(state.artifacts, [])
  } finally {
    releaseDiscovery()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  }
})

test('artifact discovery rejects a workspace-external output junction', async t => {
  const root = await mkdtemp(join(tmpdir(), 'misen-web-output-junction-'))
  const outside = await mkdtemp(join(tmpdir(), 'misen-web-output-outside-'))
  try {
    await writeFile(join(outside, 'escaped.xlsx'), 'outside')
    try {
      await symlink(outside, join(root, 'output'), 'junction')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') {
        t.skip('Windows EPERM: junction fixture unavailable')
        return
      }
      throw error
    }
    await assert.rejects(snapshotOutputArtifacts(new WorkspaceBoundary(root)), /escapes/u)
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

test('text-only free-form completion exposes no artifact and never claims Decision 441 PASS', async () => {
  const root = await mkdtemp(join(tmpdir(), 'misen-web-text-only-'))
  await fixture(root)
  const prompts = [
    '7月から8月で利益の改善額が最大だった会社は？',
    '8月で目標未達の会社があるか確認して',
    '業務引継ぎを読んで注意事項を説明して',
    `未登録の観点で比較して-${Date.now()}`,
  ]
  const received: string[] = []
  const runner: AgentRunner = async (_root, prompt, context) => {
    received.push(prompt)
    context?.emit({ type: 'assistant', text: 'bounded answer', done: true })
    return { tools: ['workspace_read_text'], status: 'COMPLETED' }
  }
  const { server, base } = await start(root, runner)
  try {
    for (const [index, prompt] of prompts.entries()) assert.equal((await run(base, prompt, `freeform-${index}`)).status, 303)
    assert.deepEqual(received, prompts)
    const state = await (await fetch(base + '/state')).json() as any
    assert.equal(state.status, 'COMPLETED')
    assert.deepEqual(state.axes, [])
    assert.deepEqual(state.artifacts, [])
    assert.doesNotMatch(JSON.stringify(state), /PASS/u)
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  }
})

test('host discovery exposes changed authorized xlsx files but ignores paths outside output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'misen-web-changed-artifact-'))
  await fixture(root)
  await writeFile(join(root, 'output', 'existing.xlsx'), 'before')
  const runner: AgentRunner = async () => {
    await writeFile(join(root, 'output', 'existing.xlsx'), 'after')
    await mkdir(join(root, 'output', 'nested'))
    await writeFile(join(root, 'output', 'nested', 'new.xlsx'), 'nested')
    await writeFile(join(root, 'escaped.xlsx'), 'outside authorized output')
    await writeFile(join(root, 'output', 'notes.txt'), 'not a deliverable')
    return { tools: ['spreadsheet_update'], status: 'COMPLETED' }
  }
  const { server, base } = await start(root, runner)
  try {
    assert.equal((await run(base, '既存成果物を更新して', 'changed-1')).status, 303)
    const state = await (await fetch(base + '/state')).json() as any
    assert.equal(state.status, 'COMPLETED')
    assert.deepEqual(state.artifacts.map((artifact: any) => artifact.filename), ['existing.xlsx', 'new.xlsx'])
    assert.equal(await (await fetch(base + '/download/' + state.artifacts[0].id)).text(), 'after')
    assert.equal(await (await fetch(base + '/download/' + state.artifacts[1].id)).text(), 'nested')
    assert.equal(JSON.stringify(state).includes('escaped.xlsx'), false)
    assert.equal(JSON.stringify(state).includes('notes.txt'), false)
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  }
})

test('artifact discovery keeps count and byte bounds fail closed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'misen-web-artifact-bounds-'))
  await fixture(root)
  const runner: AgentRunner = async () => {
    for (let index = 0; index <= MAX_SESSION_ARTIFACTS; index++) await writeFile(join(root, 'output', `bounded-${index}.xlsx`), 'x')
    return { tools: [], status: 'COMPLETED' }
  }
  const { server, base } = await start(root, runner)
  try {
    assert.equal((await run(base, '複数成果物を作成', 'bounds-count')).status, 500)
    assert.deepEqual((await (await fetch(base + '/state')).json() as any).artifacts, [])
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  }

  const byteRoot = await mkdtemp(join(tmpdir(), 'misen-web-artifact-bytes-'))
  await fixture(byteRoot)
  const byteRunner: AgentRunner = async () => {
    await truncate(join(byteRoot, 'output', 'oversized.xlsx'), MAX_ARTIFACT_BYTES + 1)
    return { tools: [], status: 'COMPLETED' }
  }
  const byteServer = await start(byteRoot, byteRunner)
  try {
    assert.equal((await run(byteServer.base, '大きすぎる成果物', 'bounds-bytes')).status, 500)
    assert.deepEqual((await (await fetch(byteServer.base + '/state')).json() as any).artifacts, [])
  } finally {
    await new Promise<void>(resolve => byteServer.server.close(() => resolve()))
    await rm(byteRoot, { recursive: true, force: true })
  }
})
