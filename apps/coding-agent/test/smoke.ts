import assert from 'node:assert'
import http from 'node:http'
import net from 'node:net'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { extractJsonReply, runAgentTurn, type AgentEvent, type AgentIO, type TextBackend } from '../src/agent'
import { createOllamaFetch, executeV2ToolCall, runAgentTurnV2 } from '../src/agent-v2'
import { runConfiguredAgentTurn } from '../src/agent-loop'
import { clearToolExecuteBeforeHooks, registerToolExecuteBeforeHook } from '../src/hooks'
import { assertSyntheticWorkspaceBoundary, capabilityPolicy, loadConfig, resolveSyntheticWorkspace, SYNTHETIC_WORKSPACE_MARKER, SYNTHETIC_WORKSPACE_MARKER_EXPECTED, type AgentConfig } from '../src/config'
import { commandPermissionTarget, createPermissionHook, evaluateToolPermission } from '../src/permission-hook'
import { isCurrentSessionRun } from '../src/ui/session-guard'
import type { ChatMessage } from '../src/llm'
import {
  COPILOT_CLICK_SEND_JS,
  COPILOT_SEND_READY_JS,
  COPILOT_CLICK_COPY_JS,
  isResponseCopyControl,
  COPILOT_SCREEN_STATE_JS,
  CopilotEdgeClient,
  assertResponseDeadline,
  isStopGenerationControl,
  makeVisibleSessionMarker,
  normalizeCopilotEditorText,
  resolveCopilotSettings,
  selectBrowserProcessId,
  selectLatestResponseCandidate,
  updateResponseCompletionState,
  visibleSessionMarkerMatches,
  type ResponseCompletionState
} from '../src/copilot'

import { formatHostCommandOutput, getFileSnapshot, normalizeRunCommand, normalizeWorkspaceOpenCommand, openAITools, parseToolResultMeta, prepareHostCommand, rollbackFileChange, validateToolArgs, TOOL_DEFS, type ToolContext } from '../src/tools'
import { getApprovalResolution, listApprovals, requestApproval, resolveApproval } from '../src/approvals'
import { getWeather, weatherCodeLabel, type WeatherFetcher } from '../src/weather'
import { convertCopilotResponse } from '../src/converter'
import { buildBridgePrompt, createOpenAICompatibleBridgeServer, interpretBridgeResponse, type OpenAITool } from '../src/openai-bridge'
import { AuditLog, auditArgsSha256, auditAvailability, auditRecordFromOutcome, auditRecordsToCsv, makeAuditRecord } from '../src/audit-log'

function makeCtx(root: string, restrict = true): ToolContext {
  return { workspace: root, restrictToWorkspace: restrict }
}

function ioStub(approve: boolean): AgentIO {
  return {
    print: () => {},
    askYesNo: async () => approve
  }
}

async function testAuditLog(): Promise<void> {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-smoke-audit-workspace-'))
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-smoke-audit-dir-'))
  const log = new AuditLog({ workspace, directory })
  log.initialize()
  const record = makeAuditRecord({
    event_id: 'run-audit-event-1',
    timestamp: '2026-08-27T00:00:00.000Z',
    session_id: 'session-audit',
    run_id: 'run-audit',
    call_id: 'call-audit',
    tool_name: 'host.write_file',
    arguments: { summary: 'write_file: notes.txt', sha256: 'a'.repeat(64) },
    permission: { decision: 'ask' },
    approval: { required: true, outcome: 'approved', actor: 'user', automatic: false },
    result: { outcome: 'success', duration_ms: 4, error: null },
    target: { path: 'notes.txt', before_sha256: 'b'.repeat(64), after_sha256: 'c'.repeat(64) }
  })
  log.append(record)
  const denied = { ...record, event_id: 'run-audit-event-2', call_id: 'call-denied', permission: { decision: 'deny' as const }, approval: { required: false, outcome: 'not_required' as const, actor: 'policy' as const, automatic: true }, result: { outcome: 'refused' as const, duration_ms: null, error: 'permission denied' } }
  log.append(denied)
  const lines = fs.readFileSync(log.filePath, 'utf8').trimEnd().split(/\r?\n/u)
  assert.strictEqual(lines.length, 2)
  for (const line of lines) assert.doesNotThrow(() => JSON.parse(line))
  assert.strictEqual(log.records(1)[0].event_id, 'run-audit-event-2', 'records must return newest first')
  assert.strictEqual(log.records(20, { result: 'success' }).length, 1)
  assert.strictEqual(log.records(20, { permission: 'deny' })[0].result.outcome, 'refused')
  const csv = log.csv()
  assert.ok(csv.startsWith('schema_version,event_id,timestamp'))
  assert.ok(csv.includes('host.write_file') && csv.includes('permission denied'))
  assert.strictEqual(auditRecordsToCsv([record]).split(/\r?\n/u).length, 3)
  const correlatedCallId = 'call-user-approval'
  const correlatedAudit = auditRecordFromOutcome({
    sessionId: 'session-correlation',
    runId: 'run-correlation',
    history: [
      { type: 'tool.requested', origin: 'host', callId: correlatedCallId, tool: 'host.write_file', audit: { arguments: record.arguments, permission: { decision: 'ask' }, approval: { required: true, outcome: 'not_required', actor: 'policy', automatic: false }, target: record.target } },
      { type: 'approval.requested', origin: 'host', callId: correlatedCallId },
      { type: 'approval.resolved', origin: 'host', callId: correlatedCallId, approved: true, metadata: { approval: { reason: '利用者が許可しました' } } }
    ],
    event: { type: 'tool.succeeded', origin: 'host', eventId: 'run-correlation-event-1', at: Date.parse(record.timestamp), callId: correlatedCallId, tool: 'host.write_file', summary: record.arguments.summary, audit: { arguments: record.arguments, permission: { decision: 'ask' }, approval: { required: true, outcome: 'not_required', actor: 'policy', automatic: false }, target: record.target } }
  })
  assert.ok(correlatedAudit)
  assert.deepStrictEqual(correlatedAudit.approval, { required: true, outcome: 'approved', actor: 'user', automatic: false })
  assert.strictEqual(correlatedAudit.call_id, correlatedCallId)
  log.append(correlatedAudit!)
  const correlatedDenied = auditRecordFromOutcome({
    sessionId: 'session-correlation',
    runId: 'run-correlation',
    // A client-controlled reason that looks like a timeout must not change
    // the server-authenticated user provenance (there is no provenance here,
    // so the compatibility default remains user).
    history: [{ type: 'approval.requested', origin: 'host', callId: correlatedCallId + '-deny' }, { type: 'approval.resolved', origin: 'host', callId: correlatedCallId + '-deny', approved: false, metadata: { approval: { reason: '承認期限切れ' } } }],
    event: { type: 'tool.denied', origin: 'host', eventId: 'run-correlation-event-2', at: Date.parse(record.timestamp), callId: correlatedCallId + '-deny', tool: 'host.write_file', summary: record.arguments.summary, error: 'ユーザーが拒否しました', audit: { arguments: record.arguments, permission: { decision: 'ask' }, approval: { required: true, outcome: 'not_required', actor: 'policy', automatic: false }, target: record.target } }
  })
  assert.ok(correlatedDenied)
  assert.deepStrictEqual(correlatedDenied.approval, { required: true, outcome: 'denied', actor: 'user', automatic: false })
  log.append(correlatedDenied!)
  assert.deepStrictEqual(log.records(10, { result: 'refused' })[0].approval, { required: true, outcome: 'denied', actor: 'user', automatic: false })
  // The server approval API resolves a timeout/cancel first, then the agent
  // may emit a duplicate approval.resolved for the same call. The policy
  // reason must win over the later user-shaped event in the terminal record.
  const duplicateUserAudit = {
    arguments: record.arguments,
    permission: { decision: 'ask' as const },
    approval: { required: true, outcome: 'denied' as const, actor: 'user' as const, automatic: false },
    target: record.target
  }
  for (const policyReason of ['承認期限切れ', '実行キャンセルにより拒否されました', 'サーバー終了により拒否されました']) {
    const policyCallId = `call-policy-${policyReason}`
    const policyAudit = auditRecordFromOutcome({
      sessionId: 'session-correlation',
      runId: 'run-correlation',
      history: [
        { type: 'tool.requested', origin: 'host', callId: policyCallId, tool: 'host.write_file', audit: duplicateUserAudit },
        { type: 'approval.requested', origin: 'host', callId: policyCallId },
        { type: 'approval.resolved', origin: 'host', authority: 'authoritative', callId: policyCallId, approved: false, metadata: { approval: { reason: policyReason, provenance: { actor: 'policy', automatic: true } } } },
        { type: 'approval.resolved', origin: 'host', callId: policyCallId, approved: false, audit: duplicateUserAudit }
      ],
      event: { type: 'tool.denied', origin: 'host', eventId: `${policyCallId}-terminal`, at: Date.parse(record.timestamp), callId: policyCallId, tool: 'host.write_file', summary: record.arguments.summary, error: policyReason, audit: duplicateUserAudit }
    })
    assert.ok(policyAudit)
    assert.deepStrictEqual(policyAudit.approval, { required: true, outcome: 'denied', actor: 'policy', automatic: true }, `policy reason must win: ${policyReason}`)
    assert.strictEqual(policyAudit.call_id, policyCallId)
  }
  assert.throws(() => new AuditLog({ workspace, directory: path.join(workspace, 'audit') }), /ワークスペース外/)
  assert.throws(() => new AuditLog({ workspace, directory: workspace }), /ワークスペース外/)
  const brokenLog = new AuditLog({ workspace, directory: fs.mkdtempSync(path.join(os.tmpdir(), 'ca-smoke-audit-broken-')) })
  brokenLog.initialize()
  // Simulate a runtime append failure without touching the filesystem: the
  // persistent descriptor is intentionally made unavailable in this test.
  ;(brokenLog as unknown as { appendHandle: number | null }).appendHandle = null
  assert.throws(() => brokenLog.append(record), /監査ログ追記に失敗しました/)
  assert.strictEqual(brokenLog.healthy, false)
  assert.deepStrictEqual(auditAvailability(brokenLog, null), { available: false, detail: '監査ログの追記ハンドルがありません' })
  assert.strictEqual(auditAvailability(log, null).available, true)
  assert.deepStrictEqual(auditAvailability(log, '起動時障害'), { available: false, detail: '起動時障害' })
  assert.throws(() => brokenLog.append(record), /unhealthy/)
  const symlinkDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-smoke-audit-symlink-'))
  const symlinkPath = path.join(symlinkDirectory, 'audit.jsonl')
  try {
    fs.symlinkSync(log.filePath, symlinkPath, 'file')
    assert.throws(() => new AuditLog({ workspace, directory: symlinkDirectory }).initialize(), /シンボリックリンク／再解析点/)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'EPERM' && code !== 'EACCES') throw err
    console.log('SKIP audit-symlink (symlink creation is restricted on this host)')
  }

  const eventRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-smoke-audit-events-'))
  fs.writeFileSync(path.join(eventRoot, 'read.txt'), 'readable')
  const events: Array<{ type: string; audit?: { arguments: { sha256: string }; permission: { decision: string }; approval: { outcome: string; actor: string; automatic: boolean }; target: { before_sha256: string | null; after_sha256: string | null } } }> = []
  const eventIo: AgentIO = {
    print: () => {},
    askYesNo: async () => true,
    event: (event) => events.push(event as typeof events[number])
  }
  const eventCfg: AgentConfig = { baseURL: '', model: '', provider: 'openai', autoApprove: { write: false, command: false } }
  const eventCtx = { workspace: eventRoot, restrictToWorkspace: true }
  await executeV2ToolCall({ toolCallId: 'audit-read', toolName: 'read_file', input: { path: 'read.txt' } }, TOOL_DEFS.find((tool) => tool.name === 'read_file')!, eventCfg, eventCtx, eventIo, [])
  const readOutcome = events.find((event) => event.type === 'tool.succeeded' && event.audit?.permission.decision === 'allow')
  assert.ok(readOutcome?.audit)
  assert.strictEqual(readOutcome.audit.arguments.sha256, auditArgsSha256({ path: 'read.txt' }))
  assert.strictEqual(readOutcome.audit.approval.outcome, 'not_required')
  await executeV2ToolCall({ toolCallId: 'audit-write', toolName: 'write_file', input: { path: 'new.txt', content: 'new content' } }, TOOL_DEFS.find((tool) => tool.name === 'write_file')!, eventCfg, eventCtx, eventIo, [])
  const writeOutcome = events.find((event) => event.type === 'tool.succeeded' && event.audit?.permission.decision === 'ask')
  assert.ok(writeOutcome?.audit)
  assert.strictEqual(writeOutcome.audit.approval.actor, 'user')
  assert.strictEqual(writeOutcome.audit.approval.outcome, 'approved')
  assert.strictEqual(writeOutcome.audit.target.before_sha256, null)
  assert.ok(writeOutcome.audit.target.after_sha256)
  const deniedEvents: Array<{ type: string; audit?: { permission: { decision: string }; approval: { outcome: string }; target: { path: string | null } } }> = []
  const deniedIo: AgentIO = { ...eventIo, event: (event) => deniedEvents.push(event as typeof deniedEvents[number]) }
  await executeV2ToolCall({ toolCallId: 'audit-deny', toolName: 'write_file', input: { path: 'denied.txt', content: 'never' } }, TOOL_DEFS.find((tool) => tool.name === 'write_file')!, { ...eventCfg, permissions: [{ permission: 'write_file', pattern: '*', action: 'deny' }] }, eventCtx, deniedIo, [])
  const deniedOutcome = deniedEvents.find((event) => event.type === 'tool.denied')
  assert.strictEqual(deniedOutcome?.audit?.permission.decision, 'deny')
  assert.strictEqual(deniedOutcome?.audit?.approval.outcome, 'not_required')

  // Exercise the complete v2 host-tool event path and append each terminal
  // outcome exactly once. The second append with the same key models server
  // re-entry/duplicate delivery and must not create another JSONL line.
  const terminalLog = new AuditLog({ workspace: eventRoot, directory: fs.mkdtempSync(path.join(os.tmpdir(), 'ca-smoke-audit-terminal-')) })
  terminalLog.initialize()
  const terminalCfg: AgentConfig = { ...eventCfg, autoApprove: { write: false, command: false } }
  const terminalCalls: Array<{ id: string; name: string; input: Record<string, unknown>; cfg?: AgentConfig }> = [
    { id: 'audit-path-list', name: 'list_files', input: { path: '.' } },
    { id: 'audit-path-read', name: 'read_file', input: { path: 'read.txt' } },
    { id: 'audit-path-search', name: 'search_files', input: { query: 'readable' } },
    { id: 'audit-path-write', name: 'write_file', input: { path: 'approved.txt', content: 'approved' } },
    { id: 'audit-path-open', name: 'start_process', input: { command: 'node -e "process.exit(0)"' } },
    { id: 'audit-path-permission-deny', name: 'write_file', input: { path: 'denied-by-permission.txt', content: 'never' }, cfg: { ...terminalCfg, permissions: [{ permission: 'write_file', pattern: '*', action: 'deny' }] } }
  ]
  for (const call of terminalCalls) {
    const callEvents: AgentEvent[] = []
    const io: AgentIO = {
      print: () => {},
      askYesNo: async () => true,
      event: (event) => callEvents.push(event)
    }
    const def = TOOL_DEFS.find((tool) => tool.name === call.name)!
    await executeV2ToolCall({ toolCallId: call.id, toolName: call.name, input: call.input }, def, call.cfg ?? terminalCfg, eventCtx, io, [])
    const terminal = callEvents.find((entry) => entry.origin === 'host' && (entry.type === 'tool.succeeded' || entry.type === 'tool.failed' || entry.type === 'tool.denied'))
    assert.ok(terminal, `terminal event missing for ${call.name}`)
    const audit = auditRecordFromOutcome({ sessionId: 'session-terminal', runId: 'run-terminal', event: terminal!, history: callEvents })
    assert.ok(audit, `audit record missing for ${call.name}`)
    terminalLog.append(audit!, `terminal:${call.id}`)
    terminalLog.append(audit!, `terminal:${call.id}`)
  }
  const terminalRecords = terminalLog.records(20)
  assert.strictEqual(terminalRecords.length, terminalCalls.length, 'each standard host path must append exactly one record')
  assert.deepStrictEqual(new Set(terminalRecords.map((entry) => entry.call_id)).size, terminalCalls.length)
  assert.ok(terminalRecords.some((entry) => entry.tool_name === 'host.write_file' && entry.approval.actor === 'user' && entry.approval.outcome === 'approved'))
  assert.ok(terminalRecords.some((entry) => entry.tool_name === 'host.write_file' && entry.permission.decision === 'deny' && entry.result.outcome === 'refused'))
  console.log('PASS audit-log')
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
  const clientReasonPending = requestApproval('client reason is not provenance')
  const clientReasonApproval = listApprovals()[0]
  assert.strictEqual(resolveApproval(clientReasonApproval.id, false, '承認期限切れ'), true)
  assert.strictEqual(await clientReasonPending, false)
  const clientReasonResolution = getApprovalResolution(clientReasonApproval.id)
  assert.deepStrictEqual(clientReasonResolution?.provenance, { actor: 'user', automatic: false })
  assert.strictEqual(clientReasonResolution?.reason, '利用者が拒否しました')
  const policyPending = requestApproval('policy provenance')
  const policyApproval = listApprovals()[0]
  assert.strictEqual(resolveApproval(policyApproval.id, false, '任意の内部理由', { actor: 'policy', automatic: true }), true)
  assert.strictEqual(await policyPending, false)
  assert.deepStrictEqual(getApprovalResolution(policyApproval.id)?.provenance, { actor: 'policy', automatic: true })
  const timeoutPending = requestApproval({ question: 'timeout provenance', expiresAt: Date.now() })
  const timeoutApproval = listApprovals()[0]
  assert.strictEqual(await timeoutPending, false)
  assert.deepStrictEqual(getApprovalResolution(timeoutApproval.id)?.provenance, { actor: 'policy', automatic: true })
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
  const directOnly = await get('list_files').run({ path: '.', recursive: false }, ctx)
  assert.ok(directOnly.includes('batch/') && directOnly.includes('other/') && !directOnly.includes('batch/utf8.txt'), 'recursive=false must return only immediate entries')
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

  const bundledWorkbook = path.resolve(__dirname, '..', '..', '..', 'demo', 'renketsu-demo', 'workspace', '集計台帳.xlsx')
  fs.copyFileSync(bundledWorkbook, path.join(root, 'batch', 'real.xlsx'))
  const workbookRead = await get('read_xlsx').run({ path: 'batch/real.xlsx' }, ctx)
  assert.ok(workbookRead.includes('"ok":true') && workbookRead.includes('sheets'), 'read_xlsx must read an arbitrary workspace workbook through the bundled helper')
  assert.ok(workbookRead.includes('連結台帳') && workbookRead.includes('確認事項'), 'read_xlsx must preserve Japanese sheet names across Windows PowerShell stdout')
  await assert.rejects(() => get('read_xlsx').run({ path: 'batch/utf8.txt' }, ctx), /\.xlsx/u)

  const cmd = await get('run_command').run({ command: 'echo smoke-ok' }, ctx)
  assert.ok(cmd.includes('smoke-ok'))

  assert.strictEqual(
    normalizeRunCommand('powershell -File tools/Read-Xlsx.ps1 reports/OS04.xlsx reports/OS05.xlsx'),
    'powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\\Read-Xlsx.ps1 -Path reports\\*.xlsx'
  )
  assert.strictEqual(
    normalizeRunCommand('powershell.exe -File tools\\Read-Xlsx.ps1 "reports\\one file.xlsx"'),
    'powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\\Read-Xlsx.ps1 -Path "reports\\one file.xlsx"'
  )
  assert.strictEqual(
    normalizeRunCommand('tools/Read-Xlsx.ps1 reports/OS04.xlsx'),
    'powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\\Read-Xlsx.ps1 -Path reports\\OS04.xlsx'
  )
  assert.strictEqual(
    normalizeRunCommand('powershell -NoProfile -File tools/Read-Xlsx.ps1 reports/OS04.xlsx,reports/OS05.xlsx,集計台帳.xlsx'),
    'powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\\Read-Xlsx.ps1 -Path reports\\*.xlsx'
  )
  assert.strictEqual(
    normalizeRunCommand('powershell -File tools/Update-Ledger.ps1 work/extracted.json rates/レート表.csv 集計台帳.xlsx'),
    'powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\\Update-Ledger.ps1 -Extracted work\\extracted.json -Rates rates\\レート表.csv -Ledger 集計台帳.xlsx'
  )
  assert.strictEqual(
    normalizeRunCommand('tools\\Update-Ledger.ps1 work\\extracted.json rates\\レート表.csv 集計台帳.xlsx'),
    'powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\\Update-Ledger.ps1 -Extracted work\\extracted.json -Rates rates\\レート表.csv -Ledger 集計台帳.xlsx'
  )
  assert.strictEqual(
    normalizeRunCommand('powershell.exe -File tools\\Update-Ledger.ps1 -Ledger 集計台帳.xlsx -Extracted work\\extracted.json -Rates rates\\レート表.csv'),
    'powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\\Update-Ledger.ps1 -Extracted work\\extracted.json -Rates rates\\レート表.csv -Ledger 集計台帳.xlsx'
  )
  assert.strictEqual(
    normalizeRunCommand('powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\\Read-Xlsx.ps1 reports\\OS04.xlsx'),
    'powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\\Read-Xlsx.ps1 -Path reports\\OS04.xlsx'
  )
  assert.strictEqual(
    normalizeRunCommand('powershell.exe "-ExecutionPolicy" Bypass -File tools\\Read-Xlsx.ps1 reports\\OS04.xlsx'),
    'powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\\Read-Xlsx.ps1 -Path reports\\OS04.xlsx'
  )
  assert.strictEqual(
    normalizeRunCommand('powershell.exe -ExecutionPolicy:Bypass -File tools\\Read-Xlsx.ps1 reports\\OS04.xlsx'),
    'powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\\Read-Xlsx.ps1 -Path reports\\OS04.xlsx'
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
  fs.writeFileSync(path.join(root, 'open-me.txt'), 'open safely')
  fs.writeFileSync(path.join(root, 'ledger-open.xlsx'), 'not a real workbook')
  fs.writeFileSync(path.join(root, 'blocked.cmd'), '@echo should-not-run')
  fs.writeFileSync(path.join(root, 'blocked.ps1'), 'throw "should-not-run"')
  fs.writeFileSync(path.join(root, 'blocked.exe'), 'not-an-executable')
  fs.writeFileSync(path.join(root, 'blocked.lnk'), 'not-a-shortcut')
  fs.writeFileSync(path.join(root, 'blocked.url'), '[InternetShortcut]\nURL=https://example.com')
  for (const openCommand of ['open-me.txt', 'Invoke-Item open-me.txt', 'Start-Process -FilePath open-me.txt', 'start " open-me.txt"', 'open open-me.txt', 'excel.exe ledger-open.xlsx']) {
    const normalizedOpen = normalizeWorkspaceOpenCommand(openCommand, ctx)
    assert.ok(normalizedOpen?.includes('Invoke-Item -LiteralPath'), `safe workspace open must normalize: ${openCommand}`)
  }
  for (const blockedOpen of ['blocked.cmd', 'blocked.ps1', 'blocked.exe', 'blocked.lnk', 'blocked.url']) {
    assert.throws(() => normalizeWorkspaceOpenCommand(`Invoke-Item ${blockedOpen}`, ctx), /安全に開ける/u, `executable/link open must be rejected: ${blockedOpen}`)
  }
  fs.mkdirSync(path.join(root, 'blocked-directory'))
  assert.throws(() => normalizeWorkspaceOpenCommand('Invoke-Item blocked-directory', ctx), /通常ファイル以外/u)
  const linked = path.join(root, 'linked.txt')
  try {
    fs.symlinkSync(path.join(root, 'open-me.txt'), linked, 'file')
    assert.throws(() => normalizeWorkspaceOpenCommand('Invoke-Item linked.txt', ctx), /通常ファイル以外/u, 'reparse/symlink open must be rejected')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EPERM') throw err
  }
  assert.strictEqual(
    formatHostCommandOutput('open open-me.txt', 'powershell.exe -NoProfile -Command "Invoke-Item -LiteralPath \'open-me.txt\'"', '', ''),
    'アプリ起動コマンド成功: open open-me.txt'
  )
  assert.throws(() => prepareHostCommand('Invoke-Item ..\\outside.txt', ctx), /run_command拒否/u)
  assert.throws(() => prepareHostCommand('Start-Process open-me.txt; whoami', ctx), /run_command拒否/u)
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
  for (const blockedStart of [
    'powershell.exe -Command "Remove-Item safe-read.txt"',
    'curl.exe https://example.com',
    'reg.exe add HKCU\\Software\\CodingAgentSmoke /v Test /d 1',
    'powershell.exe -EncodedCommand RwBlAHQALQBEAGEAdABlAA==',
    'cmd.exe /c "echo x > ..\\escape.txt"'
  ]) await assert.rejects(() => get('start_process').run({ command: blockedStart }, ctx), /run_command拒否/u, `start_process must share denial policy: ${blockedStart}`)
  await assert.rejects(
    () => get('start_process').run({ command: 'Invoke-Item open-me.txt', url: 'https://example.com/' }, { ...ctx, safeCommandOnly: true }),
    /プレビューURL/u,
    'safe mode must reject preview URLs before a process is started'
  )
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
    const deadline = Date.now() + 5000
    let processLog = { lines: [] as string[], nextOffset: 0 }
    while (Date.now() < deadline && !processLog.lines.join('\n').includes('process-smoke')) {
      await new Promise((resolve) => setTimeout(resolve, 200))
      processLog = JSON.parse(await get('read_process_log').run({ process_id: started.id }, ctx)) as { lines: string[]; nextOffset: number }
    }
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

function mockServer(steps: ScriptStep[]): Promise<{ server: http.Server; url: string; requestBodies: string[] }> {
  const state = { requests: 0, requestBodies: [] as string[] }
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => {
      body += c
    })
    req.on('end', () => {
      JSON.parse(body)
      state.requestBodies.push(body)
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
      res.end(JSON.stringify({
        id: `chatcmpl_${state.requests}`,
        object: 'chat.completion',
        created: 0,
        model: 'mock',
        choices: [{ index: 0, message, finish_reason: step.tool_call ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
      }))
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as net.AddressInfo
      resolve({ server, url: `http://127.0.0.1:${addr.port}/v1`, requestBodies: state.requestBodies })
    })
  })
}

async function withServer(
  steps: ScriptStep[],
  fn: (cfg: AgentConfig, requestBodies: string[]) => Promise<void>
): Promise<void> {
  const { server, url, requestBodies } = await mockServer(steps)
  try {
    await fn({ baseURL: url, apiKey: 'mock-key', model: 'mock' }, requestBodies)
  } finally {
    server.close()
  }
}

async function withCopilotBridge(
  responses: string[],
  fn: (cfg: AgentConfig, prompts: string[]) => Promise<void>
): Promise<void> {
  const prompts: string[] = []
  let index = 0
  const token = 'v2-smoke-bridge-token'
  const server = createOpenAICompatibleBridgeServer(token, {
    complete: async (prompt) => {
      prompts.push(prompt)
      return responses[index++] ?? responses.at(-1) ?? ''
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as net.AddressInfo).port
  try {
    await fn({ baseURL: `http://127.0.0.1:${port}/v1`, apiKey: token, model: 'copilot-edge' }, prompts)
  } finally {
    server.abortAll()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

async function listenOllamaMock(
  responder: (requestBody: Record<string, unknown>, requestNumber: number) => { status?: number; contentType?: string; body: Uint8Array | string }
): Promise<{ server: http.Server; url: string; requests: Array<{ body: Record<string, unknown>; authorization: string | null; contentType: string | null }> }> {
  const requests: Array<{ body: Record<string, unknown>; authorization: string | null; contentType: string | null }> = []
  let requestNumber = 0
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      const body = JSON.parse(raw) as Record<string, unknown>
      requests.push({ body, authorization: req.headers.authorization ?? null, contentType: req.headers['content-type'] ?? null })
      const response = responder(body, ++requestNumber)
      res.statusCode = response.status ?? 200
      res.setHeader('content-type', response.contentType ?? 'application/json')
      res.end(typeof response.body === 'string' ? response.body : Buffer.from(response.body))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as net.AddressInfo).port
  return { server, url: `http://127.0.0.1:${port}/v1`, requests }
}

async function testOllamaProvider(): Promise<void> {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-smoke-ollama-config-'))
  const writeConfig = (name: string, value: Record<string, unknown>): string => {
    const file = path.join(configDir, name)
    fs.writeFileSync(file, JSON.stringify(value), 'utf8')
    return file
  }
  try {
    const loaded = loadConfig(writeConfig('valid.json', {
      provider: 'ollama', baseURL: 'http://127.0.0.1:11434/v1', model: 'ornith-1.5:9b'
    }))
    assert.strictEqual(loaded.provider, 'ollama')
    assert.strictEqual(loaded.agentLoop, 'v1')
    assert.throws(() => loadConfig(writeConfig('unsupported.json', { provider: 'unsupported', baseURL: 'http://127.0.0.1:1/v1', model: 'x' })), /サポートされていない provider/u)
    assert.throws(() => loadConfig(writeConfig('missing.json', { provider: 'ollama', baseURL: 'http://127.0.0.1:11434/v1' })), /baseURL \/ model/u)
    assert.throws(() => loadConfig(writeConfig('remote.json', { provider: 'ollama', baseURL: 'https://example.com/v1', model: 'x' })), /loopback/u)
    assert.throws(() => loadConfig(writeConfig('bad-reasoning.json', { provider: 'ollama', baseURL: 'http://127.0.0.1:11434/v1', model: 'x', reasoningEffort: 'max' })), /reasoningEffort/u)
  } finally {
    fs.rmSync(configDir, { recursive: true, force: true })
  }

  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-smoke-ollama-workspace-'))
  const previousKey = process.env.COMPANY_LLM_API_KEY
  process.env.COMPANY_LLM_API_KEY = 'must-not-be-sent-to-ollama'
  const ollamaEvents: AgentEvent[] = []
  const mock = await listenOllamaMock((_body, requestNumber) => {
    if (requestNumber === 1) {
      return {
        contentType: 'application/json; charset=utf-8',
        body: Buffer.from(JSON.stringify({
          id: 'ollama-smoke-1', object: 'chat.completion', created: 0, model: 'mock',
          choices: [{ index: 0, message: { role: 'assistant', content: '', tool_calls: [{ id: 'ollama-call-1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'メモ.txt', content: '確認' }) } }] }, finish_reason: 'tool_calls' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
        }), 'utf8')
      }
    }
    return {
      body: Buffer.from(JSON.stringify({
        id: 'ollama-smoke-2', object: 'chat.completion', created: 0, model: 'mock',
        choices: [{ index: 0, message: { role: 'assistant', content: 'Ollama UTF-8 完了' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
      }), 'utf8')
    }
  })
  try {
    const result = await runAgentTurnV2({
      cfg: {
        provider: 'ollama', agentLoop: 'v2', baseURL: mock.url, model: 'mock', reasoningEffort: 'high',
        autoApprove: { write: true }, maxToolIterations: 3
      },
      messages: [], userInput: '日本語ファイルを書いて', ctx: makeCtx(workspace), io: { ...ioStub(true), event: (event) => ollamaEvents.push(event) }
    })
    assert.strictEqual(result.aborted, false)
    assert.strictEqual(result.reply, 'Ollama UTF-8 完了')
    assert.strictEqual(fs.readFileSync(path.join(workspace, 'メモ.txt'), 'utf8'), '確認')
    assert.ok(mock.requests[0].contentType?.toLowerCase().includes('application/json') && mock.requests[0].contentType?.toLowerCase().includes('charset=utf-8'))
    assert.strictEqual(mock.requests[0].authorization, null, 'Ollama must not receive Authorization')
    assert.strictEqual(mock.requests[0].body.reasoning_effort, 'high')
    const secondBody = JSON.stringify(mock.requests[1]?.body ?? {})
    assert.ok(secondBody.includes('メモ.txt') && secondBody.includes('確認'), 'Japanese tool args must survive the UTF-8 boundary')
    const modelEvents = ollamaEvents.filter((event) => event.type === 'model.decision')
    assert.ok(modelEvents.length > 0, 'Ollama turn must emit a model decision event')
    assert.ok(modelEvents.every((event) => event.origin === 'ollama'), 'Ollama model decisions must retain Ollama provenance')
    assert.ok(!modelEvents.some((event) => event.origin === 'copilot'), 'Ollama model decisions must not claim Copilot provenance')
  } finally {
    await new Promise<void>((resolve) => mock.server.close(() => resolve()))
    fs.rmSync(workspace, { recursive: true, force: true })
    if (previousKey === undefined) delete process.env.COMPANY_LLM_API_KEY
    else process.env.COMPANY_LLM_API_KEY = previousKey
  }

  const invalid = await listenOllamaMock(() => ({ contentType: 'application/json', body: new Uint8Array([0x7b, 0x22, 0x74, 0x22, 0x3a, 0xc3, 0x28, 0x7d]) }))
  try {
    const printed: string[] = []
    const result = await runAgentTurnV2({
      cfg: { provider: 'ollama', agentLoop: 'v2', baseURL: invalid.url, model: 'mock', turnMode: 'chat' },
      messages: [], userInput: '壊れた応答', ctx: makeCtx(os.tmpdir(), false), io: { print: (text) => printed.push(text), askYesNo: async () => true }
    })
    assert.strictEqual(result.aborted, true, 'invalid UTF-8 response must fail closed')
    assert.ok(printed.some((line) => line.startsWith('[error]')))
    assert.ok(!printed.some((line) => line.includes('\uFFFD')))
  } finally {
    await new Promise<void>((resolve) => invalid.server.close(() => resolve()))
  }

  const multiWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-smoke-ollama-multi-'))
  const multi = await listenOllamaMock(() => ({
    body: JSON.stringify({
      id: 'ollama-smoke-multi', object: 'chat.completion', created: 0, model: 'mock',
      choices: [{ index: 0, message: { role: 'assistant', content: '', tool_calls: [
        { id: 'multi-1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'a.txt', content: 'a' }) } },
        // Keep one call semantically malformed so this guards the fail-close
        // boundary for mixed valid + malformed simultaneous tool_calls.
        { id: 'multi-2', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 3, content: 'b' }) } }
      ] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
    })
  }))
  try {
    const multiEvents: AgentEvent[] = []
    let approvals = 0
    let toolDefRuns = 0
    const writeDef = TOOL_DEFS.find((toolDef) => toolDef.name === 'write_file')!
    const originalRun = writeDef.run
    writeDef.run = async (args, ctx) => {
      toolDefRuns++
      return originalRun(args, ctx)
    }
    let result
    try {
      result = await runAgentTurnV2({
        cfg: { provider: 'ollama', agentLoop: 'v2', baseURL: multi.url, model: 'mock', autoApprove: { write: true } },
        messages: [], userInput: '複数', ctx: makeCtx(multiWorkspace),
        io: { ...ioStub(true), askYesNo: async () => { approvals++; return true }, event: (event) => multiEvents.push(event) }
      })
    } finally {
      writeDef.run = originalRun
    }
    assert.strictEqual(result.aborted, true)
    assert.strictEqual(toolDefRuns, 0, 'mixed simultaneous tool calls must execute zero ToolDef.run calls')
    assert.strictEqual(approvals, 0, 'mixed simultaneous tool calls must request zero approvals')
    assert.ok(!fs.existsSync(path.join(multiWorkspace, 'a.txt')) && !fs.existsSync(path.join(multiWorkspace, 'b.txt')), 'multiple tool calls must execute zero tools')
    assert.strictEqual(multiEvents.filter((event) => event.type === 'approval.requested' || event.type === 'approval.resolved').length, 0, 'mixed simultaneous tool calls must emit zero approval events')
    const terminalEvents = multiEvents.filter((event) => ['tool.succeeded', 'tool.failed', 'tool.denied'].includes(event.type))
    assert.strictEqual(terminalEvents.length, 0, 'mixed simultaneous tool calls must emit no terminal tool/audit event')
    assert.ok(multiEvents.some((event) => event.type === 'run.warning'), 'mixed simultaneous tool calls must fail closed with a warning')
  } finally {
    await new Promise<void>((resolve) => multi.server.close(() => resolve()))
    fs.rmSync(multiWorkspace, { recursive: true, force: true })
  }
  console.log('PASS ollama-provider')
}

async function testModelWaitAndExternalProvider(): Promise<void> {
  // Every v1 backend wait is paired with a safe model.wait event. The event
  // intentionally has no output/error/metadata fields that could leak model
  // text or raw provider details.
  const v1Events: AgentEvent[] = []
  await runAgentTurn({
    cfg: { baseURL: '', model: '', provider: 'copilot-edge', copilot: { agentMode: false }, turnMode: 'chat' },
    messages: [], userInput: 'こんにちは', ctx: makeCtx(os.tmpdir(), false), io: { ...ioStub(true), event: (event) => v1Events.push(event) },
    backend: new FakeBackend(['{"answer":"応答"}\nAGENT_END'])
  })
  const waitIndex = v1Events.findIndex((event) => event.type === 'model.wait')
  const decisionIndex = v1Events.findIndex((event) => event.type === 'model.decision')
  assert.ok(waitIndex >= 0 && waitIndex < decisionIndex, 'v1 model.wait must precede model.decision')
  const waitEvent = v1Events[waitIndex]
  assert.deepStrictEqual(Object.keys(waitEvent).sort(), ['authority', 'namespace', 'origin', 'summary', 'type'].sort())
  assert.strictEqual(waitEvent.summary, 'AIが次の作業を考えています')

  const fixture = path.resolve(process.cwd(), '..', '..', 'demo', 'external-provider-synthetic', 'workspace')
  assertSyntheticWorkspaceBoundary({ provider: 'external-openai', agentLoop: 'v2', baseURL: 'https://api.example.test/v1', model: 'synthetic-model', apiKeyEnv: 'EXTERNAL_SMOKE_KEY', externalProvider: { enabled: true, syntheticWorkspace: fixture } }, fixture)

  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-smoke-external-config-'))
  const configPath = path.join(configDir, 'external.json')
  const writeConfig = (name: string, value: Record<string, unknown>): string => {
    const file = path.join(configDir, name)
    fs.writeFileSync(file, JSON.stringify(value), 'utf8')
    return file
  }
  const baseConfig: AgentConfig = {
    agentLoop: 'v2', provider: 'external-openai', baseURL: 'https://api.example.test/v1', model: 'synthetic-model', apiKeyEnv: 'EXTERNAL_SMOKE_KEY',
    externalProvider: { enabled: true, syntheticWorkspace: fixture }
  }
  try {
    const loaded = loadConfig(writeConfig('valid.json', baseConfig as unknown as Record<string, unknown>))
    assert.strictEqual(loaded.provider, 'external-openai')
    assert.strictEqual(loaded.agentLoop, 'v2')
    assert.strictEqual(loaded.configPath, path.resolve(configDir, 'valid.json'))
    assert.strictEqual(loaded.restrictToWorkspace, true, 'external provider config must force workspace restriction')
    assert.strictEqual(loaded.safeCommandOnly, true, 'external provider config must force safe command mode')
    assert.strictEqual(resolveSyntheticWorkspace(loaded), fixture)
    assert.throws(() => loadConfig(writeConfig('plaintext.json', { ...baseConfig, apiKey: 'never-store' })), /plaintext apiKey/u)
    assert.throws(() => loadConfig(writeConfig('disabled.json', { ...baseConfig, externalProvider: { ...baseConfig.externalProvider, enabled: false } })), /enabled=true/u)
    assert.throws(() => loadConfig(writeConfig('workspace-unrestricted.json', { ...baseConfig, restrictToWorkspace: false })), /restrictToWorkspace=false/u)
    assert.throws(() => loadConfig(writeConfig('commands-unrestricted.json', { ...baseConfig, safeCommandOnly: false })), /safeCommandOnly=false/u)
    assert.throws(() => loadConfig(writeConfig('no-env.json', { ...baseConfig, apiKeyEnv: '' })), /apiKeyEnv/u)
    assert.throws(() => loadConfig(writeConfig('bad-scheme.json', { ...baseConfig, baseURL: 'ftp://example.test/v1' })), /HTTPS/u)
    assert.throws(() => loadConfig(writeConfig('credentials.json', { ...baseConfig, baseURL: 'https://user:pass@example.test/v1' })), /credentials/u)
    assert.throws(() => loadConfig(writeConfig('v1.json', { ...baseConfig, agentLoop: 'v1' })), /agentLoop=v2/u)
  } finally {
    fs.rmSync(configDir, { recursive: true, force: true })
  }

  const previousKey = process.env.EXTERNAL_SMOKE_KEY
  process.env.EXTERNAL_SMOKE_KEY = 'external-smoke-secret'
  const mock = await listenOllamaMock((_body, requestNumber) => {
    const message = requestNumber === 1
      ? { role: 'assistant', content: '', tool_calls: [{ id: 'external-call-1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'reports/result.txt', content: 'synthetic-ok' }) } }] }
      : { role: 'assistant', content: '合成データの作業が完了しました' }
    return { body: JSON.stringify({ id: `external-${requestNumber}`, object: 'chat.completion', created: 0, model: 'synthetic-model', choices: [{ index: 0, message, finish_reason: requestNumber === 1 ? 'tool_calls' : 'stop' }] }) }
  })
  try {
    const events: AgentEvent[] = []
    const result = await runAgentTurnV2({
      cfg: { ...baseConfig, baseURL: mock.url, autoApprove: { write: false }, configPath: path.join(process.cwd(), 'config.external.example.json') },
      messages: [], userInput: '架空の報告を保存して', ctx: makeCtx(fixture), io: { ...ioStub(true), event: (event) => events.push(event) }
    })
    assert.strictEqual(result.aborted, false)
    assert.strictEqual(result.reply, '合成データの作業が完了しました')
    assert.strictEqual(fs.readFileSync(path.join(fixture, 'reports', 'result.txt'), 'utf8'), 'synthetic-ok')
    assert.strictEqual(mock.requests[0].authorization, 'Bearer external-smoke-secret', 'external key must be sent only as Authorization')
    const wire = JSON.stringify(mock.requests.map((request) => request.body))
    assert.ok(!wire.includes('external-smoke-secret'), 'external secret must not be in request body')
    assert.ok(!JSON.stringify(events).includes('external-smoke-secret'), 'external secret must not be in events')
    const modelEvents = events.filter((event) => event.type === 'model.decision' || event.type === 'model.wait')
    assert.ok(modelEvents.some((event) => event.type === 'model.wait') && modelEvents.some((event) => event.type === 'model.decision'))
    assert.ok(modelEvents.every((event) => event.origin === 'external'), 'external provenance must remain distinct')
    const firstDecision = events.findIndex((event) => event.type === 'model.decision')
    assert.ok(events.findIndex((event) => event.type === 'model.wait') < firstDecision)
  } finally {
    await new Promise<void>((resolve) => mock.server.close(() => resolve()))
    try { fs.rmSync(path.join(fixture, 'reports', 'result.txt'), { force: true }) } catch {}
    if (previousKey === undefined) delete process.env.EXTERNAL_SMOKE_KEY
    else process.env.EXTERNAL_SMOKE_KEY = previousKey
  }

  // Re-check the boundary immediately before every external request. If the
  // marker is replaced after the first response, the tool may finish locally,
  // but the next generateText call must be blocked without a second request.
  const revalidationRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-smoke-external-revalidation-'))
  fs.mkdirSync(path.join(revalidationRoot, 'reports'), { recursive: true })
  const replacementMarker = path.join(revalidationRoot, SYNTHETIC_WORKSPACE_MARKER)
  fs.writeFileSync(replacementMarker, JSON.stringify(SYNTHETIC_WORKSPACE_MARKER_EXPECTED), 'utf8')
  const revalidationPreviousKey = process.env.EXTERNAL_SMOKE_KEY
  process.env.EXTERNAL_SMOKE_KEY = 'external-revalidation-secret'
  const revalidationMock = await listenOllamaMock((_body, requestNumber) => {
    if (requestNumber === 1) {
      fs.writeFileSync(replacementMarker, JSON.stringify({ ...SYNTHETIC_WORKSPACE_MARKER_EXPECTED, purpose: 'replaced-after-first-request' }), 'utf8')
    }
    const message = requestNumber === 1
      ? { role: 'assistant', content: '', tool_calls: [{ id: 'external-revalidate-call-1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'reports/revalidate.txt', content: 'first-request-only' }) } }] }
      : { role: 'assistant', content: 'must not be requested' }
    return { body: JSON.stringify({ id: `external-revalidate-${requestNumber}`, object: 'chat.completion', created: 0, model: 'synthetic-model', choices: [{ index: 0, message, finish_reason: requestNumber === 1 ? 'tool_calls' : 'stop' }] }) }
  })
  try {
    const result = await runAgentTurnV2({
      cfg: { ...baseConfig, baseURL: revalidationMock.url, autoApprove: { write: true }, externalProvider: { enabled: true, syntheticWorkspace: revalidationRoot } },
      messages: [], userInput: '境界を再確認して', ctx: makeCtx(revalidationRoot), io: ioStub(true)
    })
    assert.strictEqual(result.aborted, true, 'marker replacement must abort the external v2 loop')
    assert.strictEqual(revalidationMock.requests.length, 1, 'marker replacement after first request must not send a second request')
  } finally {
    await new Promise<void>((resolve) => revalidationMock.server.close(() => resolve()))
    fs.rmSync(revalidationRoot, { recursive: true, force: true })
    if (revalidationPreviousKey === undefined) delete process.env.EXTERNAL_SMOKE_KEY
    else process.env.EXTERNAL_SMOKE_KEY = revalidationPreviousKey
  }

  // Boundary failures happen before generateText/network. Exercise mismatch,
  // missing marker, malformed marker, and symlink marker with a zero-request
  // loopback server.
  const boundaryMock = await listenOllamaMock(() => ({ body: JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'must not run' } }] }) }))
  const boundaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-smoke-external-boundary-'))
  const boundaryCfg = (root: string): AgentConfig => ({ ...baseConfig, baseURL: boundaryMock.url, configPath: path.join(boundaryRoot, 'external.json'), externalProvider: { enabled: true, syntheticWorkspace: root } })
  try {
    await assert.rejects(() => runAgentTurnV2({ cfg: { ...boundaryCfg(fixture), restrictToWorkspace: false }, messages: [], userInput: 'no', ctx: makeCtx(fixture), io: ioStub(true) }), /ワークスペース制限/u)
    await assert.rejects(() => runAgentTurnV2({ cfg: { ...boundaryCfg(fixture), safeCommandOnly: false }, messages: [], userInput: 'no', ctx: makeCtx(fixture), io: ioStub(true) }), /安全なコマンド制限/u)
    await assert.rejects(() => runAgentTurnV2({ cfg: boundaryCfg(fixture), messages: [], userInput: 'no', ctx: { ...makeCtx(fixture), restrictToWorkspace: false }, io: ioStub(true) }), /ToolContext.*ワークスペース制限/u)
    await assert.rejects(() => runAgentTurnV2({ cfg: boundaryCfg(fixture), messages: [], userInput: 'no', ctx: { ...makeCtx(fixture), safeCommandOnly: false }, io: ioStub(true) }), /ToolContext.*安全なコマンド制限/u)
    await assert.rejects(() => runAgentTurnV2({ cfg: boundaryCfg(fixture), messages: [], userInput: 'no', ctx: makeCtx(boundaryRoot), io: ioStub(true) }), /合成ワークスペース/u)
    const missing = path.join(boundaryRoot, 'missing')
    fs.mkdirSync(missing, { recursive: true })
    await assert.rejects(() => runAgentTurnV2({ cfg: boundaryCfg(missing), messages: [], userInput: 'no', ctx: makeCtx(missing), io: ioStub(true) }), /マーカー/u)
    fs.writeFileSync(path.join(missing, SYNTHETIC_WORKSPACE_MARKER), JSON.stringify({ ...SYNTHETIC_WORKSPACE_MARKER_EXPECTED, purpose: 'wrong' }), 'utf8')
    await assert.rejects(() => runAgentTurnV2({ cfg: boundaryCfg(missing), messages: [], userInput: 'no', ctx: makeCtx(missing), io: ioStub(true) }), /マーカー/u)
    try {
      fs.symlinkSync(path.join(fixture, SYNTHETIC_WORKSPACE_MARKER), path.join(missing, 'symlink-marker'), 'file')
      fs.rmSync(path.join(missing, SYNTHETIC_WORKSPACE_MARKER), { force: true })
      fs.renameSync(path.join(missing, 'symlink-marker'), path.join(missing, SYNTHETIC_WORKSPACE_MARKER))
      await assert.rejects(() => runAgentTurnV2({ cfg: boundaryCfg(missing), messages: [], userInput: 'no', ctx: makeCtx(missing), io: ioStub(true) }), /マーカー/u)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EPERM' && code !== 'EACCES') throw error
    }
    assert.strictEqual(boundaryMock.requests.length, 0, 'boundary failures must send zero external requests')
  } finally {
    await new Promise<void>((resolve) => boundaryMock.server.close(() => resolve()))
    fs.rmSync(boundaryRoot, { recursive: true, force: true })
  }

  const ui = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'main.ts'), 'utf8')
  const classic = fs.readFileSync(path.join(process.cwd(), 'public', 'classic.html'), 'utf8')
  for (const source of [ui, classic]) {
    for (const required of ['model.wait', 'AIが次の作業を考えています', 'pending', 'in-progress', 'completed', '外部AI: 有効（合成データのみ）']) assert.ok(source.includes(required), `safe progress UI contract missing: ${required}`)
    assert.ok(!/event\.output[^\n]*textContent/u.test(source), 'AI-work UI must not render event.output')
    assert.ok(!/event\.metadata[^\n]*textContent/u.test(source), 'AI-work UI must not render event.metadata')
  }
  console.log('PASS model-wait-and-external-provider')
}

async function testExternalStateIsolation(): Promise<void> {
  const fixture = path.resolve(process.cwd(), '..', '..', 'demo', 'external-provider-synthetic', 'workspace')
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-smoke-external-state-'))
  const appData = path.join(tempRoot, 'appdata')
  const localAppData = path.join(tempRoot, 'localappdata')
  const configPath = path.join(tempRoot, 'external.json')
  const sharedStatePath = path.join(appData, 'CompanyApps', 'coding-agent', 'state.json')
  const externalStatePath = path.join(appData, 'CompanyApps', 'coding-agent', 'external-synthetic-state.json')
  const legacySecret = 'legacy-copilot-ollama-session-must-not-cross-provider'
  const legacyState = {
    activeId: 'legacy-session',
    activeRunId: null,
    recoveredRunId: null,
    sessions: [{
      id: 'legacy-session',
      title: '旧プロバイダーのセッション',
      messages: [
        { role: 'system', content: 'legacy system' },
        { role: 'user', content: legacySecret },
        { role: 'assistant', content: 'legacy response' }
      ],
      created: 1,
      runs: []
    }],
    runs: []
  }
  fs.mkdirSync(path.dirname(sharedStatePath), { recursive: true })
  fs.writeFileSync(sharedStatePath, JSON.stringify(legacyState), 'utf8')
  fs.writeFileSync(configPath, JSON.stringify({
    agentLoop: 'v2',
    provider: 'external-openai',
    baseURL: 'http://127.0.0.1:1/v1',
    model: 'external-test-model',
    apiKeyEnv: 'EXTERNAL_SMOKE_KEY',
    externalProvider: { enabled: true, syntheticWorkspace: fixture },
    restrictToWorkspace: true,
    safeCommandOnly: true
  }), 'utf8')

  const probe = http.createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const port = (probe.address() as net.AddressInfo).port
  await new Promise<void>((resolve) => probe.close(() => resolve()))

  let child: ReturnType<typeof spawn> | undefined
  const childOutput: string[] = []
  const stopChild = async (): Promise<void> => {
    const processChild = child
    if (!processChild || processChild.exitCode !== null) return
    await new Promise<void>((resolve) => {
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
      }, 5000)
      processChild.once('close', finish)
      try { processChild.kill('SIGTERM') } catch { finish() }
    })
  }
  const baseURL = `http://127.0.0.1:${port}`
  const requestJson = async (pathname: string, init?: RequestInit): Promise<Record<string, unknown>> => {
    const response = await fetch(`${baseURL}${pathname}`, init)
    const text = await response.text()
    if (!response.ok) throw new Error(`state isolation request failed (${response.status}): ${text}`)
    return JSON.parse(text) as Record<string, unknown>
  }
  try {
    child = spawn(process.execPath, [path.join(process.cwd(), 'dist', 'server.js'), '--config', configPath, '--workspace', fixture], {
      cwd: process.cwd(),
      env: { ...process.env, PORT: String(port), APPDATA: appData, LOCALAPPDATA: localAppData, EXTERNAL_SMOKE_KEY: 'state-isolation-key', CODING_AGENT_NO_BROWSER: '1', NO_COLOR: '1' },
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    child.stdout?.on('data', (chunk) => { childOutput.push(String(chunk)) })
    child.stderr?.on('data', (chunk) => { childOutput.push(String(chunk)) })

    let sessions: Record<string, unknown> | undefined
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null) throw new Error(`external state isolation server exited (${child.exitCode}): ${childOutput.join('').slice(-2000)}`)
      try {
        sessions = await requestJson('/api/sessions')
        break
      } catch {
        await new Promise<void>((resolve) => setTimeout(resolve, 100))
      }
    }
    assert.ok(sessions, `external state isolation server did not become ready: ${childOutput.join('').slice(-2000)}`)
    assert.ok(!JSON.stringify(sessions).includes(legacySecret), 'external startup must not expose shared provider state')
    const activeId = typeof sessions.active === 'string' ? sessions.active : ''
    assert.ok(activeId, 'external startup must create a fresh session when dedicated state is absent')
    const session = await requestJson(`/api/session?id=${encodeURIComponent(activeId)}`)
    assert.ok(!JSON.stringify(session).includes(legacySecret), 'external session API must not disclose shared provider messages')
    assert.ok(!fs.existsSync(externalStatePath), 'external state must not be created by a read-only startup check')
    assert.strictEqual(JSON.parse(fs.readFileSync(sharedStatePath, 'utf8')).sessions[0].messages[1].content, legacySecret, 'shared provider state must remain untouched')

    await requestJson('/api/sessions', { method: 'POST' })
    assert.ok(fs.existsSync(externalStatePath), 'external mode must persist only to its dedicated state path')
    const externalState = fs.readFileSync(externalStatePath, 'utf8')
    assert.ok(!externalState.includes(legacySecret), 'dedicated external state must not contain legacy provider messages')
    console.log('PASS external-state-isolation')
  } finally {
    await stopChild()
    fs.rmSync(tempRoot, { recursive: true, force: true })
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

async function testV2SafeExecutionOrder(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-smoke-v2-order-'))
  const def = TOOL_DEFS.find((toolDef) => toolDef.name === 'write_file')!
  const order: string[] = []
  const events: Array<{ type: string; origin?: string; namespace?: string; authority?: string; callId?: string }> = []
  const io: AgentIO = {
    print: () => {},
    askYesNo: async () => { order.push('approval'); return true },
    event: (event) => events.push(event)
  }
  const invalid = await executeV2ToolCall(
    { toolCallId: 'invalid', toolName: 'write_file', input: { path: 'invalid.txt' } },
    def,
    { baseURL: '', model: '' },
    makeCtx(root),
    io,
    [() => { order.push('hook-invalid') }]
  )
  assert.strictEqual(invalid.executed, false)
  assert.ok(invalid.output.startsWith('[validation error]'))
  assert.strictEqual(order.length, 0, 'validation must reject before hooks and approval')

  clearToolExecuteBeforeHooks()
  registerToolExecuteBeforeHook(() => { order.push('hook-1') })
  registerToolExecuteBeforeHook(() => { order.push('hook-2') })
  const executed = await executeV2ToolCall(
    { toolCallId: 'valid', toolName: 'write_file', input: { path: 'ordered.txt', content: 'ordered' } },
    def,
    { baseURL: '', model: '' },
    makeCtx(root),
    io,
    [({ args }) => {
      assert.deepStrictEqual(args, { path: 'ordered.txt', content: 'ordered' })
      assert.ok(!fs.existsSync(path.join(root, 'ordered.txt')), 'hook must run before the host guard/execution')
      order.push('hook')
    }]
  )
  assert.strictEqual(executed.status, 'succeeded')
  assert.deepStrictEqual(order, ['hook-1', 'hook-2', 'hook', 'approval'])
  clearToolExecuteBeforeHooks()
  assert.strictEqual(fs.readFileSync(path.join(root, 'ordered.txt'), 'utf8'), 'ordered')
  const eventTypes = events.map((event) => event.type)
  assert.ok(eventTypes.indexOf('tool.requested') < eventTypes.indexOf('approval.requested'))
  assert.ok(eventTypes.indexOf('tool.approved') < eventTypes.indexOf('tool.started'))
  for (const event of events.filter((entry) => entry.type.startsWith('tool.') || entry.type.startsWith('step.'))) {
    assert.deepStrictEqual({ origin: event.origin, namespace: event.namespace, authority: event.authority }, { origin: 'host', namespace: 'app', authority: 'authoritative' })
    assert.ok(event.callId)
  }
  fs.rmSync(root, { recursive: true, force: true })
  console.log('PASS v2-safe-execution-order')
}

async function testV2ToolLoopAndEventContract(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-smoke-v2-loop-'))
  await withCopilotBridge([
    '{"tool":"host.write_file","args":{"path":"v2.txt","content":"from v2"}}',
    '{"answer":"v2で書き込みました"}'
  ], async (baseCfg, prompts) => {
    const events: Array<{ type: string; origin?: string; namespace?: string; authority?: string; callId?: string }> = []
    const logs: string[] = []
    const result = await runConfiguredAgentTurn({
      cfg: { ...baseCfg, agentLoop: 'v2', autoApprove: { write: true } },
      messages: [{ role: 'system', content: 'smoke system' }],
      userInput: '作って',
      ctx: makeCtx(root),
      io: { ...ioStub(true), print: (line) => logs.push(line), event: (event) => events.push(event) }
    })
    assert.strictEqual(result.reply, 'v2で書き込みました', JSON.stringify({ messages: result.messages, logs, events }))
    assert.strictEqual(result.aborted, false)
    assert.strictEqual(fs.readFileSync(path.join(root, 'v2.txt'), 'utf8'), 'from v2')
    assert.strictEqual(prompts.length, 2)
    assert.ok(prompts[1].includes('BEGIN_UNTRUSTED_HOST_RESULT'))
    assert.ok(events.some((event) => event.type === 'model.decision' && event.origin === 'copilot' && event.namespace === 'none' && event.authority === 'claimed'))
    assert.ok(events.some((event) => event.type === 'plan.created' && event.origin === 'orchestrator' && event.namespace === 'none' && event.authority === 'derived'))
    assert.ok(events.some((event) => event.type === 'tool.succeeded' && event.origin === 'host' && event.namespace === 'app' && event.authority === 'authoritative' && event.callId))
  })
  fs.rmSync(root, { recursive: true, force: true })
  console.log('PASS v2-tool-loop')
  console.log('PASS v2-event-contract')
}

async function testV2HookDenialPropagation(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-smoke-v2-hook-'))
  let approvals = 0
  await withServer([
    { tool_call: { name: 'write_file', args: { path: 'denied.txt', content: 'never' } } },
    { content: 'フック拒否を確認しました' }
  ], async (baseCfg, requestBodies) => {
    const events: string[] = []
    const result = await runAgentTurnV2({
      cfg: { ...baseCfg, agentLoop: 'v2' },
      messages: [],
      userInput: '拒否して',
      ctx: makeCtx(root),
      io: {
        print: () => {},
        askYesNo: async () => { approvals++; return true },
        event: (event) => events.push(event.type)
      },
      beforeHooks: [() => { throw new Error('phase2-policy-denied') }]
    })
    assert.strictEqual(result.reply, 'フック拒否を確認しました')
    assert.strictEqual(approvals, 0, 'hook rejection must happen before approval')
    assert.ok(!fs.existsSync(path.join(root, 'denied.txt')))
    assert.ok(requestBodies[1].includes('phase2-policy-denied'), 'hook rejection reason must be returned to the model')
    assert.ok(events.includes('tool.denied') && events.includes('step.failed'))
  })
  fs.rmSync(root, { recursive: true, force: true })
  console.log('PASS v2-hook-denial-propagation')
}

async function testV2PermissionActionsLastWins(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-smoke-v2-permission-actions-'))
  const ctx = makeCtx(root)
  const rules = [
    { permission: 'write_file', pattern: '*', action: 'ask' as const },
    { permission: 'write_file', pattern: 'notes/**', action: 'allow' as const },
    { permission: 'write_file', pattern: 'notes/private.txt', action: 'deny' as const }
  ]
  assert.strictEqual(await evaluateToolPermission('host.write_file', { path: 'notes/public.txt', content: 'x' }, ctx, rules), 'allow')
  assert.strictEqual(await evaluateToolPermission('host.write_file', { path: 'notes/private.txt', content: 'x' }, ctx, rules), 'deny')
  assert.strictEqual(await evaluateToolPermission('host.write_file', { path: 'other.txt', content: 'x' }, ctx, rules), 'ask')

  const controller = createPermissionHook(rules)
  const args = { path: 'notes/public.txt', content: 'x' }
  await controller.hook({ tool: 'host.write_file', args, ctx })
  assert.strictEqual(controller.takeDecision(args), 'allow')
  assert.strictEqual(controller.takeDecision({ ...args }), undefined, 'decisions are keyed by the exact args object')
  await assert.rejects(
    async () => { await controller.hook({ tool: 'host.write_file', args: { path: 'notes/private.txt', content: 'x' }, ctx }) },
    /permission denied/iu
  )

  let approvals = 0
  const io: AgentIO = {
    print: () => {},
    askYesNo: async () => { approvals++; return false }
  }
  const writeDef = TOOL_DEFS.find((toolDef) => toolDef.name === 'write_file')!
  const allowed = await executeV2ToolCall(
    { toolCallId: 'permission-allow', toolName: 'write_file', input: { path: 'notes/public.txt', content: 'allowed' } },
    writeDef,
    { baseURL: '', model: '', permissions: rules },
    ctx,
    io,
    []
  )
  assert.strictEqual(allowed.status, 'succeeded', 'allow skips only the existing approval prompt')
  assert.strictEqual(approvals, 0)

  const denied = await executeV2ToolCall(
    { toolCallId: 'permission-deny', toolName: 'write_file', input: { path: 'notes/private.txt', content: 'never' } },
    writeDef,
    { baseURL: '', model: '', permissions: rules },
    ctx,
    io,
    []
  )
  assert.strictEqual(denied.status, 'denied')
  assert.ok(denied.output.includes('permission denied'))
  assert.ok(!fs.existsSync(path.join(root, 'notes/private.txt')))
  assert.strictEqual(approvals, 0, 'deny happens before the existing approval flow')

  const readDef = TOOL_DEFS.find((toolDef) => toolDef.name === 'read_file')!
  const asked = await executeV2ToolCall(
    { toolCallId: 'permission-ask', toolName: 'read_file', input: { path: 'notes/public.txt' } },
    readDef,
    { baseURL: '', model: '', permissions: [{ permission: 'read_file', pattern: '*', action: 'ask' }] },
    ctx,
    io,
    []
  )
  assert.strictEqual(asked.status, 'denied')
  assert.strictEqual(asked.output, 'ユーザーが拒否しました')
  assert.strictEqual(approvals, 1, 'ask forces the existing approval flow even for a read tool')

  const mutatedArgs = { path: 'notes/public.txt', content: 'never' }
  const deniedAfterHookMutation = await executeV2ToolCall(
    { toolCallId: 'permission-post-hook', toolName: 'write_file', input: mutatedArgs },
    writeDef,
    { baseURL: '', model: '', permissions: rules },
    ctx,
    io,
    [({ args }) => { args.path = 'notes/private.txt' }]
  )
  assert.strictEqual(deniedAfterHookMutation.status, 'denied', 'permission evaluation must bind after other before-hooks')
  assert.ok(!fs.existsSync(path.join(root, 'notes/private.txt')))
  fs.rmSync(root, { recursive: true, force: true })
  console.log('PASS v2-permission-actions-last-wins')
}

async function testV2PermissionNewVsOverwrite(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-smoke-v2-permission-overwrite-'))
  const ctx = makeCtx(root)
  const writeDef = TOOL_DEFS.find((toolDef) => toolDef.name === 'write_file')!
  const rules = [
    { permission: 'write_file', pattern: '*', action: 'allow' as const },
    { permission: 'write_file.overwrite', pattern: '*', action: 'ask' as const }
  ]
  let approvals = 0
  const io: AgentIO = {
    print: () => {},
    askYesNo: async () => { approvals++; return true }
  }
  try {
    const first = await executeV2ToolCall(
      { toolCallId: 'new-write', toolName: 'write_file', input: { path: 'same.txt', content: 'first' } },
      writeDef,
      { baseURL: '', model: '', permissions: rules },
      ctx,
      io,
      []
    )
    assert.strictEqual(first.status, 'succeeded')
    assert.strictEqual(first.executed, true)
    assert.strictEqual(approvals, 0, 'new writes allowed by write_file must not prompt')

    const second = await executeV2ToolCall(
      { toolCallId: 'overwrite-write', toolName: 'write_file', input: { path: 'same.txt', content: 'second' } },
      writeDef,
      { baseURL: '', model: '', permissions: rules },
      ctx,
      io,
      []
    )
    assert.strictEqual(second.status, 'succeeded')
    assert.strictEqual(second.executed, true)
    assert.strictEqual(approvals, 1, 'existing writes must use write_file.overwrite and ask')
    assert.strictEqual(fs.readFileSync(path.join(root, 'same.txt'), 'utf8'), 'second')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
  console.log('PASS v2-permission-new-vs-overwrite')
}

async function testV2PermissionOverwriteLastWins(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-smoke-v2-permission-overwrite-order-'))
  const ctx = makeCtx(root)
  fs.writeFileSync(path.join(root, 'existing.txt'), 'before', 'utf8')
  const args = { path: 'existing.txt', content: 'after' }
  try {
    const askThenDeny = [
      { permission: 'write_file.overwrite', pattern: '*', action: 'ask' as const },
      { permission: 'write_file.overwrite', pattern: 'existing.txt', action: 'deny' as const }
    ]
    const denyThenAsk = [
      { permission: 'write_file.overwrite', pattern: 'existing.txt', action: 'deny' as const },
      { permission: 'write_file.overwrite', pattern: '*', action: 'ask' as const }
    ]
    assert.strictEqual(await evaluateToolPermission('host.write_file', args, ctx, askThenDeny), 'deny')
    assert.strictEqual(await evaluateToolPermission('host.write_file', args, ctx, denyThenAsk), 'ask')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
  console.log('PASS v2-permission-overwrite-last-wins')
}

async function testV2PermissionOverwritePrecondition(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-smoke-v2-permission-overwrite-precondition-'))
  const ctx = makeCtx(root)
  const target = path.join(root, 'existing.txt')
  fs.writeFileSync(target, 'before', 'utf8')
  const originalWriteDef = TOOL_DEFS.find((toolDef) => toolDef.name === 'write_file')!
  let runs = 0
  const writeDef: typeof originalWriteDef = {
    ...originalWriteDef,
    run: async (args, runCtx) => {
      runs++
      return originalWriteDef.run(args, runCtx)
    }
  }
  let approvals = 0
  const io: AgentIO = {
    print: () => {},
    askYesNo: async () => {
      approvals++
      fs.writeFileSync(target, 'external-change', 'utf8')
      return true
    }
  }
  try {
    const result = await executeV2ToolCall(
      { toolCallId: 'overwrite-precondition', toolName: 'write_file', input: { path: 'existing.txt', content: 'agent-change' } },
      writeDef,
      {
        baseURL: '',
        model: '',
        permissions: [
          { permission: 'write_file', pattern: '*', action: 'allow' },
          { permission: 'write_file.overwrite', pattern: '*', action: 'ask' }
        ]
      },
      ctx,
      io,
      []
    )
    assert.strictEqual(result.status, 'denied')
    assert.strictEqual(result.executed, false)
    assert.strictEqual(runs, 0, 'approval precondition denial must happen before ToolDef.run')
    assert.strictEqual(approvals, 1)
    assert.strictEqual(fs.readFileSync(target, 'utf8'), 'external-change', 'external content must be preserved')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
  console.log('PASS v2-permission-overwrite-precondition')
}

async function testV2MinAskProfileZeroApprovals(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-smoke-v2-min-ask-profile-'))
  const profilePath = path.join(process.cwd(), 'config.flex.json')
  const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8')) as AgentConfig
  const exampleProfilePath = path.join(process.cwd(), 'config.example.json')
  const exampleProfile = JSON.parse(fs.readFileSync(exampleProfilePath, 'utf8')) as AgentConfig
  assert.strictEqual(profile.agentLoop, 'v1', 'shipped flex profile must retain the v1 default')
  assert.strictEqual(profile.safeCommandOnly, true)
  assert.strictEqual(exampleProfile.safeCommandOnly, true, 'shipped example profile must retain the safe command hard guard')
  assert.deepStrictEqual(exampleProfile.permissions, profile.permissions, 'shipped profiles must share the ask-minimal permissions')
  assert.deepStrictEqual(profile.permissions, [
    { permission: 'list_files', pattern: '*', action: 'allow' },
    { permission: 'read_file', pattern: '*', action: 'allow' },
    { permission: 'read_files', pattern: '*', action: 'allow' },
    { permission: 'read_xlsx', pattern: '*', action: 'allow' },
    { permission: 'search_files', pattern: '*', action: 'allow' },
    { permission: 'write_file', pattern: '*', action: 'allow' },
    { permission: 'write_file.overwrite', pattern: '*', action: 'ask' },
    { permission: 'start_process', pattern: '*', action: 'allow' },
    { permission: 'run_command', pattern: '*', action: 'ask' }
  ])
  fs.writeFileSync(path.join(root, 'read.txt'), 'needle in fixture', 'utf8')
  fs.writeFileSync(path.join(root, 'open.txt'), 'open fixture', 'utf8')
  const scenarios: Array<{ userInput: string; tool_call: { name: string; args: Record<string, unknown> } }> = [
    { userInput: '一覧', tool_call: { name: 'list_files', args: { path: '.', recursive: false } } },
    { userInput: '読む', tool_call: { name: 'read_file', args: { path: 'read.txt' } } },
    { userInput: '開く', tool_call: { name: 'start_process', args: { command: 'open.txt' } } },
    { userInput: '新規作成', tool_call: { name: 'write_file', args: { path: 'new.txt', content: 'new fixture' } } },
    { userInput: '検索', tool_call: { name: 'search_files', args: { query: 'needle' } } }
  ]
  const steps: ScriptStep[] = scenarios.flatMap((scenario, index) => [
    { tool_call: scenario.tool_call },
    { content: `scenario-${index}-done` }
  ])
  const startProcessDef = TOOL_DEFS.find((toolDef) => toolDef.name === 'start_process')!
  const originalStartProcessRun = startProcessDef.run
  let approvals = 0
  try {
    // The open scenario must remain deterministic and must not launch a GUI app.
    startProcessDef.run = async () => 'stub-opened'
    await withServer(steps, async (baseCfg, requestBodies) => {
      for (const scenario of scenarios) {
        const cfg: AgentConfig = {
          ...baseCfg,
          ...profile,
          agentLoop: 'v2',
          baseURL: baseCfg.baseURL,
          apiKey: baseCfg.apiKey,
          model: baseCfg.model
        }
        const result = await runAgentTurnV2({
          cfg,
          messages: [],
          userInput: scenario.userInput,
          ctx: makeCtx(root, true),
          io: {
            print: () => {},
            askYesNo: async () => { approvals++; return true }
          }
        })
        assert.strictEqual(result.aborted, false, `${scenario.userInput} turn should complete`)
        assert.ok(result.reply.includes('scenario-'), `${scenario.userInput} turn should receive the model completion`)
      }
      assert.strictEqual(requestBodies.length, scenarios.length * 2)
    })
    assert.strictEqual(approvals, 0, 'ask-minimal profile must complete all five turns with zero approvals')
    assert.strictEqual(fs.readFileSync(path.join(root, 'new.txt'), 'utf8'), 'new fixture')
  } finally {
    startProcessDef.run = originalStartProcessRun
    fs.rmSync(root, { recursive: true, force: true })
  }
  console.log('PASS v2-min-ask-profile-zero-approvals')
}

async function testV2PermissionCommandPrefix(): Promise<void> {
  assert.deepStrictEqual(commandPermissionTarget('git status'), { target: 'git status', allowEligible: true })
  assert.deepStrictEqual(commandPermissionTarget('git status --short'), { target: 'git status', allowEligible: true })
  assert.deepStrictEqual(commandPermissionTarget('npm run dev'), { target: 'npm run dev', allowEligible: true })
  assert.deepStrictEqual(commandPermissionTarget('npm run dev -- --host 127.0.0.1'), { target: 'npm run dev', allowEligible: true })
  console.log('PASS v2-permission-command-prefix')
}

async function testV2PermissionCommandConservative(): Promise<void> {
  for (const command of ['git status; npm run dev', 'git status && npm run dev', 'git status | cat', 'git status > status.txt']) {
    const parsed = commandPermissionTarget(command)
    assert.strictEqual(parsed.target, command)
    assert.strictEqual(parsed.allowEligible, false, command)
  }
  const parseFailure = commandPermissionTarget('echo ${BROKEN')
  assert.strictEqual(parseFailure.target, 'echo ${BROKEN')
  assert.strictEqual(parseFailure.allowEligible, false)

  const controller = createPermissionHook([{ permission: 'run_command', pattern: '*', action: 'allow' }])
  const args = { command: 'git status; npm run dev' }
  await controller.hook({ tool: 'host.run_command', args, ctx: makeCtx(os.tmpdir()) })
  assert.strictEqual(controller.takeDecision(args), 'ask', 'complex commands downgrade an allow to ask')
  console.log('PASS v2-permission-command-conservative')
}

async function testV2PermissionHardGuardComposition(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-smoke-v2-permission-hard-'))
  const io: AgentIO = { print: () => {}, askYesNo: async () => { throw new Error('permission allow must not ask') } }
  const readDef = TOOL_DEFS.find((toolDef) => toolDef.name === 'read_file')!
  const outside = await executeV2ToolCall(
    { toolCallId: 'outside', toolName: 'read_file', input: { path: '../outside.txt' } },
    readDef,
    { baseURL: '', model: '', permissions: [{ permission: 'read_file', pattern: '../*', action: 'allow' }] },
    makeCtx(root),
    io,
    []
  )
  assert.notStrictEqual(outside.status, 'succeeded')
  assert.ok(outside.output.includes('ワークスペース外'))

  const commandDef = TOOL_DEFS.find((toolDef) => toolDef.name === 'run_command')!
  const dangerous = await executeV2ToolCall(
    { toolCallId: 'dangerous', toolName: 'run_command', input: { command: 'git reset --hard HEAD' } },
    commandDef,
    { baseURL: '', model: '', allowArbitraryCommands: true, permissions: [{ permission: 'run_command', pattern: 'git reset*', action: 'allow' }] },
    makeCtx(root),
    io,
    []
  )
  assert.notStrictEqual(dangerous.status, 'succeeded')
  assert.ok(dangerous.output.includes('破壊的'))
  fs.rmSync(root, { recursive: true, force: true })
  console.log('PASS v2-permission-hard-guard-composition')
}

async function testV2PermissionEmptyCompatibility(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-smoke-v2-permission-empty-'))
  fs.writeFileSync(path.join(root, 'same.txt'), 'same', 'utf8')
  const def = TOOL_DEFS.find((toolDef) => toolDef.name === 'read_file')!
  let missingApprovals = 0
  let emptyApprovals = 0
  const missing = await executeV2ToolCall(
    { toolCallId: 'missing', toolName: 'read_file', input: { path: 'same.txt' } },
    def,
    { baseURL: '', model: '' },
    makeCtx(root),
    { print: () => {}, askYesNo: async () => { missingApprovals++; return true } },
    []
  )
  const empty = await executeV2ToolCall(
    { toolCallId: 'empty', toolName: 'read_file', input: { path: 'same.txt' } },
    def,
    { baseURL: '', model: '', permissions: [] },
    makeCtx(root),
    { print: () => {}, askYesNo: async () => { emptyApprovals++; return true } },
    []
  )
  assert.strictEqual(missing.status, 'succeeded')
  assert.strictEqual(empty.status, 'succeeded')
  assert.strictEqual(empty.output, missing.output)
  assert.strictEqual(missingApprovals, 0)
  assert.strictEqual(emptyApprovals, 0)
  fs.rmSync(root, { recursive: true, force: true })
  console.log('PASS v2-permission-empty-compatibility')
}

async function testV2LimitsAndNoProgress(): Promise<void> {
  async function expectWarning(
    label: string,
    steps: ScriptStep[],
    overrides: Partial<AgentConfig>,
    expected: string,
    prepare?: (root: string) => void
  ): Promise<void> {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `ca-smoke-v2-${label}-`))
    prepare?.(root)
    await withServer(steps, async (baseCfg) => {
      const warnings: string[] = []
      const result = await runAgentTurnV2({
        cfg: { ...baseCfg, agentLoop: 'v2', ...overrides },
        messages: [], userInput: label, ctx: makeCtx(root),
        io: { ...ioStub(true), event: (event) => { if (event.type === 'run.warning') warnings.push(event.error ?? '') } }
      })
      assert.strictEqual(result.aborted, true, label)
      assert.ok(warnings.some((warning) => warning.includes(expected)), `${label}: ${warnings.join(' | ')}`)
    })
    fs.rmSync(root, { recursive: true, force: true })
  }

  await expectWarning('iteration', [{ tool_call: { name: 'list_files', args: {} } }], { maxToolIterations: 1 }, '最大反復回数')
  await expectWarning('host', [
    { tool_call: { name: 'list_files', args: { path: 'a' } } },
    { tool_call: { name: 'list_files', args: { path: 'b' } } }
  ], { maxToolExecutions: 1 }, 'hostツール実行上限', (root) => { fs.mkdirSync(path.join(root, 'a')); fs.mkdirSync(path.join(root, 'b')) })
  await expectWarning('write', [{ tool_call: { name: 'write_file', args: { path: 'x.txt', content: 'x' } } }], { maxWriteExecutions: 0 }, '書き込み実行上限')
  await expectWarning('command', [{ tool_call: { name: 'run_command', args: { command: 'echo never' } } }], { allowArbitraryCommands: true, maxCommandExecutions: 0 }, 'コマンド実行上限')
  await expectWarning('no-progress', [
    { tool_call: { name: 'list_files', args: { path: 'a' } } },
    { tool_call: { name: 'list_files', args: { path: 'b' } } }
  ], { maxNoProgress: 1 }, '進展がない', (root) => { fs.mkdirSync(path.join(root, 'a')); fs.mkdirSync(path.join(root, 'b')) })

  const backend = new FakeBackend(['{"answer":"v1 default"}\nAGENT_END'])
  const v1 = await runConfiguredAgentTurn({
    cfg: { baseURL: '', model: '', provider: 'copilot-edge', copilot: { agentMode: false }, turnMode: 'chat' },
    messages: [], userInput: 'default', ctx: makeCtx(os.tmpdir(), false), io: ioStub(true), backend
  })
  assert.strictEqual(v1.reply, '{"answer":"v1 default"}\nAGENT_END')
  assert.strictEqual(backend.calls, 1, 'agentLoop omitted must keep the v1 route')
  console.log('PASS v2-limits-and-no-progress')
  console.log('PASS v1-default-route')
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

  const safeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-smoke-safe-'))
  const safeBackend = new FakeBackend(['{"answer":"外部情報は取得できません"}\nAGENT_END'])
  const safeCtx = { ...makeCtx(safeRoot), safeCommandOnly: true }
  const safeAnswer = await runAgentTurn({ cfg, messages: [], userInput: '天気を教えて', ctx: safeCtx, io: ioStub(true), backend: safeBackend })
  assert.strictEqual(safeAnswer.reply, '外部情報は取得できません')
  assert.ok(!safeBackend.prompts[0].includes('host.get_weather'), 'safe command contract must hide network host tools')
  assert.ok(!safeBackend.prompts[0].includes('任意のhostコマンド実行が許可'), 'safe prompt must not claim arbitrary command permission')
  assert.ok(safeBackend.prompts[0].includes('既存のワークスペース内通常ファイル1件'))
  assert.ok(safeBackend.prompts[0].includes('answerで利用者へ許可を尋ねず'))
  const safeTools = openAITools({ allowArbitraryCommands: true, safeCommandOnly: true })
  assert.ok(!safeTools.some((tool) => tool.function.name === 'host.get_weather'))
  const safeStart = safeTools.find((tool) => tool.function.name === 'host.start_process')
  assert.ok(safeStart && !('url' in ((safeStart.function.parameters.properties ?? {}) as Record<string, unknown>)), 'safe start_process schema must omit url')
  assert.ok(safeTools.find((tool) => tool.function.name === 'host.run_command')?.function.description.includes('任意シェル'))
  const deniedWeather = await runAgentTurn({ cfg, messages: [], userInput: '天気を教えて', ctx: safeCtx, io: ioStub(true), backend: new FakeBackend(['{"tool":"host.get_weather","args":{"location":"広島市"}}\nAGENT_END']) })
  assert.strictEqual(deniedWeather.aborted, true)
  assert.ok(deniedWeather.messages.at(-1)?.content?.includes('ネットワーク通信'))
  fs.rmSync(safeRoot, { recursive: true, force: true })

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
  const sessionMarker = makeVisibleSessionMarker('mt9icyqzvay6')
  assert.strictEqual(sessionMarker, 'company-apps-coding-agent:mt9icyqzvay6')
  assert.strictEqual(visibleSessionMarkerMatches('mt9icyqzvay6', sessionMarker), true)
  assert.strictEqual(visibleSessionMarkerMatches('mt9gbgtilhj0', sessionMarker), false)
  assert.throws(() => makeVisibleSessionMarker('../wrong-session'), /表示セッションIDが不正/)
  assert.strictEqual(selectBrowserProcessId([
    { type: 'renderer', id: 23468 },
    { type: 'browser', id: 38124 },
    { type: 'GPU', id: 13292 }
  ]), 38124)
  assert.strictEqual(selectBrowserProcessId([{ type: 'browser', id: 0 }]), null)
  assert.strictEqual(selectBrowserProcessId([{ type: 'browser', id: 38124.5 }]), null)
  assert.strictEqual(selectBrowserProcessId({ type: 'browser', id: 38124 }), null)
  console.log('PASS copilot-edge-isolation')
}

async function testCopilotVisibleSessionPidLifecycle(): Promise<void> {
  const originalFetch = globalThis.fetch
  const originalWebSocket = (globalThis as Record<string, unknown>).WebSocket
  let processInfo: unknown = undefined
  const cdpMethods: string[] = []
  let closedConnections = 0

  class FakeBrowserWebSocket {
    private listeners = new Map<string, Array<{ cb: (event: { data?: unknown }) => void; once: boolean }>>()

    constructor(_url: string) {
      queueMicrotask(() => this.emit('open', {}))
    }

    addEventListener(type: string, cb: (event: { data?: unknown }) => void, options?: { once?: boolean }): void {
      const listeners = this.listeners.get(type) ?? []
      listeners.push({ cb, once: options?.once === true })
      this.listeners.set(type, listeners)
    }

    send(data: string): void {
      const request = JSON.parse(data) as { id: number; method: string }
      cdpMethods.push(request.method)
      queueMicrotask(() => this.emit('message', {
        data: JSON.stringify({ id: request.id, result: { processInfo } })
      }))
    }

    close(): void {
      closedConnections++
    }

    private emit(type: string, event: { data?: unknown }): void {
      const listeners = this.listeners.get(type) ?? []
      this.listeners.set(type, listeners.filter((listener) => {
        listener.cb(event)
        return !listener.once
      }))
    }
  }

  try {
    globalThis.fetch = (async () => ({
      ok: true,
      json: async () => ({ webSocketDebuggerUrl: 'ws://fake-browser' })
    })) as unknown as typeof fetch
    ;(globalThis as Record<string, unknown>).WebSocket = FakeBrowserWebSocket

    const client = new CopilotEdgeClient({ baseURL: '', model: '', provider: 'copilot-edge' })
    const internal = client as unknown as Record<string, any>
    const lifecycle: string[] = []
    internal.s.cdpPort = 61027
    internal.ownedEdgePid = 22468
    const ensureEdge = internal.ensureEdge.bind(client) as () => Promise<void>
    internal.ensureEdge = async () => {
      lifecycle.push('ensureEdge')
      await ensureEdge()
    }
    internal.ensurePage = async () => { lifecycle.push('ensurePage') }
    const refreshBrowserProcessId = internal.refreshBrowserProcessId.bind(client) as () => Promise<void>
    internal.refreshBrowserProcessId = async () => {
      lifecycle.push('refreshBrowserProcessId')
      await refreshBrowserProcessId()
    }
    internal.cdpMethod = async (name: string) => { lifecycle.push(name) }
    internal.waitInputReady = async () => { lifecycle.push('waitInputReady') }
    internal.assertTrustedOrigin = async () => { lifecycle.push('assertTrustedOrigin') }
    internal.stampVisibleSessionMarker = async () => { lifecycle.push('stampVisibleSessionMarker') }
    internal.bringToFront = async () => { lifecycle.push('bringToFront') }
    internal.inspectVisibleSession = async (sessionId: string) => {
      lifecycle.push('inspectVisibleSession')
      return {
        sessionId,
        marker: makeVisibleSessionMarker(sessionId),
        markerMatches: true,
        pid: internal.visibleEdgePid,
        cdpPort: internal.s.cdpPort,
        url: 'https://m365.cloud.microsoft/chat/',
        title: 'Copilot',
        inputReady: true,
        responseCount: 0,
        latestResponseLength: 0,
        generating: false,
        copyEnabled: false
      }
    }

    await assert.rejects(
      () => client.prepareVisibleSession('mt9pidlifecycle'),
      /CDPからEdgeブラウザー本体PIDを取得できませんでした/
    )
    assert.strictEqual(internal.ownedEdgePid, 22468)
    assert.strictEqual(internal.visibleEdgePid, null)
    assert.strictEqual(internal.s.cdpPort, 61027)
    assert.deepStrictEqual(cdpMethods, ['SystemInfo.getProcessInfo'])
    assert.deepStrictEqual(lifecycle, ['ensureEdge', 'ensurePage', 'refreshBrowserProcessId'])

    processInfo = [
      { type: 'renderer', id: 23468 },
      { type: 'browser', id: 38124 }
    ]
    cdpMethods.length = 0
    lifecycle.length = 0
    const visible = await client.prepareVisibleSession('mt9pidlifecycle')
    assert.strictEqual(visible.pid, 38124)
    assert.strictEqual(internal.ownedEdgePid, 22468)
    assert.strictEqual(internal.visibleEdgePid, 38124)
    assert.strictEqual(internal.s.cdpPort, 61027)
    assert.deepStrictEqual(cdpMethods, ['SystemInfo.getProcessInfo'])
    assert.deepStrictEqual(lifecycle, [
      'ensureEdge',
      'ensurePage',
      'refreshBrowserProcessId',
      'Page.navigate',
      'waitInputReady',
      'assertTrustedOrigin',
      'stampVisibleSessionMarker',
      'bringToFront',
      'inspectVisibleSession'
    ])
    assert.strictEqual(closedConnections, 2)
  } finally {
    globalThis.fetch = originalFetch
    ;(globalThis as Record<string, unknown>).WebSocket = originalWebSocket
  }
  console.log('PASS copilot-visible-session-pid-lifecycle')
}

async function testCopilotResponseCompletion(): Promise<void> {
  const empty = (): ResponseCompletionState => ({ stableText: null, stableSinceMs: null })
  let result = updateResponseCompletionState(empty(), {
    observedAtMs: 0,
    text: 'a'.repeat(5000),
    generating: true,
    copyEnabled: true
  })
  assert.strictEqual(result.ready, false)
  assert.strictEqual(result.state.stableSinceMs, null)

  result = updateResponseCompletionState(empty(), {
    observedAtMs: 0,
    text: 'a'.repeat(5000),
    generating: false,
    copyEnabled: false
  })
  assert.strictEqual(result.ready, false)
  assert.strictEqual(result.state.stableSinceMs, null)

  result = updateResponseCompletionState(empty(), {
    observedAtMs: 100,
    text: 'a'.repeat(5000),
    generating: false,
    copyEnabled: true
  })
  result = updateResponseCompletionState(result.state, {
    observedAtMs: 1200,
    text: 'b'.repeat(7000),
    generating: false,
    copyEnabled: true
  })
  assert.strictEqual(result.ready, false)
  assert.strictEqual(result.state.stableSinceMs, 1200)

  result = updateResponseCompletionState(result.state, {
    observedAtMs: 2000,
    text: 'b'.repeat(7000),
    generating: false,
    copyEnabled: true
  })
  assert.strictEqual(result.ready, false)
  result = updateResponseCompletionState(result.state, {
    observedAtMs: 2200,
    text: 'b'.repeat(7000),
    generating: false,
    copyEnabled: true
  })
  assert.strictEqual(result.ready, true)

  result = updateResponseCompletionState(result.state, {
    observedAtMs: 2300,
    text: 'c'.repeat(7000),
    generating: false,
    copyEnabled: true
  })
  assert.strictEqual(result.ready, false, 'same-length content replacement must reset response stability')
  assert.strictEqual(result.state.stableSinceMs, 2300)

  result = updateResponseCompletionState(result.state, {
    observedAtMs: 2400,
    text: 'c'.repeat(7000),
    generating: false,
    copyEnabled: false
  })
  assert.strictEqual(result.ready, false)
  assert.strictEqual(result.state.stableSinceMs, null)

  result = updateResponseCompletionState(empty(), {
    observedAtMs: 3000,
    text: 'b'.repeat(7000),
    generating: false,
    copyEnabled: true
  })
  result = updateResponseCompletionState(result.state, {
    observedAtMs: 4100,
    text: 'b'.repeat(7000),
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
  for (const required of ['shadowRoot', 'contentDocument', 'stopGeneratingButton', 'stop-button', 'fai-SendButton__stopBackground', '[role="article"][class*="CopilotMessage" i]', '[data-testid="copilot-message-div"]', 'windowName', 'data-company-apps-session']) {
    assert.ok(COPILOT_SCREEN_STATE_JS.includes(required), `screen-state detector missing ${required}`)
    if (required.includes('CopilotMessage') || required.includes('copilot-message-div')) {
      assert.ok(COPILOT_CLICK_COPY_JS.includes(required), `copy detector missing ${required}`)
    }
  }
  new Function('document', 'window', `return ${COPILOT_SCREEN_STATE_JS}`)
  new Function('document', 'window', `return ${COPILOT_CLICK_COPY_JS}`)
  new Function('document', 'window', `return ${COPILOT_CLICK_SEND_JS}`)
  new Function('document', 'window', `return ${COPILOT_SEND_READY_JS}`)
  assert.strictEqual(normalizeCopilotEditorText('前\u200B中\u200C後'), '前中後')
  for (const required of ['button[type="submit"]', '.fai-SendButton', '[class*="SendButton" i]', '[data-testid*="send" i]', '[data-automation-id*="send" i]', 'exclude.test(identity)', 'ariaLabel', 'automationId', 'diagnosticButtons']) {
    assert.ok(COPILOT_CLICK_SEND_JS.includes(required), `send-button detector missing ${required}`)
    if (required !== 'exclude.test(identity)' && required !== 'diagnosticButtons') assert.ok(COPILOT_SEND_READY_JS.includes(required), `send-button readiness detector missing ${required}`)
  }
  assert.ok(fs.readFileSync(path.join(process.cwd(), 'src', 'copilot.ts'), 'utf8').includes("this.cdpMethod('Input.dispatchMouseEvent', { type: 'mousePressed'"), 'send path must retain native CDP mouse fallback')
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
    waitResponse: (baseline: string) => Promise<{ answer: string; generationWaitMs: number; completionRetrievalMs: number }>
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
    let waitBoundaryFinalized = false
    waitBoundary.finalizeAnswer = async () => {
      waitBoundaryFinalized = true
      boundaryNow = 6000
      return 'complete response'
    }
    const directDomResponse = await waitBoundary.waitResponse('baseline')
    assert.strictEqual(directDomResponse.answer, 'complete response')
    assert.strictEqual(waitBoundaryFinalized, false, 'stable visible DOM response must not perform a clipboard round trip')

    boundaryNow = 3000
    const emptyDomClient = new CopilotEdgeClient({
      baseURL: '',
      model: '',
      provider: 'copilot-edge',
      copilot: { responseTimeoutSec: 5, pollIntervalMs: 500 }
    })
    const emptyDom = emptyDomClient as unknown as DeadlineInternals
    let emptyPolls = 0
    emptyDom.readScreenState = async () => {
      emptyPolls++
      boundaryNow = emptyPolls === 1 ? 3000 : 4100
      return { text: 'AGENT_END', generating: false, copyEnabled: true, signinRequired: false }
    }
    emptyDom.finalizeAnswer = async () => 'clipboard fallback response'
    const clipboardFallback = await emptyDom.waitResponse('baseline')
    assert.strictEqual(clipboardFallback.answer, 'clipboard fallback response')
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
    waitResponse: (baseline: string) => Promise<{ answer: string; generationWaitMs: number; completionRetrievalMs: number }>
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
  orderInternal.waitResponse = async (baseline) => { order.push(`wait:${baseline}`); return { answer: 'done', generationWaitMs: 1, completionRetrievalMs: 2 } }
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
    waitSendReady: (timeoutMs: number) => Promise<{ ready: boolean; inventory: unknown }>
    insertDirect: (prompt: string) => Promise<void>
    insertByChunks: (prompt: string) => Promise<void>
  }
  const internal = client as unknown as Internals
  const prompt = ('0123456789abcdef'.repeat(140)) + '\n末尾'
  let editor = ''
  let insertCalls = 0
  internal.editorLength = async () => normalizeCopilotEditorText(editor).length
  internal.editorState = async () => ({ found: true, text: normalizeCopilotEditorText(editor), active: true })
  internal.clearEditor = async () => { editor = '' }
  internal.focusEditor = async () => {}
  internal.bringToFront = async () => {}
  internal.cdpMethod = async (name, params) => {
    if (name !== 'Input.insertText') return
    const chunk = String(params.text ?? '')
    insertCalls++
    const inserted = insertCalls === 2 ? chunk.slice(0, 120) : chunk
    editor += `${insertCalls > 1 ? '\u200B\u200C' : ''}${inserted}`
  }
  internal.waitSendReady = async () => ({ ready: true, inventory: [] })
  await internal.insertByChunks(prompt)
  assert.strictEqual(normalizeCopilotEditorText(editor), prompt)
  assert.ok(editor.includes('\u200B\u200C'), 'Lexical chunk boundary markers were not exercised')
  assert.ok(insertCalls > Math.ceil(prompt.length / 450))
  editor = ''
  insertCalls = 0
  internal.cdpMethod = async (name, params) => {
    if (name === 'Input.insertText') { insertCalls++; editor = String(params.text ?? '') }
  }
  await internal.insertDirect(prompt)
  assert.strictEqual(editor, prompt)
  assert.strictEqual(insertCalls, 1, 'YakuLingo-style direct input must use one Input.insertText call')

  const garbageClient = new CopilotEdgeClient({ baseURL: '', model: '', provider: 'copilot-edge', copilot: { maxPromptChars: 5000 } })
  const garbage = garbageClient as unknown as Internals
  let garbageEditor = ''
  garbage.editorLength = async () => garbageEditor.length
  garbage.editorState = async () => ({ found: true, text: garbageEditor, active: true })
  garbage.clearEditor = async () => { garbageEditor = '' }
  garbage.focusEditor = async () => {}
  garbage.bringToFront = async () => {}
  garbage.waitSendReady = async () => ({ ready: true, inventory: [] })
  garbage.cdpMethod = async (name, params) => {
    if (name !== 'Input.insertText') return
    garbageEditor += String(params.text ?? '')
    if (garbageEditor === prompt) garbageEditor += 'TRAILING_GARBAGE'
  }
  const originalWarn = console.warn
  const garbageWarnings: string[] = []
  console.warn = (...args: unknown[]) => { garbageWarnings.push(args.map(String).join(' ')) }
  try {
    await assert.rejects(garbage.insertByChunks(prompt), /依頼文の入力/, 'chunk fallback must reject prompt plus trailing garbage')
  } finally {
    console.warn = originalWarn
  }
  assert.ok(garbageWarnings.some((line) => line.includes('DOM文字列不一致')), 'trailing garbage rejection must retain a diagnostic warning')

  const sendClient = new CopilotEdgeClient({ baseURL: '', model: '', provider: 'copilot-edge' })
  type SendInternals = {
    clickSend: (baseline: string) => Promise<void>
    waitSendReady: () => Promise<{ ready: boolean; inventory: unknown }>
    editorLength: () => Promise<number>
    evalWithReconnect: () => Promise<unknown>
    waitSendEstablished: () => Promise<boolean>
    cdpMethod: (name: string, params: Record<string, unknown>) => Promise<void>
  }
  const sendInternal = sendClient as unknown as SendInternals
  sendInternal.waitSendReady = async () => ({ ready: true, inventory: [] })
  sendInternal.editorLength = async () => 12
  sendInternal.evalWithReconnect = async () => JSON.stringify({ clicked: true, selected: { rect: { cx: 123, cy: 456 } } })
  let establishmentChecks = 0
  sendInternal.waitSendEstablished = async () => ++establishmentChecks > 1
  const mouseEvents: Array<{ name: string; params: Record<string, unknown> }> = []
  sendInternal.cdpMethod = async (name, params) => { mouseEvents.push({ name, params }) }
  await sendInternal.clickSend('old response')
  assert.deepStrictEqual(mouseEvents.map((event) => [event.name, event.params.type, event.params.x, event.params.y]), [
    ['Input.dispatchMouseEvent', 'mousePressed', 123, 456],
    ['Input.dispatchMouseEvent', 'mouseReleased', 123, 456]
  ])

  const freshClient = new CopilotEdgeClient({ baseURL: '', model: '', provider: 'copilot-edge' })
  type FreshInternals = {
    freshChat: () => Promise<void>
    freshSurfaceReady: () => Promise<boolean>
    waitFreshSurface: () => Promise<boolean>
    evalWithReconnect: () => Promise<unknown>
    cdpMethod: (name: string, params: Record<string, unknown>) => Promise<void>
  }
  const freshInternal = freshClient as unknown as FreshInternals
  freshInternal.freshSurfaceReady = async () => false
  freshInternal.evalWithReconnect = async () => JSON.stringify({ clicked: true })
  let freshWaits = 0
  freshInternal.waitFreshSurface = async () => ++freshWaits > 1
  const navigations: Record<string, unknown>[] = []
  freshInternal.cdpMethod = async (name, params) => { if (name === 'Page.navigate') navigations.push(params) }
  await freshInternal.freshChat()
  assert.deepStrictEqual(navigations, [{ url: 'https://m365.cloud.microsoft/chat/' }], 'unverified synthetic new-chat click must navigate explicitly')
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

async function testLocalResponseConverter(): Promise<void> {
  let responseContent = '{"answer":"変換済み"}'
  let requestCount = 0
  let lastUserContent = ''
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += String(chunk) })
    req.on('end', () => {
      requestCount++
      assert.strictEqual(req.headers.authorization, 'Bearer smoke-local-token')
      const request = JSON.parse(body) as { temperature?: number; max_tokens?: number; response_format?: { type?: string }; chat_template_kwargs?: { enable_thinking?: boolean }; messages?: Array<{ role?: string; content?: string }> }
      assert.strictEqual(request.temperature, 0); assert.strictEqual(request.response_format?.type, 'json_schema'); assert.strictEqual(request.chat_template_kwargs?.enable_thinking, false)
      assert.strictEqual(request.max_tokens, 192)
      lastUserContent = request.messages?.find((message) => message.role === 'user')?.content ?? ''
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content: responseContent } }] }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as net.AddressInfo).port
  const settings = { enabled: true, baseURL: `http://127.0.0.1:${port}/v1`, model: 'fake', timeoutMs: 1000, apiKey: 'smoke-local-token' }
  try {
    assert.strictEqual(await convertCopilotResponse(settings, 'raw', []), '{"answer":"raw"}')
    assert.strictEqual(requestCount, 0, 'plain answers must stay on deterministic layer 1')
    assert.strictEqual(await convertCopilotResponse(settings, 'write_file の判断情報が不足', [
      { name: 'host.write_file', description: 'write', parameters: { type: 'object' } }
    ]), responseContent)
    const direct = await convertCopilotResponse(settings, '{"tool":"write_file","path":"メモ.txt","content":"一言"}', [
      { name: 'host.write_file', description: 'write', parameters: { type: 'object' } }
    ])
    assert.strictEqual(direct, '{"tool":"host.write_file","args":{"path":"メモ.txt","content":"一言"}}')
    assert.strictEqual(requestCount, 1, 'strict JSON must not spend a local-model request')
    const deterministicSearch = await convertCopilotResponse(settings, 'search_filesを使い query=青', [
      { name: 'host.list_files', description: 'list', parameters: { type: 'object' } },
      { name: 'host.search_files', description: 'search', parameters: { type: 'object' } }
    ])
    assert.strictEqual(deterministicSearch, '{"tool":"host.search_files","args":{"query":"青"}}')
    assert.strictEqual(requestCount, 1, 'explicit tool text must stay on deterministic layer 1')
    await convertCopilotResponse(settings, 'search_files の判断情報が不足', [
      { name: 'host.list_files', description: 'list', parameters: { type: 'object' } },
      { name: 'host.search_files', description: 'search', parameters: { type: 'object' } }
    ])
    const converterInput = JSON.parse(lastUserContent) as { host_tools?: Array<{ name?: string }> }
    assert.deepStrictEqual(converterInput.host_tools?.map((tool) => tool.name), ['host.search_files'])
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'converter-smoke-'))
    const converted = await runAgentTurn({ cfg: { baseURL: '', model: '', provider: 'copilot-edge', copilot: { agentMode: true }, localResponseConverter: settings }, messages: [], userInput: '答えて', ctx: makeCtx(root), io: ioStub(true), backend: new FakeBackend(['write_file の判断情報が不足']) })
    assert.strictEqual(converted.reply, '変換済み')
    responseContent = '{"tool":"host.write_file","args":{"unexpected":true}}'
    const rejected = await runAgentTurn({ cfg: { baseURL: '', model: '', provider: 'copilot-edge', copilot: { agentMode: true }, localResponseConverter: settings }, messages: [], userInput: '書いて', ctx: makeCtx(root), io: ioStub(true), backend: new FakeBackend(['write_file の判断情報が不足', '{"answer":"schema rejected"}\nAGENT_END']) })
    assert.strictEqual(rejected.reply, 'schema rejected'); assert.ok(!fs.existsSync(path.join(root, 'unexpected')), 'schema-invalid converter args must not execute')
    fs.rmSync(root, { recursive: true, force: true })
    responseContent = 'invalid converter content'
    const fallback = await runAgentTurn({ cfg: { baseURL: '', model: '', provider: 'copilot-edge', copilot: { agentMode: true }, localResponseConverter: settings }, messages: [], userInput: '答えて', ctx: makeCtx(os.tmpdir(), false), io: ioStub(true), backend: new FakeBackend(['write_file の判断情報が不足', '{"answer":"fallback raw"}\nAGENT_END']) })
    assert.strictEqual(fallback.reply, 'fallback raw')
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())) }
  const ambiguousWrite = 'write_file の判断情報が不足'
  const writeTool = [{ name: 'host.write_file', description: 'write', parameters: { type: 'object' } }]
  await assert.rejects(() => convertCopilotResponse({ enabled: true, baseURL: 'http://example.com/v1' }, ambiguousWrite, writeTool), /loopback/u)
  await assert.rejects(
    () => convertCopilotResponse({ enabled: true, baseURL: 'http://[::1]:9/v1', timeoutMs: 10 }, ambiguousWrite, writeTool),
    (err: unknown) => !/loopback/u.test(String((err as Error).message)),
    'IPv6 loopback must pass URL validation before connection failure'
  )
  console.log('PASS local-response-converter')
}

async function testUiContract(): Promise<void> {
  const html = fs.readFileSync(path.join(process.cwd(), 'public', 'index.html'), 'utf8')
  const classic = fs.readFileSync(path.join(process.cwd(), 'public', 'classic.html'), 'utf8')
  const script = classic.match(/<script>([\s\S]*?)<\/script>/)?.[1]
  assert.ok(script, 'classic UI script missing')
  new Function(script)
  // The complete pre-change UI remains executable at /classic. Keep these
  // assertions unchanged so the fallback cannot silently become a placeholder.
  for (const required of ['run-plan', 'run-eyebrow', 'run-pause', 'run-resume', 'run-retry', 'run-complete', '回答完了', 'activity-details', '実際の差分を表示', '差分の続き', 'preview-frame', 'verification-list', '診断JSON', 'approval-meta', 'parentRunId', '/api/runs/', '/api/changes/', 'compositionstart', 'aria-live', 'mode-select', 'このPCで実行', 'Copilot内で観測', '@media (max-width: 720px)', 'demo-view', 'diagnostic-view', 'view-toggle', 'artifacts-panel', '過去の実行', 'friendlyToolName', '入力の反映に失敗したため、自動でやり直しています。']) assert.ok(classic.includes(required), `classic UI contract missing: ${required}`)

  const frontend = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'main.ts'), 'utf8')
  const styles = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'styles.css'), 'utf8')
  for (const required of ['lang="ja"', 'id="app"', '/assets/ui.js', '/assets/ui.css', '/classic']) assert.ok(html.includes(required), `default shell contract missing: ${required}`)
  for (const required of ['AssistantRuntimeProvider', 'useExternalStoreRuntime', 'useAui', 'aui.composer.setText', 'ThreadPrimitive', 'ComposerPrimitive', 'MessagePrimitive', 'approval-allow', 'approval-deny', 'approval-target', 'approval.binding?.path', 'approval.binding?.command', 'approval.question', '対象パス:', '実行内容:', '確認内容:', 'progress-panel', '/api/turn', '/api/approvals/resolve', 'list', 'read', 'search', 'write', 'open', '安全上限により停止しました']) assert.ok(frontend.includes(required), `default UI contract missing: ${required}`)
  for (const required of ['@media (max-width: 1100px)', '@media (max-width: 860px)', '@media (max-width: 640px)', 'prefers-reduced-motion', ':focus-visible']) assert.ok(styles.includes(required), `responsive/accessibility contract missing: ${required}`)
  const desktopGrid = styles.slice(styles.indexOf('@media (max-width: 1100px)'), styles.indexOf('@media (max-width: 860px)'))
  assert.ok(desktopGrid.includes('.task-paths { grid-template-columns: repeat(3, minmax(0, 1fr)); }'), '984px desktop task cards must use a three-column content grid')
  const mobileGrid = styles.slice(styles.indexOf('@media (max-width: 640px)'))
  assert.ok(mobileGrid.includes('.task-paths { grid-template-columns: repeat(2, minmax(0, 1fr)); }') && mobileGrid.includes('.task-path:last-child { grid-column: auto; }'), '640px mobile task cards must use a two-column grid without spanning')
  assert.ok(!/\buseChat\b/u.test(frontend), 'presentation UI must not use AI SDK useChat transport')
  assert.ok(!/\bexecute\s*:/u.test(frontend), 'presentation UI must not register an execution callback')
  assert.ok(!/tools\s*:\s*\{[^}]*execute/u.test(frontend), 'presentation UI must not attach tool execution callbacks')
  assert.ok(!frontend.includes('run.currentStep'), 'default RunSummary must not interpolate raw currentStep')
  assert.ok(frontend.includes("run.status === 'paused'") && frontend.includes("onAction('resume')"), 'paused runs must expose resume')
  assert.ok(!frontend.includes("run.status === 'failed' || run.status === 'canceled' || run.status === 'paused'"), 'paused runs must not expose retry')
  assert.ok(!/\.value\s*=/u.test(frontend), 'suggestions must use assistant-ui composer state, not DOM value assignment')
  assert.ok(!/dispatchEvent\(new Event\(['"]input['"]/u.test(frontend), 'suggestions must not synthesize DOM input events')
  let currentSession = 'session-a'
  const requestedSession = currentSession
  const staleResponse = await Promise.resolve({ sessionId: 'session-a' })
  currentSession = 'session-b'
  assert.strictEqual(isCurrentSessionRun(staleResponse, requestedSession, currentSession), false, 'an in-flight response must be rejected after a session switch')
  assert.strictEqual(isCurrentSessionRun({ sessionId: 'session-b' }, currentSession, currentSession), true, 'the current session run must remain eligible')
  assert.ok(frontend.includes('isCurrentSessionRun(response.activeRun, nextId, activeIdRef.current)'), 'session refresh must not display another session\'s active or recovered run')
  assert.ok(frontend.includes('isCurrentSessionRun(response.run, requestedSessionId, activeIdRef.current)'), 'active-run polling must reject a response that resolves after a session switch')
  assert.ok((frontend.match(/isCurrentSessionRun\(response\.run, requestedSessionId, activeIdRef\.current\)/gu) ?? []).length >= 3, 'default UI polling, actions, and turns must share the session response guard')
  assert.ok(frontend.includes("className: 'new-session', onClick: onNew, disabled: isRunning") && frontend.includes('onClick: () => onSelect(session.id), disabled: isRunning'), 'default UI must disable session changes during an active turn')
  assert.ok(classic.includes('isCurrentSessionRun(r&&r.run,requested,activeId)') && classic.includes('version!==sessionRequestVersion||activeId!==id'), 'classic UI must reject stale polling and session-load responses')
  assert.ok((classic.match(/isCurrentSessionRun\(r&&r\.(?:run|activeRun),requested,activeId\)/gu) ?? []).length >= 7, 'classic polling, turn, action, verify, cancel, and rollback responses must share the session guard')
  assert.ok(classic.includes("const created=await jpost('/api/sessions');if(!created||!created.id)return;await selectSession(created.id)") && classic.includes('message:text,mode,sessionId:requested'), 'classic new chat must adopt the created session id and send it explicitly with the turn')

  const server = fs.readFileSync(path.join(process.cwd(), 'src', 'server.ts'), 'utf8')
  for (const required of ["url.pathname === '/classic'", "'/assets/ui.js'", "'/assets/ui.css'", 'classicHtmlPath', 'uiAssets']) assert.ok(server.includes(required), `static route contract missing: ${required}`)
  assert.ok(server.indexOf("url.pathname === '/classic'") < server.indexOf("url.pathname === '/api/info'"), '/classic must be handled before API routes')
  assert.ok(server.includes('visibleRun?.sessionId === s.id ? runSnapshot(visibleRun) : null'), 'session API must not return another session\'s active or recovered run')
  console.log('PASS ui-contract (default + classic + presentation-only)')
}

async function testOpenAICompatibleBridge(): Promise<void> {
  const token = 'bridge-smoke-token-1234'
  const prompts: string[] = []
  const rawReplies = [
    'ストリーム回答',
    '通常回答です',
    `処理します。\n{'tool':'write_file','args':{'path':'メモ.txt','content':'確認'}}`,
    '{"tool":"write_file","args":{"path":3,"content":"不正"}}',
    '{"tool":"write_file","args":{"path":"禁止.txt","content":"x"}}',
    '関数を選べませんでした'
  ]
  const server = createOpenAICompatibleBridgeServer(token, {
    complete: async (prompt) => { prompts.push(prompt); return rawReplies.shift() ?? 'empty' },
    now: () => 1_700_000_000_000
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as net.AddressInfo).port
  const url = `http://127.0.0.1:${port}/v1/chat/completions`
  const post = (body: unknown, bearer = token) => fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
    body: JSON.stringify(body)
  })
  const tools: OpenAITool[] = [{
    type: 'function',
    function: {
      name: 'write_file',
      description: '新規ファイルを書く',
      parameters: {
        type: 'object', additionalProperties: false, required: ['path', 'content'],
        properties: { path: { type: 'string', minLength: 1 }, content: { type: 'string' } }
      }
    }
  }]
  try {
    const unauthorized = await post({ model: 'test', messages: [{ role: 'user', content: 'hi' }] }, 'wrong-token-12345678')
    assert.strictEqual(unauthorized.status, 401)
    const streaming = await post({ model: 'test', stream: true, messages: [{ role: 'user', content: 'hi' }] })
    assert.strictEqual(streaming.status, 200)
    assert.ok(streaming.headers.get('content-type')?.includes('text/event-stream'))
    const streamText = await streaming.text()
    assert.ok(streamText.includes('ストリーム回答') && streamText.includes('data: [DONE]'))

    const normal = await post({ model: 'bridge-test', messages: [{ role: 'system', content: '日本語で' }, { role: 'user', content: '答えて' }] })
    assert.strictEqual(normal.status, 200)
    const normalJson = await normal.json() as { choices: Array<{ message: { content: string }; finish_reason: string }> }
    assert.strictEqual(normalJson.choices[0].message.content, '通常回答です')
    assert.strictEqual(normalJson.choices[0].finish_reason, 'stop')
    assert.ok(prompts[1].includes('[1:SYSTEM]') && prompts[1].includes('[2:USER]'))

    const called = await post({ model: 'bridge-test', messages: [{ role: 'user', content: 'メモを書いて' }], tools })
    assert.strictEqual(called.status, 200)
    const calledJson = await called.json() as { choices: Array<{ message: { content: null; tool_calls: Array<{ function: { name: string; arguments: string } }> }; finish_reason: string }> }
    assert.strictEqual(calledJson.choices[0].finish_reason, 'tool_calls')
    assert.strictEqual(calledJson.choices[0].message.tool_calls[0].function.name, 'write_file')
    assert.deepStrictEqual(JSON.parse(calledJson.choices[0].message.tool_calls[0].function.arguments), { path: 'メモ.txt', content: '確認' })
    assert.ok(prompts[2].includes('AVAILABLE_FUNCTIONS=') && prompts[2].includes('write_file'))
    assert.ok(prompts[2].includes('「ここ」「この場所」「直下」') && prompts[2].includes(' . を使ってください'))
    assert.ok(prompts[2].includes('「開く」') && prompts[2].includes('既定アプリを起動'))
    assert.ok(prompts[2].includes("Start-Process -FilePath './相対パス'") && prompts[2].includes('-LiteralPath は使わず'))

    const rejected = await post({ model: 'bridge-test', messages: [{ role: 'user', content: '不正な引数' }], tools })
    const rejectedJson = await rejected.json() as { choices: Array<{ message: { content: string }; finish_reason: string }> }
    assert.strictEqual(rejectedJson.choices[0].finish_reason, 'stop')
    assert.strictEqual(rejectedJson.choices[0].message.content, '{"tool":"write_file","args":{"path":3,"content":"不正"}}')

    const toolChoiceNone = await post({ model: 'bridge-test', tool_choice: 'none', messages: [{ role: 'user', content: '関数を呼ばないで' }], tools })
    assert.strictEqual(toolChoiceNone.status, 200)
    const toolChoiceNoneJson = await toolChoiceNone.json() as { choices: Array<{ message: { content: string; tool_calls?: unknown } }> }
    assert.strictEqual(toolChoiceNoneJson.choices[0].message.tool_calls, undefined)
    assert.ok(toolChoiceNoneJson.choices[0].message.content.includes('write_file'))
    assert.ok(prompts[4].includes('関数を呼び出さず') && !prompts[4].includes('AVAILABLE_FUNCTIONS='))

    const toolChoiceRequired = await post({ model: 'bridge-test', tool_choice: 'required', messages: [{ role: 'user', content: '必ず選んで' }], tools })
    assert.strictEqual(toolChoiceRequired.status, 422)
    const unsupportedChoice = await post({ model: 'bridge-test', tool_choice: 'sometimes', messages: [{ role: 'user', content: '不正' }], tools })
    assert.strictEqual(unsupportedChoice.status, 422)

    const negative = interpretBridgeResponse('例: {"tool":"write_file","args":{"path":"推測.txt","content":"x"}} ですが今回は操作しません。', tools)
    assert.strictEqual(negative.toolCalls, undefined)
    const impossible = interpretBridgeResponse('write_file の実行は不可能です。{"tool":"write_file","args":{"path":"推測.txt","content":"x"}}', tools)
    assert.strictEqual(impossible.toolCalls, undefined)
    const informational = interpretBridgeResponse('write_file はファイルを書くツールです。', tools)
    assert.strictEqual(informational.toolCalls, undefined)
    const readTool: OpenAITool[] = [{ type: 'function', function: { name: 'read', parameters: { type: 'object', additionalProperties: false, required: ['filePath'], properties: { filePath: { type: 'string' } } } } }]
    const windowsPath = interpretBridgeResponse(String.raw`{"tool":"read","args":{"filePath":"C:\Users\yuuki\flex-live"}}`, readTool)
    assert.strictEqual(JSON.parse(String((windowsPath.toolCalls?.[0].function as { arguments?: string })?.arguments)).filePath, 'C:\\Users\\yuuki\\flex-live')
    assert.ok(windowsPath.repairs.includes('windows-path-backslash'))
    const bashTool: OpenAITool[] = [{ type: 'function', function: { name: 'bash', parameters: { type: 'object', additionalProperties: false, required: ['command'], properties: { command: { type: 'string' } } } } }]
    const relativeWindowsPath = interpretBridgeResponse(String.raw`{"tool":"bash","args":{"command":"Start-Process -FilePath '.\概要.txt'"}}`, bashTool)
    assert.strictEqual(JSON.parse(String((relativeWindowsPath.toolCalls?.[0].function as { arguments?: string })?.arguments)).command, "Start-Process -FilePath '.\\概要.txt'")
    assert.ok(relativeWindowsPath.repairs.includes('invalid-json-backslash'))
    const alreadyEscapedRelativePath = interpretBridgeResponse(String.raw`{"tool":"bash","args":{"command":"Start-Process -FilePath '.\\概要.txt'"}}`, bashTool)
    assert.strictEqual(JSON.parse(String((alreadyEscapedRelativePath.toolCalls?.[0].function as { arguments?: string })?.arguments)).command, "Start-Process -FilePath '.\\概要.txt'")
    assert.ok(!alreadyEscapedRelativePath.repairs.includes('invalid-json-backslash'))
    assert.ok(buildBridgePrompt({ messages: [{ role: 'user', content: [{ type: 'text', text: '配列本文' }] }], tools: [] }).includes('配列本文'))
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  assert.strictEqual(prompts.length, 6, 'unauthorized or invalid requests must not reach Copilot')

  let completeCalls = 0
  let abortedCalls = 0
  let releaseFirst: (() => void) | undefined
  const cancellationServer = createOpenAICompatibleBridgeServer(token, {
    complete: async (_prompt, signal) => {
      completeCalls++
      return new Promise<string>((resolve, reject) => {
        if (completeCalls === 1) releaseFirst = () => resolve('first done')
        signal?.addEventListener('abort', () => { abortedCalls++; reject(new Error('aborted by client')) }, { once: true })
      })
    }
  })
  await new Promise<void>((resolve) => cancellationServer.listen(0, '127.0.0.1', resolve))
  const cancellationPort = (cancellationServer.address() as net.AddressInfo).port
  const cancellationUrl = `http://127.0.0.1:${cancellationPort}/v1/chat/completions`
  const requestBody = JSON.stringify({ model: 'test', messages: [{ role: 'user', content: 'wait' }] })
  const first = fetch(cancellationUrl, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: requestBody })
  for (let poll = 0; poll < 50 && completeCalls === 0; poll++) await new Promise((resolve) => setTimeout(resolve, 10))
  assert.strictEqual(completeCalls, 1)
  const queuedAbort = new AbortController()
  const second = fetch(cancellationUrl, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: requestBody, signal: queuedAbort.signal }).catch((error) => error)
  await new Promise((resolve) => setTimeout(resolve, 30))
  queuedAbort.abort()
  await second
  await new Promise((resolve) => setTimeout(resolve, 150))
  releaseFirst?.()
  const firstResponse = await first
  assert.strictEqual(firstResponse.status, 200)
  await firstResponse.text()
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.strictEqual(completeCalls, 1, 'a canceled queued request must not reach Copilot')

  const activeAbort = new AbortController()
  const active = fetch(cancellationUrl, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: requestBody, signal: activeAbort.signal }).catch((error) => error)
  for (let poll = 0; poll < 50 && completeCalls < 2; poll++) await new Promise((resolve) => setTimeout(resolve, 10))
  activeAbort.abort()
  await active
  for (let poll = 0; poll < 50 && abortedCalls === 0; poll++) await new Promise((resolve) => setTimeout(resolve, 10))
  assert.strictEqual(abortedCalls, 1, 'response-side disconnect must abort active Copilot work')
  cancellationServer.abortAll()
  await new Promise<void>((resolve) => cancellationServer.close(() => resolve()))

  for (const relative of ['vendor/opencode/Get-OpenCode.ps1', 'vendor/opencode/manifest.json', 'vendor/opencode/LICENSE-OpenCode.txt']) {
    const bytes = fs.readFileSync(path.join(process.cwd(), relative))
    assert.deepStrictEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], `${relative} must use UTF-8 BOM`)
    assert.ok(!/(?<!\r)\n/u.test(bytes.subarray(3).toString('utf8')), `${relative} must use CRLF`)
  }
  console.log('PASS openai-compatible-bridge')
}

async function testDemoRecordingContract(): Promise<void> {
  const repoRoot = path.resolve(process.cwd(), '..', '..')
  const recorder = fs.readFileSync(path.join(repoRoot, 'demo', 'renketsu-demo', 'Record-Demo.ps1'), 'utf8')
  for (const required of [
    '/api/copilot/visible-session',
    "sessionId = $TargetSessionId",
    'Get-VisibleEdgeWindow -ProcessId',
    'Visible Copilot action log did not grow',
    'visibleSessionVerified',
    'visibleActivityVerified'
  ]) {
    assert.ok(recorder.includes(required), `Record-Demo visibility contract missing: ${required}`)
  }
  assert.ok(!recorder.includes('Sort-Object StartTime -Descending'), 'Record-Demo must not choose an unrelated newest Edge window')

  const motionGate = fs.readFileSync(path.join(repoRoot, 'demo', 'video', 'qa', 'Test-VideoMotion.ps1'), 'utf8')
  for (const required of ['SampleIntervalSec = 2', 'tblend=all_mode=difference', 'signalstats', 'MinimumMovingPairs', 'MinimumMovingRatio', 'MaximumStaticSec', 'crop=430:900:260:85']) {
    assert.ok(motionGate.includes(required), `video motion gate missing: ${required}`)
  }
  console.log('PASS demo-recording-contract')
}

(async () => {
  await testAuditLog()
  await testWeather()
  await testApprovals()
  await testTools()
  await testAgentLoop()
  await testV2SafeExecutionOrder()
  await testV2ToolLoopAndEventContract()
  await testV2HookDenialPropagation()
  await testV2PermissionActionsLastWins()
  await testV2PermissionNewVsOverwrite()
  await testV2PermissionOverwriteLastWins()
  await testV2PermissionOverwritePrecondition()
  await testV2MinAskProfileZeroApprovals()
  await testV2PermissionCommandPrefix()
  await testV2PermissionCommandConservative()
  await testV2PermissionHardGuardComposition()
  await testV2PermissionEmptyCompatibility()
  await testV2LimitsAndNoProgress()
  await testOllamaProvider()
  await testModelWaitAndExternalProvider()
  await testExternalStateIsolation()
  await testDenial()
  await testProtocolParsing()
  await testCopilotChoosesFirstAction()
  await testModeBoundaries()
  await testCopilotEdgeIsolation()
  await testCopilotVisibleSessionPidLifecycle()
  await testCopilotResponseCompletion()
  await testCopilotChunkFallback()
  await testCopilotLoop()
  await testCopilotToolResultBudgets()
  await testMaxIterationHistory()
  await testCopilotPlainMode()
  await testCopilotFenceMode()
  await testLocalResponseConverter()
  await testOpenAICompatibleBridge()
  await testUiContract()
  await testDemoRecordingContract()
  console.log('ALL PASS')
})().catch((err) => {
  console.error(err)
  process.exit(1)
})
