import test from 'node:test'
import { strict as assert } from 'node:assert'
import {
  applyServerEvent,
  dateGroupLabel,
  emptyThreadStore,
  failRun,
  RUN_FAILED_TEXT,
  RUN_INTERRUPTED_TEXT,
  startRun,
  threadListThreads,
  threadStoreFromSession,
  updatedTimeLabel,
  type SessionSnapshot,
  type ThreadStore,
} from '../src/web/thread-store.js'

const session = (overrides: Partial<SessionSnapshot> = {}): SessionSnapshot => ({
  id: 'session-a',
  title: '8月の利益状況を説明して',
  createdAt: '2026-09-04T00:00:00.000Z',
  updatedAt: '2026-09-04T00:01:00.000Z',
  status: 'COMPLETED',
  messages: [
    { id: 'run-1', role: 'user', text: '8月の利益状況を説明して', timestamp: '2026-09-04T00:00:00.000Z' },
    { id: 'assistant-run-1', role: 'assistant', text: '利益は改善しました。', timestamp: '2026-09-04T00:01:00.000Z' },
  ],
  tools: [
    { id: 'call-1', runId: 'run-1', name: 'spreadsheet_read', detail: 'Alpha.xlsx', status: 'success' },
    { id: 'call-other', runId: 'run-0', name: 'workspace_list_files', status: 'success' },
  ],
  artifacts: [
    { id: 'artifact-1', runId: 'run-1', filename: '8月_月次管理レポート.xlsx', available: true },
    { id: '', runId: 'run-0', filename: 'old.xlsx', available: false },
  ],
  ...overrides,
})

const parts = (store: ThreadStore, id: string) => {
  const message = store.messages.find(item => item.id === id)
  assert.ok(message, `message ${id}`)
  return message.content as readonly { type: string; toolCallId?: string; toolName?: string; result?: unknown; isError?: boolean; text?: string; args?: { detail?: string } }[]
}

const statusOf = (store: ThreadStore, id: string) => store.messages.find(item => item.id === id)?.status

test('persisted session projects Tool calls and artifacts onto its own assistant message', () => {
  const store = threadStoreFromSession(session())
  assert.equal(store.sessionId, 'session-a')
  assert.equal(store.status, 'COMPLETED')
  assert.deepEqual(store.messages.map(message => [message.id, message.role]), [['run-1', 'user'], ['assistant-run-1', 'assistant']])
  const assistant = parts(store, 'assistant-run-1')
  assert.deepEqual(assistant.map(part => part.type), ['tool-call', 'text'])
  assert.equal(assistant[0]?.toolCallId, 'call-1')
  assert.equal(assistant[0]?.result, 'success')
  assert.deepEqual(assistant[0]?.args, { detail: 'Alpha.xlsx' })
  assert.equal(assistant[1]?.text, '利益は改善しました。')
  const custom = store.messages[1]?.metadata?.custom as { runId: string; artifacts: { id: string }[] }
  assert.equal(custom.runId, 'run-1')
  assert.deepEqual(custom.artifacts.map(artifact => artifact.id), ['artifact-1'])
  assert.deepEqual(statusOf(store, 'assistant-run-1'), { type: 'complete', reason: 'stop' })
})

test('interrupted and failed sessions surface an error status on the last assistant message', () => {
  const interrupted = threadStoreFromSession(session({ status: 'RUNNING', messages: [{ id: 'run-1', role: 'user', text: '依頼' }] }))
  assert.equal(interrupted.status, 'FAIL')
  assert.deepEqual(statusOf(interrupted, 'assistant-run-1'), { type: 'incomplete', reason: 'error', error: RUN_INTERRUPTED_TEXT })
  const failed = threadStoreFromSession(session({ status: 'FAIL' }))
  assert.deepEqual(statusOf(failed, 'assistant-run-1'), { type: 'incomplete', reason: 'error', error: RUN_FAILED_TEXT })
  const fresh = threadStoreFromSession(session({ status: 'NEW', messages: [], tools: [], artifacts: [] }))
  assert.equal(fresh.status, 'idle')
  assert.equal(fresh.messages.length, 0)
})

test('a run starts optimistically and SSE events fold into the assistant placeholder in order', () => {
  let store = startRun(emptyThreadStore('session-a'), 'client-1', '依頼')
  assert.equal(store.status, 'running')
  assert.equal(store.messages[0]?.metadata?.isOptimistic, true)
  assert.deepEqual(statusOf(store, 'assistant-client-1'), { type: 'running' })

  store = applyServerEvent(store, { type: 'status', sessionId: 'session-a', status: 'running' })
  store = applyServerEvent(store, { type: 'user', sessionId: 'session-a', id: 'client-1', text: '依頼' })
  assert.equal(store.messages.length, 2, 'server confirmation reconciles the optimistic user turn')
  assert.equal(store.messages[0]?.metadata, undefined)

  store = applyServerEvent(store, { type: 'tool', phase: 'start', id: 'call-1', name: 'spreadsheet_read', detail: 'Alpha.xlsx' })
  store = applyServerEvent(store, { type: 'assistant', text: '確認中' })
  store = applyServerEvent(store, { type: 'tool', phase: 'start', id: 'call-2', name: 'spreadsheet_create_output', detail: 'report.xlsx' })
  store = applyServerEvent(store, { type: 'tool', phase: 'end', id: 'call-1', name: 'spreadsheet_read', status: 'success' })
  store = applyServerEvent(store, { type: 'tool', phase: 'end', id: 'call-2', name: 'spreadsheet_create_output', status: 'error' })
  store = applyServerEvent(store, { type: 'assistant', text: '最終回答', done: true })
  const assistant = parts(store, 'assistant-client-1')
  assert.deepEqual(assistant.map(part => part.type), ['tool-call', 'tool-call', 'text'], 'Tool calls stay ahead of the visible answer')
  assert.equal(assistant[0]?.result, 'success')
  assert.equal(assistant[1]?.result, 'error')
  assert.equal(assistant[1]?.isError, true)
  assert.equal(assistant[2]?.text, '最終回答')

  store = applyServerEvent(store, { type: 'state', state: { status: 'COMPLETED', runId: 'client-1', sessionId: 'session-a', artifacts: [{ id: 'artifact-1', runId: 'client-1', filename: 'report.xlsx', available: true }] } })
  store = applyServerEvent(store, { type: 'status', status: 'COMPLETED' })
  assert.equal(store.status, 'COMPLETED')
  assert.deepEqual(statusOf(store, 'assistant-client-1'), { type: 'complete', reason: 'stop' })
  const custom = store.messages[1]?.metadata?.custom as { artifacts: { id: string }[] }
  assert.deepEqual(custom.artifacts.map(artifact => artifact.id), ['artifact-1'])
})

test('failure and cancellation become assistant-ui incomplete statuses without raw details', () => {
  const failed = applyServerEvent(startRun(emptyThreadStore(), 'client-1', '依頼'), { type: 'status', status: 'FAIL', error: '処理に失敗しました。' })
  assert.deepEqual(statusOf(failed, 'assistant-client-1'), { type: 'incomplete', reason: 'error', error: '処理に失敗しました。' })
  const cancelled = applyServerEvent(startRun(emptyThreadStore(), 'client-2', '依頼'), { type: 'status', status: 'CANCELLED' })
  assert.deepEqual(statusOf(cancelled, 'assistant-client-2'), { type: 'incomplete', reason: 'cancelled' })
  const hostFailure = failRun(startRun(emptyThreadStore(), 'client-3', '依頼'), '依頼を開始できませんでした。')
  assert.equal(hostFailure.status, 'FAIL')
  assert.deepEqual(statusOf(hostFailure, 'assistant-client-3'), { type: 'incomplete', reason: 'error', error: '依頼を開始できませんでした。' })
})

test('plan, step progress, and checkpoint request-response events reduce into the active assistant card', () => {
  let store = startRun(emptyThreadStore('session-a'), 'client-plan', 'レポートを更新して')
  store = applyServerEvent(store, { type: 'plan', plan: { id: 'plan-1', title: '実行計画', steps: [{ id: 'review', title: '依頼内容と入力を確認', status: 'running' }, { id: 'work', title: '必要な作業を実行', status: 'pending' }] } })
  store = applyServerEvent(store, { type: 'step', planId: 'plan-1', stepId: 'review', status: 'completed' })
  store = applyServerEvent(store, { type: 'step', planId: 'plan-1', stepId: 'work', status: 'running' })
  store = applyServerEvent(store, { type: 'checkpoint_request', checkpoint: { id: 'checkpoint-1', verb: '上書き', target: 'output/report.xlsx', risk: '中', reason: '既存ファイルの内容が置き換わります。' } })
  let custom = store.messages[1]?.metadata?.custom as any
  assert.deepEqual(custom.plan.steps.map((step: any) => step.status), ['completed', 'running'])
  assert.deepEqual(custom.checkpoints[0], { id: 'checkpoint-1', verb: '上書き', target: 'output/report.xlsx', risk: '中', reason: '既存ファイルの内容が置き換わります。', status: 'pending' })
  store = applyServerEvent(store, { type: 'checkpoint_response', id: 'checkpoint-1', decision: 'approved', approveSimilar: true })
  custom = store.messages[1]?.metadata?.custom as any
  assert.equal(custom.checkpoints[0].status, 'approved')
  assert.equal(custom.checkpoints[0].approveSimilar, true)

  const reconnected = applyServerEvent(emptyThreadStore('session-a'), { type: 'state', state: { status: 'running', runId: 'client-plan', sessionId: 'session-a', artifacts: [], runUi: { runId: 'client-plan', plan: custom.plan, checkpoints: custom.checkpoints } } })
  const restored = reconnected.messages[0]?.metadata?.custom as any
  assert.equal(restored.plan.id, 'plan-1')
  assert.equal(restored.checkpoints[0].status, 'approved')
})

test('a reconnect during an active run restores the running placeholder from the state event', () => {
  let store = threadStoreFromSession(session({ status: 'RUNNING', messages: [{ id: 'run-1', role: 'user', text: '依頼' }], tools: [], artifacts: [] }))
  store = applyServerEvent(store, { type: 'state', state: { status: 'running', runId: 'run-1', sessionId: 'session-a', artifacts: [] } })
  assert.equal(store.status, 'running')
  assert.deepEqual(statusOf(store, 'assistant-run-1'), { type: 'running' })
  store = applyServerEvent(store, { type: 'user', id: 'run-1', text: '依頼' })
  assert.equal(store.messages.filter(message => message.role === 'user').length, 1)
})

test('thread list metadata carries date grouping so rows need no fetch of their own', () => {
  const now = new Date(2026, 8, 4, 12, 0, 0)
  const threads = threadListThreads([
    { id: 'a', title: '今日1', createdAt: '', updatedAt: new Date(2026, 8, 4, 9, 30).toISOString(), status: 'COMPLETED' },
    { id: 'b', title: '今日2', createdAt: '', updatedAt: new Date(2026, 8, 4, 8, 0).toISOString(), status: 'NEW' },
    { id: 'c', title: '昨日', createdAt: '', updatedAt: new Date(2026, 8, 3, 8, 0).toISOString(), status: 'FAIL' },
    { id: 'd', title: '先週', createdAt: '', updatedAt: new Date(2026, 7, 28, 8, 0).toISOString(), status: 'COMPLETED' },
  ], now)
  assert.deepEqual(threads.map(thread => [thread.id, thread.status, (thread.custom as { group: string }).group, (thread.custom as { showGroup: boolean }).showGroup]), [
    ['a', 'regular', '今日', true],
    ['b', 'regular', '今日', false],
    ['c', 'regular', '昨日', true],
    ['d', 'regular', '8/28', true],
  ])
  assert.equal(dateGroupLabel(new Date(2026, 8, 4, 9, 30).toISOString(), now), '今日')
  assert.equal(updatedTimeLabel(new Date(2026, 8, 4, 9, 5).toISOString(), now), '09:05')
  assert.equal(updatedTimeLabel(new Date(2026, 7, 28, 8, 0).toISOString(), now), '8/28')
})
