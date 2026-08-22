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

export async function chat(cfg: AgentConfig, messages: ChatMessage[], tools: OpenAIToolSchema[]): Promise<ChatMessage> {
  const url = cfg.baseURL.replace(/\/+$/, '') + '/chat/completions'
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  const key = resolveApiKey(cfg)
  if (key) headers.authorization = `Bearer ${key}`
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: cfg.model,
      temperature: cfg.temperature ?? 0.2,
      messages,
      ...(tools.length > 0 ? { tools } : {})
    })
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`LLM API エラー ${res.status}: ${text.slice(0, 400)}`)
  }
  const data = (await res.json()) as CompletionResponse
  const raw = data.choices?.[0]?.message
  if (!raw) throw new Error('LLM API の応答形式が不正です')
  return {
    role: 'assistant',
    content: raw.content ?? '',
    ...(raw.tool_calls ? { tool_calls: raw.tool_calls } : {})
  }
}
