import test from 'node:test'
import { strict as assert } from 'node:assert'
import { StaticLifecycleHooks, type LifecycleHook } from '../src/customization/hooks.js'
import { ENTERPRISE_TOOL_NAMES } from '../src/capabilities/tools.js'

const beforeContext = (name = 'workspace_read_text') => ({ toolCall: { name }, args: {}, assistantMessage: {}, context: {} } as any)
const afterContext = () => ({ ...beforeContext(), result: { content: [] }, isError: false } as any)

test('typed hooks run in deterministic static order on before and after paths', async () => {
  const events: string[] = []
  const hooks = new StaticLifecycleHooks([
    { name: 'one', beforeTool: () => { events.push('before-one') }, afterTool: () => { events.push('after-one') } },
    { name: 'two', beforeTool: () => { events.push('before-two') }, afterTool: () => { events.push('after-two') } },
  ])
  await hooks.prepareSession({ workspaceRoot: 'C:\\workspace', systemPrompt: 'safe', toolNames: ENTERPRISE_TOOL_NAMES })
  assert.equal(await hooks.beforeToolCall(beforeContext()), undefined)
  assert.equal(await hooks.afterToolCall(afterContext()), undefined)
  assert.deepEqual(events, ['before-one', 'before-two', 'after-one', 'after-two'])
})

test('registration snapshots hook objects instead of retaining a mutable plugin surface', async () => {
  const events: string[] = []
  const hook: LifecycleHook = { name: 'snapshot', beforeTool: () => { events.push('original') } }
  const hooks = new StaticLifecycleHooks([hook])
  ;(hook as any).beforeTool = () => { events.push('mutated') }
  await hooks.beforeToolCall(beforeContext())
  assert.deepEqual(events, ['original'])
})

test('capability authority and explicit denial fail closed', async () => {
  const hooks = new StaticLifecycleHooks([{ name: 'deny', beforeTool: () => ({ block: true, reason: 'denied' }) }])
  assert.deepEqual(await hooks.beforeToolCall(beforeContext('shell')), { block: true, reason: 'Misen policy validation failed.', terminate: true })
  assert.deepEqual(await hooks.beforeToolCall(beforeContext()), { block: true, reason: 'denied', terminate: true })
  await assert.rejects(hooks.prepareSession({ workspaceRoot: 'x', systemPrompt: 'x', toolNames: ['shell'] }))
})

test('hook exceptions and invalid results do not fail open or expose exception text', async () => {
  const throwing = new StaticLifecycleHooks([{ name: 'throws-secret', beforeTool: () => { throw new Error('SENTINEL_SECRET') } }])
  const before = await throwing.beforeToolCall(beforeContext())
  assert.deepEqual(before, { block: true, reason: 'Misen policy validation failed.', terminate: true })
  assert.ok(!JSON.stringify(before).includes('SENTINEL_SECRET'))
  const invalid: LifecycleHook = { name: 'invalid', afterTool: (() => ({ isError: 'no' })) as any }
  const after = await new StaticLifecycleHooks([invalid]).afterToolCall(afterContext())
  assert.equal(after?.isError, true)
  assert.equal(after?.terminate, true)
  assert.ok(!JSON.stringify(after).includes('SENTINEL_SECRET'))
  const session = new StaticLifecycleHooks([{ name: 'session-secret', prepareSession: () => { throw new Error('SENTINEL_SECRET') } }])
  await assert.rejects(
    session.prepareSession({ workspaceRoot: 'x', systemPrompt: 'x', toolNames: ENTERPRISE_TOOL_NAMES }),
    error => error instanceof Error && error.message === 'Misen policy validation failed.',
  )
})

test('after hooks merge bounded typed overrides', async () => {
  const hooks = new StaticLifecycleHooks([{ name: 'audit', afterTool: () => ({ details: { audit: 'checked' } }) }])
  assert.deepEqual(await hooks.afterToolCall(afterContext()), { details: { audit: 'checked' } })
})

test('hung hooks are bounded and fail closed', async () => {
  const hooks = new StaticLifecycleHooks([{ name: 'hung', beforeTool: () => new Promise(() => undefined) }])
  const started = Date.now()
  assert.deepEqual(await hooks.beforeToolCall(beforeContext()), { block: true, reason: 'Misen policy validation failed.', terminate: true })
  assert.ok(Date.now() - started >= 900)
  assert.ok(Date.now() - started < 2500)
})
