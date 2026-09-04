import test from 'node:test'
import { strict as assert } from 'node:assert'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'
import { withSessionReadCache } from '../src/capabilities/tool-cache.js'

function fixtureTool(name: string, calls: string[]): AgentTool<any> {
  return {
    name,
    label: name,
    description: name,
    parameters: Type.Object({}, { additionalProperties: true }),
    execute: async (_id, args) => {
      calls.push(`${name}:${JSON.stringify(args)}`)
      return { content: [{ type: 'text', text: name }], details: { name, sequence: calls.length } }
    },
  }
}

test('same read Tool and canonical arguments reuse the previous session result', async () => {
  const calls: string[] = []
  const [read] = withSessionReadCache([fixtureTool('workspace_read_text', calls)])
  const first = await read!.execute('one', { path: '業務.md', offset: 0 })
  const second = await read!.execute('two', { offset: 0, path: '業務.md' })
  assert.equal(calls.length, 1)
  assert.equal((first.details as any).cached, undefined)
  assert.equal((second.details as any).cached, true)
  assert.deepEqual(second.content, first.content)
})

test('a write execution invalidates all read entries and separate sessions share nothing', async () => {
  const calls: string[] = []
  const tools = withSessionReadCache([
    fixtureTool('workspace_list_files', calls),
    fixtureTool('spreadsheet_read', calls),
    fixtureTool('office_set', calls),
  ])
  const [list, sheet, write] = tools
  await list!.execute('list-1', {})
  await sheet!.execute('sheet-1', { workbook: 'Alpha.xlsx' })
  await list!.execute('list-2', {})
  await write!.execute('write', { file: 'output/report.xlsx' })
  await list!.execute('list-3', {})
  await sheet!.execute('sheet-2', { workbook: 'Alpha.xlsx' })
  assert.deepEqual(calls.map(call => call.split(':')[0]), ['workspace_list_files', 'spreadsheet_read', 'office_set', 'workspace_list_files', 'spreadsheet_read'])

  const [otherSession] = withSessionReadCache([fixtureTool('workspace_list_files', calls)])
  await otherSession!.execute('other', {})
  assert.equal(calls.at(-1)?.startsWith('workspace_list_files:'), true)
  assert.equal(calls.length, 6)
})

test('failed reads are not cached', async () => {
  let calls = 0
  const failing = fixtureTool('workspace_read_text', [])
  failing.execute = async () => { calls += 1; throw new Error('read failed') }
  const [read] = withSessionReadCache([failing])
  await assert.rejects(read!.execute('one', { path: 'missing.md' }))
  await assert.rejects(read!.execute('two', { path: 'missing.md' }))
  assert.equal(calls, 2)
})
