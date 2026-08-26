import crypto from 'node:crypto'
import http from 'node:http'
import { interpretCopilotResponseDeterministically, type ConverterToolDefinition } from './converter'

type JsonObject = Record<string, unknown>

export interface OpenAITool {
  type: 'function'
  function: {
    name: string
    description?: string
    parameters?: JsonObject
  }
}

export interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content?: unknown
  name?: string
  tool_call_id?: string
  tool_calls?: unknown
}

export interface OpenAIChatRequest {
  model?: string
  messages: OpenAIMessage[]
  tools?: OpenAITool[]
  tool_choice?: unknown
  stream?: boolean
}

export interface BridgeCompletionOptions {
  complete(prompt: string, signal?: AbortSignal): Promise<string>
  now?: () => number
}

const MAX_BODY_BYTES = 2 * 1024 * 1024
const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/u
const ANNOTATION_KEYWORDS = new Set(['description', 'title', 'default', 'examples', 'deprecated', 'readOnly', 'writeOnly', '$comment', '$schema', '$id', '$defs', 'definitions'])

function isObject(value: unknown): value is JsonObject {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function messageContent(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return ''
  if (!Array.isArray(value)) throw new Error('message.content は文字列またはtext part配列だけ対応しています')
  return value.map((part) => {
    if (!isObject(part) || part.type !== 'text' || typeof part.text !== 'string') {
      throw new Error('画像・音声などtext以外のmessage content partは未対応です')
    }
    return part.text
  }).join('\n')
}

function assertTools(value: unknown): OpenAITool[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 128) throw new Error('tools は128件以下の配列で指定してください')
  const seen = new Set<string>()
  return value.map((candidate) => {
    if (!isObject(candidate) || candidate.type !== 'function' || !isObject(candidate.function)) throw new Error('function tool以外は未対応です')
    const name = candidate.function.name
    if (typeof name !== 'string' || !TOOL_NAME.test(name)) throw new Error(`tool名が不正です: ${String(name ?? '')}`)
    if (seen.has(name)) throw new Error(`tool名が重複しています: ${name}`)
    seen.add(name)
    const description = candidate.function.description
    if (description !== undefined && typeof description !== 'string') throw new Error(`tool descriptionが不正です: ${name}`)
    const parameters = candidate.function.parameters ?? { type: 'object', properties: {} }
    if (!isObject(parameters)) throw new Error(`tool parametersが不正です: ${name}`)
    return { type: 'function', function: { name, description, parameters } }
  })
}

export function parseOpenAIChatRequest(value: unknown): OpenAIChatRequest {
  if (!isObject(value)) throw new Error('request bodyはJSON objectで指定してください')
  if (!Array.isArray(value.messages) || value.messages.length === 0 || value.messages.length > 200) throw new Error('messages は1〜200件で指定してください')
  const messages = value.messages.map((candidate) => {
    if (!isObject(candidate) || !['system', 'user', 'assistant', 'tool'].includes(String(candidate.role ?? ''))) throw new Error('message.roleが不正です')
    messageContent(candidate.content)
    return candidate as unknown as OpenAIMessage
  })
  const stream = value.stream
  if (stream !== undefined && typeof stream !== 'boolean') throw new Error('stream はbooleanで指定してください')
  return {
    model: typeof value.model === 'string' ? value.model : undefined,
    messages,
    tools: assertTools(value.tools),
    tool_choice: value.tool_choice,
    stream
  }
}

export function buildBridgePrompt(request: OpenAIChatRequest): string {
  const transcript = request.messages.map((message, index) => {
    const meta = [message.name ? `name=${message.name}` : '', message.tool_call_id ? `tool_call_id=${message.tool_call_id}` : ''].filter(Boolean).join(' ')
    const calls = message.tool_calls === undefined ? '' : `\ntool_calls=${JSON.stringify(message.tool_calls)}`
    return `[${index + 1}:${message.role.toUpperCase()}${meta ? ` ${meta}` : ''}]\n${messageContent(message.content)}${calls}`
  }).join('\n\n')
  if (!request.tools?.length) return [
    '以下の会話に対する次のassistant回答を生成してください。簡潔に答えてください。',
    transcript
  ].join('\n\n')

  const tools = request.tools.map((tool) => ({
    name: tool.function.name,
    description: tool.function.description ?? '',
    parameters: tool.function.parameters ?? { type: 'object', properties: {} }
  }))
  return [
    '以下の会話に対する次のassistantの1手だけを生成してください。',
    '利用可能な関数が必要なら、地の文を付けず JSON 1個だけを返してください: {"tool":"関数名","args":{...}}',
    '関数が不要なら通常の回答だけを返してください。値・パス・事実を推測しないでください。並列関数呼び出しはしません。',
    '利用者の「ここ」「この場所」「直下」はホストの現在の作業ディレクトリを指します。関数が相対パスを許す場合は、その基準を表す . を使ってください。',
    '利用者がファイルを「開く」と頼んだ場合は内容の読み取りで代用せず、利用可能なコマンド実行関数で既定アプリを起動する1手を選んでください。',
    '新規ファイルの親フォルダと名前が利用者の依頼から一意なら、親フォルダを検索せず、指定を相対パスへ忠実に組み立てて書き込み関数を呼んでください。',
    `AVAILABLE_FUNCTIONS=${JSON.stringify(tools)}`,
    transcript
  ].join('\n\n')
}

type ValidationResult = { ok: true } | { ok: false; error: string }

function matchesType(value: unknown, type: string): boolean {
  if (type === 'null') return value === null
  if (type === 'array') return Array.isArray(value)
  if (type === 'object') return isObject(value)
  if (type === 'integer') return typeof value === 'number' && Number.isSafeInteger(value)
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value)
  return typeof value === type
}

function validateSchema(value: unknown, schema: unknown, at = '$'): ValidationResult {
  if (schema === true || schema === undefined) return { ok: true }
  if (schema === false || !isObject(schema)) return { ok: false, error: `${at}: unsupported schema` }
  if ('$ref' in schema || 'patternProperties' in schema || 'not' in schema || 'if' in schema || 'then' in schema || 'else' in schema) {
    return { ok: false, error: `${at}: unsupported schema keyword` }
  }
  if (Array.isArray(schema.allOf)) {
    for (const item of schema.allOf) {
      const result = validateSchema(value, item, at)
      if (!result.ok) return result
    }
  }
  if (Array.isArray(schema.anyOf)) {
    const results = schema.anyOf.map((item) => validateSchema(value, item, at))
    if (!results.some((result) => result.ok)) return { ok: false, error: `${at}: anyOf mismatch` }
  }
  if (Array.isArray(schema.oneOf)) {
    if (schema.oneOf.filter((item) => validateSchema(value, item, at).ok).length !== 1) return { ok: false, error: `${at}: oneOf mismatch` }
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => JSON.stringify(item) === JSON.stringify(value))) return { ok: false, error: `${at}: enum mismatch` }
  if ('const' in schema && JSON.stringify(schema.const) !== JSON.stringify(value)) return { ok: false, error: `${at}: const mismatch` }
  const types = Array.isArray(schema.type) ? schema.type : (typeof schema.type === 'string' ? [schema.type] : [])
  if (types.length > 0 && !types.some((type) => typeof type === 'string' && matchesType(value, type))) return { ok: false, error: `${at}: type mismatch` }

  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) return { ok: false, error: `${at}: minLength` }
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) return { ok: false, error: `${at}: maxLength` }
    if (typeof schema.pattern === 'string') {
      try { if (!new RegExp(schema.pattern, 'u').test(value)) return { ok: false, error: `${at}: pattern` } } catch { return { ok: false, error: `${at}: invalid pattern` } }
    }
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) return { ok: false, error: `${at}: minimum` }
    if (typeof schema.maximum === 'number' && value > schema.maximum) return { ok: false, error: `${at}: maximum` }
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) return { ok: false, error: `${at}: minItems` }
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) return { ok: false, error: `${at}: maxItems` }
    if (schema.items !== undefined) {
      for (let index = 0; index < value.length; index++) {
        const result = validateSchema(value[index], schema.items, `${at}[${index}]`)
        if (!result.ok) return result
      }
    }
  }
  if (isObject(value)) {
    const properties = isObject(schema.properties) ? schema.properties : {}
    const required = Array.isArray(schema.required) ? schema.required : []
    for (const key of required) if (typeof key !== 'string' || !(key in value)) return { ok: false, error: `${at}: missing ${String(key)}` }
    for (const [key, item] of Object.entries(value)) {
      if (key in properties) {
        const result = validateSchema(item, properties[key], `${at}.${key}`)
        if (!result.ok) return result
      } else if (schema.additionalProperties === false) {
        return { ok: false, error: `${at}: additional property ${key}` }
      } else if (isObject(schema.additionalProperties)) {
        const result = validateSchema(item, schema.additionalProperties, `${at}.${key}`)
        if (!result.ok) return result
      }
    }
  }
  for (const key of Object.keys(schema)) {
    if (ANNOTATION_KEYWORDS.has(key)) continue
    if (!['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'allOf', 'anyOf', 'oneOf', 'minLength', 'maxLength', 'pattern', 'minimum', 'maximum', 'minItems', 'maxItems'].includes(key)) {
      return { ok: false, error: `${at}: unsupported schema keyword ${key}` }
    }
  }
  return { ok: true }
}

function converterTools(tools: OpenAITool[]): ConverterToolDefinition[] {
  return tools.map((tool) => ({
    name: `host.${tool.function.name}`,
    description: tool.function.description ?? '',
    parameters: tool.function.parameters ?? { type: 'object', properties: {} }
  }))
}

export function interpretBridgeResponse(raw: string, tools: OpenAITool[]): { content: string | null; toolCalls?: Array<JsonObject>; method: string; repairs: string[]; diagnostic?: string } {
  const deterministic = interpretCopilotResponseDeterministically(raw, converterTools(tools))
  if (!deterministic) return { content: raw, method: 'raw-fallback', repairs: [] }
  let decision: JsonObject
  try { decision = JSON.parse(deterministic.content) as JsonObject } catch { return { content: raw, method: 'raw-fallback', repairs: [] } }
  if (typeof decision.answer === 'string') return { content: decision.answer, method: deterministic.method, repairs: deterministic.repairs }
  if (typeof decision.tool !== 'string' || !isObject(decision.args)) return { content: raw, method: 'raw-fallback', repairs: [] }
  const externalName = decision.tool.startsWith('host.') ? decision.tool.slice(5) : decision.tool
  const matched = tools.find((tool) => tool.function.name === externalName)
  if (!matched) return { content: raw, method: 'raw-fallback', repairs: [] }
  const validation = validateSchema(decision.args, matched.function.parameters ?? { type: 'object', properties: {} })
  if (!validation.ok) return { content: raw, method: 'schema-rejected', repairs: deterministic.repairs, diagnostic: validation.error }
  return {
    content: null,
    toolCalls: [{
      id: `call_${crypto.randomBytes(12).toString('hex')}`,
      type: 'function',
      function: { name: externalName, arguments: JSON.stringify(decision.args) }
    }],
    method: deterministic.method,
    repairs: deterministic.repairs
  }
}

export async function completeOpenAIChat(request: OpenAIChatRequest, options: BridgeCompletionOptions, signal?: AbortSignal): Promise<JsonObject> {
  const raw = await options.complete(buildBridgePrompt(request), signal)
  const interpreted = interpretBridgeResponse(raw, request.tools ?? [])
  console.log('[bridge-decision] ' + JSON.stringify({
    interpretation: interpreted.method,
    repairs: interpreted.repairs,
    tool: interpreted.toolCalls?.[0]?.function && isObject(interpreted.toolCalls[0].function) ? interpreted.toolCalls[0].function.name : null,
    diagnostic: interpreted.diagnostic ?? null,
    toolCount: request.tools?.length ?? 0
  }))
  const created = Math.floor((options.now?.() ?? Date.now()) / 1000)
  const toolCalls = interpreted.toolCalls
  return {
    id: `chatcmpl_${crypto.randomBytes(12).toString('hex')}`,
    object: 'chat.completion',
    created,
    model: request.model ?? 'copilot-edge-layer1',
    choices: [{
      index: 0,
      message: toolCalls ? { role: 'assistant', content: null, tool_calls: toolCalls } : { role: 'assistant', content: interpreted.content ?? '' },
      finish_reason: toolCalls ? 'tool_calls' : 'stop'
    }],
    bridge: { interpretation: interpreted.method, repairs: interpreted.repairs }
  }
}

function authorized(header: string | undefined, token: string): boolean {
  const prefix = 'Bearer '
  if (!header?.startsWith(prefix)) return false
  const supplied = Buffer.from(header.slice(prefix.length), 'utf8')
  const expected = Buffer.from(token, 'utf8')
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected)
}

function sendJson(response: http.ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) })
  response.end(body)
}

function sendSingleChunkSse(response: http.ServerResponse, completion: JsonObject): void {
  const choices = Array.isArray(completion.choices) ? completion.choices : []
  const first = isObject(choices[0]) ? choices[0] : {}
  const message = isObject(first.message) ? first.message : {}
  const id = String(completion.id ?? `chatcmpl_${crypto.randomBytes(12).toString('hex')}`)
  const created = Number(completion.created ?? Math.floor(Date.now() / 1000))
  const model = String(completion.model ?? 'copilot-edge-layer1')
  const delta: JsonObject = { role: 'assistant' }
  if (Array.isArray(message.tool_calls)) delta.tool_calls = message.tool_calls.map((call, index) => ({ index, ...(isObject(call) ? call : {}) }))
  else delta.content = typeof message.content === 'string' ? message.content : ''
  const chunks = [
    { id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: null }] },
    { id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: {}, finish_reason: String(first.finish_reason ?? 'stop') }] }
  ]
  response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' })
  for (const chunk of chunks) response.write(`data: ${JSON.stringify(chunk)}\n\n`)
  response.end('data: [DONE]\n\n')
}

function openAIError(response: http.ServerResponse, status: number, message: string, code: string): void {
  sendJson(response, status, { error: { message, type: status >= 500 ? 'server_error' : 'invalid_request_error', param: null, code } })
}

async function readJsonBody(request: http.IncomingMessage): Promise<unknown> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new Error('request bodyが2MBを超えています')
    chunks.push(buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}

export function createOpenAICompatibleBridgeServer(token: string, options: BridgeCompletionOptions): http.Server {
  if (token.length < 16) throw new Error('COPILOT_BRIDGE_TOKEN は16文字以上で固定してください')
  let queue: Promise<void> = Promise.resolve()
  const schedule = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work)
    queue = next.then(() => undefined, () => undefined)
    return next
  }
  return http.createServer(async (request, response) => {
    if (!authorized(request.headers.authorization, token)) return openAIError(response, 401, 'Bearer tokenが不正です', 'invalid_api_key')
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') return openAIError(response, 404, 'POST /v1/chat/completions だけ対応しています', 'not_found')
    try {
      const parsed = parseOpenAIChatRequest(await readJsonBody(request))
      const controller = new AbortController()
      request.once('aborted', () => controller.abort())
      const result = await schedule(() => completeOpenAIChat(parsed, options, controller.signal))
      if (parsed.stream === true) sendSingleChunkSse(response, result)
      else sendJson(response, 200, result)
    } catch (error) {
      const message = error instanceof SyntaxError ? 'request bodyが正しいJSONではありません' : (error as Error).message
      openAIError(response, error instanceof SyntaxError ? 400 : 422, message, 'bridge_request_failed')
    }
  })
}
