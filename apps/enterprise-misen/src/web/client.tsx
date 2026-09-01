import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  MessagePrimitive,
  MessagePartPrimitive,
  ThreadPrimitive,
  useExternalStoreRuntime,
  type ThreadMessageLike,
} from '@assistant-ui/react'
import { MarkdownTextPrimitive } from '@assistant-ui/react-markdown'
import './client.css'
import { processEventsForRun, runIdFromMessage, shouldShowThinkingPlaceholder, type ToolEvent } from './process.js'

type UiMessage = {
  id: string
  role: 'user' | 'assistant'
  text: string
  optimistic?: boolean
}

type UiState = {
  status: 'idle' | 'running' | 'PASS' | 'FAIL' | 'CANCELLED'
  runId?: string
  output?: string
  error?: string
}

type ServerEvent =
  | { type: 'state'; state: UiState & { tools: string[]; axes: string[] } }
  | { type: 'user'; id: string; text: string }
  | { type: 'assistant'; text: string; done?: boolean }
  | { type: 'tool'; phase: 'start' | 'end'; id: string; name: string; detail?: string; status?: 'success' | 'error' }
  | { type: 'status'; status: 'running' | 'PASS' | 'FAIL' | 'CANCELLED'; output?: string; error?: string }

const TOOL_PRESENTATION: Record<string, string> = {
  workspace_list_files: 'ファイル一覧を確認',
  workspace_read_text: '引継ぎ資料を確認',
  spreadsheet_read: 'Excelを確認',
  spreadsheet_create_output: 'Excelを作成',
  spreadsheet_update: 'Excelを更新',
}

function Icon({ name, className }: { name: 'send' | 'stop' | 'running' | 'success' | 'error' | 'chevron-right' | 'chevron-down' | 'file' | 'open' | 'back'; className?: string }) {
  const common = { className: className ?? 'icon', viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true }
  if (name === 'send') return <svg {...common}><path d="M10 15V5m0 0L6.5 8.5M10 5l3.5 3.5" /></svg>
  if (name === 'stop') return <svg {...common} fill="currentColor" stroke="none"><rect x="6" y="6" width="8" height="8" rx="1.5" /></svg>
  if (name === 'running') return <svg {...common}><circle cx="10" cy="10" r="6.5" opacity=".28" /><path d="M10 3.5a6.5 6.5 0 0 1 6.5 6.5" /></svg>
  if (name === 'success') return <svg {...common}><path d="m5.5 10 3 3 6-6" /></svg>
  if (name === 'error') return <svg {...common}><path d="m6.5 6.5 7 7m0-7-7 7" /></svg>
  if (name === 'chevron-right') return <svg {...common}><path d="m8 6 4 4-4 4" /></svg>
  if (name === 'chevron-down') return <svg {...common}><path d="m6 8 4 4 4-4" /></svg>
  if (name === 'file') return <svg {...common}><path d="M6 3.5h5l3 3V16.5H6z" /><path d="M11 3.5v3h3" /></svg>
  if (name === 'open') return <svg {...common}><path d="M8 5h7v7M15 5 7 13" /><path d="M13 11v4H5V7h4" /></svg>
  return <svg {...common}><path d="m6 8 4 4 4-4" /></svg>
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter(part => Boolean(part && typeof part === 'object' && (part as any).type === 'text'))
    .map(part => String((part as any).text ?? ''))
    .join('')
}

function toThreadMessage(message: UiMessage): ThreadMessageLike {
  return {
    id: message.id,
    role: message.role,
    content: [{ type: 'text', text: message.text }],
    metadata: message.optimistic ? { isOptimistic: true } : undefined,
  }
}

const TextPart = () => <MessagePartPrimitive.Text component="span" smooth={false} />
const MarkdownTextPart = () => (
  <MarkdownTextPrimitive
    className="assistant-markdown"
    components={{
      // Brain-authored links and images are presentation text only. They must
      // not create a browser network or navigation authority.
      a: ({ children }) => <span>{children}</span>,
      img: ({ alt }) => <span>{alt ?? ''}</span>,
    }}
  />
)
const HiddenPart = () => null
const Parts = ({ markdown = false }: { markdown?: boolean }) => (
  <MessagePrimitive.Parts
    components={{
      Text: markdown ? MarkdownTextPart : TextPart,
      Reasoning: HiddenPart,
      Image: HiddenPart,
      File: HiddenPart,
      Source: HiddenPart,
      Unstable_Audio: HiddenPart,
      tools: { Override: HiddenPart },
    }}
  />
)

const UserMessage = () => (
  <MessagePrimitive.Root className="message message--user">
    <div className="user-bubble"><Parts /></div>
  </MessagePrimitive.Root>
)

const AssistantMessage = () => (
  <MessagePrimitive.Root className="message message--assistant">
    <div className="assistant-copy"><Parts markdown /></div>
  </MessagePrimitive.Root>
)

const MESSAGE_COMPONENTS = { UserMessage, AssistantMessage }

function ProcessRows({ tools, running, expanded, onToggle }: { tools: ToolEvent[]; running: boolean; expanded: boolean; onToggle: () => void }) {
  if (tools.length === 0) return null
  if (!running && !expanded) {
    return <button className="process-disclosure" type="button" onClick={onToggle} aria-expanded="false"><span>{tools.length}件の操作</span><Icon name="chevron-right" /></button>
  }
  return (
    <div className="process-stack" aria-label="操作履歴">
      {!running && <button className="process-disclosure process-disclosure--open" type="button" onClick={onToggle} aria-expanded="true"><span>{tools.length}件の操作</span><Icon name="chevron-down" /></button>}
      {tools.map(tool => (
        <div className={`process-row process-row--${tool.status}`} key={tool.id}>
          <span className="process-icon" aria-hidden="true"><Icon name={tool.status === 'running' ? 'running' : tool.status === 'error' ? 'error' : 'success'} /></span>
          <span className="process-label">{TOOL_PRESENTATION[tool.name] ?? '操作'}</span>
          {tool.detail && <span className="process-detail">{tool.detail}</span>}
        </div>
      ))}
    </div>
  )
}

function Composer({ running, onCancel }: { running: boolean; onCancel: () => void }) {
  return (
    <ComposerPrimitive.Root className="composer" compact={false}>
      <ComposerPrimitive.Input aria-label="依頼" placeholder="何をお手伝いしましょう？" submitMode="enter" maxRows={8} />
      {running ? (
        <button className="composer-action composer-action--stop" type="button" onClick={onCancel} aria-label="停止"><Icon name="stop" /></button>
      ) : (
        <ComposerPrimitive.Send className="composer-action" type="submit" aria-label="送信"><Icon name="send" /></ComposerPrimitive.Send>
      )}
    </ComposerPrimitive.Root>
  )
}

function Artifact({ output }: { output?: string }) {
  if (!output) return null
  const filename = output.replace(/\\/gu, '/').split('/').filter(Boolean).at(-1) ?? 'monthly-report.xlsx'
  return <a className="artifact-row" href="/download" download aria-label={`${filename}をダウンロード`}><Icon name="file" className="artifact-icon" /><span>{filename}</span><Icon name="open" className="artifact-arrow" /></a>
}

function Conversation({ messages, tools, running, expandedRunId, onToggle, output, activeRunId, onCancel }: {
  messages: UiMessage[]
  tools: ToolEvent[]
  running: boolean
  expandedRunId?: string
  onToggle: (runId: string) => void
  output?: string
  activeRunId?: string
  onCancel: () => void
}) {
  const showThinking = shouldShowThinkingPlaceholder(messages, tools, running, activeRunId)
  return (
    <ThreadPrimitive.Root className="thread-root">
      <ThreadPrimitive.Viewport className="thread-viewport" autoScroll turnAnchor="bottom">
        <div className="thread-content">
          {messages.length === 0 && <div className="empty-hero" aria-hidden="true"><h1>Misen</h1></div>}
          <ThreadPrimitive.Messages>
            {({ message }) => {
              // Keep process activity immediately before the assistant turn,
              // matching the DSH conversation rhythm. If the assistant has
              // not emitted a message yet, place it after the last user turn.
              const beforeAssistant = message.role === 'assistant'
              const runId = runIdFromMessage(message.id, message.role === 'user' ? 'user' : 'assistant')
              const runTools = processEventsForRun(tools, runId)
              const runIsActive = running && activeRunId === runId
              const afterLastUser = message.role === 'user' && message.id === messages.at(-1)?.id && !messages.some(item => item.id === `assistant-${runId}`)
              return <Fragment key={message.id}>
                {beforeAssistant && <ProcessRows tools={runTools} running={runIsActive} expanded={expandedRunId === runId} onToggle={() => onToggle(runId)} />}
                {message.role === 'user' ? <UserMessage /> : <AssistantMessage />}
                {afterLastUser && <ProcessRows tools={runTools} running={runIsActive} expanded={expandedRunId === runId} onToggle={() => onToggle(runId)} />}
                {afterLastUser && showThinking && <div className="thinking-status" role="status"><span className="thinking-dot" aria-hidden="true">•</span>考えています…</div>}
              </Fragment>
            }}
          </ThreadPrimitive.Messages>
          <Artifact output={output} />
        </div>
        <ThreadPrimitive.ViewportFooter className="composer-region">
          <ThreadPrimitive.ScrollToBottom className="back-to-bottom" aria-label="最新のメッセージへ移動"><Icon name="back" /></ThreadPrimitive.ScrollToBottom>
          <Composer running={running} onCancel={onCancel} />
        </ThreadPrimitive.ViewportFooter>
      </ThreadPrimitive.Viewport>
    </ThreadPrimitive.Root>
  )
}

function MisenApp() {
  const [messages, setMessages] = useState<UiMessage[]>([])
  const [tools, setTools] = useState<ToolEvent[]>([])
  const [state, setState] = useState<UiState>({ status: 'idle' })
  const [expandedRunId, setExpandedRunId] = useState<string | undefined>()
  const runIdRef = useRef<string | undefined>(undefined)
  const eventSourceRef = useRef<EventSource | null>(null)

  const running = state.status === 'running'
  const hasConversation = messages.length > 0

  const handleEvent = useCallback((event: ServerEvent) => {
    if (event.type === 'state') {
      if (event.state.runId) runIdRef.current = event.state.runId
      setState({ status: event.state.status, runId: event.state.runId, output: event.state.output, error: event.state.error })
      return
    }
    if (event.type === 'status') {
      setState(previous => ({ ...previous, status: event.status, output: event.output ?? previous.output, error: event.error }))
      if (event.status !== 'running') setExpandedRunId(undefined)
      return
    }
    if (event.type === 'user') {
      setMessages(previous => {
        const existing = previous.findIndex(message => message.id === event.id)
        if (existing >= 0) return previous.map((message, index) => index === existing ? { ...message, optimistic: false } : message)
        return [...previous, { id: event.id, role: 'user', text: event.text }]
      })
      return
    }
    if (event.type === 'assistant') {
      setMessages(previous => {
        const id = `assistant-${runIdRef.current ?? 'active'}`
        const index = previous.findIndex(message => message.role === 'assistant' && message.id === id)
        if (index >= 0) return previous.map((message, current) => current === index ? { ...message, text: event.text } : message)
        return [...previous, { id, role: 'assistant', text: event.text }]
      })
      return
    }
    if (event.type === 'tool') {
      setTools(previous => {
        const runId = runIdRef.current ?? 'active'
        const existing = previous.findIndex(tool => tool.id === event.id && tool.runId === runId)
        if (event.phase === 'start') {
          const next = { id: event.id, runId, name: event.name, detail: event.detail, status: 'running' as const }
          return existing >= 0 ? previous.map((tool, index) => index === existing ? next : tool) : [...previous, next]
        }
        if (existing < 0) return [...previous, { id: event.id, runId, name: event.name, status: event.status === 'error' ? 'error' : 'success' }]
        return previous.map((tool, index) => index === existing ? { ...tool, status: event.status === 'error' ? 'error' : 'success' } : tool)
      })
    }
  }, [])

  useEffect(() => {
    const source = new EventSource('/events')
    eventSourceRef.current = source
    const receive = (event: MessageEvent<string>) => {
      try { handleEvent(JSON.parse(event.data) as ServerEvent) } catch { /* ignore malformed event */ }
    }
    for (const type of ['state', 'status', 'user', 'assistant', 'tool']) source.addEventListener(type, receive)
    source.onerror = () => { /* browser reconnects; no provider data is exposed */ }
    return () => { source.close(); eventSourceRef.current = null }
  }, [handleEvent])

  const send = useCallback(async (append: { content?: unknown }) => {
    const text = contentText(append.content).trim()
    if (!text || running) return
    const clientId = `client-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`
    runIdRef.current = clientId
    setMessages(previous => [...previous, { id: clientId, role: 'user', text, optimistic: true }])
    setExpandedRunId(undefined)
    setState({ status: 'running', runId: clientId })
    try {
      const response = await fetch('/run', { method: 'POST', headers: { origin: globalThis.location.origin, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ prompt: text, clientId }) })
      if (!response.ok && response.status !== 202) setState(previous => ({ ...previous, status: 'FAIL', error: '依頼を開始できませんでした。' }))
    } catch {
      setState(previous => ({ ...previous, status: 'FAIL', error: '依頼を開始できませんでした。' }))
    }
  }, [running])

  const cancel = useCallback(async () => {
    try { await fetch('/cancel', { method: 'POST', headers: { origin: globalThis.location.origin } }) } catch { /* connection close is handled by SSE */ }
  }, [])

  const runtime = useExternalStoreRuntime<UiMessage>({
    messages,
    convertMessage: toThreadMessage,
    isRunning: running,
    isSendDisabled: running,
    onNew: send,
    onCancel: cancel,
  })

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <main className={`misen-shell ${hasConversation ? 'misen-shell--active' : 'misen-shell--empty'}`}>
        <header className="misen-header"><span className="misen-mark" aria-hidden="true">M</span><span>Misen</span></header>
        <section className="conversation" aria-label="Conversation">
          <Conversation messages={messages} tools={tools} running={running} expandedRunId={expandedRunId} onToggle={runId => setExpandedRunId(value => value === runId ? undefined : runId)} output={state.output} activeRunId={state.runId} onCancel={cancel} />
          {state.status === 'FAIL' && <p className="error-note" role="alert">{state.error ?? '処理に失敗しました。'}</p>}
        </section>
      </main>
    </AssistantRuntimeProvider>
  )
}

const root = document.getElementById('root')
if (root) createRoot(root).render(<MisenApp />)
