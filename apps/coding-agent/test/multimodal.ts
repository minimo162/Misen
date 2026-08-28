import assert from 'node:assert/strict'
import { runAgentTurnV2 } from '../src/agent-v2'
import { runConfiguredAgentTurn } from '../src/agent-loop'
import {
  normalizeAgentUserContent,
  type AgentUserContent
} from '../src/multimodal'
import type { LanguageModel } from 'ai'
import type { ToolContext, ToolDef } from '../src/tools'

const ctx: ToolContext = { workspace: process.cwd(), restrictToWorkspace: true }

function io() {
  return {
    print: () => {},
    askYesNo: async () => true
  }
}

function fakeModel(responses: Array<Record<string, unknown>>): { model: LanguageModel; requests: Array<Record<string, unknown>> } {
  const requests: Array<Record<string, unknown>> = []
  const model = {
    specificationVersion: 'v3' as const,
    provider: 'multimodal-test',
    modelId: 'multimodal-test',
    supportedUrls: {},
    doGenerate: async (options: Record<string, unknown>) => {
      requests.push(options)
      return {
        content: responses.shift()?.content ?? [{ type: 'text', text: 'ok' }],
        finishReason: { unified: 'stop' as const },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 }
        },
        warnings: []
      }
    },
    doStream: async () => { throw new Error('stream is not used in this test') }
  } as unknown as LanguageModel
  return { model, requests }
}

async function testContentContract(): Promise<void> {
  const source = new Uint8Array([0x53, 0x45, 0x43, 0x52, 0x45, 0x54])
  const normalized = normalizeAgentUserContent([
    { type: 'text', text: '画像' },
    { type: 'image', mediaType: 'image/png', image: source }
  ], '画像')
  assert.ok(Array.isArray(normalized))
  assert.notEqual((normalized[1] as { image: Uint8Array }).image, source)
  assert.deepEqual((normalized[1] as { image: Uint8Array }).image, source)
  assert.throws(() => normalizeAgentUserContent([{ type: 'image', mediaType: 'image/png', image: source }], '画像'), /テキスト/u)
  assert.throws(() => normalizeAgentUserContent([{ type: 'text', text: '画像' }, { type: 'image', mediaType: 'image/gif' as 'image/png', image: source }], '画像'), /PNG/u)
  assert.throws(() => normalizeAgentUserContent([{ type: 'text', text: '別' }, { type: 'image', mediaType: 'image/png', image: source }], '画像'), /一致しません/u)
  assert.throws(() => normalizeAgentUserContent([{ type: 'text', text: '画像' }, { type: 'image', mediaType: 'image/png', image: 'data:image/png;base64,AAAA' as unknown as Uint8Array }], '画像'), /bytes/u)
}

async function testImageBoundaryAndRedaction(): Promise<void> {
  const marker = new Uint8Array([0x53, 0x45, 0x43, 0x52, 0x45, 0x54, 0x2d, 0x49, 0x4d, 0x47])
  const userContent: AgentUserContent = [
    { type: 'text', text: '画像を確認' },
    { type: 'image', mediaType: 'image/png', image: marker }
  ]
  const fake = fakeModel([{ content: [{ type: 'text', text: '確認しました' }] }])
  const events: unknown[] = []
  const result = await runAgentTurnV2({
    cfg: { agentLoop: 'v2', provider: 'ollama', baseURL: '', model: '' },
    messages: [],
    userInput: '画像を確認',
    userContent,
    ctx,
    io: { ...io(), event: (event) => events.push(event) },
    model: fake.model
  })
  const prompt = fake.requests[0].prompt as Array<{ role: string; content: unknown }>
  const user = prompt.find((message) => message.role === 'user')
  assert.ok(Array.isArray(user?.content))
  const image = (user?.content as Array<{ type: string; data?: Uint8Array }>).find((part) => part.type === 'file')
  assert.ok(image && image.data instanceof Uint8Array)
  assert.deepEqual(image?.data, marker)
  assert.equal(result.messages.some((message) => JSON.stringify(message).includes('SECRET-IMG')), false)
  assert.equal(JSON.stringify(events).includes('SECRET-IMG'), false)
}

async function testScopedToolsAndObservation(): Promise<void> {
  const requests: string[] = []
  const openCompany: ToolDef = {
    name: 'open_company',
    description: 'Open a company',
    kind: 'read',
    parameters: { type: 'object', properties: {}, required: [] },
    run: async () => 'open_company succeeded'
  }
  const globalLike: ToolDef = {
    name: 'list_files',
    description: 'must not be exposed',
    kind: 'read',
    parameters: { type: 'object', properties: {}, required: [] },
    run: async () => 'not used'
  }
  const fake = fakeModel([
    { content: [{ type: 'tool-call', toolCallId: 'open-1', toolName: 'open_company', input: '{}' }] },
    { content: [{ type: 'text', text: '完了' }] }
  ])
  const result = await runAgentTurnV2({
    cfg: { agentLoop: 'v2', provider: 'ollama', baseURL: '', model: '' },
    messages: [],
    userInput: '会社を開いて',
    ctx,
    io: io(),
    model: fake.model,
    toolDefs: [openCompany],
    afterToolObservation: ({ toolName, status }) => {
      requests.push(`${toolName}:${status}`)
      return [
        { type: 'text', text: '画面を再確認' },
        { type: 'image', mediaType: 'image/png', image: new Uint8Array([1, 2, 3]) }
      ]
    }
  })
  assert.deepEqual(requests, ['open_company:succeeded'])
  const firstTools = fake.requests[0].tools as Array<{ name: string }>
  const secondTools = fake.requests[1].tools as Array<{ name: string }> | undefined
  assert.deepEqual(firstTools.map((tool) => tool.name), ['open_company'])
  assert.equal((secondTools ?? []).length, 0)
  const secondPrompt = fake.requests[1].prompt as Array<{ role: string; content: unknown }>
  assert.ok(secondPrompt.some((message) => message.role === 'user' && Array.isArray(message.content)))
  assert.equal(JSON.stringify(result.messages).includes('画面を再確認'), false)
  assert.equal(JSON.stringify(result.messages).includes('list_files'), false)
}

async function testV1ImageRejection(): Promise<void> {
  assert.throws(() => runConfiguredAgentTurn({
    cfg: { agentLoop: 'v1', provider: 'copilot-edge', baseURL: '', model: '' },
    messages: [],
    userInput: '画像を確認',
    userContent: [
      { type: 'text', text: '画像を確認' },
      { type: 'image', mediaType: 'image/png', image: new Uint8Array([1]) }
    ],
    ctx,
    io: io()
  }), /画像入力/u)
}

async function testImageRequiredToolFailsBeforeModel(): Promise<void> {
  let modelCalls = 0
  const imageRequired: ToolDef = {
    name: 'image_required', description: 'visual action', kind: 'write', requiresImage: true,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async run() { return 'unreachable' }
  }
  await assert.rejects(() => runAgentTurnV2({
    cfg: { agentLoop: 'v2', provider: 'ollama', baseURL: '', model: '' },
    messages: [], userInput: '画像なし', userContent: '画像なし', ctx, io: io(),
    toolDefs: [imageRequired],
    model: { specificationVersion: 'v3', provider: 'test', modelId: 'no-call', supportedUrls: {}, doGenerate: async () => { modelCalls++; throw new Error('must not run') } } as never
  }), /スクリーンショットなし/u)
  assert.equal(modelCalls, 0)
}

async function main(): Promise<void> {
  await testContentContract()
  await testImageBoundaryAndRedaction()
  await testScopedToolsAndObservation()
  await testV1ImageRejection()
  await testImageRequiredToolFailsBeforeModel()
  console.log('multimodal tests passed')
}

void main()
