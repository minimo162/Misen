export interface ParsedReply {
  tool?: string
  args?: Record<string, unknown>
  answer?: string
}

interface Candidate {
  text: string
  end: number
}

function scanCandidates(text: string): Candidate[] {
  const candidates: Candidate[] = []
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
        if (depth === 0 && start >= 0) candidates.push({ text: text.slice(start, i + 1), end: i + 1 })
      }
    }
  }
  return candidates
}

function pickReply(candidates: Candidate[]): { parsed: ParsedReply; end: number } | null {
  let found: { parsed: ParsedReply; end: number } | null = null
  for (const cand of candidates) {
    try {
      const obj = JSON.parse(cand.text) as Record<string, unknown>
      if (typeof obj.tool === 'string') {
        found = { parsed: { tool: obj.tool, args: (obj.args ?? {}) as Record<string, unknown> }, end: cand.end }
      } else if (typeof obj.answer === 'string') {
        found = { parsed: { answer: obj.answer }, end: cand.end }
      }
    } catch {
      const repaired = repairWriteFileCandidate(cand.text)
      if (repaired) found = repaired
    }
  }
  return found
}

function repairWriteFileCandidate(c: string): { parsed: ParsedReply; end: number } | null {
  const m = c.match(/"tool"\s*:\s*"write_file"[\s\S]*?"path"\s*:\s*"((?:[^"\\]|\\.)*)"[\s\S]*?"content"\s*:\s*"([\s\S]*)/)
  if (!m) return null
  let content = m[2].replace(/\s*"?\s*\}\s*$/, '').split(END_MARKER)[0]
  try {
    content = JSON.parse(`"${content}"`)
  } catch {
    content = content.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\\\/g, '\\')
  }
  return { parsed: { tool: 'write_file', args: { path: m[1], content } }, end: c.length }
}

export function extractReplyAndEnd(raw: string): { parsed: ParsedReply; end: number } | null {
  const text = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
  return pickReply(scanCandidates(text))
}

export function extractJsonReply(raw: string): ParsedReply | null {
  return extractReplyAndEnd(raw)?.parsed ?? null
}

function attachFenceContent(raw: string, end: number, parsed: ParsedReply): void {
  if (parsed.tool !== 'write_file' || typeof parsed.args?.content === 'string') return
  const rest = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').slice(end)
  const cm = rest.match(/^\s*(?:CONTENT|内容)\s*[:：]\s*\r?\n?([\s\S]+)$/i)
  if (cm) {
    const body = cm[1].split(END_MARKER)[0].replace(/\s+$/, '').replace(/＜/g, '<').replace(/＞/g, '>').replace(/｀/g, String.fromCharCode(96)).replace(/¶/g, '\n')
    parsed.args = { ...(parsed.args ?? {}), content: body }
    return
  }
  const fm = rest.match(/```[\w+-]*[ \t]*\r?\n?([\s\S]*?)```/)
  if (fm) {
    parsed.args = { ...(parsed.args ?? {}), content: fm[1].replace(/^\r?\n/, '').trim() }
    return
  }
  const numbered = stripLineNumbered(rest)
  if (numbered !== null) {
    parsed.args = { ...(parsed.args ?? {}), content: numbered }
    return
  }
  console.log('[debug-fence-miss] rest=' + JSON.stringify(rest.slice(0, 300)))
}

function stripLineNumbered(rest: string): string | null {
  if (!/^\s*\d+\s*\r?\n/.test(rest) && !/^\s*\n?[A-Za-z][\w+#.-]*[ \t]*\r?\n\d+\s*\r?\n/.test(rest)) return null
  const bodyMatch = rest.match(/^\s*\n?(?:[A-Za-z][\w+#.-]*[ \t]*\r?\n)?([\s\S]+)$/)
  const body = bodyMatch ? bodyMatch[1] : rest
  const markers = (body.match(/(?:^|\r?\n)\d+[ \t]*(?:\r?\n|$)/g) || []).length
  if (markers < 2) return null
  const out = body.replace(/(?:^|\r?\n)\d+[ \t]*(?:\r?\n)/g, '\n').replace(/\r?\n$/, '')
  return out
}
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
  const toolDocs = TOOL_DEFS.map((t) => {
    const req = ((t.parameters as { required?: string[] }).required ?? [])
    const props = Object.keys((t.parameters as { properties?: Record<string, unknown> }).properties ?? {})
    return `- ${t.name}(${props.join(', ')}):${req.length ? ` 必須=${req.join(',')};` : ''} ${t.description}`
  }).join('\n')
  return [
    'あなたは社内コーディング支援エージェントです。次に取るべきローカル開発アクションを、ホストブリッジへ渡す構造化 JSON として返します。',
    'あなたの応答は実行結果ではなく、ホストブリッジが解釈する「次の1手」です。あなたが直接ファイルを操作できるかどうかを説明する必要はありません。',
    'ホストブリッジは JSON の tool を受け取ると、指定されたワークスペース内で実行し、その結果を次の入力に TOOL_RESULT として渡します。',
    '「ツールを使えません」「実行できません」といった拒否や説明は禁止です。必ず指定形式の JSON で次の1手を返してください。',
    'あなたの仕事は、状況に応じて次に行うべきアクションを 1 つ選び JSON で報告することです。',
    '',
    '選択できるアクション:',
    toolDocs,
    '長時間のローカル開発サーバーはrun_commandではなく、start_process→read_process_log→stop_processの順で管理する。',
    'プレビューURLが分かる場合はstart_processのurlにhttp/httpsを指定し、起動後にログで待受状態を確認する。',
    '',
    'この会話はローカルホストブリッジと連携しています。tool JSON を返すと、ホストブリッジが取得した一覧が次の入力に TOOL_RESULT として届きます。',
    'TOOL_RESULT はホストブリッジが取得した実際の結果です。結果を想像せず、受け取った内容だけを根拠に次の1手を選びます。',
    '実際には存在しない環境・ファイル・実行結果を想像して答えることは禁止です。',
    '',
    '対話の流れ:',
    '  1. あなたが {"tool":"..."} を返す',
    '  2. システムが実際に実行し、次の入力に TOOL_RESULT(...) として結果を提示する',
    '  3. それを受けてあなたが次の JSON を返す(繰り返し)',
    '  4. 完了したら {"answer":"..."} で締める',
    '',
    '出力ルール(厳守): 毎回、次のどちらかの JSON オブジェクト「1つだけ」を出力する。',
    '  {"tool":"<アクション名>","args":{...}}',
    '  {"answer":"<ユーザーへの最終回答(日本語)>"}',
    'JSON 以外の文章・見出し・挨拶は一切出力しない。',
    'write_file でファイル内容を渡すときは、content を JSON 内に書かず、JSON の直後に「CONTENT:」の行と本文を続けてください:',
    '  {"tool":"write_file","args":{"path":"index.html"}}',
    '  CONTENT:',
    '  <p>ここにファイル本文</p>',
    '  AGENT_END',
    '⚠️ 応答は必ず「一つのコードフェンスブロック ``` 〜 ``` 」の中に、JSON・CONTENT 本文・AGENT_END のすべてを含めてください。ブロック内ではタグ < > やバッククォート ` もそのまま書いて構いません(システムがブロック単位で原文を受け取ります)。ブロックの外には何も書かないでください。',
    `出力の最後に、${END_MARKER} という文字列だけの行を必ず付ける。`,
    '',
    '出力例:',
    '{"tool":"list_files","args":{}}',
    END_MARKER,
    '',
    'それでは開始です。'
  ].join('\n')
}

function unwrapAnswer(raw: string): string {
  const cleaned = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
  const m = cleaned.match(/"answer"\s*:\s*"((?:[^"\\]|\\.)*)"/)
  if (m) {
    try {
      return JSON.parse(`"${m[1]}"`) as string
    } catch {
      return m[1]
    }
  }
  return cleaned.replace(new RegExp(`"?${END_MARKER}"?`, 'g'), '').trim()
}

function composeCopilotPrompt(userInput: string, steps: string[], budget = 120000, history: { role: string; content: string }[] = []): string {
  const histBlock = history.length > 0
    ? ['', '[これまでのやりとり]', ...history.map((h) => `${h.role}: ${h.content.replace(/\r?\n+/g, ' ')}`)]
    : []
  const head = [buildProtocolRules(), ...histBlock, '', '[依頼]', userInput]
  const tail = [
    '',
    '[指示]',
    '上記の状況を踏まえて、次に取るべきアクションを指定の JSON 形式のみで返してください。',
    `回答の最後には ${END_MARKER} だけの行を付けてください。`
  ]
  let keep = steps
  const build = (list: string[], omitted: boolean): string =>
    [...head, ...(omitted ? ['(※ 古い経過は省略しました)'] : []), ...list, ...tail].join('\n')
  let text = build(keep, false)
  while (text.length > budget && keep.length > 1) {
    keep = keep.slice(1)
    text = build(keep, true)
  }
  return text
}

async function runCopilotTurn(opts: {
  cfg: AgentConfig
  messages: ChatMessage[]
  backend: TextBackend
  userInput: string
  ctx: ToolContext
  io: AgentIO
}): Promise<AgentTurnResult> {
  const { cfg, ctx, io, backend } = opts
  const history = opts.messages.filter((m: ChatMessage) => m.role !== 'system').map((m: ChatMessage) => ({ role: m.role === 'assistant' ? 'アシスタント' : 'ユーザー', content: String(m.content ?? '').slice(0, 400) })).slice(-12)
  if (cfg.copilot?.agentMode !== true) {
    const prompt = [cfg.systemPrompt, opts.userInput].filter((s) => s && s.trim()).join('\n\n')
    try {
      const text = (await backend.complete(prompt)).trim()
      return { reply: text, messages: [...opts.messages, { role: 'user', content: opts.userInput }, { role: 'assistant', content: text }], aborted: false }
    } catch (err) {
      const msg = (err as Error).message
      io.print(`[error] ${msg}`)
      return { reply: '', messages: [{ role: 'assistant', content: `[error] ${msg}` }], aborted: true }
    }
  }
  const steps: string[] = []
  try {
    const listDef = TOOL_DEFS.find((d) => d.name === 'list_files')!
    steps.push(`TOOL_RESULT(list_files): ${(await listDef.run({}, ctx)).slice(0, 600)}`)
  } catch {}
  let parseRetried = false
  let refusals = 0
  const maxIter = cfg.maxToolIterations ?? 15
  for (let i = 0; i < maxIter; i++) {
    let raw: string
    try {
      raw = await backend.complete(composeCopilotPrompt(opts.userInput, steps, opts.cfg.copilot?.maxPromptChars ?? 120000, history))
      raw = raw.replace(/＜/g, '<').replace(/＞/g, '>').replace(new RegExp(String.fromCharCode(65312) === '' ? '' : '｀', 'g'), String.fromCharCode(96))
    } catch (err) {
      io.print(`[error] ${(err as Error).message}`)
      return { reply: '', messages: [{ role: 'assistant', content: `[error] ${(err as Error).message}` }], aborted: true }
    }
    const pe = extractReplyAndEnd(raw)
    let parsed = pe?.parsed ?? null
    if (parsed && parsed.tool === 'write_file') attachFenceContent(raw, pe!.end, parsed)
    if (!parsed) {
      if (!parseRetried) {
        parseRetried = true
        steps.push('SYSTEM: 直前の応答は指定形式に違反しました。説明文を省き、{"tool":...} または {"answer":"..."} の JSON オブジェクト1つだけを出力してください。')
        continue
      }
      const fallback = unwrapAnswer(raw)
      return { reply: fallback, messages: [...opts.messages, { role: 'user', content: opts.userInput }, { role: 'assistant', content: fallback }], aborted: false }
    }
    if (parsed.answer !== undefined && refusals < 3 && (/使用でき|実行できません|共有して|確認できません|アップロードして/.test(parsed.answer))) {
      refusals++
      if (refusals >= 2) steps.push('SYSTEM: read_file や run_command は実際に動作します。断らず JSON でアクションを返してください。')
      continue
    }
    if (parsed.answer !== undefined) {
      const reply = parsed.answer.trim()
      steps.push(`assistant: {"answer":"..."}`)
    return { reply, messages: [...opts.messages, { role: 'user', content: opts.userInput }, { role: 'assistant', content: reply }], aborted: false }
    }
    const def = TOOL_DEFS.find((d) => d.name === parsed.tool)
    if (!def) {
      steps.push(`TOOL_RESULT: [error] 未知のツール "${parsed.tool}"。tool は正確な名前で指定してください。`)
      continue
    }
    io.print(`[tool] ${summarize(def.name, parsed.args ?? {})}`)
    if (def.kind !== 'read') {
      const auto = def.kind === 'write' ? (cfg.autoApprove?.write ?? true) : (cfg.autoApprove?.command ?? false)
      if (!auto) {
        const ok = await io.askYesNo(`実行を許可しますか？\n${summarize(def.name, parsed.args ?? {})}`)
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
    steps.push(`TOOL_RESULT(${def.name}): ${output.slice(0, 2000)}`)
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
    return runCopilotTurn({ cfg: opts.cfg, messages: opts.messages, backend, userInput: opts.userInput, ctx: opts.ctx, io: opts.io })
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
    const auto = def.kind === 'write' ? (cfg.autoApprove?.write ?? true) : (cfg.autoApprove?.command ?? false)
    if (!auto) {
      const ok = await io.askYesNo(`実行を許可しますか？\n${summarize(def.name, args)}`)
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
