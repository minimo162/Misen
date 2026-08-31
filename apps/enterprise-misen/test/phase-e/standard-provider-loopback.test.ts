import { strict as assert } from 'node:assert'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'

import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import type { Config as LlmPiAiConfig } from '@deepseek-ai/dsh-llm-pi-ai'
import * as LlmRetry from '@deepseek-ai/dsh-llm-retry'
import {
  createUserMessage,
  ReasoningEffortId,
} from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Context } from '@deepseek-ai/cordis'

import { createPhaseAContext } from '../../src/runtime/phase-a.js'

const LOOPBACK_KEY_ENV = 'MISEN_STANDARD_PROVIDER_LOOPBACK_KEY'
const LOOPBACK_MODEL = 'gpt-5.6-luna-loopback'

interface CapturedRequest {
  readonly index: number
  readonly authorizationPresent: boolean
  readonly body: Record<string, unknown>
}

interface LoopbackRequest {
  readonly index: number
  readonly body: Record<string, unknown>
  readonly request: IncomingMessage
}

type LoopbackHandler = (request: LoopbackRequest, response: ServerResponse<IncomingMessage>) => void | Promise<void>

interface LoopbackServer {
  readonly baseURL: string
  readonly requests: CapturedRequest[]
  readonly close: () => Promise<void>
}

interface RetryOptions {
  readonly enabled?: boolean
}

function providerConfig(baseURL: string, options: RetryOptions = {}): LlmPiAiConfig {
  return {
    providers: {
      loopback: {
        apiKeyEnv: LOOPBACK_KEY_ENV,
        api: 'openai-completions',
        baseURL,
        timeoutMs: 80,
        streamIdleTimeoutMs: 200,
        ...(options.enabled === true
          ? {
              retryPolicy: {
                mode: 'normal' as const,
                maxRetries: 1,
                retryableCodes: ['SERVER', 'TIMEOUT', 'TRANSPORT'],
                backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 },
              },
            }
          : {}),
        models: [{
          id: LOOPBACK_MODEL,
          name: 'GPT-5.6 Luna loopback',
          contextWindow: 4096,
          maxTokens: 256,
          input: ['text'],
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
}

async function startLoopbackServer(handler: LoopbackHandler): Promise<LoopbackServer> {
  const requests: CapturedRequest[] = []
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', chunk => chunks.push(Buffer.from(chunk)))
    request.on('error', () => undefined)
    request.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf8')
      let body: Record<string, unknown> = {}
      try {
        const parsed = JSON.parse(rawBody) as unknown
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          body = parsed as Record<string, unknown>
        }
      } catch {
        // The standard adapter will surface malformed provider payloads as a
        // stable transport/provider failure; the test deliberately retains no
        // raw body in logs.
      }
      const index = requests.length + 1
      requests.push({
        index,
        authorizationPresent: typeof request.headers.authorization === 'string',
        body,
      })
      void Promise.resolve(handler({ index, body, request }, response)).catch(() => {
        if (!response.headersSent) response.writeHead(500)
        response.end()
      })
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') {
    await new Promise<void>(resolve => server.close(() => resolve()))
    throw new Error('loopback server did not expose an address')
  }
  return {
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  }
}

function sendSse(response: ServerResponse<IncomingMessage>, payloads: readonly Record<string, unknown>[]): void {
  response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' })
  for (const payload of payloads) response.write(`data: ${JSON.stringify(payload)}\n\n`)
  response.write('data: [DONE]\n\n')
  response.end()
}

function textSse(text: string): readonly Record<string, unknown>[] {
  return [
    {
      id: 'loopback-response',
      object: 'chat.completion.chunk',
      created: 0,
      model: LOOPBACK_MODEL,
      choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }],
    },
    {
      id: 'loopback-response',
      object: 'chat.completion.chunk',
      created: 0,
      model: LOOPBACK_MODEL,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    },
  ]
}

function toolCallSse(name: string, argumentsText: string): readonly Record<string, unknown>[] {
  return [
    {
      id: 'loopback-tool-call',
      object: 'chat.completion.chunk',
      created: 0,
      model: LOOPBACK_MODEL,
      choices: [{
        index: 0,
        delta: {
          role: 'assistant',
          tool_calls: [{ index: 0, id: 'loopback-call', type: 'function', function: { name, arguments: argumentsText } }],
        },
        finish_reason: null,
      }],
    },
    {
      id: 'loopback-tool-call',
      object: 'chat.completion.chunk',
      created: 0,
      model: LOOPBACK_MODEL,
      choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
    },
  ]
}

function errorBody(message: string): string {
  // This body is intentionally generic; provider diagnostics must never carry
  // a credential or unredacted remote response into test output.
  return JSON.stringify({ error: { message } })
}

async function withProvider<T>(
  baseURL: string,
  callback: (ctx: Context) => Promise<T>,
  retry = false,
): Promise<T> {
  const previous = process.env[LOOPBACK_KEY_ENV]
  process.env[LOOPBACK_KEY_ENV] = 'loopback-test-secret'
  const ctx = await createPhaseAContext()
  try {
    await ctx.plugin(LlmPiAi, providerConfig(baseURL, { enabled: retry }))
    if (retry) await ctx.plugin(LlmRetry)
    return await callback(ctx)
  } finally {
    await ctx.fiber.dispose()
    if (previous === undefined) delete process.env[LOOPBACK_KEY_ENV]
    else process.env[LOOPBACK_KEY_ENV] = previous
  }
}

async function streamOnce(ctx: Context): Promise<readonly unknown[]> {
  const chunks: unknown[] = []
  for await (const chunk of ctx.llm.stream({
    provider: 'loopback',
    model: LOOPBACK_MODEL,
    messages: [createUserMessage({
      content: [{ type: 'text', text: 'loopback diagnostic' }],
      source: { kind: 'user' },
    })],
    reasoningEffort: ReasoningEffortId('off'),
    maxTokens: 32,
  })) chunks.push(chunk)
  return chunks
}

function finishReason(chunks: readonly unknown[]): Record<string, unknown> | undefined {
  const finish = [...chunks].reverse().find(chunk =>
    typeof chunk === 'object' && chunk !== null && (chunk as { type?: unknown }).type === 'finish')
  if (typeof finish !== 'object' || finish === null) return undefined
  const reason = (finish as { reason?: unknown }).reason
  return reason !== null && typeof reason === 'object' && !Array.isArray(reason)
    ? reason as Record<string, unknown>
    : undefined
}

test('standard provider maps a loopback 401 to AUTH without fallback', async () => {
  const server = await startLoopbackServer(async (_request, response) => {
    response.writeHead(401, { 'content-type': 'application/json' })
    response.end(errorBody('unauthorized'))
  })
  try {
    const chunks = await withProvider(server.baseURL, streamOnce)
    const reason = finishReason(chunks)
    assert.equal(reason?.kind, 'error')
    assert.equal((reason?.failure as Record<string, unknown> | undefined)?.code, 'AUTH')
    assert.equal(server.requests.length, 1)
    assert.equal(server.requests[0]?.authorizationPresent, true)
  } finally {
    await server.close()
  }
})

test('standard provider maps a loopback model 5xx to SERVER without fallback', async () => {
  const server = await startLoopbackServer(async (_request, response) => {
    response.writeHead(503, { 'content-type': 'application/json' })
    response.end(errorBody('server unavailable'))
  })
  try {
    const chunks = await withProvider(server.baseURL, streamOnce)
    const reason = finishReason(chunks)
    assert.equal(reason?.kind, 'error')
    assert.equal((reason?.failure as Record<string, unknown> | undefined)?.code, 'SERVER')
    assert.equal(server.requests.length, 1)
  } finally {
    await server.close()
  }
})

test('standard provider turns a loopback timeout into TIMEOUT without fallback', async () => {
  const server = await startLoopbackServer(async (_request, response) => {
    await delay(250)
    if (!response.writableEnded) response.end()
  })
  try {
    const chunks = await withProvider(server.baseURL, streamOnce)
    const reason = finishReason(chunks)
    assert.equal(reason?.kind, 'error')
    assert.equal((reason?.failure as Record<string, unknown> | undefined)?.code, 'TIMEOUT')
    assert.equal(server.requests.length, 1)
  } finally {
    await server.close()
  }
})

test('standard DSH retry plugin retries one transient SERVER failure and then completes', async () => {
  const server = await startLoopbackServer(async (request, response) => {
    if (request.index === 1) {
      response.writeHead(500, { 'content-type': 'application/json' })
      response.end(errorBody('temporary server failure'))
      return
    }
    sendSse(response, textSse('loopback success'))
  })
  try {
    await withProvider(server.baseURL, async ctx => {
      const agent = ctx.agentLoop.create(SessionId('loopback-retry'), {
        provider: 'loopback',
        model: LOOPBACK_MODEL,
      })
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: 'retry once' }],
        source: { kind: 'user' },
      }))
      await agent.whenIdle()
      const final = [...agent.session.events].reverse().find(event => event.type === 'assistant/message')
      assert.ok(final !== undefined, 'retry must produce a successful assistant message')
      if (final?.type === 'assistant/message') {
        assert.deepEqual(final.data.message.content, [{ type: 'text', text: 'loopback success' }])
      }
      assert.equal(server.requests.length, 2)
      assert.ok(agent.session.events.some(event => event.type === 'llm/retry'))
      assert.equal(agent.session.events.some(event => event.type === 'turn/end' && event.data.reason.kind === 'error'), false)
    }, true)
  } finally {
    await server.close()
  }
})

test('standard provider preserves malformed tool-call payload as a tool-call result, not an alternate Brain', async () => {
  const server = await startLoopbackServer(async (_request, response) => {
    sendSse(response, toolCallSse('unknown_tool', '{"unterminated"'))
  })
  try {
    const chunks = await withProvider(server.baseURL, streamOnce)
    const reason = finishReason(chunks)
    assert.equal(reason?.kind, 'tool-calls')
    const toolCall = [...chunks].find(chunk =>
      typeof chunk === 'object' && chunk !== null && (chunk as { type?: unknown }).type === 'block-end') as
      { block?: { type?: unknown; name?: string; arguments?: string } } | undefined
    assert.equal(toolCall?.block?.type, 'tool-call')
    assert.equal(toolCall?.block?.name, 'unknown_tool')
    // pi-ai/DSH keeps a malformed argument string on the standard provider
    // seam; Agent Loop validation, not a hidden fallback, owns the failure.
    assert.equal(typeof toolCall?.block?.arguments, 'string')
  } finally {
    await server.close()
  }
})

test('Agent Loop records an unknown or unnecessary tool call as an error and keeps the standard provider boundary', async () => {
  const server = await startLoopbackServer(async (request, response) => {
    if (request.index === 1) {
      sendSse(response, toolCallSse('unnecessary_tool', '{}'))
      return
    }
    sendSse(response, textSse('provider completed after tool error'))
  })
  try {
    await withProvider(server.baseURL, async ctx => {
      const agent = ctx.agentLoop.create(SessionId('loopback-unknown-tool'), {
        provider: 'loopback',
        model: LOOPBACK_MODEL,
      })
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: 'do not use unavailable tools' }],
        source: { kind: 'user' },
      }))
      await agent.whenIdle()
      const toolResult = agent.session.events.find(event => event.type === 'tool/result')
      assert.ok(toolResult !== undefined, 'unknown tool call must produce a durable tool result')
      if (toolResult?.type === 'tool/result') {
        const block = toolResult.data.message.content[0]
        assert.equal(block?.type, 'tool-result')
        if (block?.type === 'tool-result') assert.equal(block.isError, true)
      }
      const final = [...agent.session.events].reverse().find(event => event.type === 'assistant/message')
      assert.ok(final !== undefined, 'the provider response after the tool error must be durable')
      assert.equal(server.requests.length, 2)
    })
  } finally {
    await server.close()
  }
})

test('standard provider empty completed response yields EMPTY_RESPONSE and no assistant success', async () => {
  const server = await startLoopbackServer(async (_request, response) => {
    sendSse(response, [{
      id: 'loopback-empty',
      object: 'chat.completion.chunk',
      created: 0,
      model: LOOPBACK_MODEL,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    }])
  })
  try {
    const chunks = await withProvider(server.baseURL, streamOnce)
    const reason = finishReason(chunks)
    assert.equal(reason?.kind, 'error')
    assert.equal((reason?.failure as Record<string, unknown> | undefined)?.code, 'EMPTY_RESPONSE')
    assert.equal(chunks.some(chunk => typeof chunk === 'object' && chunk !== null && (chunk as { type?: unknown }).type === 'block-end'), false)
    assert.equal(server.requests.length, 1)
  } finally {
    await server.close()
  }
})
