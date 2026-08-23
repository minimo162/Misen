import http from 'node:http'
import https from 'node:https'
import { resolveApiKey, type AgentConfig } from './config'

export interface FunctionSpec {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface ToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content?: string | null
  tool_calls?: ToolCall[]
  tool_call_id?: string
  name?: string
}

export interface OpenAIToolSchema {
  type: 'function'
  function: FunctionSpec
}

interface CompletionResponse {
  choices?: Array<{
    message?: {
      role?: string
      content?: string | null
      tool_calls?: ToolCall[]
    }
  }>
}

function postJson(url: string, body: string, headers: Record<string, string>, signal?: AbortSignal): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const mod = u.protocol === 'https:' ? https : http
    const req = mod.request(
      u,
      { method: 'POST', headers: { ...headers, 'content-length': Buffer.byteLength(body).toString() } },
      (res) => {
        let data = ''
        res.setEncoding('utf8')
        res.on('data', (c) => {
          data += c
        })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text: data }))
      }
    )
    req.setTimeout(0)
    const abort = () => req.destroy(new Error('LLM request aborted'))
    if (signal?.aborted) abort()
    signal?.addEventListener('abort', abort, { once: true })
    req.on('error', reject)
    req.on('close', () => signal?.removeEventListener('abort', abort))
    req.end(body)
  })
}

export async function chat(cfg: AgentConfig, messages: ChatMessage[], tools: OpenAIToolSchema[], signal?: AbortSignal): Promise<ChatMessage> {
  const url = cfg.baseURL.replace(/\/+$/, '') + '/chat/completions'
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  const key = resolveApiKey(cfg)
  if (key) headers.authorization = `Bearer ${key}`
  const payload = JSON.stringify({
    model: cfg.model,
    temperature: cfg.temperature ?? 0.2,
    messages,
    ...(cfg.chatTemplateKwargs ? { chat_template_kwargs: cfg.chatTemplateKwargs } : {}),
    ...(tools.length > 0 ? { tools } : {})
  })
  const res = await postJson(url, payload, headers, signal)
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`LLM API エラー ${res.status}: ${res.text.slice(0, 400)}`)
  }
  let data: CompletionResponse
  try {
    data = JSON.parse(res.text) as CompletionResponse
  } catch {
    throw new Error('LLM API の応答が JSON ではありません')
  }
  const raw = data.choices?.[0]?.message
  if (!raw) throw new Error('LLM API の応答形式が不正です')
  return {
    role: 'assistant',
    content: raw.content ?? '',
    ...(raw.tool_calls ? { tool_calls: raw.tool_calls } : {})
  }
}
