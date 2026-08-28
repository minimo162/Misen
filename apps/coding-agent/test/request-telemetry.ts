import assert from 'node:assert/strict'
import {
  PRUNING_REASON_CATEGORIES,
  approximateToolResultContextBytes,
  approximateToolSchemaBytes,
  createRequestTelemetryCollector,
  createRequestTelemetryRecord,
  parseRequestTelemetryRecord,
  type RequestTelemetryGenerationPhase,
  type RequestTelemetryBeginInput,
  type RequestTelemetryToolDefinition,
  type RequestTelemetryToolResultContext
} from '../src/request-telemetry'

function beginInput(overrides: Partial<RequestTelemetryBeginInput> = {}): RequestTelemetryBeginInput {
  return {
    requestIndex: 2,
    runId: 'run-56-fixture',
    provider: 'fixture-provider',
    model: 'fixture-model',
    workingMessageCount: 4,
    exposedToolDefs: [
      { name: 'open_company', parameterNames: ['path'], parameterCount: 1 },
      { name: 'read_status', parameterNames: ['scope'], parameterCount: 1 }
    ],
    toolResultContext: [{ toolName: 'open_company', status: 'succeeded', resultChars: 42, metadataKeys: ['status', 'path'] }],
    pruning: {
      count: 3,
      reasons: { reasoning: 1, largeToolResults: 1, oldMessages: 1 }
    },
    ...overrides
  }
}

function testPersistenceRevalidation(): void {
  const record = createRequestTelemetryRecord({ ...beginInput(), elapsedMs: 12 }, { inputTokens: 3 })
  assert.deepEqual(parseRequestTelemetryRecord(JSON.parse(JSON.stringify(record))), record)
  assert.throws(() => parseRequestTelemetryRecord({ ...record, rawPrompt: 'do not persist' }), /unsafe key/u)
  assert.throws(() => parseRequestTelemetryRecord({ ...record, tokenUsage: { ...record.tokenUsage, content: 'raw result' } }), /unsafe key/u)
}

function testDeterministicRequestAndProviderUsage(): void {
  const ticks = [1000, 1125]
  const collector = createRequestTelemetryCollector({ now: () => ticks.shift() ?? 1125 })
  const request = collector.beginRequest(beginInput())
  const record = request.finish({ inputTokens: 42, outputTokens: 13, reasoningTokens: 5, cachedInputTokens: 7 })

  assert.equal(record.schemaVersion, 'misen.request-telemetry/v1')
  assert.equal(record.requestIndex, 2)
  assert.equal(record.runId, 'run-56-fixture')
  assert.equal(record.provider, 'fixture-provider')
  assert.equal(record.model, 'fixture-model')
  assert.equal(record.elapsedMs, 125)
  assert.deepEqual(record.tokenUsage, {
    inputTokens: 42,
    outputTokens: 13,
    reasoningTokens: 5,
    cachedInputTokens: 7
  })
  assert.equal(record.workingMessageCount, 4)
  assert.equal(record.exposedToolCount, 2)
  assert.equal(record.toolSchemaBytes, approximateToolSchemaBytes(beginInput().exposedToolDefs ?? []))
  assert.equal(record.toolResultContextBytes, approximateToolResultContextBytes(beginInput().toolResultContext ?? []))
  assert.deepEqual(record.pruning, {
    count: 3,
    reasons: {
      reasoning: 1,
      largeToolResults: 1,
      images: 0,
      oldImages: 0,
      oldMessages: 1,
      assistant: 0,
      toolPairs: 0,
      toolResults: 0,
      protocol: 0,
      base64: 0
    }
  })
  assert.deepEqual(collector.records(), [record])
  assert.throws(() => request.finish(), /finished twice/u)
}

function testUnknownTokensStayNull(): void {
  const record = createRequestTelemetryRecord({ ...beginInput({ exposedToolDefs: undefined, toolResultContext: undefined, pruning: undefined }), elapsedMs: 8 })
  assert.deepEqual(record.tokenUsage, {
    inputTokens: null,
    outputTokens: null,
    reasoningTokens: null,
    cachedInputTokens: null
  })
  assert.equal(record.toolSchemaBytes, null)
  assert.equal(record.toolResultContextBytes, null)
  assert.equal(record.exposedToolCount, 0)
}

function testGenerationPhaseAndRequestedCap(): void {
  const phase: RequestTelemetryGenerationPhase = 'work-read-tool'
  const record = createRequestTelemetryRecord({
    ...beginInput({ exposedToolDefs: [], toolResultContext: [], generationPhase: phase, requestedMaxOutputTokens: 256 }),
    elapsedMs: 2
  }, { outputTokens: 17 })
  assert.equal(record.generationPhase, 'work-read-tool')
  assert.equal(record.requestedMaxOutputTokens, 256)
  assert.equal(record.tokenUsage.outputTokens, 17)
  assert.notEqual(record.requestedMaxOutputTokens, record.tokenUsage.outputTokens)
  assert.throws(() => createRequestTelemetryRecord({ ...beginInput({ generationPhase: 'bad-phase' as RequestTelemetryGenerationPhase }), elapsedMs: 1 }), /generationPhase/u)
  for (const value of [-1, 1.5, '256']) {
    assert.throws(() => createRequestTelemetryRecord({ ...beginInput({ requestedMaxOutputTokens: value as number }), elapsedMs: 1 }), /requestedMaxOutputTokens/u)
  }
  const persisted = JSON.stringify(parseRequestTelemetryRecord(JSON.parse(JSON.stringify(record))))
  assert.ok(!persisted.includes('prompt') && !persisted.includes('raw') && !persisted.includes('secret'))
}

function testCallerComputedSizesAreAcceptedWithoutRetainingInputs(): void {
  const record = createRequestTelemetryRecord({
    ...beginInput({ exposedToolDefs: undefined, toolResultContext: undefined, toolSchemaBytes: 901, toolResultContextBytes: 73 }),
    elapsedMs: 3
  })
  assert.equal(record.toolSchemaBytes, 901)
  assert.equal(record.toolResultContextBytes, 73)
  assert.throws(() => createRequestTelemetryRecord({ ...beginInput({ toolSchemaBytes: -1 }), elapsedMs: 1 }), /toolSchemaBytes/u)
  assert.throws(() => createRequestTelemetryRecord({ ...beginInput({ toolResultContextBytes: Number.POSITIVE_INFINITY }), elapsedMs: 1 }), /toolResultContextBytes/u)
}

function testSizesAreDeterministicAndUtf8Aware(): void {
  const definitions: RequestTelemetryToolDefinition[] = [
    { name: '会社を開く', parameterNames: ['パス'], parameterCount: 1 }
  ]
  const context: RequestTelemetryToolResultContext[] = [
    { toolName: '会社を開く', status: 'failed', resultChars: 120, metadataKeys: ['状態'] }
  ]
  const schemaBytes = approximateToolSchemaBytes(definitions)
  const resultBytes = approximateToolResultContextBytes(context)
  assert.equal(schemaBytes, approximateToolSchemaBytes(definitions))
  assert.equal(resultBytes, approximateToolResultContextBytes(context))
  assert.ok(schemaBytes > JSON.stringify([{ name: '会社を開く', parameterNames: ['パス'], parameterCount: 1 }]).length)
  assert.ok(resultBytes > JSON.stringify([{ toolName: '会社を開く', status: 'failed', resultChars: 120, metadataKeys: ['状態'] }]).length)
}

function testPruningReasonsAndInputBounds(): void {
  assert.deepEqual(PRUNING_REASON_CATEGORIES, ['reasoning', 'largeToolResults', 'images', 'oldImages', 'oldMessages', 'assistant', 'toolPairs', 'toolResults', 'protocol', 'base64'])
  const extensible = createRequestTelemetryRecord({ ...beginInput({ pruning: { count: 2, reasons: { toolPairs: 1, protocol: 1 } } }), elapsedMs: 1 })
  assert.equal(extensible.pruning.reasons.toolPairs, 1)
  assert.equal(extensible.pruning.reasons.protocol, 1)
  assert.throws(() => createRequestTelemetryRecord({ ...beginInput({ pruning: { count: 1, reasons: { reasoning: 2 } } }), elapsedMs: 1 }), /sum of pruning/u)
  assert.throws(() => createRequestTelemetryRecord({ ...beginInput({ workingMessageCount: -1 }), elapsedMs: 1 }), /workingMessageCount/u)
  assert.throws(() => createRequestTelemetryRecord({ ...beginInput({ exposedToolCount: 1 }), elapsedMs: 1 }), /exposedToolCount/u)
}

function testUnsafeContentIsRejectedAndNeverRetained(): void {
  const unsafeCases: unknown[] = [
    { ...beginInput(), prompt: 'private request' },
    { ...beginInput(), exposedToolDefs: [{ name: 'read_status', description: 'raw prompt text' }] },
    { ...beginInput(), toolResultContext: [{ toolName: 'read_status', status: 'succeeded', content: 'private result' }] },
    { ...beginInput(), runId: 'data:image/png;base64,AAAA' },
    { ...beginInput(), model: 'sk-secret-value' },
    { ...beginInput(), provider: 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo0123456789' }
  ]
  for (const value of unsafeCases) {
    assert.throws(() => createRequestTelemetryRecord({ ...(value as RequestTelemetryBeginInput), elapsedMs: 1 }), /unsafe|forbidden|secret-like|bounded/u)
  }
  assert.throws(() => createRequestTelemetryRecord({ ...beginInput(), elapsedMs: 1 }, { inputTokens: 'prompt' } as unknown as { inputTokens: number }), /inputTokens/u)

  const definitions = [{ name: 'read_status', parameterNames: ['scope'] }]
  const contexts = [{ toolName: 'read_status', status: 'succeeded' as const, resultChars: 10 }]
  const input = beginInput({ exposedToolDefs: definitions, toolResultContext: contexts })
  const record = createRequestTelemetryRecord({ ...input, elapsedMs: 1 })
  definitions[0].name = 'mutated-after-start'
  contexts[0].resultChars = 99
  assert.equal(record.exposedToolCount, 1)
  assert.ok(!JSON.stringify(record).includes('mutated-after-start'))
  assert.ok(!JSON.stringify(record).includes('private'))
}

function testClockGoingBackwardsClampsElapsed(): void {
  const ticks = [50, 25]
  const request = createRequestTelemetryCollector({ now: () => ticks.shift() as number }).beginRequest(beginInput())
  assert.equal(request.finish().elapsedMs, 0)
}

testDeterministicRequestAndProviderUsage()
testPersistenceRevalidation()
testUnknownTokensStayNull()
testGenerationPhaseAndRequestedCap()
testCallerComputedSizesAreAcceptedWithoutRetainingInputs()
testSizesAreDeterministicAndUtf8Aware()
testPruningReasonsAndInputBounds()
testUnsafeContentIsRejectedAndNeverRetained()
testClockGoingBackwardsClampsElapsed()
console.log('PASS request-telemetry')
