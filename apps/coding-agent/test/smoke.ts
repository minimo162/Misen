import assert from 'node:assert'
import http from 'node:http'
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { extractJsonReply, runAgentTurn, type AgentIO, type TextBackend } from '../src/agent'
import { capabilityPolicy, type AgentConfig } from '../src/config'
import type { ChatMessage } from '../src/llm'
import {
  COPILOT_CLICK_COPY_JS,
  isResponseCopyControl,
  COPILOT_SCREEN_STATE_JS,
  CopilotEdgeClient,
  assertResponseDeadline,
  isStopGenerationControl,
  resolveCopilotSettings,
  selectLatestResponseCandidate,
  updateResponseCompletionState,
  type ResponseCompletionState
} from '../src/copilot'

import { getFileSnapshot, normalizeRunCommand, openAITools, parseToolResultMeta, rollbackFileChange, validateToolArgs, TOOL_DEFS, type ToolContext } from '../src/tools'
import { listApprovals, requestApproval, resolveApproval } from '../src/approvals'
import { getWeather, weatherCodeLabel, type WeatherFetcher } from '../src/weather'

function makeCtx(root: string, restrict = true): ToolContext {
  return { workspace: root, restrictToWorkspace: restrict }
}

function ioStub(approve: boolean): AgentIO {
  return {
    print: () => {},
    askYesNo: async () => approve
  }
}

async function testWeather(): Promise<void> {
  assert.strictEqual(weatherCodeLabel(0).emoji, '☀️')
  assert.strictEqual(weatherCodeLabel(2).emoji, '⛅')
  assert.strictEqual(weatherCodeLabel(3).label, '曇り')
  assert.strictEqual(weatherCodeLabel(45).emoji, '🌫️')
  assert.strictEqual(weatherCodeLabel(61).emoji, '🌧️')

  const calls: string[] = []
  const fetcher: WeatherFetcher = async (input) => {
    calls.push(input)
    if (input.includes('geocoding-api')) {
      return new Response(JSON.stringify({ results: [{ name: '広島市', latitude: 34.3853, longitude: 132.4553, country: '日本', admin1: '広島県' }] }), { status: 200 })
    }
    return new Response(JSON.stringify({
      timezone: 'Asia/Tokyo',
      current: { time: '2026-08-24T08:30', temperature_2m: 27.8, apparent_temperature: 33.2, weather_code: 0 },
      daily: { time: ['2026-08-24'], temperature_2m_max: [33.0], temperature_2m_min: [24.8], weather_code: [1] }
    }), { status: 200 })
  }
  const result = await getWeather('広島市', undefined, fetcher)
  assert.strictEqual(calls.length, 2)
  assert.ok(calls[0].includes('name=%E5%BA%83%E5%B3%B6%E5%B8%82'))
  assert.ok(result.includes('広島市（広島県・日本）'))
  assert.ok(result.includes('27.8°C'))
  assert.ok(result.includes('☀️ 快晴'))
  assert.ok(result.includes('最高 33.0°C / 最低 24.8°C'))
  assert.ok(result.includes('Open-Meteo'))

  let missing = false
  try {
    await getWeather('', undefined, fetcher)
  } catch (err) {
    missing = String((err as Error).message).includes('地域名が必要')
  }
  assert.ok(missing, 'weather should reject missing location')
  console.log('PASS weather')
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

  fs.mkdirSync(path.join(root, 'tools'), { recursive: true })
  fs.writeFileSync(path.join(root, 'tools', 'Read-Xlsx.ps1'), "param([string]$Path)\nWrite-Output ('READ_OK:' + $Path)\n")
  fs.writeFileSync(path.join(root, 'tools', 'Update-Ledger.ps1'), "param([string]$Extracted,[string]$Rates,[string]$Ledger)\nWrite-Output ('UPDATE_OK:' + $Ledger)\n")
  fs.writeFileSync(path.join(root, 'safe-read.txt'), 'safe-read-ok')

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

  fs.mkdirSync(path.join(root, 'batch'), { recursive: true })
  fs.mkdirSync(path.join(root, 'other'), { recursive: true })
  fs.writeFileSync(path.join(root, 'batch', 'utf8.txt'), 'UTF-8本文')
  fs.writeFileSync(path.join(root, 'batch', 'bom.txt'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('BOM本文')]))
  fs.writeFileSync(path.join(root, 'batch', 'cp932.txt'), Buffer.from([0x43, 0x50, 0x39, 0x33, 0x32, 0x3a, 0x93, 0xfa, 0x96, 0x7b]))
  fs.writeFileSync(path.join(root, 'batch', 'empty.txt'), Buffer.alloc(0))
  fs.writeFileSync(path.join(root, 'batch', 'ledger.xlsx'), Buffer.from('not-read-as-text'))
  fs.writeFileSync(path.join(root, 'other', 'note.md'), '別glob')
  const batch = await get('read_files').run({ patterns: ['batch/*.txt', 'other/*.md'] }, ctx)
  assert.ok(batch.includes('UTF-8本文') && batch.includes('BOM本文') && batch.includes('CP932:日本') && batch.includes('別glob'))
  const directoryPatterns = await get('read_files').run({ patterns: ['batch/', 'other/'] }, ctx)
  assert.ok(directoryPatterns.includes('UTF-8本文') && directoryPatterns.includes('別glob'), 'trailing-slash directory patterns must read immediate files')
  assert.ok(batch.includes('===== batch/empty.txt ====='), 'empty files must be successful results')
  assert.ok(batch.indexOf('batch/bom.txt') < batch.indexOf('batch/cp932.txt'), 'read_files ordering must be stable')
  const xlsx = await get('read_files').run({ paths: ['batch/ledger.xlsx', 'batch/utf8.txt', 'batch/utf8.txt'] }, ctx)
  assert.ok(xlsx.includes('run_commandで tools/Read-Xlsx.ps1 batch/ledger.xlsx を使ってください'))
  assert.strictEqual((xlsx.match(/===== batch\/utf8\.txt =====/g) ?? []).length, 1, 'duplicate paths must be removed')
  fs.writeFileSync(path.join(root, 'batch', 'large-a.txt'), 'A'.repeat(90_000))
  fs.writeFileSync(path.join(root, 'batch', 'large-b.txt'), 'B'.repeat(100))
  const limited = await get('read_files').run({ paths: ['batch/large-a.txt', 'batch/large-b.txt'] }, ctx)
  assert.ok(limited.includes('途中打切り') && limited.includes('batch/large-b.txt: 文字数予算を使い切ったため未読'))
  assert.ok(limited.length <= 80_000, 'read_files complete result must stay within the character budget')
  assert.strictEqual(await get('read_files').run({ pattern: 'missing/**/*.txt' }, ctx), '(該当なし)')
  let readFilesOutsideThrew = false
  try {
    await get('read_files').run({ paths: ['../outside.txt'] }, ctx)
  } catch {
    readFilesOutsideThrew = true
  }
  assert.ok(readFilesOutsideThrew, 'read_files must reject workspace escape')

  const cmd = await get('run_command').run({ command: 'echo smoke-ok' }, ctx)
  assert.ok(cmd.includes('smoke-ok'))

  assert.strictEqual(
    normalizeRunCommand('powershell -File tools/Read-Xlsx.ps1 reports/OS04.xlsx reports/OS05.xlsx'),
    'powershell.exe -NoProfile -File tools\\Read-Xlsx.ps1 -Path reports\\*.xlsx'
  )
  assert.strictEqual(
    normalizeRunCommand('powershell.exe -File tools\\Read-Xlsx.ps1 "reports\\one file.xlsx"'),
    'powershell.exe -NoProfile -File tools\\Read-Xlsx.ps1 -Path "reports\\one file.xlsx"'
  )
  assert.strictEqual(
    normalizeRunCommand('tools/Read-Xlsx.ps1 reports/OS04.xlsx'),
    'powershell.exe -NoProfile -File tools\\Read-Xlsx.ps1 -Path reports\\OS04.xlsx'
  )
  assert.strictEqual(
    normalizeRunCommand('powershell -NoProfile -File tools/Read-Xlsx.ps1 reports/OS04.xlsx,reports/OS05.xlsx,集計台帳.xlsx'),
    'powershell.exe -NoProfile -File tools\\Read-Xlsx.ps1 -Path reports\\*.xlsx'
  )
  assert.strictEqual(
    normalizeRunCommand('powershell -File tools/Update-Ledger.ps1 work/extracted.json rates/レート表.csv 集計台帳.xlsx'),
    'powershell.exe -NoProfile -File tools\\Update-Ledger.ps1 -Extracted work\\extracted.json -Rates rates\\レート表.csv -Ledger 集計台帳.xlsx'
  )
  assert.strictEqual(
    normalizeRunCommand('tools\\Update-Ledger.ps1 work\\extracted.json rates\\レート表.csv 集計台帳.xlsx'),
    'powershell.exe -NoProfile -File tools\\Update-Ledger.ps1 -Extracted work\\extracted.json -Rates rates\\レート表.csv -Ledger 集計台帳.xlsx'
  )
  assert.strictEqual(
    normalizeRunCommand('powershell.exe -File tools\\Update-Ledger.ps1 -Ledger 集計台帳.xlsx -Extracted work\\extracted.json -Rates rates\\レート表.csv'),
    'powershell.exe -NoProfile -File tools\\Update-Ledger.ps1 -Extracted work\\extracted.json -Rates rates\\レート表.csv -Ledger 集計台帳.xlsx'
  )
  assert.strictEqual(
    normalizeRunCommand('powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\\Read-Xlsx.ps1 reports\\OS04.xlsx'),
    'powershell.exe -NoProfile -File tools\\Read-Xlsx.ps1 -Path reports\\OS04.xlsx'
  )
  assert.strictEqual(
    normalizeRunCommand('powershell.exe "-ExecutionPolicy" Bypass -File tools\\Read-Xlsx.ps1 reports\\OS04.xlsx'),
    'powershell.exe -NoProfile -File tools\\Read-Xlsx.ps1 -Path reports\\OS04.xlsx'
  )
  assert.strictEqual(
    normalizeRunCommand('powershell.exe -ExecutionPolicy:Bypass -File tools\\Read-Xlsx.ps1 reports\\OS04.xlsx'),
    'powershell.exe -NoProfile -File tools\\Read-Xlsx.ps1 -Path reports\\OS04.xlsx'
  )
  const bypassReadXlsx = await get('run_command').run({
    command: 'powershell.exe -ExecutionPolicy Bypass -File tools\\Read-Xlsx.ps1 reports\\OS04.xlsx'
  }, ctx)
  assert.ok(bypassReadXlsx.includes('READ_OK:reports\\OS04.xlsx'), 'known Read-Xlsx with Bypass must execute after normalization')
  const bypassUpdateLedger = await get('run_command').run({
    command: 'powershell.exe -ExecutionPolicy Bypass -File tools\\Update-Ledger.ps1 work\\extracted.json rates\\rates.csv ledger.xlsx'
  }, ctx)
  assert.ok(bypassUpdateLedger.includes('UPDATE_OK:ledger.xlsx'), 'known Update-Ledger with Bypass must execute after normalization')
  const bypassGeneralRead = await get('run_command').run({
    command: 'powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Get-Content -LiteralPath safe-read.txt"'
  }, ctx)
  assert.ok(bypassGeneralRead.includes('safe-read-ok'), 'harmless general read with Bypass must execute')
  for (const harmlessRead of [
    'powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Get-ChildItem -LiteralPath safe-read.txt | Select-Object -ExpandProperty Name"',
    'cmd.exe /c dir safe-read.txt',
    'cmd.exe /c type safe-read.txt'
  ]) {
    const result = await get('run_command').run({ command: harmlessRead }, ctx)
    assert.ok(result.includes('safe-read'), `harmless read command must execute: ${harmlessRead}`)
  }
  await get('run_command').run({
    command: 'powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Set-Content -LiteralPath safe-write.txt -Value inside-ok"'
  }, ctx)
  assert.ok(fs.readFileSync(path.join(root, 'safe-write.txt'), 'utf8').includes('inside-ok'), 'workspace-local writes must remain allowed')
  assert.throws(
    () => normalizeRunCommand('powershell.exe -File tools\\Read-Xlsx.ps1 "reports\\x&whoami.xlsx"'),
    /複合コマンド/u,
    'quoted Read-Xlsx arguments must not reintroduce shell metacharacters'
  )
  assert.throws(
    () => normalizeRunCommand('powershell.exe -File tools\\Update-Ledger.ps1 -Extracted "work\\%PATH%.json" -Rates rates\\レート表.csv -Ledger 集計台帳.xlsx'),
    /複合コマンド/u,
    'known-tool values must reject environment expansion metacharacters'
  )
  assert.throws(
    () => normalizeRunCommand("powershell.exe -File tools\\Read-Xlsx.ps1 reports\\OS04.xlsx\necho injected"),
    /複合コマンド/u,
    'known-tool calls must reject embedded newlines'
  )
  assert.throws(
    () => normalizeRunCommand('powershell.exe -File tools\\Update-Ledger.ps1 -Extracted work\\extracted.json -Rates rates\\レート表.csv -Ledger 集計台帳.xlsx -ImportExcelPath C:\\outside'),
    /未許可の引数/u,
    'known-tool normalization must not load a caller-selected PowerShell module'
  )
  for (const blockedCommand of [
    'powershell.exe -ExecutionPolicy Bypass -Command "Remove-Item -LiteralPath safe-read.txt"',
    'cmd.exe /c del safe-read.txt',
    'powershell.exe -ExecutionPolicy Bypass -Command "Invoke-WebRequest https://example.com"',
    'curl.exe https://example.com',
    'powershell.exe -ExecutionPolicy Bypass -Command "Stop-Process -Id 999999"',
    'reg.exe add HKCU\\Software\\CodingAgentSmoke /v Test /d 1',
    'powershell.exe -EncodedCommand RwBlAHQALQBEAGEAdABlAA=='
  ]) {
    await assert.rejects(
      () => get('run_command').run({ command: blockedCommand }, ctx),
      /run_command拒否/u,
      `dangerous operation must be rejected: ${blockedCommand}`
    )
  }
  const outsideName = `ca-smoke-outside-${process.pid}.txt`
  await assert.rejects(
    () => get('run_command').run({
      command: `powershell.exe -ExecutionPolicy Bypass -Command "Set-Content -LiteralPath ..\\${outsideName} -Value blocked"`
    }, ctx),
    /ワークスペース外への書き込みは禁止/u
  )
  assert.ok(!fs.existsSync(path.resolve(root, '..', outsideName)), 'outside write rejection must happen before execution')
  await assert.rejects(
    () => get('run_command').run({
      command: `cmd.exe /c "echo blocked > ..\\${outsideName}"`
    }, ctx),
    /ワークスペース外への書き込みは禁止/u
  )
  assert.ok(!fs.existsSync(path.resolve(root, '..', outsideName)), 'outside redirection must be rejected before execution')

  let wttrBlocked = false
  try {
    await get('run_command').run({ command: 'curl https://wttr.in/?format=3' }, ctx)
  } catch (err) {
    wttrBlocked = String((err as Error).message).includes('get_weather')
  }
  assert.ok(wttrBlocked, 'wttr.in should be routed to get_weather')

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

  const journalCtx = { ...ctx, runId: 'journal-run' }
  const created = await get('write_file').run({ path: 'journal/new.txt', content: 'first' }, journalCtx)
  const createdMeta = parseToolResultMeta(created)
  assert.ok(createdMeta && createdMeta.existedBefore === false)
  await get('edit_file').run({ path: 'journal/new.txt', old_string: 'first', new_string: 'second' }, journalCtx)
  const editedTwice = await get('edit_file').run({ path: 'journal/new.txt', old_string: 'second', new_string: 'third' }, journalCtx)
  const editedTwiceMeta = parseToolResultMeta(editedTwice)
  assert.ok(editedTwiceMeta && editedTwiceMeta.afterHash)
  await rollbackFileChange({ path: 'journal/new.txt', afterHash: editedTwiceMeta!.afterHash, existedBefore: false, beforeContent: '' }, journalCtx)
  assert.ok(!fs.existsSync(path.join(root, 'journal', 'new.txt')), 'new files must be deleted on rollback')
  assert.strictEqual(validateToolArgs(get('edit_file'), { path: 'a/hello.txt', old_string: 'x', new_string: 'y', replace_all: 'false' }), 'replace_all の型が不正です（期待: boolean）')
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
      { tool_call: { name: 'host.write_file', args: { path: 'hello.txt', content: 'hi from mock' } } },
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
    [{ tool_call: { name: 'host.run_command', args: { command: 'echo x' } } }, { content: '中止しました' }],
    async (cfg) => {
      const result = await runAgentTurn({
        cfg: { ...cfg, allowArbitraryCommands: true },
        messages: [],
        userInput: '走って',
        ctx: makeCtx(os.tmpdir(), false),
        io: ioStub(false)
      })
      assert.strictEqual(result.reply, '中止しました')
      assert.ok(
        result.messages.some((m) => m.role === 'tool' && m.content?.includes('"kind":"host_result"') && m.content?.includes('"status":"denied"'))
      )
    }
  )
  console.log('PASS denial')
}

async function testCopilotChoosesFirstAction(): Promise<void> {
  const answerRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-smoke-'))
  fs.writeFileSync(path.join(answerRoot, 'evidence.txt'), 'bootstrap evidence')
  const answerBackend = new FakeBackend(['{"answer":"こんにちは！"}\nAGENT_END'])
  const answerEvents: string[] = []
  const cfg = { baseURL: '', model: '', provider: 'copilot-edge' as const, systemPrompt: 'WORK_SYSTEM_PROMPT_SENTINEL', copilot: { agentMode: true } }
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
  assert.deepStrictEqual(answerEvents, ['tool.requested', 'tool.succeeded'])
  assert.ok(answerBackend.prompts[0].includes('TOOL_RESULT (第0ターン自動実行'))
  assert.ok(answerBackend.prompts[0].includes('[業務固有指示]') && answerBackend.prompts[0].includes('WORK_SYSTEM_PROMPT_SENTINEL'), 'work-mode prompts must include configured system instructions')
  assert.ok(answerBackend.prompts[0].includes('BEGIN_UNTRUSTED_HOST_RESULT'))
  assert.ok(answerBackend.prompts[0].includes('evidence.txt'))
  assert.ok(answerBackend.prompts[0].includes('host.get_weather') && !answerBackend.prompts[0].includes('host.run_command(command)'))
  assert.deepStrictEqual(fs.readdirSync(answerRoot), ['evidence.txt'])
  fs.rmSync(answerRoot, { recursive: true, force: true })

  const toolRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-smoke-'))
  const toolBackend = new FakeBackend([
    '{"tool":"host.list_files","args":{}}\nAGENT_END',
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
  assert.ok(toolBackend.prompts[0].includes('TOOL_RESULT (第0ターン自動実行'))
  assert.ok(toolBackend.prompts[1].includes('BEGIN_UNTRUSTED_HOST_RESULT'))
  fs.rmSync(toolRoot, { recursive: true, force: true })

  const repeatRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-smoke-'))
  const repeatBackend = new FakeBackend([
    '{"tool":"host.list_files","args":{}}\nAGENT_END',
    '{"tool":"host.list_files","args":{"path":".","glob":"**/*"}}\nAGENT_END',
    '{"tool":"host.list_files","args":{"path":"."}}\nAGENT_END'
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
  assert.strictEqual(repeat.aborted, true)
  assert.ok(repeat.messages.some((message) => String(message.content).includes('同じhost操作')))
  assert.strictEqual(repeatBackend.calls, 3)
  assert.strictEqual(repeatEvents.filter((type) => type === 'tool.requested').length, 2)
  fs.rmSync(repeatRoot, { recursive: true, force: true })
  console.log('PASS copilot-tool-choice')
}
async function testModeBoundaries(): Promise<void> {
  const workPolicy = capabilityPolicy({ baseURL: '', model: '' }, 'work')
  const researchPolicy = capabilityPolicy({ baseURL: '', model: '' }, 'research')
  assert.deepStrictEqual({ hostTools: workPolicy.hostTools, nativeSearch: workPolicy.nativeSearch, maxHostExecutions: workPolicy.maxHostExecutions }, { hostTools: 'all', nativeSearch: false, maxHostExecutions: 8 })
  assert.deepStrictEqual({ hostTools: researchPolicy.hostTools, nativeSearch: researchPolicy.nativeSearch, nativeOffice: researchPolicy.nativeOffice }, { hostTools: 'none', nativeSearch: true, nativeOffice: false })
  const researchBackend = new FakeBackend(['検索結果: https://example.com（取得 2026-08-24T09:00+09:00）'])
  const research = await runAgentTurn({
    cfg: { baseURL: '', model: '', provider: 'copilot-edge' as const, turnMode: 'research', copilot: { agentMode: false } },
    messages: [], userInput: '最新情報を調べて', ctx: makeCtx(os.tmpdir(), false), io: ioStub(true), backend: researchBackend
  })
  assert.strictEqual(research.aborted, false)
  assert.ok(research.research)
  assert.strictEqual(research.research?.sources.length, 1)
  assert.strictEqual(research.research?.sources[0].url, 'https://example.com')
  assert.ok(research.research?.contentHash)
  assert.ok(researchBackend.prompts[0].includes('Copilot内蔵の検索'))
  assert.ok(!researchBackend.prompts[0].includes('host.get_weather'))
  assert.ok(!researchBackend.prompts[0].includes('TOOL_RESULT (第0ターン自動実行'))
  const sourceRequired = await runAgentTurn({
    cfg: { baseURL: '', model: '', provider: 'copilot-edge' as const, turnMode: 'research', copilot: { agentMode: false } },
    messages: [], userInput: '調べて', ctx: makeCtx(os.tmpdir(), false), io: ioStub(true), backend: new FakeBackend(['検索結果はありません'])
  })
  assert.strictEqual(sourceRequired.aborted, true)
  assert.ok(sourceRequired.messages.at(-1)?.content?.includes('出典URL'))

  const chatBackend = new FakeBackend(['こんにちは'])
  const chat = await runAgentTurn({
    cfg: { baseURL: '', model: '', provider: 'copilot-edge' as const, turnMode: 'chat', copilot: { agentMode: false } },
    messages: [], userInput: 'こんにちは', ctx: makeCtx(os.tmpdir(), false), io: ioStub(true), backend: chatBackend
  })
  assert.strictEqual(chat.reply, 'こんにちは')
  assert.ok(!chatBackend.prompts[0].includes('host.'))
  assert.ok(!chatBackend.prompts[0].includes('TOOL_RESULT (第0ターン自動実行'))

  const nativeBackend = new FakeBackend([
    '{"tool":"copilot.search","args":{}}\nAGENT_END',
    '{"tool":"copilot.search","args":{}}\nAGENT_END'
  ])
  const nativeEvents: string[] = []
  const native = await runAgentTurn({
    cfg: { baseURL: '', model: '', provider: 'copilot-edge' as const, turnMode: 'work', copilot: { agentMode: true } },
    messages: [], userInput: '検索して編集して', ctx: makeCtx(os.tmpdir(), false), io: { ...ioStub(true), event: (event) => nativeEvents.push(event.type) }, backend: nativeBackend
  })
  assert.strictEqual(native.aborted, true)
  assert.ok(nativeEvents.includes('copilot.native.observed'))
  assert.strictEqual(nativeBackend.calls, 2)

  assert.ok(!openAITools().some((entry) => entry.function.name === 'host.run_command'))
  assert.ok(openAITools({ allowArbitraryCommands: true }).some((entry) => entry.function.name === 'host.run_command'))
  const commandDisabledBackend = new FakeBackend(["{\"tool\":\"host.run_command\",\"args\":{\"command\":\"echo should-not-run\"}}\nAGENT_END"])
  const commandDisabled = await runAgentTurn({
    cfg: { baseURL: '', model: '', provider: 'copilot-edge' as const, turnMode: 'work', copilot: { agentMode: true } },
    messages: [], userInput: '実行して', ctx: makeCtx(os.tmpdir(), false), io: ioStub(true), backend: commandDisabledBackend
  })
  assert.strictEqual(commandDisabled.aborted, true)
  assert.strictEqual(commandDisabledBackend.calls, 1)
  assert.ok(commandDisabled.messages.at(-1)?.content?.includes('任意コマンド'))
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-smoke-'))
  const approvalBackend = new FakeBackend([
    '{"tool":"host.write_file","args":{"path":"denied.txt","content":"x"}}\nAGENT_END',
    '{"answer":"変更しませんでした"}\nAGENT_END'
  ])
  const approvalEvents: string[] = []
  const approval = await runAgentTurn({
    cfg: { baseURL: '', model: '', provider: 'copilot-edge' as const, turnMode: 'work', copilot: { agentMode: true } },
    messages: [], userInput: '書いて', ctx: makeCtx(root), io: { ...ioStub(false), event: (event) => approvalEvents.push(event.type) }, backend: approvalBackend
  })
  assert.strictEqual(approval.reply, '変更しませんでした')
  assert.ok(approvalEvents.includes('tool.denied'))
  assert.ok(!fs.existsSync(path.join(root, 'denied.txt')))
  fs.rmSync(root, { recursive: true, force: true })
  console.log('PASS mode-boundaries')
}
async function testProtocolParsing(): Promise<void> {
  assert.strictEqual(extractJsonReply('{"answer":"hi"}')?.answer, 'hi')

  const fenced = extractJsonReply('```json\n{"tool":"host.read_file","args":{"path":"a.txt"}}\n```\nAGENT_END')
  assert.ok(fenced && fenced.tool === 'host.read_file' && fenced.args && fenced.args.path === 'a.txt')

  const prose = extractJsonReply('前置き\n{"answer":"波括弧 } を含む回答"}\nAGENT_END')
  assert.strictEqual(prose, null)

  const toolNoArgs = extractJsonReply('{"tool":"host.list_files"}')
  assert.ok(toolNoArgs && toolNoArgs.tool === 'host.list_files' && toolNoArgs.args)
  const flattened = extractJsonReply('{"tool":"read_files","pattern":"reports/*","AGENT_END":true}')
  assert.deepStrictEqual(flattened, { tool: 'read_files', args: { pattern: 'reports/*' } })
  const repairedWrite = extractJsonReply('{"tool":"write_file","path":"quote.txt","content":"He said "hello" today","AGENT_END":true}')
  assert.deepStrictEqual(repairedWrite, { tool: 'write_file', args: { path: 'quote.txt', content: 'He said "hello" today' } })
  const nestedJsonContent = '{"companies":[{"id":"JP01","values":{"revenue":123}}]}'
  const nestedWriteRaw = `{"tool":"write_file","path":"work/extracted.json","content":"${nestedJsonContent}","AGENT_END":true}`
  const repairedNestedWrite = extractJsonReply(nestedWriteRaw)
  assert.deepStrictEqual(repairedNestedWrite, { tool: 'write_file', args: { path: 'work/extracted.json', content: nestedJsonContent } })
  assert.strictEqual(extractJsonReply(`前置き\n${nestedWriteRaw}`), null)
  assert.strictEqual(extractJsonReply(`${nestedWriteRaw}\n{"answer":"余分"}`), null)
  assert.strictEqual(extractJsonReply('{"tool":"write_file","path":"x.txt",content:"x","AGENT_END":true}'), null)
  assert.strictEqual(extractJsonReply('{"tool":"write_file","path":"x.txt",,"content":"x","AGENT_END":true}'), null)
  assert.strictEqual(extractJsonReply('{"tool":"write_file" "path":"x.txt","content":"x","AGENT_END":true}'), null)
  assert.strictEqual(extractJsonReply('{"tool":"write_file","path":"x.txt",/*comment*/"content":"x","AGENT_END":true}'), null)
  assert.strictEqual(extractJsonReply('{"tool":"write_file","args":{"path":"x.txt","content":"ok"}} trailing prose'), null)
  assert.strictEqual(extractJsonReply('{"answer":"a"}\n{"answer":"b"}'), null)
  assert.strictEqual(extractJsonReply('{"answer":"a","tool":"host.list_files"}'), null)
  assert.strictEqual(extractJsonReply('{"answer":"a","extra":1}'), null)
  assert.strictEqual(extractJsonReply('{"tool":"read_files","args":{},"pattern":"reports/*"}'), null)
  assert.strictEqual(extractJsonReply('{"tool":"read_files","AGENT_END":false}'), null)
  assert.strictEqual(extractJsonReply('{"answer":1}'), null)
  assert.strictEqual(extractJsonReply('null'), null)
  assert.strictEqual(extractJsonReply('{"tool":"host.write_file","args":{"path":"x","content":"unterminated}}'), null)
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

async function testCopilotEdgeIsolation(): Promise<void> {
  const base = { baseURL: '', model: '', provider: 'copilot-edge' as const }
  const isolated = resolveCopilotSettings({ ...base, copilot: { cdpPort: 9444 } })
  assert.strictEqual(isolated.reuseExistingEdge, false)
  assert.strictEqual(isolated.cdpPort, 0)
  const attached = resolveCopilotSettings({ ...base, copilot: { cdpPort: 9444, reuseExistingEdge: true } })
  assert.strictEqual(attached.reuseExistingEdge, true)
  assert.strictEqual(attached.cdpPort, 9444)
  console.log('PASS copilot-edge-isolation')
}
async function testCopilotResponseCompletion(): Promise<void> {
  const empty = (): ResponseCompletionState => ({ stableLength: null, stableSinceMs: null })
  let result = updateResponseCompletionState(empty(), {
    observedAtMs: 0,
    textLength: 5000,
    generating: true,
    copyEnabled: true
  })
  assert.strictEqual(result.ready, false)
  assert.strictEqual(result.state.stableSinceMs, null)

  result = updateResponseCompletionState(empty(), {
    observedAtMs: 0,
    textLength: 5000,
    generating: false,
    copyEnabled: false
  })
  assert.strictEqual(result.ready, false)
  assert.strictEqual(result.state.stableSinceMs, null)

  result = updateResponseCompletionState(empty(), {
    observedAtMs: 100,
    textLength: 5000,
    generating: false,
    copyEnabled: true
  })
  result = updateResponseCompletionState(result.state, {
    observedAtMs: 1200,
    textLength: 7000,
    generating: false,
    copyEnabled: true
  })
  assert.strictEqual(result.ready, false)
  assert.strictEqual(result.state.stableSinceMs, 1200)

  result = updateResponseCompletionState(result.state, {
    observedAtMs: 2000,
    textLength: 7000,
    generating: false,
    copyEnabled: true
  })
  assert.strictEqual(result.ready, false)
  result = updateResponseCompletionState(result.state, {
    observedAtMs: 2200,
    textLength: 7000,
    generating: false,
    copyEnabled: true
  })
  assert.strictEqual(result.ready, true)

  result = updateResponseCompletionState(result.state, {
    observedAtMs: 2300,
    textLength: 7000,
    generating: false,
    copyEnabled: false
  })
  assert.strictEqual(result.ready, false)
  assert.strictEqual(result.state.stableSinceMs, null)

  result = updateResponseCompletionState(empty(), {
    observedAtMs: 3000,
    textLength: 7000,
    generating: false,
    copyEnabled: true
  })
  result = updateResponseCompletionState(result.state, {
    observedAtMs: 4100,
    textLength: 7000,
    generating: true,
    copyEnabled: true
  })
  assert.strictEqual(result.ready, false)
  assert.strictEqual(result.state.stableSinceMs, null)

  const olderCopyOnly = selectLatestResponseCandidate([
    { text: 'old', bottom: 100, order: 0, copyEnabled: true },
    { text: 'latest', bottom: 200, order: 1, copyEnabled: false }
  ])
  assert.strictEqual(olderCopyOnly?.text, 'latest')
  assert.strictEqual(olderCopyOnly?.copyEnabled, false)
  const latestCopy = selectLatestResponseCandidate([
    { text: 'old', bottom: 100, order: 0, copyEnabled: true },
    { text: 'latest', bottom: 200, order: 1, copyEnabled: true }
  ])
  assert.strictEqual(latestCopy?.copyEnabled, true)

  assert.strictEqual(isStopGenerationControl({ label: '', selector: '.fai-SendButton__stopBackground' }), true)
  assert.strictEqual(isStopGenerationControl({ label: '応答の生成を停止する', selector: '[aria-label*="停止"]' }), true)
  assert.strictEqual(isStopGenerationControl({ label: 'Stop generating', selector: '[aria-label*="Stop"]' }), true)
  assert.strictEqual(isStopGenerationControl({ label: 'コピー', selector: 'button' }), false)
  const responseCopy = { label: '応答のコピー', testId: 'CopyButtonTestId', inResponseToolbar: true, inCodeBlock: false, disabled: false, ariaDisabled: false }
  const codeCopy = { label: 'コードをコピー', testId: 'CodeCopyButtonTestId', inResponseToolbar: false, inCodeBlock: true, disabled: false, ariaDisabled: false }
  assert.strictEqual(isResponseCopyControl(responseCopy), true)
  assert.strictEqual(isResponseCopyControl(codeCopy), false)
  assert.strictEqual(isResponseCopyControl({ ...responseCopy, testId: '', label: 'Copy response' }), true)
  assert.strictEqual(isResponseCopyControl({ ...responseCopy, testId: '', label: 'Copy', inResponseToolbar: true }), true)
  assert.strictEqual(isResponseCopyControl({ ...responseCopy, disabled: true }), false)
  const latestWithCodeCopyOnly = selectLatestResponseCandidate([
    { text: 'old', bottom: 100, order: 0, copyEnabled: isResponseCopyControl(responseCopy) },
    { text: 'latest', bottom: 200, order: 1, copyEnabled: isResponseCopyControl(codeCopy) }
  ])
  assert.strictEqual(latestWithCodeCopyOnly?.text, 'latest')
  assert.strictEqual(latestWithCodeCopyOnly?.copyEnabled, false)
  const latestWithResponseCopy = selectLatestResponseCandidate([
    { text: 'old', bottom: 100, order: 0, copyEnabled: isResponseCopyControl(responseCopy) },
    { text: 'latest', bottom: 200, order: 1, copyEnabled: isResponseCopyControl(responseCopy) }
  ])
  assert.strictEqual(latestWithResponseCopy?.copyEnabled, true)
  for (const required of ['shadowRoot', 'contentDocument', 'stopGeneratingButton', 'stop-button', 'fai-SendButton__stopBackground', '[role="article"][class*="CopilotMessage" i]', '[data-testid="copilot-message-div"]']) {
    assert.ok(COPILOT_SCREEN_STATE_JS.includes(required), `screen-state detector missing ${required}`)
    if (required.includes('CopilotMessage') || required.includes('copilot-message-div')) {
      assert.ok(COPILOT_CLICK_COPY_JS.includes(required), `copy detector missing ${required}`)
    }
  }
  new Function('document', 'window', `return ${COPILOT_SCREEN_STATE_JS}`)
  new Function('document', 'window', `return ${COPILOT_CLICK_COPY_JS}`)
  assert.ok(COPILOT_CLICK_COPY_JS.includes('scope=latest'))
  assert.ok(COPILOT_CLICK_COPY_JS.includes('others.length>0'))
  for (const required of ['CopyButtonTestId', 'CopyButtonContainerTestId', 'pre,code', 'copy\\s*(?:response|answer)']) {
    assert.ok(COPILOT_SCREEN_STATE_JS.includes(required), `screen-state response-copy detector missing ${required}`)
    assert.ok(COPILOT_CLICK_COPY_JS.includes(required), `click response-copy detector missing ${required}`)
  }

  const deadlineClient = new CopilotEdgeClient({
    baseURL: '',
    model: '',
    provider: 'copilot-edge',
    copilot: { responseTimeoutSec: 0.01 }
  })
  type DeadlineInternals = {
    readScreenState: (timeoutMs?: number) => Promise<{ text: string; generating: boolean; copyEnabled: boolean; signinRequired: boolean }>
    finalizeAnswer: (text: string) => Promise<string>
    waitResponse: (baseline: string) => Promise<string>
  }
  const deadlineInternal = deadlineClient as unknown as DeadlineInternals
  let finalized = false
  deadlineInternal.readScreenState = async () => {
    await new Promise((resolve) => setTimeout(resolve, 25))
    return { text: 'complete', generating: false, copyEnabled: true, signinRequired: false }
  }
  deadlineInternal.finalizeAnswer = async (text) => { finalized = true; return text }
  await assert.rejects(deadlineInternal.waitResponse('baseline'), /タイムアウト/)
  assert.strictEqual(finalized, false)

  const recoveryClient = new CopilotEdgeClient({
    baseURL: '',
    model: '',
    provider: 'copilot-edge',
    copilot: { responseTimeoutSec: 0.05 }
  })
  type RecoveryInternals = {
    bringToFront: (deadlineMs?: number) => Promise<void>
    grantClipboard: (deadlineMs?: number) => Promise<void>
    readSystemClipboard: (deadlineMs?: number) => string
    evalWithReconnect: (expression: string, timeoutMs?: number) => Promise<unknown>
    finalizeAnswer: (fallbackText: string, deadlineMs?: number) => Promise<string>
  }
  const recoveryInternal = recoveryClient as unknown as RecoveryInternals
  recoveryInternal.bringToFront = async () => {}
  recoveryInternal.grantClipboard = async () => {}
  recoveryInternal.readSystemClipboard = () => ''
  let recoveryEvalCalls = 0
  recoveryInternal.evalWithReconnect = async () => {
    recoveryEvalCalls++
    return recoveryEvalCalls === 1 ? 'old clipboard' : JSON.stringify({ clicked: true })
  }
  const recoveryStarted = Date.now()
  await assert.rejects(
    recoveryInternal.finalizeAnswer('fallback response', recoveryStarted + 30),
    /タイムアウト/
  )
  assert.ok(Date.now() - recoveryStarted < 250)
  assert.doesNotThrow(() => assertResponseDeadline(101, 300, 100))
  assert.throws(() => assertResponseDeadline(100, 300, 100), /タイムアウト/)

  type ReturnBoundaryInternals = RecoveryInternals & {
    stripOuterFence: (text: string) => string
    cleanResponse: (text: string) => string
  }
  const realDateNow = Date.now
  let boundaryNow = 100
  Date.now = () => boundaryNow
  try {
    const clipboardBoundaryClient = new CopilotEdgeClient({ baseURL: '', model: '', provider: 'copilot-edge' })
    const clipboardBoundary = clipboardBoundaryClient as unknown as ReturnBoundaryInternals
    clipboardBoundary.bringToFront = async () => {}
    clipboardBoundary.grantClipboard = async () => {}
    clipboardBoundary.readSystemClipboard = () => ''
    let clipboardEvalCalls = 0
    clipboardBoundary.evalWithReconnect = async () => {
      clipboardEvalCalls++
      if (clipboardEvalCalls === 1) return 'old clipboard'
      if (clipboardEvalCalls === 2) return JSON.stringify({ clicked: true })
      return 'new clipboard response'
    }
    clipboardBoundary.stripOuterFence = () => {
      boundaryNow = 102
      return 'new clipboard response'
    }
    await assert.rejects(clipboardBoundary.finalizeAnswer('fallback', 102), /タイムアウト/)

    boundaryNow = 200
    const fallbackBoundaryClient = new CopilotEdgeClient({ baseURL: '', model: '', provider: 'copilot-edge' })
    const fallbackBoundary = fallbackBoundaryClient as unknown as ReturnBoundaryInternals
    fallbackBoundary.bringToFront = async () => {}
    fallbackBoundary.grantClipboard = async () => {}
    fallbackBoundary.readSystemClipboard = () => ''
    let fallbackEvalCalls = 0
    fallbackBoundary.evalWithReconnect = async () => {
      fallbackEvalCalls++
      return fallbackEvalCalls === 1 ? 'old clipboard' : JSON.stringify({ clicked: false })
    }
    fallbackBoundary.cleanResponse = () => {
      boundaryNow = 202
      return 'fallback response'
    }
    await assert.rejects(fallbackBoundary.finalizeAnswer('fallback', 202), /タイムアウト/)

    boundaryNow = 300
    const systemClipboardClient = new CopilotEdgeClient({ baseURL: '', model: '', provider: 'copilot-edge' })
    const systemClipboard = systemClipboardClient as unknown as ReturnBoundaryInternals
    systemClipboard.bringToFront = async () => {}
    systemClipboard.grantClipboard = async () => {}
    let systemClipboardReads = 0
    systemClipboard.readSystemClipboard = () => (++systemClipboardReads === 1 ? 'old clipboard' : 'new clipboard response')
    systemClipboard.evalWithReconnect = async () => JSON.stringify({ clicked: true })
    assert.strictEqual(await systemClipboard.finalizeAnswer('fallback', 5000), 'new clipboard response')

    boundaryNow = 1000
    const waitBoundaryClient = new CopilotEdgeClient({
      baseURL: '',
      model: '',
      provider: 'copilot-edge',
      copilot: { responseTimeoutSec: 5, pollIntervalMs: 500 }
    })
    const waitBoundary = waitBoundaryClient as unknown as DeadlineInternals
    let waitPolls = 0
    waitBoundary.readScreenState = async () => {
      waitPolls++
      boundaryNow = waitPolls === 1 ? 1000 : 2100
      return { text: 'complete response', generating: false, copyEnabled: true, signinRequired: false }
    }
    waitBoundary.finalizeAnswer = async () => {
      boundaryNow = 6000
      return 'complete response'
    }
    await assert.rejects(waitBoundary.waitResponse('baseline'), /タイムアウト/)
  } finally {
    Date.now = realDateNow
  }

  const orderClient = new CopilotEdgeClient({ baseURL: '', model: '', provider: 'copilot-edge' })
  type CompleteInternals = {
    ensureEdge: () => Promise<void>
    ensurePage: () => Promise<void>
    freshChat: () => Promise<void>
    waitInputReady: () => Promise<void>
    selectModel: () => Promise<void>
    assertTrustedOrigin: () => Promise<void>
    insertPrompt: () => Promise<void>
    readScreenState: () => Promise<{ text: string; generating: boolean; copyEnabled: boolean; signinRequired: boolean }>
    clickSend: () => Promise<void>
    waitResponse: (baseline: string) => Promise<string>
  }
  const orderInternal = orderClient as unknown as CompleteInternals
  const order: string[] = []
  orderInternal.ensureEdge = async () => { order.push('edge') }
  orderInternal.ensurePage = async () => { order.push('page') }
  orderInternal.freshChat = async () => { order.push('fresh') }
  orderInternal.waitInputReady = async () => { order.push('input') }
  orderInternal.selectModel = async () => { order.push('model') }
  orderInternal.assertTrustedOrigin = async () => { order.push('origin') }
  orderInternal.insertPrompt = async () => { order.push('insert') }
  orderInternal.readScreenState = async () => {
    order.push('baseline')
    return { text: 'old response', generating: false, copyEnabled: true, signinRequired: false }
  }
  orderInternal.clickSend = async () => { order.push('send') }
  orderInternal.waitResponse = async (baseline) => { order.push(`wait:${baseline}`); return 'done' }
  assert.strictEqual(await orderClient.complete('prompt'), 'done')
  assert.ok(order.indexOf('baseline') < order.indexOf('send'))
  assert.strictEqual(order[order.length - 1], 'wait:old response')
  console.log('PASS copilot-response-completion')
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
  const extractedJson = '{"companies":[{"id":"JP01","values":{"revenue":123}}]}'
  const backend = new FakeBackend([
    `{"tool":"write_file","path":"work/extracted.json","content":"${extractedJson}","AGENT_END":true}`,
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
  assert.strictEqual(fs.readFileSync(path.join(root, 'work', 'extracted.json'), 'utf8'), extractedJson)
  assert.strictEqual(backend.calls, 2)
  assert.ok(backend.prompts[1].includes('BEGIN_UNTRUSTED_HOST_RESULT'))
  assert.ok(backend.prompts[0].includes('AGENT_END'))
  fs.rmSync(root, { recursive: true, force: true })
  console.log('PASS copilot-loop')
}

async function testCopilotToolResultBudgets(): Promise<void> {
  const readRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-smoke-'))
  fs.writeFileSync(path.join(readRoot, 'a-long.txt'), `${'x'.repeat(3500)}\nLATE_TEXT_MARKER`)
  fs.writeFileSync(path.join(readRoot, 'z-final.xlsx'), Buffer.from('xlsx-placeholder'))
  const readBackend = new FakeBackend([
    '{"tool":"host.read_files","args":{"patterns":["a-long.txt","z-final.xlsx"]}}\nAGENT_END',
    '{"answer":"read complete"}\nAGENT_END'
  ])
  const readResult = await runAgentTurn({
    cfg: { baseURL: '', model: '', provider: 'copilot-edge', copilot: { agentMode: true } },
    messages: [],
    userInput: 'read all evidence',
    ctx: makeCtx(readRoot),
    io: ioStub(true),
    backend: readBackend
  })
  assert.strictEqual(readResult.reply, 'read complete')
  assert.ok(readBackend.prompts[1].includes('LATE_TEXT_MARKER'), 'read_files late text must reach the next prompt')
  assert.ok(readBackend.prompts[1].includes('z-final.xlsx'), 'final xlsx entry must reach the next prompt')
  assert.ok(readBackend.prompts[1].includes('tools/Read-Xlsx.ps1'), 'xlsx guidance must reach the next prompt')
  fs.rmSync(readRoot, { recursive: true, force: true })

  const commandRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-smoke-'))
  const emitterPath = path.join(commandRoot, 'emit-long.cjs')
  fs.writeFileSync(emitterPath, "process.stdout.write('A'.repeat(3500) + '\\nlast.xlsx FINAL_WORKBOOK_MARKER')")
  const command = `"${process.execPath}" "${emitterPath}"`
  const commandBackend = new FakeBackend([
    JSON.stringify({ tool: 'host.run_command', args: { command } }) + '\nAGENT_END',
    '{"answer":"command complete"}\nAGENT_END'
  ])
  const commandResult = await runAgentTurn({
    cfg: {
      baseURL: '',
      model: '',
      provider: 'copilot-edge',
      allowArbitraryCommands: true,
      autoApprove: { command: true },
      copilot: { agentMode: true }
    },
    messages: [],
    userInput: 'read all workbooks',
    ctx: makeCtx(commandRoot),
    io: ioStub(true),
    backend: commandBackend
  })
  assert.strictEqual(commandResult.reply, 'command complete')
  assert.ok(commandBackend.prompts[0].includes('任意のhostコマンド実行は自動承認済みです'), 'auto-approved command prompt must state that approval is already granted')
  assert.ok(!commandBackend.prompts[0].includes('実行前に承認を取得してください'), 'auto-approved command prompt must not ask the model to request approval')
  assert.ok(commandBackend.prompts[1].includes('last.xlsx FINAL_WORKBOOK_MARKER'), 'final command workbook must reach the next prompt')
  fs.rmSync(commandRoot, { recursive: true, force: true })
  console.log('PASS copilot-tool-result-budgets')
}

async function testMaxIterationHistory(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-smoke-'))
  const backend = new FakeBackend(['{"tool":"host.list_files","args":{}}'])
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
    '{\"tool\":\"host.write_file\",\"args\":{\"path\":\"fence.html\"}}\n```html\n<p>fence ok</p>\n```\nAGENT_END',
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
  for (const required of ['run-plan', 'run-eyebrow', 'run-pause', 'run-resume', 'run-retry', 'run-complete', '回答完了', 'activity-details', '実際の差分を表示', '差分の続き', 'preview-frame', 'verification-list', '診断JSON', 'approval-meta', 'parentRunId', '/api/runs/', '/api/changes/', 'compositionstart', 'aria-live', 'mode-select', 'このPCで実行', 'Copilot内で観測', '@media (max-width: 720px)']) assert.ok(html.includes(required), `UI contract missing: ${required}`)
  console.log('PASS ui-contract')
}

(async () => {
  await testWeather()
  await testApprovals()
  await testTools()
  await testAgentLoop()
  await testDenial()
  await testProtocolParsing()
  await testCopilotChoosesFirstAction()
  await testModeBoundaries()
  await testCopilotEdgeIsolation()
  await testCopilotResponseCompletion()
  await testCopilotChunkFallback()
  await testCopilotLoop()
  await testCopilotToolResultBudgets()
  await testMaxIterationHistory()
  await testCopilotPlainMode()
  await testCopilotFenceMode()
  await testUiContract()
  console.log('ALL PASS')
})().catch((err) => {
  console.error(err)
  process.exit(1)
})
