import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import type { Config as LlmPiAiConfig } from '@deepseek-ai/dsh-llm-pi-ai'
import { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import {
  collectSpreadsheetUpdateDiagnostics,
  createLivePrompt,
  createLiveSessionId,
  runJulyMonthDiagnosis,
  runLiveAcceptance,
} from '../../acceptance/live-brain.js'
import { createPhaseAContext } from '../../src/runtime/phase-a.js'

const DIAGNOSTIC_CONFIG: LlmPiAiConfig = {
  providers: {
    'diagnostic-openai': {
      apiKeyEnv: 'MISEN_DIAGNOSTIC_MISSING_KEY',
      api: 'openai-responses',
      baseURL: 'https://example.invalid/v1',
      reasoning: 'off',
      models: [{
        id: 'gpt-5.6-luna',
        name: 'GPT-5.6 Luna (diagnostic)',
        contextWindow: 1_050_000,
        maxTokens: 128_000,
        input: ['text', 'image'],
        reasoningEfforts: {
          off: 'none',
          low: 'low',
          medium: 'medium',
          high: 'high',
          xhigh: 'xhigh',
          max: 'max',
        },
      }],
    },
  },
}

test('standard DSH provider mount resolves the configured model and off default', async () => {
  const ctx = await createPhaseAContext()
  try {
    await ctx.plugin(LlmPiAi, DIAGNOSTIC_CONFIG)
    const resolved = await ctx.llm.resolveModelInfo('diagnostic-openai', 'gpt-5.6-luna')
    assert.equal(resolved.provider, 'diagnostic-openai')
    assert.equal(resolved.id, 'gpt-5.6-luna')
    assert.equal(resolved.context?.contextWindow, 1_050_000)
    assert.deepEqual(resolved.reasoning?.efforts.map(effort => effort.id), [
      'off', 'low', 'medium', 'high', 'xhigh', 'max',
    ])
    assert.equal(resolved.reasoning?.defaultEffort, 'off')
  } finally {
    await ctx.fiber.dispose()
  }
})

test('standard DSH provider reports missing named credential before network fallback', async () => {
  const ctx = await createPhaseAContext()
  try {
    await ctx.plugin(LlmPiAi, DIAGNOSTIC_CONFIG)
    const chunks = []
    for await (const chunk of ctx.llm.stream({
      provider: 'diagnostic-openai',
      model: 'gpt-5.6-luna',
      messages: [createUserMessage({
        content: [{ type: 'text', text: 'diagnostic' }],
        source: { kind: 'user' },
      })],
      reasoningEffort: ReasoningEffortId('off'),
      maxTokens: 2,
    })) chunks.push(chunk)
    const finish = chunks.find(chunk => chunk.type === 'finish')
    assert.ok(finish !== undefined && finish.type === 'finish')
    assert.equal(finish.reason.kind, 'error')
    if (finish.reason.kind === 'error') assert.equal(finish.reason.failure.code, 'MISSING_CREDENTIAL')
  } finally {
    await ctx.fiber.dispose()
  }
})

test('live correlation ids remain HTTP-header-safe for localized month labels', () => {
  const july = String(createLiveSessionId('7月'))
  const august = String(createLiveSessionId('8月'))

  // pi-ai forwards SessionId as x-client-request-id.  Keep this deterministic
  // and transport-safe without exposing the localized business label itself.
  assert.match(july, /^enterprise-live-[0-9a-f]{16}$/u)
  assert.match(august, /^enterprise-live-[0-9a-f]{16}$/u)
  assert.doesNotMatch(july, /[^\x21-\x7e]/u)
  assert.doesNotMatch(august, /[^\x21-\x7e]/u)
  assert.doesNotMatch(july, /[\r\n]/u)
  assert.doesNotMatch(august, /[\r\n]/u)
  assert.notEqual(july, august)
})

test('live acceptance reports NOT RUN without a credential and does not fall back', async () => {
  const previous = process.env.OPENAI_API_KEY
  delete process.env.OPENAI_API_KEY
  try {
    const result = await runLiveAcceptance()
    assert.equal(result.status, 'NOT RUN')
    assert.equal(result.reason, 'OPENAI_API_KEY unavailable')
    assert.deepEqual(result.months, [])
  } finally {
    if (previous === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = previous
  }
})

test('Decision 428 July diagnosis reports NOT RUN without a credential and does not fall back', async () => {
  const previous = process.env.OPENAI_API_KEY
  delete process.env.OPENAI_API_KEY
  try {
    const result = await runJulyMonthDiagnosis()
    assert.equal(result.status, 'NOT RUN')
    assert.equal(result.reason, 'OPENAI_API_KEY unavailable')
    assert.equal(result.provider, 'openai')
    assert.equal(result.model, 'gpt-5.6-luna')
    assert.deepEqual(result.months, [])
  } finally {
    if (previous === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = previous
  }
})

test('Decision 428 observer correlates DSH tool results without retaining unrelated arguments', () => {
  const events = [
    {
      type: 'tool/call',
      data: { callId: 'call-1', name: 'workspace_list_files', arguments: '{"path":"."}' },
    },
    {
      type: 'tool/result',
      data: {
        message: {
          source: { kind: 'tool', callId: 'call-1' },
          content: [{ type: 'tool-result', toolCallId: 'call-1', content: [], isError: false }],
        },
      },
    },
    {
      type: 'tool/call',
      data: {
        callId: 'call-2',
        name: 'spreadsheet_update',
        arguments: '{"workbook":"output/report.xlsx","sheet":"Report","range":"B2:B2","values":[["2024年7月"]] }',
      },
    },
    {
      type: 'tool/result',
      data: {
        message: {
          source: { kind: 'tool', callId: 'call-2' },
          content: [{ type: 'tool-result', toolCallId: 'call-2', content: [], isError: false }],
        },
      },
    },
  ]

  assert.deepEqual(collectSpreadsheetUpdateDiagnostics(events), [{
    sequence: 2,
    workbook: 'output/report.xlsx',
    sheet: 'Report',
    range: 'B2:B2',
    values: [['2024年7月']],
    result: 'success',
  }])
})

test('live prompt remains the exact minimal Japanese request', () => {
  assert.equal(createLivePrompt('7月'), '7月の3社実績を取りまとめて、月次管理レポートを完成させて')
  assert.equal(createLivePrompt('8月'), '8月の3社実績を取りまとめて、月次管理レポートを完成させて')
})
