import type { AgentConfig } from './config'
import { chat, type ChatMessage, type ToolCall } from './llm'
import { openAITools, TOOL_DEFS, type ToolContext } from './tools'

export interface AgentIO {
  print(text: string): void
  askYesNo(question: string): Promise<boolean>
}

export interface AgentTurnResult {
  reply: string
  messages: ChatMessage[]
  aborted: boolean
}

export interface TextBackend {
  readonly name: string
  complete(prompt: string): Promise<string>
  close?(): void
}

const END_MARKER = 'AGENT_END'

function buildProtocolRules(): string {
  const toolDocs = TOOL_DEFS.map((t) => `- ${t.name}: ${t.description}\n  引数スキーマ: ${JSON.stringify(t.parameters)}`).join('\n')
  return [
    'これから「社内コーディング支援エージェント」のロールプレイをお願いします。',
    'あなたの発言はすべて社内ツールから受け取られ、記載されたアクションは外部システムが自動実行します。',
    'あなた自身はアクションを実行できないため、「〜を確認しました」「〜はできません」といった回答は不要です。',
    'あなたの仕事は、状況に応じて次に行うべきアクションを 1 つ選び JSON で報告することです。',
    '',
    '選択できるアクション:',
    toolDocs,
    '',
    '出力ルール(厳守): 毎回、次のどちらかの JSON オブジェクト「1つだけ」を出力する。',
    '  {"tool":"<アクション名>","args":{...}}',
    '  {"answer":"<ユーザーへの最終回答(日本語)>"}',
    'JSON 以外の文章・見出し・挨拶は一切出力しない。',
    `出力の最後に、${END_MARKER} という文字列だけの行を必ず付ける。`,
    '',
    '出力例:',
    '{"tool":"list_files","args":{}}',
    END_MARKER,
    '',
    'それでは開始です。'
  ].join('\n')
}

export function extractJsonReply(raw: string): { tool?: string; args?: Record<string, unknown>; answer?: string } | null {
  let text = raw.trim()
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence) text = fence[1].trim()
  const candidates: string[] = []
  let depth = 0
  let start = -1
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') {
      if (depth === 0) start = i
      depth++
    } else if (ch === '}') {
      if (depth > 0) {
        depth--
        if (depth === 0 && start >= 0) candidates.push(text.slice(start, i + 1))
      }
    }
  }
  for (const c of candidates) {
    try {
      const obj = JSON.parse(c) as Record<string, unknown>
      if (typeof obj.tool === 'string') {
        return { tool: obj.tool, args: (obj.args ?? {}) as Record<string, unknown> }
      }
      if (typeof obj.answer === 'string') return { answer: obj.answer }
    } catch {
      continue
    }
  }
  return null
}

function composeCopilotPrompt(userInput: string, steps: string[]): string {
  const parts = [buildProtocolRules(), '', '[依頼]', userInput]
  for (const s of steps) parts.push('', s)
  parts.push(
    '',
    '[指示]',
    '上記の状況を踏まえて、次に取るべきアクションを指定の JSON 形式のみで返してください。',
    `回答の最後には ${END_MARKER} だけの行を付けてください。`
  )
  return parts.join('\n')
}

async function runCopilotTurn(opts: {
  cfg: AgentConfig
  backend: TextBackend
  userInput: string
  ctx: ToolContext
  io: AgentIO
}): Promise<AgentTurnResult> {
  const { cfg, ctx, io, backend } = opts
  if (cfg.copilot?.agentMode !== true) {
    const prompt = [cfg.systemPrompt, opts.userInput].filter((s) => s && s.trim()).join('\n\n')
    try {
      const text = (await backend.complete(prompt)).trim()
      return { reply: text, messages: [{ role: 'user', content: opts.userInput }, { role: 'assistant', content: text }], aborted: false }
    } catch (err) {
      const msg = (err as Error).message
      io.print(`[error] ${msg}`)
      return { reply: '', messages: [{ role: 'assistant', content: `[error] ${msg}` }], aborted: true }
    }
  }
  const steps: string[] = []
  let parseRetried = false
  const maxIter = cfg.maxToolIterations ?? 15
  for (let i = 0; i < maxIter; i++) {
    let raw: string
    try {
      raw = await backend.complete(composeCopilotPrompt(opts.userInput, steps))
    } catch (err) {
      io.print(`[error] ${(err as Error).message}`)
      return { reply: '', messages: [{ role: 'assistant', content: `[error] ${(err as Error).message}` }], aborted: true }
    }
    const parsed = extractJsonReply(raw)
    if (!parsed) {
      if (!parseRetried) {
        parseRetried = true
        steps.push('SYSTEM: 直前の応答は指定形式に違反しました。説明文を省き、{"tool":...} または {"answer":"..."} の JSON オブジェクト1つだけを出力してください。')
        continue
      }
      io.print('[warn] 応答を JSON として解釈できなかったため、そのまま回答として扱います')
      return { reply: raw.replace(new RegExp(`^${END_MARKER}$`, 'm'), '').trim(), messages: [{ role: 'assistant', content: raw }], aborted: false }
    }
    if (parsed.answer !== undefined) {
      const reply = parsed.answer.trim()
      steps.push(`assistant: {"answer":"..."}`)
      return { reply, messages: [{ role: 'user', content: opts.userInput }, { role: 'assistant', content: reply }], aborted: false }
    }
    const def = TOOL_DEFS.find((d) => d.name === parsed.tool)
    if (!def) {
      steps.push(`TOOL_RESULT: [error] 未知のツール "${parsed.tool}"。tool は正確な名前で指定してください。`)
      continue
    }
    io.print(`[tool] ${summarize(def.name, parsed.args ?? {})}`)
    if (def.kind !== 'read') {
      const auto = def.kind === 'write' ? cfg.autoApprove?.write : cfg.autoApprove?.command
      if (!auto) {
        const ok = await io.askYesNo(`  ↑ 実行しますか？ (${def.kind})`)
        if (!ok) {
          steps.push(`TOOL_RESULT(${def.name}): (ユーザーが拒否しました)`)
          continue
        }
      }
    }
    let output: string
    try {
      output = await def.run(parsed.args ?? {}, ctx)
    } catch (err) {
      output = `[tool error] ${(err as Error).message}`
    }
    steps.push(`TOOL_RESULT(${def.name}): ${output.slice(0, 6000)}`)
  }
  io.print('[warn] 最大反復回数に達しました')
  return { reply: '', messages: [], aborted: true }
}


export async function runAgentTurn(opts: {
  cfg: AgentConfig
  messages: ChatMessage[]
  userInput: string
  ctx: ToolContext
  io: AgentIO
  backend?: TextBackend
}): Promise<AgentTurnResult> {
  if (opts.backend || opts.cfg.provider === 'copilot-edge') {
    const backend = opts.backend
    if (!backend) throw new Error('provider=copilot-edge には backend が必要です')
    return runCopilotTurn({ cfg: opts.cfg, backend, userInput: opts.userInput, ctx: opts.ctx, io: opts.io })
  }
  return runOpenAITurn(opts)
}

async function runOpenAITurn(opts: {
  cfg: AgentConfig
  messages: ChatMessage[]
  userInput: string
  ctx: ToolContext
  io: AgentIO
}): Promise<AgentTurnResult> {
  const { cfg, ctx, io } = opts
  const messages: ChatMessage[] = [...opts.messages, { role: 'user', content: opts.userInput }]
  const maxIter = cfg.maxToolIterations ?? 15
  for (let i = 0; i < maxIter; i++) {
    let assistant: ChatMessage
    try {
      assistant = await chat(cfg, messages, openAITools())
    } catch (err) {
      const msg = (err as Error).message
      io.print(`[error] ${msg}`)
      return { reply: '', messages, aborted: true }
    }
    messages.push(assistant)
    const calls = assistant.tool_calls ?? []
    if (calls.length === 0) {
      return { reply: assistant.content ?? '', messages, aborted: false }
    }
    for (const call of calls) {
      const output = await executeCall(call, cfg, ctx, io)
      messages.push({ role: 'tool', tool_call_id: call.id, name: call.function.name, content: output })
    }
  }
  io.print('[warn] 最大反復回数に達しました')
  return { reply: '', messages, aborted: true }
}

async function executeCall(
  call: ToolCall,
  cfg: AgentConfig,
  ctx: ToolContext,
  io: AgentIO
): Promise<string> {
  const def = TOOL_DEFS.find((d) => d.name === call.function.name)
  if (!def) return `未知のツール: ${call.function.name}`
  let args: Record<string, unknown> = {}
  try {
    args = call.function.arguments ? (JSON.parse(call.function.arguments) as Record<string, unknown>) : {}
  } catch {
    return '引数の JSON パースに失敗しました'
  }
  io.print(`[tool] ${summarize(def.name, args)}`)
  if (def.kind !== 'read') {
    const auto = def.kind === 'write' ? cfg.autoApprove?.write : cfg.autoApprove?.command
    if (!auto) {
      const ok = await io.askYesNo(`  ↑ 実行しますか？ (${def.kind})`)
      if (!ok) return '(ユーザーが拒否しました)'
    }
  }
  try {
    return await def.run(args, ctx)
  } catch (err) {
    return `[tool error] ${(err as Error).message}`
  }
}

function summarize(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case 'run_command':
      return `run_command: ${args.command}`
    case 'write_file':
      return `write_file: ${args.path}`
    case 'edit_file':
      return `edit_file: ${args.path}`
    default:
      return `${name}: ${JSON.stringify(args)}`
  }
}
