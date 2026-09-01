import test from 'node:test'
import { strict as assert } from 'node:assert'
import { processEventsForRun, runIdFromMessage, type ToolEvent } from '../src/web/process.js'

test('process activity remains attached to its originating turn across sequential runs', () => {
  const tools: ToolEvent[] = [
    { id: 'call-1', runId: 'run-1', name: 'spreadsheet_read', status: 'success' },
    { id: 'call-2', runId: 'run-2', name: 'spreadsheet_update', status: 'success' },
  ]
  assert.deepEqual(processEventsForRun(tools, runIdFromMessage('assistant-run-1', 'assistant')).map(tool => tool.id), ['call-1'])
  assert.deepEqual(processEventsForRun(tools, runIdFromMessage('run-2', 'user')).map(tool => tool.id), ['call-2'])
  assert.deepEqual(processEventsForRun(tools, 'run-3'), [])
})
