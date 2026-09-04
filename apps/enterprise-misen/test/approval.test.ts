import test from 'node:test'
import { strict as assert } from 'node:assert'
import { approvalHook, checkpointFor } from '../src/runtime/live.js'

test('checkpoint classification covers overwrite and element removal only', () => {
  assert.deepEqual(checkpointFor('office_create_output', { output: 'output/report.xlsx', overwrite: true }), { verb: '上書き', target: 'output/report.xlsx', risk: '中', reason: '既存ファイルの内容が置き換わります。' })
  assert.equal(checkpointFor('office_create_output', { output: 'output/new.xlsx' }), undefined)
  assert.equal(checkpointFor('office_set', { file: 'output/report.xlsx' }), undefined)
  assert.equal(checkpointFor('office_remove', { file: 'output/report.xlsx', path: '/slides/0' })?.verb, '削除')
  assert.equal(checkpointFor('office_batch', { file: 'output/report.xlsx', items: [{ command: 'remove', path: '/slides/0' }] })?.verb, '削除')
})

test('every-time mode waits for a decision and session-auto mode is session-local allow', async () => {
  const requested: string[] = []
  const rejected = approvalHook({ approvalMode: 'confirm', requestCheckpoint: async checkpoint => { requested.push(checkpoint.verb); return { approved: false } } })
  const result = await rejected.beforeTool!({ toolCall: { name: 'office_remove' }, args: { file: 'output/report.xlsx' } } as any)
  assert.equal(result?.block, true)
  assert.equal(result?.terminate, false)
  assert.deepEqual(requested, ['削除'])
  const approved = approvalHook({ approvalMode: 'confirm', requestCheckpoint: async () => ({ approved: true }) })
  assert.equal(await approved.beforeTool!({ toolCall: { name: 'office_remove' }, args: { file: 'output/report.xlsx' } } as any), undefined)
  const automatic = approvalHook({ approvalMode: 'session-auto' })
  assert.equal(await automatic.beforeTool!({ toolCall: { name: 'office_remove' }, args: { file: 'output/report.xlsx' } } as any), undefined)
})
