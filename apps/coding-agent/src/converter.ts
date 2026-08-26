import http from 'node:http'
import https from 'node:https'
import type { LocalResponseConverterSettings } from './config'

export interface ConverterToolDefinition { name: string; description: string; parameters: Record<string, unknown> }

function decisionSchema(tools: ConverterToolDefinition[]) {
  return {
    type: 'object',
    additionalProperties: false,
    oneOf: [
      { type: 'object', additionalProperties: false, required: ['answer'], properties: { answer: { type: 'string' } } },
      {
        type: 'object',
        additionalProperties: false,
        required: ['tool', 'args'],
        properties: {
          tool: { type: 'string', enum: tools.map((tool) => tool.name) },
          args: { type: 'object', additionalProperties: true }
        }
      }
    ]
  }
}

function compactParameters(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(compactParameters)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !['description', 'examples', 'default', 'title'].includes(key))
    .map(([key, item]) => [key, compactParameters(item)]))
}

function candidateTools(rawResponse: string, tools: ConverterToolDefinition[]): ConverterToolDefinition[] {
  const lower = rawResponse.toLowerCase()
  const mentioned = tools.filter((tool) => {
    const bare = tool.name.startsWith('host.') ? tool.name.slice(5) : tool.name
    return lower.includes(tool.name.toLowerCase()) || lower.includes(bare.toLowerCase())
  })
  return mentioned.length > 0 ? mentioned : tools
}

function strictProtocolFastPath(rawResponse: string, tools: ConverterToolDefinition[]): string | null {
  try {
    const parsed = JSON.parse(rawResponse.trim()) as Record<string, unknown>
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    if (typeof parsed.answer === 'string' && Object.keys(parsed).every((key) => ['answer', 'AGENT_END'].includes(key))) {
      return JSON.stringify({ answer: parsed.answer })
    }
    if (typeof parsed.tool !== 'string') return null
    const requested = parsed.tool.startsWith('host.') ? parsed.tool : `host.${parsed.tool}`
    const matched = tools.find((tool) => tool.name === requested)
    if (!matched) return null
    const args = parsed.args && typeof parsed.args === 'object' && !Array.isArray(parsed.args)
      ? parsed.args
      : Object.fromEntries(Object.entries(parsed).filter(([key]) => !['tool', 'AGENT_END'].includes(key)))
    return JSON.stringify({ tool: matched.name, args })
  } catch {
    return null
  }
}

function loopbackUrl(value: string): URL {
  const url = new URL(value)
  const host = url.hostname.toLowerCase()
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !['127.0.0.1', '::1', 'localhost'].includes(host)) {
    throw new Error('localResponseConverter.baseURL は loopback HTTP(S) URL だけ指定できます')
  }
  return url
}

function endpoint(baseURL: string): URL {
  const base = loopbackUrl(baseURL)
  return new URL(base.pathname.endsWith('/') ? 'chat/completions' : `${base.pathname}/chat/completions`, base)
}

/**
 * Converts an observed Copilot reply into the already-existing host protocol.
 * This is deliberately advisory: callers must parse and validate the returned
 * text exactly as if it came from Copilot, and fall back on every failure.
 */
export async function convertCopilotResponse(
  settings: LocalResponseConverterSettings | undefined,
  rawResponse: string,
  tools: ConverterToolDefinition[],
  signal?: AbortSignal
): Promise<string | null> {
  if (settings?.enabled !== true) return null
  const baseURL = settings.baseURL ?? 'http://127.0.0.1:8080/v1'
  const url = endpoint(baseURL)
  const direct = strictProtocolFastPath(rawResponse, tools)
  if (direct) return direct
  const timeoutMs = Math.max(250, Math.min(60_000, Math.floor(settings.timeoutMs ?? 30000)))
  const activeTools = candidateTools(rawResponse, tools)
  const body = JSON.stringify({
    model: settings.model ?? 'Qwen3.5-4B-Q4_K_M.gguf',
    temperature: 0,
    max_tokens: 192,
    stream: false,
    // llama.cpp accepts OpenAI's response_format JSON schema and disables
    // free-form "thinking" through the Qwen chat-template flag.
    response_format: { type: 'json_schema', json_schema: { name: 'host_decision', strict: true, schema: decisionSchema(activeTools) } },
    chat_template_kwargs: { enable_thinking: false },
    messages: [
      {
        role: 'system',
        content: [
          'Copilotの生応答を、許可済みhost操作またはanswerへ変換する。JSONだけを返す。',
          'raw_responseに明示されたtool、path、paths、pattern、glob、query、content、commandだけを忠実に移す。',
          '値やファイル名を推測・補完・置換せず、host_toolsの例示値も使わない。',
          'tool名にhost.がなければ付け、トップレベルの引数はargsへ移す。',
          '操作と引数を特定できない自然文は、raw_response全文をanswerにする。'
        ].join('\n')
      },
      {
        role: 'user',
        content: JSON.stringify({
          raw_response: rawResponse,
          host_tools: activeTools.map((tool) => ({ name: tool.name, parameters: compactParameters(tool.parameters) }))
        })
      }
    ]
  })
  const headers: Record<string, string | number> = { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }
  if (settings.apiKey) headers.authorization = `Bearer ${settings.apiKey}`
  return await new Promise<string>((resolve, reject) => {
    const request = (url.protocol === 'https:' ? https.request : http.request)(url, {
      method: 'POST', headers, timeout: timeoutMs
    }, (response) => {
      let text = ''
      response.setEncoding('utf8')
      response.on('data', (chunk: string) => { text += chunk })
      response.on('end', () => {
        if ((response.statusCode ?? 500) < 200 || (response.statusCode ?? 500) >= 300) return reject(new Error(`converter HTTP ${response.statusCode ?? 0}`))
        try {
          const parsed = JSON.parse(text) as { choices?: Array<{ message?: { content?: unknown } }> }
          const content = parsed.choices?.[0]?.message?.content
          if (typeof content !== 'string' || !content.trim()) throw new Error('converter response content がありません')
          resolve(content)
        } catch (error) { reject(error) }
      })
    })
    request.once('timeout', () => request.destroy(new Error(`converter timeout (${timeoutMs}ms)`)))
    request.once('error', reject)
    const abort = () => request.destroy(new Error('converter canceled'))
    signal?.addEventListener('abort', abort, { once: true })
    request.once('close', () => signal?.removeEventListener('abort', abort))
    request.end(body)
  })
}
