import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ChatMessage } from './llm'

let logPath: string | undefined

function ensureLog(): string {
  if (!logPath) {
    const dir = path.join(os.tmpdir(), 'company-coding-agent', 'sessions')
    fs.mkdirSync(dir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    logPath = path.join(dir, `${stamp}.jsonl`)
  }
  return logPath
}

export function appendSession(userInput: string, newMessages: ChatMessage[]): void {
  try {
    const line = JSON.stringify({ ts: new Date().toISOString(), input: userInput, messages: newMessages }) + '\n'
    fs.appendFileSync(ensureLog(), line, 'utf8')
  } catch {
    // ログ書き込み失敗は動作に影響させない
  }
}
