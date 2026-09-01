import test from 'node:test'
import { strict as assert } from 'node:assert'
import { processEventsForRun, runIdFromMessage, shouldShowThinkingPlaceholder, type ToolEvent } from '../src/web/process.js'

test('process activity remains attached to its originating turn across sequential runs', () => {
  const tools: ToolEvent[] = [
    { id: 'call-1', runId: 'run-1', name: 'spreadsheet_read', status: 'success' },
    { id: 'call-2', runId: 'run-2', name: 'spreadsheet_update', status: 'success' },
  ]
  assert.deepEqual(processEventsForRun(tools, runIdFromMessage('assistant-run-1', 'assistant')).map(tool => tool.id), ['call-1'])
  assert.deepEqual(processEventsForRun(tools, runIdFromMessage('run-2', 'user')).map(tool => tool.id), ['call-2'])
  assert.deepEqual(processEventsForRun(tools, 'run-3'), [])
})

test('thinking placeholder is limited to the active run before visible activity', () => {
  const user = [{ id: 'run-1', role: 'user' as const, text: '依頼' }]
  assert.equal(shouldShowThinkingPlaceholder(user, [], true, 'run-1'), true)
  assert.equal(shouldShowThinkingPlaceholder(user, [{ id: 'call-1', runId: 'run-1', name: 'spreadsheet_read', status: 'running' }], true, 'run-1'), false)
  assert.equal(shouldShowThinkingPlaceholder([...user, { id: 'assistant-run-1', role: 'assistant', text: '回答' }], [], true, 'run-1'), false)
  assert.equal(shouldShowThinkingPlaceholder(user, [], false, 'run-1'), false)
  assert.equal(shouldShowThinkingPlaceholder(user, [], true, 'run-2'), false)
})
