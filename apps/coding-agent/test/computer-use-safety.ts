import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { executeV2ToolCall, runAgentTurnV2 } from '../src/agent-v2'
import type { AgentEvent, AgentIO } from '../src/agent'
import { AuditLog, auditRecordFromOutcome, type AuditEventLike } from '../src/audit-log'
import {
  createOpenCompanyTool,
  createSyntheticBusinessScreen,
  type SyntheticBusinessScreen
} from '../src/computer-use-demo'
import {
  SYNTHETIC_WORKSPACE_MARKER,
  SYNTHETIC_WORKSPACE_MARKER_EXPECTED,
  type AgentConfig
} from '../src/config'
import type { ToolContext } from '../src/tools'

const SECRET = 'ISSUE53_SECRET_MUST_NEVER_PERSIST'
const IMAGE_SENTINEL = 'ISSUE53_IMAGE_BYTES_MUST_NEVER_PERSIST'
const REASONING_SENTINEL = 'ISSUE53_REASONING_MUST_NEVER_PERSIST'

function context(workspace: string, flags: Partial<ToolContext> = {}): ToolContext {
  return { workspace, restrictToWorkspace: true, ...flags }
}

function config(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    provider: 'openai',
    agentLoop: 'v2',
    baseURL: 'http://127.0.0.1:1/v1',
    model: 'issue53-loopback',
    restrictToWorkspace: true,
    safeCommandOnly: true,
    maxToolIterations: 3,
    maxToolExecutions: 3,
    maxWriteExecutions: 3,
    maxCommandExecutions: 0,
    autoApprove: { write: false, command: false },
    permissions: [{ permission: 'open_company', pattern: '*', action: 'ask' }],
    ...overrides
  }
}

interface RecordedIO {
  io: AgentIO
  events: AgentEvent[]
  approvals: Array<{ question: string; approved: boolean; binding?: unknown }>
  prints: string[]
}

function makeIO(approved: boolean | ((question: string, binding: unknown) => boolean | Promise<boolean>)): RecordedIO {
  const events: AgentEvent[] = []
  const approvals: RecordedIO['approvals'] = []
  const prints: string[] = []
  const io: AgentIO = {
    print: (text) => prints.push(text),
    askYesNo: async (question, binding) => {
      const answer = typeof approved === 'function' ? await approved(question, binding) : approved
      approvals.push({ question, approved: answer, binding })
      return answer
    },
    event: (event) => events.push(event)
  }
  return { io, events, approvals, prints }
}

function eventTypes(events: readonly AgentEvent[]): string[] {
  return events.map((event) => event.type)
}

function targetId(screen: SyntheticBusinessScreen): string {
  return screen.targetCompanyId
}

function nonTargetId(screen: SyntheticBusinessScreen): string {
  const candidate = screen.snapshot().visibleCompanies.find((company) => company.id !== targetId(screen))
  assert.ok(candidate, 'fixture must contain a visible non-target company')
  return candidate.id
}

async function execute(
  screen: SyntheticBusinessScreen,
  io: AgentIO,
  input: unknown,
  options: {
    expectedFingerprint?: string
    cfg?: AgentConfig
    beforeHooks?: Parameters<typeof executeV2ToolCall>[5]
    callId?: string
  } = {}
) {
  const def = createOpenCompanyTool(screen, options.expectedFingerprint ?? screen.stateFingerprint())
  return executeV2ToolCall(
    { toolCallId: options.callId ?? 'issue53-open-company', toolName: 'open_company', input },
    def,
    options.cfg ?? config(),
    context(os.tmpdir()),
    io,
    options.beforeHooks ?? []
  )
}

async function testValidationAndHookOrder(): Promise<void> {
  const screen = createSyntheticBusinessScreen({ seed: 5301 })
  let hookCalls = 0
  const recorded = makeIO(true)
  const invalid = await execute(screen, recorded.io, { company_id: targetId(screen), extra: 'reject-me' }, {
    beforeHooks: [() => { hookCalls++ }]
  })
  assert.equal(invalid.status, 'failed')
  assert.equal(invalid.executed, false, 'schema failures must not execute ToolDef.run')
  assert.equal(hookCalls, 0, 'schema validation must precede hooks')
  assert.equal(recorded.approvals.length, 0, 'schema failures must not request approval')
  assert.equal(recorded.events.length, 0, 'schema failures must not create an audit event')

  let hookObservedByApproval = false
  const successful = makeIO((question) => {
    assert.match(question, /open_company|実行を許可/u)
    assert.equal(hookObservedByApproval, true, 'approval must follow every before-hook')
    return true
  })
  const approved = await execute(screen, successful.io, { company_id: targetId(screen) }, {
    beforeHooks: [({ tool, args }) => {
      assert.equal(tool, 'host.open_company')
      assert.equal(args.company_id, targetId(screen))
      hookObservedByApproval = true
    }],
    callId: 'issue53-order-success'
  })
  assert.equal(approved.status, 'succeeded')
  assert.equal(approved.executed, true)
  assert.equal(successful.approvals.length, 1)
  assert.equal(screen.isOpened, true)

  const types = eventTypes(successful.events)
  assert.ok(types.indexOf('tool.requested') >= 0)
  assert.ok(types.indexOf('approval.requested') > types.indexOf('tool.requested'))
  assert.ok(types.indexOf('approval.resolved') > types.indexOf('approval.requested'))
  assert.ok(types.indexOf('tool.started') > types.indexOf('approval.resolved'))
  assert.ok(types.indexOf('tool.succeeded') > types.indexOf('tool.started'))
  const terminal = successful.events.find((event) => event.type === 'tool.succeeded')
  assert.ok(terminal?.audit, 'terminal host event must carry redacted audit metadata')
  assert.equal(terminal?.audit?.arguments.sha256.length, 64)
}

async function testPermissionAndApprovalFailClosed(): Promise<void> {
  const denyScreen = createSyntheticBusinessScreen({ seed: 5302 })
  const deniedIO = makeIO(true)
  const denied = await execute(denyScreen, deniedIO.io, { company_id: targetId(denyScreen) }, {
    cfg: config({ permissions: [{ permission: 'open_company', pattern: '*', action: 'deny' }] }),
    callId: 'issue53-permission-denied'
  })
  assert.equal(denied.status, 'denied')
  assert.equal(denied.executed, false)
  assert.equal(deniedIO.approvals.length, 0, 'permission deny must precede approval')
  assert.equal(denyScreen.isOpened, false)
  assert.ok(deniedIO.events.some((event) => event.type === 'tool.denied'))

  const hookScreen = createSyntheticBusinessScreen({ seed: 5303 })
  const hookIO = makeIO(true)
  const hookDenied = await execute(hookScreen, hookIO.io, { company_id: targetId(hookScreen) }, {
    beforeHooks: [() => { throw new Error('issue53-hook-deny') }],
    callId: 'issue53-hook-denied'
  })
  assert.equal(hookDenied.status, 'denied')
  assert.equal(hookDenied.executed, false)
  assert.equal(hookIO.approvals.length, 0)
  assert.equal(hookScreen.isOpened, false)
  assert.ok(hookIO.events.find((event) => event.type === 'tool.denied')?.error?.includes('issue53-hook-deny'))

  const rejectScreen = createSyntheticBusinessScreen({ seed: 5304 })
  const rejectIO = makeIO(false)
  const rejected = await execute(rejectScreen, rejectIO.io, { company_id: targetId(rejectScreen) }, { callId: 'issue53-approval-rejected' })
  assert.equal(rejected.status, 'denied')
  assert.equal(rejected.executed, false)
  assert.equal(rejectIO.approvals.length, 1)
  assert.equal(rejectIO.approvals[0].approved, false)
  assert.equal(rejectScreen.isOpened, false, 'a rejected approval must not mutate the screen')
}

async function testPreconditionAndHardGuards(): Promise<void> {
  // A stale screenshot is changed between the approval callback and ToolDef.run.
  // The fake is structural only; no direct ToolDef.run call is made.
  let fingerprint = 'issue53-before'
  let opens = 0
  const fakeScreen = {
    stateFingerprint: () => fingerprint,
    openCompany: () => {
      opens++
      return { action: 'open_company', changed: true, companyId: 'co-amber-17', beforeRevision: 0, afterRevision: 1, route: '/computer-use-demo.html' }
    }
  } as unknown as SyntheticBusinessScreen
  const staleIO = makeIO(() => {
    fingerprint = 'issue53-after'
    return true
  })
  const stale = await execute(fakeScreen, staleIO.io, { company_id: 'co-amber-17' }, {
    expectedFingerprint: 'issue53-before',
    callId: 'issue53-stale-screen'
  })
  assert.equal(stale.status, 'failed')
  assert.equal(stale.executed, true, 'the host reached ToolDef.run, where the hard precondition guard failed')
  assert.equal(opens, 0, 'stale precondition must block the structured action')
  assert.match(stale.output, /画面状態が変わった|stale_screen/u)
  assert.ok(staleIO.events.some((event) => event.type === 'tool.failed'))

  const wrongScreen = createSyntheticBusinessScreen({ seed: 5305 })
  const wrongIO = makeIO(true)
  const wrong = await execute(wrongScreen, wrongIO.io, { company_id: nonTargetId(wrongScreen) }, { callId: 'issue53-wrong-target' })
  assert.equal(wrong.status, 'failed')
  assert.equal(wrong.executed, true)
  assert.equal(wrongScreen.isOpened, false)
  assert.match(wrong.output, /一致しません|wrong_target/u)

  const invisibleScreen = createSyntheticBusinessScreen({ seed: 5306 })
  const invisibleIO = makeIO(true)
  const invisible = await execute(invisibleScreen, invisibleIO.io, { company_id: 'co-not-visible-999' }, { callId: 'issue53-not-visible' })
  assert.equal(invisible.status, 'failed')
  assert.equal(invisible.executed, true)
  assert.equal(invisibleScreen.isOpened, false)
  assert.match(invisible.output, /表示されていません|company_not_visible/u)

  const duplicateScreen = createSyntheticBusinessScreen({ seed: 5307 })
  const firstIO = makeIO(true)
  const first = await execute(duplicateScreen, firstIO.io, { company_id: targetId(duplicateScreen) }, { callId: 'issue53-duplicate-first' })
  assert.equal(first.status, 'succeeded')
  const revision = duplicateScreen.currentRevision
  const secondIO = makeIO(true)
  const second = await execute(duplicateScreen, secondIO.io, { company_id: targetId(duplicateScreen) }, { callId: 'issue53-duplicate-second' })
  assert.equal(second.status, 'failed')
  assert.equal(second.executed, true)
  assert.equal(duplicateScreen.currentRevision, revision)
  assert.match(second.output, /既に実行済み|duplicate_action/u)
}

function writeSyntheticWorkspace(root: string): string {
  const workspace = path.join(root, 'synthetic')
  fs.mkdirSync(workspace, { recursive: true })
  fs.writeFileSync(path.join(workspace, SYNTHETIC_WORKSPACE_MARKER), JSON.stringify(SYNTHETIC_WORKSPACE_MARKER_EXPECTED), 'utf8')
  return workspace
}

async function testExternalBoundaryAndStateIsolation(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'misen-issue53-external-'))
  const configRoot = path.join(root, 'config')
  fs.mkdirSync(configRoot, { recursive: true })
  const synthetic = writeSyntheticWorkspace(configRoot)
  const outside = path.join(root, 'outside')
  fs.mkdirSync(outside, { recursive: true })
  // A provider-independent state-shaped file must not become a fallback for an
  // external turn. The boundary must stop before model construction/request.
  fs.writeFileSync(path.join(outside, 'state.json'), JSON.stringify({ messages: [{ content: SECRET }] }), 'utf8')
  const cfg = config({
    provider: 'external-openai',
    agentLoop: 'v2',
    baseURL: 'http://127.0.0.1:1/v1',
    model: 'external-synthetic',
    apiKeyEnv: 'ISSUE53_EXTERNAL_KEY',
    externalProvider: { enabled: true, syntheticWorkspace: 'synthetic' },
    configPath: path.join(configRoot, 'config.json')
  })
  const previous = process.env.ISSUE53_EXTERNAL_KEY
  process.env.ISSUE53_EXTERNAL_KEY = SECRET
  try {
    const outsideIO = makeIO(true)
    await assert.rejects(
      () => runAgentTurnV2({ cfg, messages: [{ role: 'user', content: SECRET }], userInput: '外部境界確認', ctx: context(outside), io: outsideIO.io }),
      /合成ワークスペース|外部AI/u
    )
    assert.ok(outsideIO.events.some((event) => event.type === 'run.warning' && event.metadata?.safetyBoundary === 'external-synthetic-workspace'))
    assert.equal(outsideIO.events.filter((event) => event.type === 'model.decision').length, 0)

    const flagIO = makeIO(true)
    await assert.rejects(
      () => runAgentTurnV2({ cfg: { ...cfg, restrictToWorkspace: false }, messages: [], userInput: '拒否', ctx: context(synthetic), io: flagIO.io }),
      /ワークスペース制限/u
    )
    await assert.rejects(
      () => runAgentTurnV2({ cfg: { ...cfg, safeCommandOnly: false }, messages: [], userInput: '拒否', ctx: context(synthetic), io: flagIO.io }),
      /安全なコマンド制限/u
    )
    await assert.rejects(
      () => runAgentTurnV2({ cfg: { ...cfg, apiKey: SECRET }, messages: [], userInput: '拒否', ctx: context(synthetic), io: flagIO.io }),
      /plaintext apiKey/u
    )
  } finally {
    if (previous === undefined) delete process.env.ISSUE53_EXTERNAL_KEY
    else process.env.ISSUE53_EXTERNAL_KEY = previous
    fs.rmSync(root, { recursive: true, force: true })
  }
}

interface MockRequest {
  body: Record<string, unknown>
  raw: string
  authorization: string | null
}

async function listenOllamaMock(
  response: (request: MockRequest, requestNumber: number) => Record<string, unknown>
): Promise<{ server: http.Server; url: string; requests: MockRequest[] }> {
  const requests: MockRequest[] = []
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      const body = JSON.parse(raw) as Record<string, unknown>
      const request: MockRequest = { body, raw, authorization: typeof req.headers.authorization === 'string' ? req.headers.authorization : null }
      requests.push(request)
      const payload = response(request, requests.length)
      res.statusCode = 200
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.end(JSON.stringify(payload))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  return { server, url: `http://127.0.0.1:${port}/v1`, requests }
}

function bodyContains(value: unknown, needle: string): boolean {
  return JSON.stringify(value).includes(needle)
}

async function testEphemeralImageReasoningAndAuditRedaction(): Promise<void> {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'misen-issue53-image-'))
  const screen = createSyntheticBusinessScreen({ seed: 5308 })
  const initial = screen.captureScreenshot()
  const imageBytes = new TextEncoder().encode(`${IMAGE_SENTINEL}:${Buffer.from(initial.bytes).toString('base64')}`)
  const recorded = makeIO(true)
  const mock = await listenOllamaMock((request, number) => {
    if (number === 1) {
      return {
        id: 'issue53-image-1', object: 'chat.completion', created: 0, model: 'issue53-ollama',
        choices: [{ index: 0, message: { role: 'assistant', content: '', tool_calls: [{ id: 'issue53-open-call', type: 'function', function: { name: 'open_company', arguments: JSON.stringify({ company_id: targetId(screen) }) } }] }, finish_reason: 'tool_calls' }],
        usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 }
      }
    }
    return {
      id: 'issue53-image-2', object: 'chat.completion', created: 0, model: 'issue53-ollama',
      choices: [{ index: 0, message: { role: 'assistant', content: 'Vision確認が完了しました', reasoning_content: REASONING_SENTINEL }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 }
    }
  })
  const beforeHooks: Array<string> = []
  try {
    const result = await runAgentTurnV2({
      cfg: config({ provider: 'ollama', baseURL: mock.url, model: 'issue53-ollama', reasoningEffort: 'high', permissions: [{ permission: 'open_company', pattern: '*', action: 'ask' }] }),
      messages: [],
      userInput: '画面の FOCUS 会社を開く',
      userContent: [
        { type: 'text', text: '画面の FOCUS 会社を開く' },
        { type: 'image', mediaType: 'image/png', image: imageBytes, estimatedVisualTokens: 256 }
      ],
      visualTokenBudget: 512,
      maxContextTokens: 4096,
      ctx: context(workspace),
      io: recorded.io,
      toolDefs: [createOpenCompanyTool(screen, initial.stateFingerprint)],
      beforeHooks: [({ tool }) => { beforeHooks.push(tool) }],
      afterToolObservation: async (observation) => {
        assert.equal(observation.toolName, 'open_company')
        assert.equal(observation.status, 'succeeded')
        const after = screen.captureScreenshot()
        return [
          { type: 'text', text: '操作後の画面を確認する' },
          { type: 'image', mediaType: after.mediaType, image: after.bytes, estimatedVisualTokens: 256 }
        ]
      }
    })
    assert.equal(result.aborted, false)
    assert.equal(result.reply, 'Vision確認が完了しました')
    assert.equal(screen.isOpened, true)
    assert.deepEqual(beforeHooks, ['host.open_company'])
    assert.equal(recorded.approvals.length, 1)

    // Session messages are the persisted contract. They may include safe text
    // and host-result summaries, but never image bytes/data-URIs/reasoning.
    const persisted = JSON.stringify({ messages: result.messages, events: recorded.events })
    assert.equal(persisted.includes(IMAGE_SENTINEL), false)
    assert.equal(persisted.includes(REASONING_SENTINEL), false)
    assert.equal(persisted.includes(SECRET), false)
    assert.equal(persisted.includes(Buffer.from(imageBytes).toString('base64')), false)
    assert.ok(recorded.events.every((event) => event.type !== 'model.decision' || !bodyContains(event.metadata, IMAGE_SENTINEL)))
    assert.ok(recorded.events.filter((event) => event.type === 'tool.succeeded').every((event) => !bodyContains(event, IMAGE_SENTINEL)))

    // The provider request is the only place where the image may be encoded.
    assert.equal(mock.requests.length, 2)
    assert.equal(mock.requests[0].authorization, null, 'Ollama loopback must not receive an API secret')
    assert.equal(mock.requests[0].raw.includes('image'), true)
    assert.equal(mock.requests[0].raw.includes(SECRET), false)
    assert.equal(mock.requests[1].raw.includes(SECRET), false)

    const terminal = recorded.events.find((event) => event.type === 'tool.succeeded')
    assert.ok(terminal)
    const history = recorded.events as unknown as AuditEventLike[]
    const audit = auditRecordFromOutcome({ sessionId: 'issue53-session', runId: 'issue53-run', event: terminal as unknown as AuditEventLike, history })
    assert.ok(audit)
    const auditDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'misen-issue53-audit-'))
    const auditLog = new AuditLog({ workspace, directory: auditDirectory })
    auditLog.initialize()
    auditLog.append(audit!)
    const auditText = fs.readFileSync(auditLog.filePath, 'utf8')
    assert.equal(auditText.includes(IMAGE_SENTINEL), false)
    assert.equal(auditText.includes(REASONING_SENTINEL), false)
    assert.equal(auditText.includes(SECRET), false)
    assert.equal(auditText.includes(Buffer.from(imageBytes).toString('base64')), false)
    auditLog.close()
    fs.rmSync(auditDirectory, { recursive: true, force: true })
  } finally {
    await new Promise<void>((resolve) => mock.server.close(() => resolve()))
    fs.rmSync(workspace, { recursive: true, force: true })
  }
}

async function main(): Promise<void> {
  await testValidationAndHookOrder()
  await testPermissionAndApprovalFailClosed()
  await testPreconditionAndHardGuards()
  await testExternalBoundaryAndStateIsolation()
  await testEphemeralImageReasoningAndAuditRedaction()
  console.log('COMPUTER_USE_SAFETY_SUMMARY chain=pass guards=pass boundary=pass ephemeral=pass audit=pass')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
