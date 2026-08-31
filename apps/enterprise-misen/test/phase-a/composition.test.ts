import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import { createUserMessage, LlmAdapter, ReasoningEffortId, ToolCallId } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelReasoningInfo,
  LlmResolvedModelInfo,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'

import {
  createPhaseAContext,
  PHASE_A_COMPONENTS,
  PHASE_A_FORBIDDEN_SERVICES,
} from '../../src/runtime/phase-a.js'

type ScriptEntry = (options: GenerateOptions) => readonly StreamChunk[]

function textResponse(text: string): readonly StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: text.length } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function toolCallResponse(
  rawCallId: string,
  name: string,
  args: object,
  text?: string,
): readonly StreamChunk[] {
  const callId = ToolCallId(rawCallId)
  const argumentsJson = JSON.stringify(args)
  const chunks: StreamChunk[] = []
  let index = 0
  if (text !== undefined) {
    chunks.push(
      { type: 'block-start', index, blockType: 'text' },
      { type: 'text-delta', index, text },
      { type: 'block-end', index, block: { type: 'text', text } },
    )
    index += 1
  }
  chunks.push(
    { type: 'block-start', index, blockType: 'tool-call' },
    {
      type: 'tool-call-delta',
      index,
      id: callId,
      name,
      argumentsDelta: argumentsJson,
    },
    {
      type: 'block-end',
      index,
      block: { type: 'tool-call', id: callId, name, arguments: argumentsJson },
    },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  )
  return chunks
}

/**
 * Test-only adapter. It implements DSH's public provider seam and never ships
 * as a production provider or replaces the Agent Loop.
 */
class DeterministicAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(
    private readonly providerName: string,
    private readonly script: ScriptEntry[],
  ) {
    super()
  }

  override providerInfo(provider: string) {
    return { id: provider, name: this.providerName }
  }

  override resolveModel(
    provider: string,
    model: string,
  ): Promise<LlmResolvedModelInfo> {
    const reasoning: LlmModelReasoningInfo = {
      efforts: [{ id: ReasoningEffortId('off'), name: 'Off' }],
      defaultEffort: ReasoningEffortId('off'),
    }
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      context: { contextWindow: 4096 },
      inputModalities: ['text'],
      reasoning,
    })
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(structuredClone(options))
    const entry = this.script.shift()
    if (entry === undefined) throw new Error('deterministic adapter script exhausted')
    for (const chunk of entry(options)) yield chunk
  }
}

function echoTool() {
  return defineTool({
    name: 'phase_a_echo',
    description: 'Echo one supplied value for deterministic Phase A verification.',
    parameters: {
      text: { type: 'string', required: true },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          echo: { type: 'string', required: true },
        },
      },
      render(_args, value) {
        return [{ type: 'text', text: value.echo }]
      },
    },
    execute(args) {
      return Promise.resolve({ echo: `ack:${args.text}` })
    },
  })
}

function sendAndWait(ctx: Awaited<ReturnType<typeof createPhaseAContext>>, agent: Agent, text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject !== agent || status !== 'idle' || settled) return
      settled = true
      dispose()
      resolve()
    })
    try {
      agent.followup(createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'user' },
      }))
    } catch (error) {
      settled = true
      dispose()
      reject(error)
    }
  })
}

test('Phase A mounts only the public DSH Agent Loop composition', async () => {
  const ctx = await createPhaseAContext({ persona: 'Phase A deterministic test.' })
  try {
    for (const service of ['llm', 'sessions', 'sessionProjections', 'systemPrompt', 'tools', 'agents', 'agentLoop']) {
      assert.ok(ctx.get(service), `expected ${service} service`)
    }
    for (const service of PHASE_A_FORBIDDEN_SERVICES) {
      assert.equal(ctx.get(service), undefined, `${service} must not be mounted`)
    }
    assert.deepEqual([...PHASE_A_COMPONENTS], [
      '@deepseek-ai/cordis@4.0.2',
      '@deepseek-ai/dsh-llm@0.1.2-alpha.2',
      '@deepseek-ai/dsh-session@0.1.2-alpha.2',
      '@deepseek-ai/dsh-session-projection@0.1.2-alpha.2',
      '@deepseek-ai/dsh-system-prompt@0.1.2-alpha.2',
      '@deepseek-ai/dsh-tools@0.1.2-alpha.2',
      '@deepseek-ai/dsh-agent@0.1.2-alpha.2',
      '@deepseek-ai/dsh-agent-loop@0.1.2-alpha.2',
    ])
    assert.deepEqual(ctx.tools.schemas(), [])
  } finally {
    await ctx.fiber.dispose()
  }
})

test('Phase A completes tool-call → result → next reasoning → final response', async () => {
  const ctx = await createPhaseAContext()
  const adapter = new DeterministicAdapter('deterministic-alpha', [
    () => toolCallResponse('call-1', 'phase_a_echo', { text: 'ping' }, 'calling tool'),
    () => textResponse('done after tool result'),
  ])
  const disposeAdapter = ctx.llm.registerAdapter(['deterministic-alpha'], adapter)
  const disposeTool = ctx.tools.register(echoTool())
  try {
    assert.deepEqual(ctx.tools.schemas().map(({ name }) => name), ['phase_a_echo'])
    const agent = ctx.agentLoop.create(SessionId('phase-a-tool-loop'), {
      provider: 'deterministic-alpha',
      model: 'phase-a-model',
    })

    await sendAndWait(ctx, agent, 'use the registered tool')

    assert.equal(adapter.requests.length, 2)
    assert.equal(adapter.requests[0]?.provider, 'deterministic-alpha')
    assert.equal(adapter.requests[0]?.model, 'phase-a-model')
    assert.deepEqual(adapter.requests[0]?.tools?.map(({ name }) => name), ['phase_a_echo'])

    const secondMessages = adapter.requests[1]?.messages ?? []
    const toolResult = secondMessages
      .flatMap(message => message.content)
      .find(block => block.type === 'tool-result')
    if (toolResult === undefined || toolResult.type !== 'tool-result') {
      throw new Error('expected a tool-result block in the second model request')
    }
    assert.equal(toolResult.toolCallId, ToolCallId('call-1'))
    assert.equal(toolResult.isError, false)
    assert.deepEqual(toolResult.content, [{ type: 'text', text: 'ack:ping' }])

    assert.ok(ctx.sessions.list().some(session => session.id === SessionId('phase-a-tool-loop')))
    const eventTypes = agent.session.events.map(event => event.type)
    assert.ok(eventTypes.includes('tool/call'))
    assert.ok(eventTypes.includes('tool/result'))
    const assistant = agent.session.events
      .filter(event => event.type === 'assistant/message')
      .at(-1)
    if (assistant === undefined || assistant.type !== 'assistant/message') {
      throw new Error('expected a final assistant message')
    }
    assert.deepEqual(assistant.data.message.content, [{ type: 'text', text: 'done after tool result' }])
  } finally {
    disposeTool()
    disposeAdapter()
    await ctx.fiber.dispose()
  }
})

test('Phase A keeps provider/model routing replaceable without changing the loop', async () => {
  const ctx = await createPhaseAContext()
  const alpha = new DeterministicAdapter('alpha', [() => textResponse('alpha response')])
  const beta = new DeterministicAdapter('beta', [() => textResponse('beta response')])
  const disposeAlpha = ctx.llm.registerAdapter(['provider-alpha'], alpha)
  const disposeBeta = ctx.llm.registerAdapter(['provider-beta'], beta)
  try {
    const first = ctx.agentLoop.create(SessionId('phase-a-provider-alpha'), {
      provider: 'provider-alpha',
      model: 'model-alpha',
    })
    await sendAndWait(ctx, first, 'alpha request')

    const second = ctx.agentLoop.create(SessionId('phase-a-provider-beta'), {
      provider: 'provider-beta',
      model: 'model-beta',
    })
    await sendAndWait(ctx, second, 'beta request')

    assert.equal(alpha.requests[0]?.provider, 'provider-alpha')
    assert.equal(alpha.requests[0]?.model, 'model-alpha')
    assert.equal(beta.requests[0]?.provider, 'provider-beta')
    assert.equal(beta.requests[0]?.model, 'model-beta')
  } finally {
    disposeBeta()
    disposeAlpha()
    await ctx.fiber.dispose()
  }
})
