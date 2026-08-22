import readline from 'node:readline'
import type { AgentConfig } from './config'
import { runAgentTurn, type AgentIO, type TextBackend } from './agent'
import { CopilotEdgeClient } from './copilot'
import type { ChatMessage } from './llm'
import { appendSession } from './session'
import type { ToolContext } from './tools'

const DEFAULT_SYSTEM_PROMPT =
  'あなたは社内のコーディング支援エージェントです。提供されたツールでファイルの調査・編集・コマンド実行を行い、簡潔な日本語で回答してください。'

function printHelp(): void {
  console.log(
    [
      'コマンド:',
      '  /help   ヘルプ表示',
      '  /reset  会話履歴をリセット',
      '  /cwd    ワークスペースを表示',
      '  /exit   終了 (空Enterでも終了)',
      '',
      'ファイル書き込み・コマンド実行の前に確認プロンプトが表示されます'
    ].join('\n')
  )
}

export async function startRepl(cfg: AgentConfig, ctx: ToolContext): Promise<void> {
  const lineQueue: string[] = []
  let waiter: ((line: string) => void) | null = null

  const rl = readline.createInterface({ input: process.stdin, terminal: false })
  rl.on('line', (raw) => {
    const line = raw.trim()
    if (waiter) {
      const w = waiter
      waiter = null
      w(line)
    } else {
      lineQueue.push(line)
    }
  })
  rl.on('close', () => {
    if (waiter) {
      const w = waiter
      waiter = null
      w('')
    }
  })

  async function nextLine(promptText: string): Promise<string> {
    process.stdout.write(promptText)
    if (lineQueue.length > 0) return lineQueue.shift() as string
    return new Promise<string>((resolve) => {
      waiter = resolve
    })
  }

  const io: AgentIO = {
    print: (t) => console.log(t),
    askYesNo: async (q) => /^y(es)?$/i.test(await nextLine(`${q} [y/N]: `))
  }

  let messages: ChatMessage[] = [{ role: 'system', content: cfg.systemPrompt ?? DEFAULT_SYSTEM_PROMPT }]
  let copilotBackend: TextBackend | null = null
  console.log(`coding-agent (${cfg.model || (cfg.provider ?? 'openai')}) — 開始。/help でコマンド、空Enterで終了`)
  for (;;) {
    const input = await nextLine('> ')
    if (input === '') break
    if (input.startsWith('/')) {
      const cmd = input.split(/\s+/)[0]
      if (cmd === '/exit' || cmd === '/quit') break
      if (cmd === '/reset') {
        messages = messages.slice(0, 1)
        console.log('(会話をリセットしました)')
        continue
      }
      if (cmd === '/cwd') {
        console.log(ctx.workspace)
        continue
      }
      if (cmd === '/help') {
        printHelp()
        continue
      }
      console.log(`不明なコマンド: ${cmd}`)
      continue
    }
    const backend = cfg.provider === 'copilot-edge' ? (copilotBackend ??= new CopilotEdgeClient(cfg)) : undefined
    const result = await runAgentTurn({ cfg, messages, userInput: input, ctx, io, backend })
    if (result.reply) console.log(result.reply + '\n')
    messages = result.messages
    appendSession(input, result.messages)
  }
  rl.close()
  copilotBackend?.close?.()
}
