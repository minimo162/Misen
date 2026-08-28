import assert from 'node:assert/strict'
import { buildModelWorkingContext, capToolResultForModel, type ModelMessageLike } from '../src/working-context'
import { formatHostResult } from '../src/agent'

const encoder = new TextEncoder()
const byteLength = (value: string): number => encoder.encode(value).byteLength

function testUtf8AndJsonCaps(): void {
  const utf8 = '前置き😀'.repeat(100)
  const capped = capToolResultForModel(utf8, { maxBytes: 256, chunkBytes: 128 })
  assert.equal(capped.truncated, true)
  assert.ok(byteLength(capped.content) <= 256)
  assert.match(capped.content, /tool-result-truncated/u)
  assert.ok(!capped.content.includes('\uFFFD'))
  assert.ok(capped.chunks.length > 1)
  assert.ok(capped.chunks.every((chunk) => byteLength(chunk) <= 128 && !chunk.includes('\uFFFD')))

  const source = JSON.stringify({
    status: 'succeeded', approved: true, precondition: 'unchanged',
    before_sha256: 'before', after_sha256: 'after', secretToken: 'do-not-copy',
    result: '観察結果'.repeat(300)
  })
  const json = capToolResultForModel(source, { maxBytes: 512 })
  assert.equal(json.format, 'json')
  assert.ok(byteLength(json.content) <= 512)
  const envelope = JSON.parse(json.content) as { summary?: { facts?: Record<string, unknown> } }
  assert.equal(envelope.summary?.facts?.status, 'succeeded')
  assert.equal(envelope.summary?.facts?.approved, true)
  assert.equal(envelope.summary?.facts?.precondition, 'unchanged')
  assert.equal(envelope.summary?.facts?.secretToken, undefined)
  console.log(`TOOL_RESULT_CAP_SUMMARY ${JSON.stringify({ originalBytes: json.originalBytes, retainedBytes: json.retainedBytes, omittedBytes: json.omittedBytes, format: json.format })}`)
}

function testAtomicProjectionAndCompleteHistory(): void {
  const history: ModelMessageLike[] = [
    { role: 'user', content: 'old request' },
    { role: 'assistant', content: 'old explanation' },
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'old', toolName: 'read_file', input: {} }] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'old', toolName: 'read_file', output: { type: 'text', value: 'old result' } }] },
    { role: 'assistant', content: [{ type: 'reasoning', text: 'private chain' }, { type: 'tool-call', toolCallId: 'current', toolName: 'read_file', input: {} }] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'current', toolName: 'read_file', output: { type: 'text', value: 'x'.repeat(8_000) } }] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'orphan', toolName: 'read_file', output: { type: 'text', value: 'orphan' } }] },
    { role: 'user', content: [{ type: 'text', text: 'current request' }, { type: 'image', image: 'base64-bytes' }] }
  ]
  const original = structuredClone(history)
  const result = buildModelWorkingContext(history, { keepRecentMessages: 1, keepRecentToolPairs: 1, maxToolResultBytes: 256 })
  assert.deepEqual(history, original, 'complete session history must not be mutated')
  const serialized = JSON.stringify(result.messages)
  assert.ok(serialized.includes('current request'))
  assert.ok(serialized.includes('current'))
  assert.ok(serialized.includes('old result'), 'complete prior tool facts must be retained without a semantic stale proof')
  assert.ok(!serialized.includes('orphan'))
  assert.ok(!serialized.includes('private chain'))
  assert.ok(!serialized.includes('base64-bytes'))
  assert.match(serialized, /tool-result-truncated/u)
  assert.equal(result.telemetry.dropped.toolPairs, 0)
  assert.equal(result.telemetry.dropped.orphanToolCalls, 0)
  assert.equal(result.telemetry.dropped.orphanToolResults, 1)
  assert.equal(result.telemetry.dropped.reasoning, 1)
  assert.equal(result.telemetry.dropped.images, 1)

  const calls = [...serialized.matchAll(/"toolCallId":"([^"]+)"/gu)].map((match) => match[1])
  assert.deepEqual(calls, ['old', 'old', 'current', 'current'], 'every retained tool call/result must remain paired')
  console.log(`WORKING_CONTEXT_SUMMARY ${JSON.stringify({ inputMessages: result.telemetry.inputMessages, outputMessages: result.telemetry.outputMessages, inputBytes: result.telemetry.inputBytes, outputBytes: result.telemetry.outputBytes, dropped: result.telemetry.dropped })}`)
}

function testAllToolPairsAreRetained(): void {
  const history: ModelMessageLike[] = [{ role: 'user', content: 'combine observations' }]
  for (let index = 1; index <= 4; index++) {
    history.push(
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: `call-${index}`, toolName: 'read_file', input: { index } }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: `call-${index}`, toolName: 'read_file', output: { type: 'text', value: `result-${index}` } }] }
    )
  }
  const result = buildModelWorkingContext(history, { keepRecentMessages: 1, keepRecentToolPairs: 3 })
  const serialized = JSON.stringify(result.messages)
  assert.ok(serialized.includes('call-1'), 'initial task observation must be retained')
  assert.ok(serialized.includes('call-2'), 'middle prerequisite facts must not be dropped by position')
  assert.ok(serialized.includes('call-3') && serialized.includes('call-4'), 'latest pairs must be retained')
  assert.equal(result.telemetry.dropped.toolPairs, 0)
}

function testHostResultEnvelopeRemainsParseableAfterCap(): void {
  const wrapped = formatHostResult('host.read_file', '結果😀'.repeat(4_000), { path: 'report.txt' }, 'succeeded', 'call-large', 'run-large')
  const result = buildModelWorkingContext([
    { role: 'user', content: 'read report.txt' },
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'call-large', toolName: 'read_file', input: { path: 'report.txt' } }] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'call-large', toolName: 'read_file', output: { type: 'text', value: wrapped } }] }
  ], { maxToolResultBytes: 4096 })
  const tool = result.messages.find((message) => message.role === 'tool')
  const part = (tool?.content as Array<Record<string, unknown>>)[0]
  const output = (part.output as { value: string }).value
  const begin = '[BEGIN_UNTRUSTED_HOST_RESULT]\n'
  const end = '\n[END_UNTRUSTED_HOST_RESULT]'
  assert.ok(output.startsWith(begin) && output.endsWith(end))
  assert.doesNotThrow(() => JSON.parse(output.slice(begin.length, -end.length)))
  assert.ok(byteLength(output) <= 4096)
  assert.match(output, /tool-result-truncated/u)
}

function testMixedOrphanPartsAreRemovedById(): void {
  const result = buildModelWorkingContext([
    { role: 'user', content: 'mixed protocol' },
    { role: 'assistant', content: [
      { type: 'tool-call', toolCallId: 'matched-call', toolName: 'read_file', input: {} },
      { type: 'tool-call', toolCallId: 'orphan-call', toolName: 'read_file', input: {} }
    ] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'matched-call', toolName: 'read_file', output: { type: 'text', value: 'matched result' } }] },
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'matched-result', toolName: 'read_file', input: {} }] },
    { role: 'tool', content: [
      { type: 'tool-result', toolCallId: 'matched-result', toolName: 'read_file', output: { type: 'text', value: 'second matched result' } },
      { type: 'tool-result', toolCallId: 'orphan-result', toolName: 'read_file', output: { type: 'text', value: 'must not leak into protocol' } }
    ] }
  ])
  const serialized = JSON.stringify(result.messages)
  const ids = [...serialized.matchAll(/"toolCallId":"([^"]+)"/gu)].map((match) => match[1])
  assert.deepEqual(ids, ['matched-call', 'matched-call', 'matched-result', 'matched-result'])
  assert.equal(result.telemetry.dropped.orphanToolCalls, 1)
  assert.equal(result.telemetry.dropped.orphanToolResults, 1)
  assert.ok(!serialized.includes('must not leak into protocol'))
}

testUtf8AndJsonCaps()
testAtomicProjectionAndCompleteHistory()
testAllToolPairsAreRetained()
testHostResultEnvelopeRemainsParseableAfterCap()
testMixedOrphanPartsAreRemovedById()
console.log('PASS working-context')
