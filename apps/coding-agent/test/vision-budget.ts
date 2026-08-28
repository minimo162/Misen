import assert from 'node:assert/strict'
import {
  DEFAULT_MAX_CONTEXT_TOKENS,
  DEFAULT_RESERVED_VISUAL_TOKENS,
  DEFAULT_VISION_TOKEN_BUDGET,
  MINIMAL_ACTIVE_TOOL_ALLOWLIST,
  QWEN_VISION_FACTOR,
  activeToolAllowlist,
  estimateQwenVisualTokens,
  pruneWorkingContext,
  selectVisionBudget,
  type WorkingContextMessage
} from '../src/vision-budget'

function testVisionBudgetTiers(): void {
  const tiers = [512, 768, 1024] as const
  assert.equal(DEFAULT_VISION_TOKEN_BUDGET, 512)
  let previous = 0
  for (const tier of tiers) {
    const first = selectVisionBudget(3508, 2480, tier)
    const second = selectVisionBudget({ width: 3508, height: 2480, maxVisualTokens: tier })
    assert.deepStrictEqual(first, second, `budget ${tier} must be deterministic for positional/object calls`)
    assert.equal(first.maxVisualTokens, tier)
    assert.equal(first.visualTokenFactor, QWEN_VISION_FACTOR)
    assert.equal(first.estimationBasis, 'qwen-factor-32-grid-estimate')
    assert.equal(first.processorReported, false)
    assert.equal(first.width % QWEN_VISION_FACTOR, 0)
    assert.equal(first.height % QWEN_VISION_FACTOR, 0)
    assert.ok(first.estimatedVisualTokens <= tier)
    assert.equal(first.estimatedTokens, first.estimatedVisualTokens)
    assert.ok(first.estimatedVisualTokens >= previous)
    previous = first.estimatedVisualTokens
  }

  assert.equal(selectVisionBudget(1024, 1024, 513).maxVisualTokens, 768, 'intermediate request rounds to the next safe tier')
  assert.equal(selectVisionBudget(1024, 1024, 1).maxVisualTokens, 512)
  assert.throws(() => selectVisionBudget(1024, 1024, 1025), /exceeds the supported 4K budget/u)
  assert.throws(() => selectVisionBudget(0, 1024, 512), /width must be a positive safe integer/u)
  assert.throws(() => selectVisionBudget(1024, Number.MAX_SAFE_INTEGER, 512), /safe arithmetic range/u)
}

function testQwenEstimate(): void {
  assert.equal(estimateQwenVisualTokens(640, 320), 200)
  assert.equal(estimateQwenVisualTokens(641, 321), 231, 'arbitrary dimensions use conservative ceil grid arithmetic')
  assert.throws(() => estimateQwenVisualTokens(0, 320), /width must be a positive safe integer/u)
}

function testActiveToolAllowlist(): void {
  const tools = [
    { name: 'open_company', description: 'fixture opener' },
    { name: 'host.open_company', description: 'different qualified tool' },
    { name: 'run_command', description: 'not needed for vision' }
  ]
  assert.deepStrictEqual(activeToolAllowlist(tools), [tools[0]])
  assert.deepStrictEqual(activeToolAllowlist(tools, ['host.open_company']), [tools[1]])
  assert.deepStrictEqual(activeToolAllowlist(tools, []), [])
  assert.deepStrictEqual(MINIMAL_ACTIVE_TOOL_ALLOWLIST, ['open_company'])
}

function testContextPruning(): void {
  const giantResult = 'sensitive tool payload '.repeat(500)
  const imageData = `data:image/png;base64,${'A'.repeat(5000)}`
  const messages = [
    { role: 'user', content: 'old request that may be removed' },
    { role: 'assistant', kind: 'reasoning', content: 'private chain of thought that must not persist' },
    { role: 'assistant', content: `old screenshot context ${imageData}` },
    {
      role: 'tool',
      name: 'open_company',
      tool_call_id: 'call-open-1',
      content: giantResult,
      metadata: {
        status: 'succeeded',
        before_sha256: 'before-hash',
        after_sha256: 'after-hash',
        path: 'fixture.xlsx'
      }
    },
    {
      role: 'observation',
      kind: 'structured-observation',
      content: { observation: 'cell B3 has a red fill', image_url: imageData },
      metadata: { structuredObservation: true, relevant: true }
    },
    {
      role: 'event',
      kind: 'approval.resolved',
      content: 'approval retained for provenance',
      metadata: { approval: 'approved', approved: true, outcome: 'approved' }
    },
    {
      role: 'event',
      kind: 'precondition',
      content: 'target unchanged before execution',
      metadata: { precondition: 'unchanged', before_sha256: 'before-hash' }
    },
    { role: 'user', content: 'Open the company workbook and report the visible issue.' }
  ] as WorkingContextMessage[]

  const result = pruneWorkingContext(messages, {
    maxContextTokens: DEFAULT_MAX_CONTEXT_TOKENS,
    reservedVisualTokens: DEFAULT_RESERVED_VISUAL_TOKENS,
    keepRecentMessages: 1,
    maxToolResultChars: 100,
    ephemeralContent: [
      { type: 'text', text: 'ephemeral screenshot' },
      { type: 'image', mediaType: 'image/png', image: new Uint8Array([1, 2, 3]) }
    ]
  })
  assert.equal(result.withinBudget, true)
  assert.ok(result.estimatedContextTokens <= DEFAULT_MAX_CONTEXT_TOKENS)
  assert.equal(result.retained.latestUserRequest, true)
  assert.ok(result.retained.structuredObservations >= 1)
  assert.ok(result.retained.toolEssentials >= 1)
  assert.ok(result.retained.approvalEssentials >= 1)
  assert.ok(result.retained.preconditionEssentials >= 1)
  assert.ok(result.dropped.reasoning >= 1)
  assert.ok(result.dropped.largeToolResults >= 1)
  assert.ok(result.dropped.images >= 2)
  assert.ok(result.dropped.oldImages >= 2)
  assert.ok(result.messages.every((message) => !Object.prototype.hasOwnProperty.call(message, 'image_url')))
  assert.ok(result.messages.every((message) => !Object.prototype.hasOwnProperty.call(message, 'images')))
  const serialized = JSON.stringify(result.messages)
  assert.ok(!serialized.includes('data:image/'))
  assert.ok(!serialized.includes('A'.repeat(100)), 'image/base64 bytes must not survive pruning')
  assert.ok(!serialized.includes('sensitive tool payload '.repeat(20)), 'large tool result must not survive pruning')
  const latest = result.messages.find((message) => message.role === 'user' && message.content.includes('Open the company'))
  assert.ok(latest)
  const tool = result.messages.find((message) => message.role === 'tool')
  assert.equal(tool?.metadata?.before_sha256, 'before-hash')
  assert.equal(tool?.metadata?.after_sha256, 'after-hash')
  assert.equal(tool?.metadata?.path, 'fixture.xlsx')
  assert.equal(result.workingContext, result.messages)
}

function testContextFailFast(): void {
  assert.throws(() => pruneWorkingContext([{ role: 'user', content: 'request' }], { maxContextTokens: 4097 }), /maxContextTokens/u)
  assert.throws(() => pruneWorkingContext([{ role: 'user', content: 'request' }], { reservedVisualTokens: 2048 }), /supported 4K visual tier/u)
  assert.throws(() => pruneWorkingContext([{ role: 'user', content: 'request' }], { maxContextTokens: 8, reservedVisualTokens: 8 }), /required working-context state/u)
}

testVisionBudgetTiers()
testQwenEstimate()
testActiveToolAllowlist()
testContextPruning()
testContextFailFast()
console.log('PASS vision-budget')
