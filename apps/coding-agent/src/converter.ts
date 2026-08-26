import http from 'node:http'
import https from 'node:https'
import { jsonrepair } from '../vendor/npm/node_modules/jsonrepair'
import type { LocalResponseConverterSettings } from './config'

export interface ConverterToolDefinition { name: string; description: string; parameters: Record<string, unknown> }
export interface DeterministicConversion { content: string; method: string; repairs: string[] }

type JsonCandidate = { text: string; position: number; score: number; repairs: string[] }

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

function protocolObject(value: unknown, tools: ConverterToolDefinition[]): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const parsed = value as Record<string, unknown>
  const keys = Object.keys(parsed)
  if (Object.prototype.hasOwnProperty.call(parsed, 'AGENT_END') && parsed.AGENT_END !== true) return null
  if (typeof parsed.answer === 'string' && keys.every((key) => ['answer', 'AGENT_END'].includes(key))) {
    return JSON.stringify({ answer: parsed.answer })
  }
  if (typeof parsed.tool !== 'string') return null
  const requested = parsed.tool.startsWith('host.') ? parsed.tool : `host.${parsed.tool}`
  const matched = tools.find((tool) => tool.name === requested)
  if (!matched) return null
  if (Object.prototype.hasOwnProperty.call(parsed, 'args')) {
    if (keys.some((key) => !['tool', 'args', 'AGENT_END'].includes(key))) return null
    if (!parsed.args || typeof parsed.args !== 'object' || Array.isArray(parsed.args)) return null
    return JSON.stringify({ tool: matched.name, args: parsed.args })
  }
  const args = Object.fromEntries(Object.entries(parsed).filter(([key]) => !['tool', 'AGENT_END'].includes(key)))
  return JSON.stringify({ tool: matched.name, args })
}

function scanJsonObjects(text: string): Array<{ text: string; position: number }> {
  const found: Array<{ text: string; position: number }> = []
  for (let start = 0; start < text.length; start++) {
    if (text[start] !== '{') continue
    let depth = 0
    let inString = false
    let escaped = false
    for (let index = start; index < text.length; index++) {
      const ch = text[index]
      if (inString) {
        if (escaped) escaped = false
        else if (ch === '\\') escaped = true
        else if (ch === '"') inString = false
        continue
      }
      if (ch === '"') inString = true
      else if (ch === '{') depth++
      else if (ch === '}' && --depth === 0) {
        found.push({ text: text.slice(start, index + 1), position: start })
        start = index
        break
      }
    }
  }
  return found
}

function closeTruncatedJson(text: string): string | null {
  let inString = false
  let escaped = false
  const stack: string[] = []
  let lastSafe = -1
  let lastComma = -1
  for (let index = 0; index < text.length; index++) {
    const ch = text[index]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') { inString = false; lastSafe = index }
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{' || ch === '[') stack.push(ch)
    else if (ch === '}' || ch === ']') { if (stack.length > 0) stack.pop(); lastSafe = index }
    else if (ch === ',') { lastSafe = index; lastComma = index }
  }
  if (!inString && stack.length === 0) return null
  const cutAt = inString ? lastComma : lastSafe
  if (cutAt < 0) return null
  let closed = text.slice(0, cutAt).replace(/,\s*$/u, '')
  const remaining: string[] = []
  let quoted = false
  let slash = false
  for (const ch of closed) {
    if (quoted) {
      if (slash) slash = false
      else if (ch === '\\') slash = true
      else if (ch === '"') quoted = false
    } else if (ch === '"') quoted = true
    else if (ch === '{' || ch === '[') remaining.push(ch)
    else if ((ch === '}' || ch === ']') && remaining.length > 0) remaining.pop()
  }
  for (let index = remaining.length - 1; index >= 0; index--) closed += remaining[index] === '{' ? '}' : ']'
  return closed
}

function repairJsonText(source: string): { text: string; repairs: string[] } {
  let text = source
  const repairs: string[] = []
  let next = text.replace(/((?:"[^"\r\n]+"\s*:\s*))([「｢『【])/gu, '$1"$2')
  if (next !== text) { text = next; repairs.push('missing-open-quote') }
  const closed = closeTruncatedJson(text)
  if (closed !== null) {
    text = closed
    repairs.push('truncated-tool-tail-drop')
  }
  return { text, repairs }
}

function repairWindowsPathBackslashes(source: string): string | null {
  let changed = false
  const repaired = source.replace(/(:\s*")([A-Za-z]:\\[^"\r\n]*)(")/gu, (_match, prefix: string, pathValue: string, suffix: string) => {
    const escaped = pathValue.replace(/\\+/gu, (slashes) => slashes.length % 2 === 0 ? slashes : `${slashes}\\`)
    if (escaped !== pathValue) changed = true
    return prefix + escaped + suffix
  })
  return changed ? repaired : null
}

function jsonDecisionCandidates(rawResponse: string, tools: ConverterToolDefinition[]): JsonCandidate[] {
  const clean = rawResponse.replace(/<think>[\s\S]*?<\/think>/giu, '').replace(/```(?:json)?/giu, '').replace(/```/gu, '').replace(/\bAGENT_END\b/giu, '').trim()
  const sources: Array<{ text: string; offset: number }> = scanJsonObjects(clean).map((candidate) => ({ text: candidate.text, offset: candidate.position }))
  for (let position = clean.indexOf('{'); position >= 0; position = clean.indexOf('{', position + 1)) sources.push({ text: clean.slice(position), offset: position })
  const valid: JsonCandidate[] = []
  const seen = new Set<string>()
  for (const source of sources) {
    const attempts: Array<{ text: string; repairs: string[]; semanticBonus?: number }> = [{ text: source.text, repairs: [] }]
    try {
      const repaired = jsonrepair(source.text)
      if (repaired !== source.text) attempts.push({ text: repaired, repairs: ['jsonrepair'] })
    } catch {
      const custom = repairJsonText(source.text)
      if (custom.repairs.length > 0) {
        try { attempts.push({ text: jsonrepair(custom.text), repairs: [...custom.repairs, 'jsonrepair'] }) } catch {}
      }
    }
    const windowsPath = repairWindowsPathBackslashes(source.text)
    if (windowsPath !== null) {
      try { attempts.push({ text: jsonrepair(windowsPath), repairs: ['windows-path-backslash', 'jsonrepair'], semanticBonus: 40 }) } catch {}
    }
    for (const attempt of attempts) {
      try {
        const content = protocolObject(JSON.parse(attempt.text), tools)
        if (!content) continue
        const key = `${source.offset}:${content}:${attempt.repairs.join(',')}`
        if (seen.has(key)) continue
        seen.add(key)
        const score = /"(?:tool|answer)"/u.test(attempt.text) ? 20 : 0
        valid.push({ text: content, position: source.offset, score: score + (/"args"/u.test(attempt.text) ? 8 : 0) + (attempt.semanticBonus ?? 0), repairs: attempt.repairs })
      } catch {}
    }
  }
  return valid.sort((a, b) => (b.score - a.score) || (b.position - a.position) || (a.repairs.length - b.repairs.length))
}

function captureLabeledValue(raw: string, key: string): unknown {
  const marker = new RegExp(`${key}\\s*(?:は|=|:|：)\\s*`, 'iu').exec(raw)
  if (!marker) return undefined
  let rest = raw.slice(marker.index + marker[0].length).trim()
  if (rest.startsWith('「')) return rest.slice(1, rest.indexOf('」') >= 0 ? rest.indexOf('」') : undefined)
  if (rest.startsWith('"')) {
    try { return JSON.parse(rest.match(/^"(?:\\.|[^"\\])*"/u)?.[0] ?? '') } catch {}
  }
  if (rest.startsWith('[') || rest.startsWith('{')) {
    const candidate = rest.startsWith('{') ? scanJsonObjects(rest)[0]?.text : rest.match(/^\[[\s\S]*?\]/u)?.[0]
    try { if (candidate) return JSON.parse(candidate) } catch {}
  }
  rest = rest.split(/\s+\/\s+(?=[a-z_]+\s*=)/iu)[0]
    .replace(/\s+(?:で呼びます|で呼ぶ|を使います|を使う|です)[。.!！]?\s*$/u, '')
    .replace(/[。.!！]\s*$/u, '').trim()
  if (/^(?:true|false)$/iu.test(rest)) return rest.toLowerCase() === 'true'
  if (/^-?\d+$/u.test(rest)) return Number(rest)
  return rest || undefined
}

function explicitToolDecision(rawResponse: string, tools: ConverterToolDefinition[]): string | null {
  const text = rawResponse.trim()
  const negative = /(?:例[:：]|たとえば|例えば|今回は[^。\n]*(?:しません|しない)|拒否され|呼び出せません|まだ[^。\n]*(?:できません|呼べません)|操作しません)/u.test(text)
  if (negative) return null
  const matched = [...tools]
    .sort((a, b) => b.name.length - a.name.length)
    .find((tool) => {
      const bare = tool.name.startsWith('host.') ? tool.name.slice(5) : tool.name
      return text.toLowerCase().includes(tool.name.toLowerCase()) || text.toLowerCase().includes(bare.toLowerCase())
    })
  if (!matched) return null
  const argsLabel = /\bARGS?\b\s*[:：]?\s*/iu.exec(text)
  if (argsLabel) {
    const argsCandidate = scanJsonObjects(text.slice(argsLabel.index + argsLabel[0].length))[0]
    if (argsCandidate) {
      try { return JSON.stringify({ tool: matched.name, args: JSON.parse(argsCandidate.text) }) } catch {}
    }
  }
  const bare = matched.name.startsWith('host.') ? matched.name.slice(5) : matched.name
  if (bare === 'write_file') {
    const naturalWrite = text.match(/(?:host\.)?write_file\s*で\s*([^\r\n]+?)\s*に「([\s\S]*?)」を新規作成/u)
    if (naturalWrite) return JSON.stringify({ tool: matched.name, args: { path: naturalWrite[1].trim(), content: naturalWrite[2] } })
  }
  const keysByTool: Record<string, string[]> = {
    list_files: ['path', 'glob', 'recursive'], read_file: ['path'], read_files: ['paths', 'pattern'], read_xlsx: ['path'],
    search_files: ['query', 'path', 'glob', 'max_results'], write_file: ['path', 'content'], run_command: ['command'], start_process: ['command']
  }
  const args: Record<string, unknown> = {}
  for (const key of keysByTool[bare] ?? []) {
    const value = captureLabeledValue(text, key)
    if (value !== undefined) args[key] = value
  }
  if (Object.keys(args).length === 0 && !/(?:使|呼び|実行|取得|列挙|一覧)/u.test(text)) return null
  return JSON.stringify({ tool: matched.name, args })
}

export function interpretCopilotResponseDeterministically(rawResponse: string, tools: ConverterToolDefinition[]): DeterministicConversion | null {
  const candidates = jsonDecisionCandidates(rawResponse, tools)
  const negativeContext = /(?:例[:：]|たとえば|例えば|今回は[^。\n]*(?:しません|しない)|操作しません|拒否され|呼び出せません)/u.test(rawResponse)
  if (candidates.length > 0 && !negativeContext) return { content: candidates[0].text, method: 'json-candidate', repairs: candidates[0].repairs }
  const explicit = explicitToolDecision(rawResponse, tools)
  if (explicit) return { content: explicit, method: 'explicit-tool-text', repairs: [] }
  const answer = rawResponse.replace(/<think>[\s\S]*?<\/think>/giu, '').replace(/```/gu, '').replace(/\bAGENT_END\b/giu, '').trim()
  if (!answer) return null
  const mentionsAllowedTool = tools.some((tool) => {
    const bare = tool.name.startsWith('host.') ? tool.name.slice(5) : tool.name
    return answer.toLowerCase().includes(tool.name.toLowerCase()) || answer.toLowerCase().includes(bare.toLowerCase())
  })
  if (mentionsAllowedTool && !negativeContext) return null
  return { content: JSON.stringify({ answer }), method: 'plain-answer', repairs: [] }
}

function loopbackUrl(value: string): URL {
  const url = new URL(value)
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/gu, '')
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
  const deterministic = interpretCopilotResponseDeterministically(rawResponse, tools)
  if (deterministic) return deterministic.content
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
