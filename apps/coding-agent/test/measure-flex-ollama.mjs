import fs from 'node:fs'
import fsp from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import process from 'node:process'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const tempRoot = path.join(projectRoot, '.tmp', `ollama-live-${runId}`)
const workspace = path.join(tempRoot, 'workspace')
const auditDir = path.join(tempRoot, 'audit')
const appData = path.join(tempRoot, 'appdata')
const localAppData = path.join(tempRoot, 'localappdata')
const configPath = path.join(tempRoot, 'config.json')
const outputPath = path.resolve(process.env.OLLAMA_LIVE_OUTPUT ?? path.join(projectRoot, '.tmp', 'flex-ollama-live-result.json'))
const baseURL = process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434/v1'
const model = process.env.OLLAMA_MODEL ?? 'ornith-1.5:9b'
const taskTimeoutMs = Number(process.env.OLLAMA_LIVE_TASK_TIMEOUT_MS ?? 300_000)
const requestedTasks = new Set((process.env.OLLAMA_LIVE_TASKS ?? 'list,read,open,write,search,long').split(',').map((value) => value.trim()).filter(Boolean))
const reasoningEffort = process.env.OLLAMA_REASONING_EFFORT?.trim() || null
if (reasoningEffort && !['high', 'medium', 'low', 'none'].includes(reasoningEffort)) throw new Error('OLLAMA_REASONING_EFFORT must be high, medium, low, or none')

let child
const childOutput = []
const results = []
let longCase = null
let ollamaPs = { before: null, after: null }
let failure = null

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port
      probe.close((error) => error ? reject(error) : resolve(port))
    })
  })
}

async function jsonRequest(url, options = {}, timeoutMs = taskTimeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, {
      ...options,
      signal: options.signal ?? controller.signal,
      headers: { 'content-type': 'application/json; charset=utf-8', ...(options.headers ?? {}) }
    })
    const text = await response.text()
    let body
    try { body = JSON.parse(text) } catch { body = { text } }
    if (!response.ok) throw new Error(`${response.status} ${url}: ${JSON.stringify(body)}`)
    return body
  } finally {
    clearTimeout(timer)
  }
}

function originForOllama(value) {
  const parsed = new URL(value)
  return `${parsed.protocol}//${parsed.host}`
}

async function queryOllamaPs() {
  const url = `${originForOllama(baseURL)}/api/ps`
  const response = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000) })
  const text = await response.text()
  let body
  try { body = JSON.parse(text) } catch { throw new Error(`Ollama /api/ps returned invalid JSON: ${text.slice(0, 300)}`) }
  if (!response.ok) throw new Error(`Ollama /api/ps failed (${response.status}): ${JSON.stringify(body)}`)
  const models = Array.isArray(body?.models) ? body.models : []
  // `/api/ps` may expose several aliases with a common prefix.  The live
  // result must describe the exact model requested by the harness, never a
  // similarly named model that happened to be loaded.
  const selected = models.find((entry) => String(entry?.name ?? entry?.model ?? '') === model) ?? null
  return {
    url,
    queriedAt: new Date().toISOString(),
    model,
    ...(reasoningEffort ? { reasoningEffort } : {}),
    availableModels: models.map((entry) => String(entry?.name ?? entry?.model ?? '')).filter(Boolean),
    loaded: Boolean(selected),
    context: selected?.context_length ?? selected?.contextLength ?? selected?.details?.context_length ?? null,
    size: selected?.size ?? selected?.size_bytes ?? null,
    sizeVram: selected?.size_vram ?? selected?.sizeVram ?? null,
    parameterSize: selected?.details?.parameter_size ?? null
  }
}

function writeFixtures() {
  fs.mkdirSync(workspace, { recursive: true })
  fs.writeFileSync(path.join(workspace, '概要_日本語.txt'), '色: 青\n用途: Ollama UTF-8 検証\n', 'utf8')
  fs.writeFileSync(path.join(workspace, '表示用.csv'), '項目,値\n速度,確認\n', 'utf8')
  fs.writeFileSync(path.join(workspace, '検索資料.txt'), '計測キーワード: セキュリティ\n', 'utf8')
  const longLines = []
  for (let index = 1; index <= 100; index++) {
    longLines.push(`行${index}: これは数千トークンのツール結果を作るための日本語サンプル本文です。識別子=${index.toString(16).padStart(4, '0')}。`)
  }
  longLines[77] += ' 長文検索語'
  fs.writeFileSync(path.join(workspace, '長文資料_日本語.txt'), `${longLines.join('\n')}\n`, 'utf8')
  try { fs.rmSync(path.join(workspace, '作業メモ_日本語.txt'), { force: true }) } catch {}
}

function writeConfig() {
  const config = {
    agentLoop: 'v2',
    provider: 'ollama',
    baseURL,
    model,
    ...(reasoningEffort ? { reasoningEffort } : {}),
    temperature: 0.2,
    maxToolIterations: 8,
    maxToolExecutions: 8,
    maxWriteExecutions: 2,
    maxCommandExecutions: 1,
    maxNoProgress: 2,
    allowArbitraryCommands: false,
    safeCommandOnly: true,
    restrictToWorkspace: true,
    autoApprove: { write: false, command: false },
    auditLogDir: auditDir,
    permissions: [
      { permission: 'list_files', pattern: '*', action: 'allow' },
      { permission: 'read_file', pattern: '*', action: 'allow' },
      { permission: 'read_files', pattern: '*', action: 'allow' },
      { permission: 'read_xlsx', pattern: '*', action: 'allow' },
      { permission: 'search_files', pattern: '*', action: 'allow' },
      { permission: 'list_processes', pattern: '*', action: 'allow' },
      { permission: 'read_process_log', pattern: '*', action: 'allow' },
      { permission: 'write_file', pattern: '*', action: 'ask' },
      { permission: 'write_file.overwrite', pattern: '*', action: 'ask' },
      { permission: 'start_process', pattern: '*', action: 'ask' },
      { permission: 'run_command', pattern: '*', action: 'ask' }
    ],
    systemPrompt: [
      'あなたはローカルOllamaのコーディング支援エージェントです。必ずhostツールで確認してから日本語で回答してください。',
      '一覧はlist_files、読むはread_file、検索はsearch_filesを使い、要求された相対パスだけを対象にしてください。',
      '「開く」はstart_processで既存のCSVを開き、commandは表示用.csvだけにしてください。外部URLや任意コマンドは禁止です。',
      'ファイルを開くstart_processが成功したら、その結果だけで完了してください。read_process_log、list_processes、stop_processは不要です。',
      '書き込みはwrite_fileで指定された新規ファイルだけを作り、本文をそのまま保存してください。',
      'ツール呼び出しは常に一度に一つだけにし、内部思考タグや<think>を最終回答へ出力しないでください。'
    ].join('\n')
  }
  fs.mkdirSync(tempRoot, { recursive: true })
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
}

function captureChild(stream) {
  stream.setEncoding('utf8')
  stream.on('data', (chunk) => {
    childOutput.push(String(chunk))
    if (childOutput.length > 400) childOutput.splice(0, childOutput.length - 400)
  })
}

async function startServer() {
  const port = await freePort()
  child = spawn(process.execPath, ['dist/server.js', '--config', configPath, '--workspace', workspace], {
    cwd: projectRoot,
    env: {
      ...process.env,
      PORT: String(port),
      APPDATA: appData,
      LOCALAPPDATA: localAppData,
      CODING_AGENT_NO_BROWSER: '1',
      NO_COLOR: '1'
    },
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  captureChild(child.stdout)
  captureChild(child.stderr)
  const url = `http://127.0.0.1:${port}`
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`coding-agent server exited before readiness (${child.exitCode})`)
    try {
      await jsonRequest(`${url}/api/sessions`, {}, 2_000)
      return url
    } catch {
      await sleep(200)
    }
  }
  throw new Error(`coding-agent server did not become ready: ${childOutput.join('').slice(-2000)}`)
}

async function stopServer() {
  if (!child || child.exitCode !== null) return
  const processChild = child
  await new Promise((resolve) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      try { processChild.kill('SIGKILL') } catch {}
      finish()
    }, 5_000)
    processChild.once('close', finish)
    try { processChild.kill('SIGTERM') } catch { finish() }
  })
}

function expectedApproval(task, approval) {
  const binding = approval?.binding ?? {}
  if (path.resolve(String(approval?.scope ?? '')) !== path.resolve(workspace)) return false
  if (task.type === 'write') {
    return String(approval?.toolName ?? '').endsWith('write_file')
      && binding.path === task.path
      && binding.existedBefore === false
      && !String(binding.command ?? '')
  }
  if (task.type === 'open') {
    const command = String(binding.command ?? '').trim().replaceAll('\\', '/')
    const allowed = new Set([task.path, `./${task.path}`, `Start-Process -FilePath './${task.path}'`, `Invoke-Item '${task.path}'`])
    return String(approval?.toolName ?? '').endsWith('start_process') && allowed.has(command)
  }
  return false
}

async function resolveApprovalsUntil(state, baseURLForServer, sessionId, task) {
  while (!state.done && !state.error) {
    try {
      const sessions = await jsonRequest(`${baseURLForServer}/api/sessions`, {}, 10_000)
      const current = (sessions.sessions ?? []).find((entry) => entry.id === sessionId)
      const runId = current?.latestRun?.id
      const pending = await jsonRequest(`${baseURLForServer}/api/approvals`, {}, 10_000)
      for (const approval of pending.approvals ?? []) {
        if (!runId || approval.runId !== runId) continue
        const permitted = expectedApproval(task, approval)
        await jsonRequest(`${baseURLForServer}/api/approvals/resolve`, {
          method: 'POST',
          body: JSON.stringify({ id: approval.id, approved: permitted })
        }, 10_000)
        if (!permitted) state.error = `unexpected approval for ${task.type}: ${JSON.stringify({ toolName: approval.toolName, binding: approval.binding })}`
      }
    } catch (error) {
      // The turn may still be creating its Run. Keep polling transient API
      // errors, but surface a persistent server failure through the turn.
      if (error?.name === 'AbortError') state.error = error.message
    }
    if (!state.done && !state.error) await sleep(150)
  }
}

function eventList(run) {
  return Array.isArray(run?.events) ? run.events : []
}

function replacementOrThink(value) {
  const text = String(value ?? '')
  return { replacement: text.includes('\uFFFD'), think: /<think>|<\/think>/iu.test(text) }
}

function eventSummary(events) {
  const modelEvents = events.filter((event) => event.type === 'model.decision')
  const requested = events.filter((event) => event.type === 'tool.requested')
  const terminal = events.filter((event) => ['tool.succeeded', 'tool.failed', 'tool.denied'].includes(event.type))
  const approvalRequested = events.filter((event) => event.type === 'approval.requested')
  const approvalResolved = events.filter((event) => event.type === 'approval.resolved')
  const concreteApprovalRequested = approvalRequested.filter((event) => event.metadata?.approval?.id)
  const concreteApprovalResolved = approvalResolved.filter((event) => event.metadata?.approval?.id)
  return {
    modelDecisionCount: modelEvents.length,
    toolCallCount: requested.length,
    toolCallNames: requested.map((event) => event.tool),
    approvalRequestedCount: new Set(concreteApprovalRequested.map((event) => event.metadata.approval.id)).size,
    approvalResolvedCount: new Set(concreteApprovalResolved.map((event) => event.metadata.approval.id)).size,
    approvalEventCount: approvalRequested.length + approvalResolved.length,
    approvalOutcomes: concreteApprovalResolved.map((event) => event.approved === true ? 'approved' : 'denied'),
    retries: events.filter((event) => /retry|再試行/iu.test(`${event.type} ${event.message ?? ''}`)).length,
    failures: events.filter((event) => event.type === 'tool.failed' || event.type === 'run.failed').length,
    warnings: events.filter((event) => event.type === 'run.warning').length,
    terminal,
    rounds: requested.map((event, index) => ({ round: index + 1, callId: event.callId ?? null, tool: event.tool, summary: event.summary ?? null }))
  }
}

function assertAuditRecords(records, task, summary) {
  if (!records.length) throw new Error(`${task.type}: audit record missing`)
  const terminalIds = new Set(summary.terminal.map((event) => event.callId).filter(Boolean))
  if (terminalIds.size > 0 && records.length < terminalIds.size) throw new Error(`${task.type}: audit record count is lower than terminal tool count`)
  for (const record of records) {
    if (record.schema_version !== 1 || typeof record.tool_name !== 'string' || !record.tool_name.startsWith('host.')) throw new Error(`${task.type}: invalid audit tool/schema`)
    if (typeof record.arguments?.summary !== 'string' || !/^[a-f0-9]{64}$/u.test(String(record.arguments?.sha256 ?? ''))) throw new Error(`${task.type}: invalid audit arguments summary/hash`)
    if (!['allow', 'ask', 'deny'].includes(record.permission?.decision)) throw new Error(`${task.type}: invalid audit permission`)
    if (!['not_required', 'approved', 'denied'].includes(record.approval?.outcome) || !['policy', 'user'].includes(record.approval?.actor)) throw new Error(`${task.type}: invalid audit approval`)
    if (!['success', 'failure', 'refused'].includes(record.result?.outcome)) throw new Error(`${task.type}: invalid audit result`)
    if (!record.target || !('path' in record.target) || !('before_sha256' in record.target) || !('after_sha256' in record.target)) throw new Error(`${task.type}: audit target is incomplete`)
    if (record.call_id && terminalIds.size > 0 && !terminalIds.has(record.call_id)) throw new Error(`${task.type}: audit call is not correlated to a terminal event`)
    if (task.type === 'write' && record.tool_name.endsWith('write_file')) {
      const emptySha256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
      if (record.target.path !== task.path || ![null, emptySha256].includes(record.target.before_sha256) || !/^[a-f0-9]{64}$/u.test(String(record.target.after_sha256 ?? ''))) throw new Error(`${task.type}: write audit path/hash mismatch`)
    }
  }
}

function validateTask(task, response, auditRecords) {
  const events = eventList(response.run)
  const summary = eventSummary(events)
  const expectedTools = new Set([...task.expectedTools, 'list_files', 'read_file', 'read_files'])
  const unexpected = summary.toolCallNames.filter((name) => !expectedTools.has(String(name).replace(/^host\./u, '')))
  if (unexpected.length) throw new Error(`${task.type}: unexpected tool calls: ${unexpected.join(', ')}`)
  if (response.aborted === true || !response.run || summary.failures > 0 || summary.warnings > 0) throw new Error(`${task.type}: run aborted/failed/warned`)
  if (!summary.terminal.some((event) => event.type === 'tool.succeeded')) throw new Error(`${task.type}: expected successful tool event missing`)
  const requested = events.filter((event) => event.type === 'tool.requested')
  if (task.path && task.type !== 'open') {
    const pathMentioned = requested.some((event) => String(event.summary ?? '').includes(task.path))
    if (!pathMentioned) throw new Error(`${task.type}: requested tool did not target the expected path`)
  }
  if (task.type === 'search' && !requested.some((event) => String(event.summary ?? '').includes(task.query))) throw new Error(`${task.type}: requested tool did not use the expected Japanese query`)
  if (task.type === 'open' || task.type === 'write') {
    const approvalEvents = events.filter((event) => event.type === 'approval.requested' && event.metadata?.approval?.id)
    if (approvalEvents.length !== 1) throw new Error(`${task.type}: expected exactly one approval request`)
    const approval = approvalEvents[0].metadata?.approval
    if (!expectedApproval(task, approval)) throw new Error(`${task.type}: approval binding was not exact`)
  }
  const requiredTool = { list: 'list_files', read: 'read_file', open: 'start_process', write: 'write_file', search: 'search_files' }[task.type]
  if (requiredTool && !summary.toolCallNames.some((name) => String(name).endsWith(requiredTool))) throw new Error(`${task.type}: ${requiredTool} was not selected`)
  if (task.type === 'list' && !['概要_日本語.txt', '表示用.csv', '検索資料.txt'].every((name) => String(response.reply ?? '').includes(name))) throw new Error(`${task.type}: reply omitted fixture names`)
  if (task.type === 'read' && !String(response.reply ?? '').includes('青')) throw new Error(`${task.type}: reply omitted Japanese file content`)
  if (task.type === 'search' && !String(response.reply ?? '').includes('セキュリティ')) throw new Error(`${task.type}: reply omitted Japanese search result`)
  if (task.type === 'write' && (!fs.existsSync(path.join(workspace, task.path)) || !fs.readFileSync(path.join(workspace, task.path), 'utf8').includes('速度確認'))) throw new Error(`${task.type}: expected Japanese file/content was not written`)
  const outputChecks = [replacementOrThink(response.reply)]
  for (const event of events) outputChecks.push(replacementOrThink(event.output))
  if (outputChecks.some((check) => check.replacement || check.think)) throw new Error(`${task.type}: UTF-8 replacement or <think> leakage detected`)
  assertAuditRecords(auditRecords, task, summary)
  return {
    ...task,
    ok: true,
    runId: response.run.id,
    elapsedMs: task.elapsedMs,
    ...summary,
    finalReply: String(response.reply ?? '').slice(0, 1000),
    utf8Replacement: false,
    thinkLeakage: false,
    auditRecordCount: auditRecords.length
  }
}

async function runTask(serverURL, task) {
  if (task.type === 'write') try { fs.rmSync(path.join(workspace, task.path), { force: true }) } catch {}
  const session = await jsonRequest(`${serverURL}/api/sessions`, { method: 'POST', body: '{}' })
  const state = { done: false, error: null }
  const approvalWorker = resolveApprovalsUntil(state, serverURL, session.id, task)
  const startedAt = performance.now()
  let response
  try {
    response = await jsonRequest(`${serverURL}/api/turn`, {
      method: 'POST',
      body: JSON.stringify({ message: task.request, mode: 'work', sessionId: session.id })
    })
  } finally {
    state.done = true
    await approvalWorker
  }
  if (state.error) throw new Error(state.error)
  const elapsedMs = Math.round(performance.now() - startedAt)
  const audit = await jsonRequest(`${serverURL}/api/audit?limit=500`)
  const records = (audit.records ?? []).filter((record) => record.run_id === response.run?.id)
  return validateTask({ ...task, elapsedMs }, response, records)
}

async function runLongCase(serverURL) {
  const task = {
    type: 'long',
    request: '検証手順を厳密に実行してください。最初の判断ラウンドではread_fileだけを使い、path="長文資料_日本語.txt"を全文読み取ってください。次の判断ラウンドではsearch_filesだけを使い、query="長文検索語"、path="."で検索してください。その後はhostツールを一切使わず、見つかった行番号だけを日本語で回答してください。write_fileを含む他のツール、同じツールの反復、ファイル作成・変更は禁止です。',
    expectedTools: ['read_file', 'search_files'],
    path: '長文資料_日本語.txt'
  }
  const session = await jsonRequest(`${serverURL}/api/sessions`, { method: 'POST', body: '{}' })
  const state = { done: false, error: null }
  const approvalWorker = resolveApprovalsUntil(state, serverURL, session.id, task)
  const startedAt = performance.now()
  let response
  try {
    response = await jsonRequest(`${serverURL}/api/turn`, { method: 'POST', body: JSON.stringify({ message: task.request, mode: 'work', sessionId: session.id }) })
  } finally {
    state.done = true
    await approvalWorker
  }
  if (state.error) throw new Error(state.error)
  const events = eventList(response.run)
  const summary = eventSummary(events)
  const toolNames = new Set(summary.toolCallNames.map((name) => String(name).replace(/^host\./u, '')))
  if (response.aborted === true || !toolNames.has('read_file') || !toolNames.has('search_files') || summary.toolCallCount < 2 || summary.modelDecisionCount < 2) {
    throw new Error(`long case did not complete two model/tool rounds: ${JSON.stringify({ toolNames: [...toolNames], modelDecisionCount: summary.modelDecisionCount, toolCallCount: summary.toolCallCount })}`)
  }
  const audit = await jsonRequest(`${serverURL}/api/audit?limit=500`)
  const records = (audit.records ?? []).filter((record) => record.run_id === response.run?.id)
  assertAuditRecords(records, task, summary)
  const allText = [response.reply, ...events.map((event) => event.output)].map((value) => String(value ?? '')).join('\n')
  const checks = replacementOrThink(allText)
  if (checks.replacement || checks.think) throw new Error('long case UTF-8 replacement or <think> leakage detected')
  const longSource = fs.readFileSync(path.join(workspace, task.path), 'utf8')
  const longToolResult = longSource
    .split('\n')
    .slice(0, 2000)
    .map((line, index) => `${index + 1}: ${line}`)
    .join('\n')
    .slice(0, 100_000)
  return {
    ...task,
    ok: true,
    runId: response.run?.id ?? null,
    elapsedMs: Math.round(performance.now() - startedAt),
    ...summary,
    promptToolRoundEvidence: summary.rounds,
    longToolResultSize: {
      utf8Bytes: Buffer.byteLength(longToolResult, 'utf8'),
      jsCharacters: longToolResult.length
    },
    finalReply: String(response.reply ?? '').slice(0, 1000),
    utf8Replacement: false,
    thinkLeakage: false,
    auditRecordCount: records.length
  }
}

async function main() {
  const tasks = [
    { type: 'list', request: 'ワークスペース直下に何があるか一覧してください。', expectedTools: ['list_files'] },
    { type: 'read', request: '概要_日本語.txtを読んで、色を教えてください。', expectedTools: ['read_file'], path: '概要_日本語.txt' },
    { type: 'open', request: '表示用.csvを実際に開いてください。', expectedTools: ['start_process', 'read_process_log', 'list_processes'], path: '表示用.csv' },
    { type: 'write', request: '作業メモ_日本語.txtを新しく作成して、本文を「速度確認」にしてください。', expectedTools: ['write_file'], path: '作業メモ_日本語.txt' },
    { type: 'search', request: '全ファイルから「セキュリティ」を検索してください。', expectedTools: ['search_files'], query: 'セキュリティ' }
  ]
  fs.mkdirSync(tempRoot, { recursive: true })
  fs.mkdirSync(auditDir, { recursive: true })
  fs.mkdirSync(appData, { recursive: true })
  fs.mkdirSync(localAppData, { recursive: true })
  writeFixtures()
  writeConfig()
  try { ollamaPs.before = await queryOllamaPs() } catch (error) { ollamaPs.before = { error: error.message } }
  const serverURL = await startServer()
  for (const task of tasks.filter((candidate) => requestedTasks.has(candidate.type))) {
    const result = await runTask(serverURL, task)
    results.push(result)
    console.log(`OLLAMA_LIVE_TASK\t${task.type}\tPASS\t${result.elapsedMs}ms\tmodels=${result.modelDecisionCount}\ttools=${result.toolCallNames.join(',')}`)
  }
  if (requestedTasks.has('long')) {
    longCase = await runLongCase(serverURL)
    console.log(`OLLAMA_LIVE_TASK\tlong\tPASS\t${longCase.elapsedMs}ms\tmodels=${longCase.modelDecisionCount}\ttools=${longCase.toolCallNames.join(',')}`)
  }
  try { ollamaPs.after = await queryOllamaPs() } catch (error) { ollamaPs.after = { error: error.message } }
  if (ollamaPs.after?.error) throw new Error(`Ollama /api/ps after live tasks failed: ${ollamaPs.after.error}`)
}

async function writeOutput(summary) {
  await fsp.mkdir(path.dirname(outputPath), { recursive: true })
  await fsp.writeFile(outputPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
}

try {
  await main()
} catch (error) {
  failure = error instanceof Error ? error.message : String(error)
  console.error(`[ollama-live] ${failure}`)
} finally {
  const baseTaskNames = ['list', 'read', 'open', 'write', 'search']
  const expectedBaseTasks = baseTaskNames.filter((name) => requestedTasks.has(name)).length
  const expectsLong = requestedTasks.has('long')
  await stopServer()
  const summary = {
    measuredAt: new Date().toISOString(),
    success: !failure && results.length === expectedBaseTasks && (!expectsLong || longCase?.ok === true),
    total: expectedBaseTasks + (expectsLong ? 1 : 0),
    completed: results.length + (longCase?.ok === true ? 1 : 0),
    requestedTasks: [...requestedTasks],
    baseURL,
    model,
    reasoningEffort,
    workspace,
    auditDir,
    configPath,
    outputPath,
    tasks: results,
    longCase,
    ollamaPs,
    childLogTail: childOutput.join('').slice(-4000),
    failure
  }
  try { await writeOutput(summary) } catch (error) { failure = `${failure ? `${failure}; ` : ''}result write failed: ${error.message}` }
  console.log(`OLLAMA_LIVE_SUMMARY ${JSON.stringify({ success: summary.success && !failure, total: summary.total, completed: summary.completed, model, context: ollamaPs.after?.context ?? ollamaPs.before?.context ?? null, size: ollamaPs.after?.size ?? ollamaPs.before?.size ?? null, outputPath, failure })}`)
  if (failure || !summary.success) process.exitCode = 1
}
