import assert from 'node:assert'
import http from 'node:http'
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { extractJsonReply, runAgentTurn, type AgentIO, type TextBackend } from '../src/agent'
import type { AgentConfig } from '../src/config'
import type { ChatMessage } from '../src/llm'
import { CopilotEdgeClient } from '../src/copilot'
import { getFileSnapshot, parseToolResultMeta, rollbackFileChange, TOOL_DEFS, type ToolContext } from '../src/tools'
import { listApprovals, requestApproval, resolveApproval } from '../src/approvals'

function makeCtx(root: string, restrict = true): ToolContext {
  return { workspace: root, restrictToWorkspace: restrict }
}

function ioStub(approve: boolean): AgentIO {
  return {
    print: () => {},
    askYesNo: async () => approve
  }
}

async function testApprovals(): Promise<void> {
  const pending = requestApproval('approve smoke')
  const listed = listApprovals()
  assert.strictEqual(listed.length, 1)
  assert.strictEqual(listed[0].question, 'approve smoke')
  assert.strictEqual(resolveApproval(listed[0].id, true), true)
  assert.strictEqual(await pending, true)
  assert.strictEqual(listApprovals().length, 0)
  assert.strictEqual(resolveApproval('missing-approval', false), false)
  console.log('PASS approvals')
}
async function testTools(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-smoke-'))
  const ctx = makeCtx(root)
  const get = (n: string) => TOOL_DEFS.find((t) => t.name === n)!

  await get('write_file').run({ path: 'a/hello.txt', content: 'line1\nline2 unique\n' }, ctx)
  const read = await get('read_file').run({ path: 'a/hello.txt' }, ctx)
  assert.ok(read.includes('unique'))

  const edited = await get('edit_file').run({ path: 'a/hello.txt', old_string: 'unique', new_string: 'edited' }, ctx)
  assert.ok(edited.includes('1 箇所'))
  const after = await get('read_file').run({ path: 'a/hello.txt' }, ctx)
  assert.ok(after.includes('edited'))
  assert.ok(!after.includes('unique'))
  const editMeta = parseToolResultMeta(edited)
  assert.ok(editMeta && editMeta.changed === true && editMeta.status === 'applied_unverified' && editMeta.readBack === true)
  const noOp = await get('edit_file').run({ path: 'a/hello.txt', old_string: 'edited', new_string: 'edited' }, ctx)
  const noOpMeta = parseToolResultMeta(noOp)
  assert.ok(noOp.includes('変更なし') && noOpMeta && noOpMeta.changed === false && noOpMeta.status === 'no_op')

  const search = await get('search_files').run({ query: 'edited' }, ctx)
  assert.ok(search.includes('hello.txt'))

  const list = await get('list_files').run({ glob: '*.txt' }, ctx)
  assert.ok(list.includes('hello.txt'))

  const cmd = await get('run_command').run({ command: 'echo smoke-ok' }, ctx)
  assert.ok(cmd.includes('smoke-ok'))

  const started = JSON.parse(await get('start_process').run({
    command: `node -e "console.log('process-smoke'); setTimeout(() => {}, 10000)"`,
    label: 'smoke preview'
  }, ctx)) as { id: string; status: string }
  assert.ok(started.id && started.status === 'running')
  try {
    await new Promise((resolve) => setTimeout(resolve, 150))
    const processLog = JSON.parse(await get('read_process_log').run({ process_id: started.id }, ctx)) as { lines: string[]; nextOffset: number }
    assert.ok(processLog.lines.join('\n').includes('process-smoke'))
    assert.ok(processLog.nextOffset >= processLog.lines.length)
    const stopped = JSON.parse(await get('stop_process').run({ process_id: started.id }, ctx)) as { status: string }
    assert.ok(['stopped', 'exited'].includes(stopped.status))
  } finally {
    try { await get('stop_process').run({ process_id: started.id }, ctx) } catch {}
  }

  let outsideThrew = false
  try {
    await get('read_file').run({ path: '..\\outside.txt' }, ctx)
  } catch {
    outsideThrew = true
  }
  assert.ok(outsideThrew, 'restrict guard should throw')

  let dupThrew = false
  try {
    await get('edit_file').run({ path: 'a/hello.txt', old_string: 'e', new_string: 'X' }, ctx)
  } catch (err) {
    dupThrew = String((err as Error).message).includes('件一致')
  }
  assert.ok(dupThrew, 'multi-match should throw without replace_all')

  fs.rmSync(root, { recursive: true, force: true })
  console.log('PASS tools')
}

interface ScriptStep {
  content?: string
  tool_call?: { name: string; args: Record<string, unknown> }
}

function mockServer(steps: ScriptStep[]): Promise<{ server: http.Server; url: string; requests: number }> {
  const state = { requests: 0 }
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => {
      body += c
    })
    req.on('end', () => {
      JSON.parse(body)
      state.requests++
      const step = steps[state.requests - 1] ?? steps[steps.length - 1]
      const message: Record<string, unknown> = step.tool_call
        ? {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: `call_${state.requests}`,
                type: 'function',
                function: { name: step.tool_call.name, arguments: JSON.stringify(step.tool_call.args) }
              }
            ]
          }
        : { role: 'assistant', content: step.content ?? 'ok' }
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ choices: [{ message }] }))
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as net.AddressInfo
      resolve({ server, url: `http://127.0.0.1:${addr.port}/v1`, requests: state.requests })
    })
  })
}

async function withServer(
  steps: ScriptStep[],
  fn: (cfg: AgentConfig) => Promise<void>
): Promise<void> {
  const { server, url } = await mockServer(steps)
  try {
    await fn({ baseURL: url, model: 'mock' })
  } finally {
    server.close()
  }
}

async function testAgentLoop(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-smoke-'))
  await withServer(
    [
      { tool_call: { name: 'write_file', args: { path: 'hello.txt', content: 'hi from mock' } } },
      { content: '書き込みました' }
    ],
    async (cfg) => {
      const result = await runAgentTurn({
        cfg,
        messages: [],
        userInput: '作って',
        ctx: makeCtx(root),
        io: ioStub(true)
      })
      assert.strictEqual(result.reply, '書き込みました')
      assert.strictEqual(result.aborted, false)
      const toolMsg = result.messages.find((m) => m.role === 'tool')
      assert.ok(toolMsg && toolMsg.content && toolMsg.content.includes('書き込み完了'))
      assert.ok(fs.readFileSync(path.join(root, 'hello.txt'), 'utf8').includes('hi from mock'))
    }
  )
  fs.rmSync(root, { recursive: true, force: true })
  console.log('PASS agent-loop')
}

async function testDenial(): Promise<void> {
  await withServer(
    [{ tool_call: { name: 'run_command', args: { command: 'echo x' } } }, { content: '中止しました' }],
    async (cfg) => {
      const result = await runAgentTurn({
        cfg,
        messages: [],
        userInput: '走って',
        ctx: makeCtx(os.tmpdir(), false),
        io: ioStub(false)
      })
      assert.strictEqual(result.reply, '中止しました')
      assert.ok(
        result.messages.some((m) => m.role === 'tool' && m.content === '(ユーザーが拒否しました)')
      )
    }
  )
  console.log('PASS denial')
}

async function testCopilotChoosesFirstAction(): Promise<void> {
  const answerRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-smoke-'))
  const answerBackend = new FakeBackend(['{"answer":"こんにちは！"}\nAGENT_END'])
  const answerEvents: string[] = []
  const cfg = { baseURL: '', model: '', provider: 'copilot-edge' as const, copilot: { agentMode: true } }
  const answer = await runAgentTurn({
    cfg,
    messages: [],
    userInput: 'こんにちは',
    ctx: makeCtx(answerRoot),
    io: { ...ioStub(true), event: (event) => { if (event.type.startsWith('tool.')) answerEvents.push(event.type) } },
    backend: answerBackend
  })
  assert.strictEqual(answer.reply, 'こんにちは！')
  assert.strictEqual(answer.aborted, false)
  assert.strictEqual(answerBackend.calls, 1)
  assert.deepStrictEqual(answerEvents, [])
  assert.ok(!answerBackend.prompts[0].includes('TOOL_RESULT(list_files)'))
  assert.deepStrictEqual(fs.readdirSync(answerRoot), [])
  fs.rmSync(answerRoot, { recursive: true, force: true })

  const toolRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-smoke-'))
  const toolBackend = new FakeBackend([
    '{"tool":"list_files","args":{}}\nAGENT_END',
    '{"answer":"調査しました"}\nAGENT_END'
  ])
  const toolEvents: string[] = []
  const toolResult = await runAgentTurn({
    cfg,
    messages: [],
    userInput: 'ファイル一覧を確認して',
    ctx: makeCtx(toolRoot),
    io: { ...ioStub(true), event: (event) => { if (event.type.startsWith('tool.')) toolEvents.push(event.type) } },
    backend: toolBackend
  })
  assert.strictEqual(toolResult.reply, '調査しました')
  assert.strictEqual(toolResult.aborted, false)
  assert.strictEqual(toolBackend.calls, 2)
  assert.ok(toolEvents.includes('tool.requested'))
  assert.ok(!toolBackend.prompts[0].includes('TOOL_RESULT(list_files)'))
  assert.ok(toolBackend.prompts[1].includes('TOOL_RESULT(list_files)'))
  fs.rmSync(toolRoot, { recursive: true, force: true })

  const repeatRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-smoke-'))
  const repeatBackend = new FakeBackend([
    '{"tool":"list_files","args":{}}\nAGENT_END',
    '{"tool":"list_files","args":{"path":".","glob":"**/*"}}\nAGENT_END',
    '{"tool":"list_files","args":{"path":"."}}\nAGENT_END'
  ])
  const repeatEvents: string[] = []
  const repeat = await runAgentTurn({
    cfg,
    messages: [],
    userInput: 'ファイル一覧を確認して',
    ctx: makeCtx(repeatRoot),
    io: { ...ioStub(true), event: (event) => { if (event.type.startsWith('tool.')) repeatEvents.push(event.type) } },
    backend: repeatBackend
  })
  assert.strictEqual(repeat.aborted, false)
  assert.ok(repeat.reply.includes('同じツール操作'))
  assert.strictEqual(repeatBackend.calls, 3)
  assert.strictEqual(repeatEvents.filter((type) => type === 'tool.requested').length, 1)
  fs.rmSync(repeatRoot, { recursive: true, force: true })
  console.log('PASS copilot-tool-choice')
}
async function testProtocolParsing(): Promise<void> {
  assert.strictEqual(extractJsonReply('{"answer":"hi"}')?.answer, 'hi')

  const fenced = extractJsonReply('説明文\n```json\n{"tool":"read_file","args":{"path":"a.txt"}}\n```\nAGENT_END')
  assert.ok(fenced && fenced.tool === 'read_file' && fenced.args && fenced.args.path === 'a.txt')

  const prose = extractJsonReply('前置き\n{"answer":"波括弧 } を含む回答"}\nAGENT_END')
  assert.strictEqual(prose?.answer, '波括弧 } を含む回答')

  const toolNoArgs = extractJsonReply('{"tool":"list_files"}')
  assert.ok(toolNoArgs && toolNoArgs.tool === 'list_files' && toolNoArgs.args)

  assert.strictEqual(extractJsonReply('これはJSONではありません'), null)
  console.log('PASS protocol-parsing')
}

class FakeBackend implements TextBackend {
  readonly name = 'fake'
  calls = 0
  prompts: string[] = []
  constructor(private replies: string[]) {}
  async complete(prompt: string): Promise<string> {
    this.prompts.push(prompt)
    const r = this.replies[this.calls]
    this.calls++
    return r ?? '{"answer":"no script"}'
  }
}

async function testCopilotChunkFallback(): Promise<void> {
  const client = new CopilotEdgeClient({ baseURL: '', model: '', provider: 'copilot-edge', copilot: { maxPromptChars: 5000 } })
  type Internals = {
    editorLength: () => Promise<number>
    editorState: () => Promise<{ found: boolean; text: string; active: boolean }>
    clearEditor: () => Promise<void>
    focusEditor: () => Promise<void>
    bringToFront: () => Promise<void>
    cdpMethod: (name: string, params: Record<string, unknown>) => Promise<void>
    insertByChunks: (prompt: string) => Promise<void>
  }
  const internal = client as unknown as Internals
  const prompt = ('0123456789abcdef'.repeat(140)) + '\n末尾'
  let editor = ''
  let insertCalls = 0
  internal.editorLength = async () => editor.length
  internal.editorState = async () => ({ found: true, text: editor, active: true })
  internal.clearEditor = async () => { editor = '' }
  internal.focusEditor = async () => {}
  internal.bringToFront = async () => {}
  internal.cdpMethod = async (name, params) => {
    if (name !== 'Input.insertText') return
    const chunk = String(params.text ?? '')
    insertCalls++
    editor += insertCalls === 2 ? chunk.slice(0, 120) : chunk
  }
  await internal.insertByChunks(prompt)
  assert.strictEqual(editor, prompt)
  assert.ok(insertCalls > Math.ceil(prompt.length / 450))
  console.log('PASS copilot-chunk-fallback')
}
async function testCopilotLoop(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-smoke-'))
  const backend = new FakeBackend([
    '```json\n{"tool":"write_file","args":{"path":"b.txt","content":"from copilot"}}\n```\nAGENT_END',
    '{"answer":"完了しました"}\nAGENT_END'
  ])
  const cfg = { baseURL: '', model: '', provider: 'copilot-edge' as const, autoApprove: { write: true }, copilot: { agentMode: true } }
  const result = await runAgentTurn({
    cfg,
    messages: [],
    userInput: '作って',
    ctx: makeCtx(root),
    io: ioStub(true),
    backend
  })
  assert.strictEqual(result.reply, '完了しました')
  assert.strictEqual(result.aborted, false)
  assert.ok(fs.readFileSync(path.join(root, 'b.txt'), 'utf8').includes('from copilot'))
  assert.strictEqual(backend.calls, 2)
  assert.ok(backend.prompts[1].includes('TOOL_RESULT(write_file)'))
  assert.ok(backend.prompts[0].includes('AGENT_END'))
  fs.rmSync(root, { recursive: true, force: true })
  console.log('PASS copilot-loop')
}

async function testMaxIterationHistory(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-smoke-'))
  const backend = new FakeBackend(['{"tool":"list_files","args":{}}'])
  const cfg = { baseURL: '', model: '', provider: 'copilot-edge' as const, maxToolIterations: 1, copilot: { agentMode: true } }
  const result = await runAgentTurn({ cfg, messages: [], userInput: '履歴を残して', ctx: makeCtx(root), io: ioStub(true), backend })
  assert.strictEqual(result.aborted, true)
  assert.ok(result.messages.some((message) => message.role === 'user' && message.content === '履歴を残して'))
  assert.ok(result.messages.some((message) => message.role === 'assistant' && String(message.content).includes('最大反復回数')))
  fs.rmSync(root, { recursive: true, force: true })
  console.log('PASS max-iteration-history')
}

async function testCopilotPlainMode(): Promise<void> {
  const backend = new FakeBackend(['これは平文の回答です'])
  const cfg = { baseURL: '', model: '', provider: 'copilot-edge' as const, systemPrompt: 'SYS' }
  const result = await runAgentTurn({
    cfg,
    messages: [],
    userInput: '質問',
    ctx: makeCtx(os.tmpdir(), false),
    io: ioStub(true),
    backend
  })
  assert.strictEqual(result.reply, 'これは平文の回答です')
  assert.strictEqual(backend.calls, 1)
  assert.ok(backend.prompts[0].includes('SYS') && backend.prompts[0].includes('質問'))
  console.log('PASS copilot-plain')
}

async function testCopilotFenceMode(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-smoke-'))
  const backend = new FakeBackend([
    '{\"tool\":\"write_file\",\"args\":{\"path\":\"fence.html\"}}\n```html\n<p>fence ok</p>\n```\nAGENT_END',
    '{"answer":"フェンス完了"}\nAGENT_END'
  ])
  const cfg = { baseURL: '', model: '', provider: 'copilot-edge' as const, autoApprove: { write: true }, copilot: { agentMode: true } }
  const result = await runAgentTurn({
    cfg,
    messages: [],
    userInput: '作って',
    ctx: makeCtx(root),
    io: ioStub(true),
    backend
  })
  assert.strictEqual(result.reply, 'フェンス完了')
  assert.ok(fs.readFileSync(path.join(root, 'fence.html'), 'utf8').includes('<p>fence ok</p>'))
  fs.rmSync(root, { recursive: true, force: true })
  console.log('PASS copilot-fence')
}

async function testUiContract(): Promise<void> {
  const html = fs.readFileSync(path.join(process.cwd(), 'public', 'index.html'), 'utf8')
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1]
  assert.ok(script, 'UI script missing')
  new Function(script)
  for (const required of ['run-plan', 'run-pause', 'run-resume', 'run-retry', 'run-complete', '実際の差分を表示', '差分の続き', 'preview-frame', 'verification-list', '診断JSON', 'approval-meta', 'parentRunId', '/api/runs/', '/api/changes/', 'compositionstart', 'aria-live', '@media (max-width: 720px)']) assert.ok(html.includes(required), `UI contract missing: ${required}`)
  console.log('PASS ui-contract')
}

(async () => {
  await testApprovals()
  await testTools()
  await testAgentLoop()
  await testDenial()
  await testProtocolParsing()
  await testCopilotChoosesFirstAction()
  await testCopilotChunkFallback()
  await testCopilotLoop()
  await testMaxIterationHistory()
  await testCopilotPlainMode()
  await testCopilotFenceMode()
  await testUiContract()
  console.log('ALL PASS')
})().catch((err) => {
  console.error(err)
  process.exit(1)
})
