import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { loadConfig, type AgentConfig } from './config'
import { runAgentTurn, type AgentIO, type TextBackend } from './agent'
import { CopilotEdgeClient } from './copilot'
import type { ChatMessage } from './llm'
import type { ToolContext } from './tools'

const PORT = Number(process.env.PORT ?? 3948)

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1] : undefined
}

const cfg: AgentConfig = loadConfig(argValue('--config'))
const workspaceArg = argValue('--workspace')
const workspace = workspaceArg ? path.resolve(workspaceArg) : process.cwd()
const ctx: ToolContext = { workspace, restrictToWorkspace: cfg.restrictToWorkspace ?? true }

const here = typeof __dirname !== 'undefined' ? __dirname : path.dirname(process.argv[1] ?? '.')
const indexCandidates = [
  process.env.INDEX_HTML,
  path.join(here, '..', 'public', 'index.html'),
  path.join(process.cwd(), 'public', 'index.html')
]
const indexHtmlPath = indexCandidates.find((p): p is string => typeof p === 'string' && fs.existsSync(p))

const DEFAULT_SYSTEM_PROMPT =
  'あなたは社内コーディング支援エージェントです。提供されたツールでファイルの調査・編集・コマンド実行を行い、簡潔な日本語で回答してください。'

interface SessionData {
  id: string
  title: string
  messages: ChatMessage[]
  created: number
}

const systemMsg = (): ChatMessage => ({ role: 'system', content: cfg.systemPrompt ?? DEFAULT_SYSTEM_PROMPT })
const sessions = new Map<string, SessionData>()
let activeId = ''
let copilotBackend: TextBackend | null = null
let busy = false
let lastLogSeen = 0
const logLines: string[] = []

function newSession(): SessionData {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
  const s: SessionData = { id, title: '新しいセッション', messages: [systemMsg()], created: Date.now() }
  sessions.set(id, s)
  activeId = id
  return s
}

function activeSession(): SessionData {
  return sessions.get(activeId) ?? newSession()
}

newSession()

function getBackend(): TextBackend | undefined {
  if (cfg.provider !== 'copilot-edge') return undefined
  if (!copilotBackend) copilotBackend = new CopilotEdgeClient(cfg)
  return copilotBackend
}

const io: AgentIO = {
  print: (t) => {
    logLines.push(t)
    console.log(t)
  },
  askYesNo: async () => false
}

function json(res: http.ServerResponse, status: number, obj: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(obj))
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let d = ''
    req.on('data', (c) => (d += c))
    req.on('end', () => resolve(d))
    req.on('error', reject)
  })
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')

  if (req.method === 'GET' && url.pathname === '/') {
    if (indexHtmlPath) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(fs.readFileSync(indexHtmlPath))
    } else {
      res.writeHead(500)
      res.end('public/index.html が見つかりません')
    }
    return
  }

  if (req.method === 'GET' && url.pathname === '/api/info') {
    json(res, 200, { model: cfg.model || (cfg.provider ?? ''), provider: cfg.provider ?? 'openai', workspace, project: path.basename(workspace), version: '0.8.0' })
    return
  }

  if (req.method === 'GET' && url.pathname === '/api/log') {
    const offset = Number(url.searchParams.get('offset') ?? 0)
    json(res, 200, { total: logLines.length, lines: logLines.slice(offset) })
    return
  }

  if (req.method === 'GET' && url.pathname === '/api/sessions') {
    const list = [...sessions.values()].sort((a, b) => b.created - a.created).map((s) => ({ id: s.id, title: s.title, created: s.created }))
    json(res, 200, { active: activeId, sessions: list })
    return
  }

  if (req.method === 'POST' && url.pathname === '/api/sessions') {
    const s = newSession()
    json(res, 200, { id: s.id, title: s.title })
    return
  }

  if (req.method === 'POST' && url.pathname === '/api/sessions/select') {
    const b = JSON.parse(await readBody(req)) as { id?: string }
    const s = b.id ? sessions.get(b.id) : undefined
    if (!s) { json(res, 404, { error: 'session not found' }); return }
    activeId = s.id
    json(res, 200, { ok: true })
    return
  }

  if (req.method === 'GET' && url.pathname === '/api/session') {
    const s = sessions.get(url.searchParams.get('id') ?? '')
    if (!s) { json(res, 404, { error: 'session not found' }); return }
    activeId = s.id
    json(res, 200, {
      id: s.id,
      title: s.title,
      messages: s.messages.filter((m) => m.role === 'user' || m.role === 'assistant').map((m) => ({ role: m.role, content: m.content ?? '' }))
    })
    return
  }

  if (req.method === 'POST' && url.pathname === '/api/turn') {
    if (busy) { json(res, 409, { error: '別の処理を実行中です' }); return }
    let input = ''
    let mode: 'chat' | 'work' = 'work'
    try {
      const b = JSON.parse(await readBody(req)) as { message?: string; mode?: string }
      input = String(b.message ?? '').trim()
      if (b.mode === 'chat') mode = 'chat'
    } catch {}
    if (!input) { json(res, 400, { error: 'message が空です' }); return }
    busy = true
    const startIdx = logLines.length
    const s = activeSession()
    if (s.title === '新しいセッション') s.title = input.slice(0, 30)
    const effCfg: AgentConfig = mode === 'chat' ? { ...cfg, copilot: { ...(cfg.copilot ?? {}), agentMode: false } } : cfg
    try {
      const backend = getBackend()
      const result = await runAgentTurn({ cfg: effCfg, messages: s.messages, userInput: input, ctx, io, backend })
      s.messages = result.messages
      json(res, 200, { reply: result.reply || (result.aborted ? '(中断しました)' : ''), aborted: result.aborted, logs: logLines.slice(startIdx), sessionId: s.id })
    } catch (err) {
      json(res, 500, { error: (err as Error).message })
    } finally {
      busy = false
    }
    return
  }

  res.writeHead(404); res.end('not found')
})

lastLogSeen = logLines.length

server.listen(PORT, '127.0.0.1', () => {
  console.log(`coding-agent web UI: http://127.0.0.1:${PORT}  (workspace=${workspace})`)
})
