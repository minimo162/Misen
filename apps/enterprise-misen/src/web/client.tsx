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
import { beginSessionSelection, eventAppliesToActiveSession, isCurrentSessionSelection } from './session-events.js'

type UiMessage = {
  id: string
  role: 'user' | 'assistant'
  text: string
  optimistic?: boolean
}

type UiState = {
  status: 'idle' | 'running' | 'COMPLETED' | 'FAIL' | 'CANCELLED'
  runId?: string
  sessionId?: string
  artifacts: UiArtifact[]
  error?: string
}

type UiArtifact = { id: string; runId: string; filename: string; available: boolean }

type SessionStatus = 'NEW' | 'RUNNING' | 'COMPLETED' | 'FAIL' | 'CANCELLED'
type SessionSummary = { id: string; title: string; createdAt: string; updatedAt: string; status: SessionStatus }
type UiSession = SessionSummary & { messages: UiMessage[]; tools: ToolEvent[]; artifacts: UiArtifact[] }

type ServerEvent =
  | { type: 'state'; state: UiState & { tools: string[]; axes: string[] } }
  | { type: 'user'; sessionId?: string; id: string; text: string }
  | { type: 'assistant'; sessionId?: string; text: string; done?: boolean }
  | { type: 'tool'; sessionId?: string; phase: 'start' | 'end'; id: string; name: string; detail?: string; status?: 'success' | 'error' }
  | { type: 'status'; sessionId?: string; status: 'running' | 'COMPLETED' | 'FAIL' | 'CANCELLED'; error?: string }

const TOOL_PRESENTATION: Record<string, string> = {
  workspace_list_files: 'ファイル一覧を確認',
  workspace_read_text: '業務ガイドを確認',
  spreadsheet_read: 'Excelを確認',
  spreadsheet_create_output: 'Excelを作成',
  spreadsheet_update: 'Excelを更新',
}

function Icon({ name, className }: { name: 'send' | 'stop' | 'running' | 'success' | 'error' | 'chevron-right' | 'chevron-down' | 'file' | 'open' | 'back' | 'plus'; className?: string }) {
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
  if (name === 'plus') return <svg {...common}><path d="M10 4v12M4 10h12" /></svg>
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

function Composer({ running, readOnly, onCancel }: { running: boolean; readOnly: boolean; onCancel: () => void }) {
  return (
    <ComposerPrimitive.Root className="composer" compact={false}>
      <ComposerPrimitive.Input aria-label="依頼" placeholder={readOnly ? '過去の会話は閲覧のみです' : '何をお手伝いしましょう？'} submitMode="enter" maxRows={8} disabled={readOnly} />
      {running ? (
        <button className="composer-action composer-action--stop" type="button" onClick={onCancel} aria-label="停止"><Icon name="stop" /></button>
      ) : (
        <ComposerPrimitive.Send className="composer-action" type="submit" aria-label="送信"><Icon name="send" /></ComposerPrimitive.Send>
      )}
    </ComposerPrimitive.Root>
  )
}

function Artifacts({ artifacts }: { artifacts: readonly UiArtifact[] }) {
  return <>{artifacts.map(artifact => artifact.available
    ? <a key={artifact.id} className="artifact-row" href={`/download/${encodeURIComponent(artifact.id)}`} download aria-label={`${artifact.filename}をダウンロード`}><Icon name="file" className="artifact-icon" /><span>{artifact.filename}</span><Icon name="open" className="artifact-arrow" /></a>
    : <span key={`${artifact.runId}-${artifact.filename}`} className="artifact-row artifact-row--unavailable" aria-label={`${artifact.filename}は利用できません`}><Icon name="file" className="artifact-icon" /><span>{artifact.filename}</span><small>利用できません</small></span>)}</>
}

function groupLabel(updatedAt: string): string {
  const updated = new Date(updatedAt)
  const today = new Date()
  const startToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()
  const startUpdated = new Date(updated.getFullYear(), updated.getMonth(), updated.getDate()).getTime()
  const days = Math.round((startToday - startUpdated) / 86_400_000)
  if (days === 0) return '今日'
  if (days === 1) return '昨日'
  return new Intl.DateTimeFormat('ja-JP', { month: 'numeric', day: 'numeric' }).format(updated)
}

function updatedLabel(updatedAt: string): string {
  const updated = new Date(updatedAt)
  return groupLabel(updatedAt) === '今日'
    ? new Intl.DateTimeFormat('ja-JP', { hour: '2-digit', minute: '2-digit' }).format(updated)
    : new Intl.DateTimeFormat('ja-JP', { month: 'numeric', day: 'numeric' }).format(updated)
}

function HistoryPanel({ sessions, activeId, disabled, onNew, onSelect }: {
  sessions: SessionSummary[]
  activeId?: string
  disabled: boolean
  onNew: () => void
  onSelect: (id: string) => void
}) {
  let priorGroup = ''
  return <aside className="history-panel" aria-label="会話履歴">
    <div className="history-brand"><span className="misen-mark" aria-hidden="true">M</span><span>Misen</span></div>
    <button className="new-chat" type="button" onClick={onNew} disabled={disabled}><Icon name="plus" /><span>新しいチャット</span></button>
    <div className="history-list">
      {sessions.length === 0 && <p className="history-empty">会話履歴はまだありません</p>}
      {sessions.map(session => {
        const group = groupLabel(session.updatedAt)
        const showGroup = group !== priorGroup
        priorGroup = group
        return <Fragment key={session.id}>
          {showGroup && <h2 className="history-group">{group}</h2>}
          <button className={`history-row${activeId === session.id ? ' history-row--active' : ''}`} type="button" onClick={() => onSelect(session.id)} disabled={disabled} aria-current={activeId === session.id ? 'page' : undefined}>
            <span className="history-title">{session.title}</span>
            <time dateTime={session.updatedAt}>{updatedLabel(session.updatedAt)}</time>
          </button>
        </Fragment>
      })}
    </div>
    <p className="local-only-note">このPCにのみ保存</p>
  </aside>
}

function Conversation({ messages, tools, running, readOnly, expandedRunId, onToggle, artifacts, activeRunId, onCancel }: {
  messages: UiMessage[]
  tools: ToolEvent[]
  running: boolean
  readOnly: boolean
  expandedRunId?: string
  onToggle: (runId: string) => void
  artifacts: UiArtifact[]
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
              const runArtifacts = artifacts.filter(artifact => artifact.runId === runId)
              const runIsActive = running && activeRunId === runId
              const afterLastUser = message.role === 'user' && message.id === messages.at(-1)?.id && !messages.some(item => item.id === `assistant-${runId}`)
              return <Fragment key={message.id}>
                {beforeAssistant && <ProcessRows tools={runTools} running={runIsActive} expanded={expandedRunId === runId} onToggle={() => onToggle(runId)} />}
                {message.role === 'user' ? <UserMessage /> : <><AssistantMessage /><Artifacts artifacts={runArtifacts} /></>}
                {afterLastUser && <ProcessRows tools={runTools} running={runIsActive} expanded={expandedRunId === runId} onToggle={() => onToggle(runId)} />}
                {afterLastUser && showThinking && <div className="thinking-status" role="status"><span className="thinking-dot" aria-hidden="true">•</span>考えています…</div>}
              </Fragment>
            }}
          </ThreadPrimitive.Messages>
        </div>
        <ThreadPrimitive.ViewportFooter className="composer-region">
          <ThreadPrimitive.ScrollToBottom className="back-to-bottom" aria-label="最新のメッセージへ移動"><Icon name="back" /></ThreadPrimitive.ScrollToBottom>
          {readOnly && <p className="read-only-note">過去の会話は閲覧のみです。続きは「新しいチャット」から開始してください。</p>}
          <Composer running={running} readOnly={readOnly} onCancel={onCancel} />
        </ThreadPrimitive.ViewportFooter>
      </ThreadPrimitive.Viewport>
    </ThreadPrimitive.Root>
  )
}

function MisenApp() {
  const [messages, setMessages] = useState<UiMessage[]>([])
  const [tools, setTools] = useState<ToolEvent[]>([])
  const [state, setState] = useState<UiState>({ status: 'idle', artifacts: [] })
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string | undefined>()
  const [historyReady, setHistoryReady] = useState(false)
  const [expandedRunId, setExpandedRunId] = useState<string | undefined>()
  const runIdRef = useRef<string | undefined>(undefined)
  const activeSessionIdRef = useRef<string | undefined>(undefined)
  const sessionSelectionRef = useRef({ revision: 0 })
  const eventSourceRef = useRef<EventSource | null>(null)

  const running = state.status === 'running'
  const hasConversation = messages.length > 0
  const readOnly = hasConversation && !running

  const openSession = useCallback(async (id: string) => {
    const selection = beginSessionSelection(sessionSelectionRef.current)
    const response = await fetch(`/sessions/${encodeURIComponent(id)}`)
    if (!response.ok) return false
    const session = await response.json() as UiSession
    if (!isCurrentSessionSelection(sessionSelectionRef.current, selection)) return false
    activeSessionIdRef.current = session.id
    runIdRef.current = undefined
    setActiveSessionId(session.id)
    globalThis.localStorage?.setItem('misen.activeSessionId', session.id)
    setMessages(session.messages)
    setTools(session.tools)
    setExpandedRunId(undefined)
    setState({
      status: session.status === 'NEW' ? 'idle' : session.status === 'RUNNING' ? 'FAIL' : session.status,
      sessionId: session.id,
      artifacts: session.artifacts,
      error: session.status === 'RUNNING' ? '前回の処理は完了していません。' : undefined,
    })
    return true
  }, [])

  const refreshHistory = useCallback(async () => {
    const response = await fetch('/sessions')
    if (!response.ok) return []
    const next = await response.json() as SessionSummary[]
    setSessions(next)
    return next
  }, [])

  const createSession = useCallback(async () => {
    const selection = beginSessionSelection(sessionSelectionRef.current)
    const response = await fetch('/sessions', { method: 'POST', headers: { origin: globalThis.location.origin } })
    if (!response.ok) throw new Error('session')
    const session = await response.json() as UiSession
    if (!isCurrentSessionSelection(sessionSelectionRef.current, selection)) return activeSessionIdRef.current
    activeSessionIdRef.current = session.id
    runIdRef.current = undefined
    setActiveSessionId(session.id)
    globalThis.localStorage?.setItem('misen.activeSessionId', session.id)
    setMessages([])
    setTools([])
    setExpandedRunId(undefined)
    setState({ status: 'idle', sessionId: session.id, artifacts: [] })
    await refreshHistory()
    return session.id
  }, [refreshHistory])

  const handleEvent = useCallback((event: ServerEvent) => {
    if (!eventAppliesToActiveSession(event, activeSessionIdRef.current)) return
    if (event.type === 'state') {
      if (event.state.runId) runIdRef.current = event.state.runId
      setState({ status: event.state.status, runId: event.state.runId, sessionId: event.state.sessionId, artifacts: event.state.artifacts, error: event.state.error })
      return
    }
    if (event.type === 'status') {
      setState(previous => ({ ...previous, status: event.status, error: event.error }))
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
    let cancelled = false
    const load = async () => {
      try {
        const available = await refreshHistory()
        if (cancelled) return
        const remembered = globalThis.localStorage?.getItem('misen.activeSessionId') ?? undefined
        const target = available.find(session => session.id === remembered)?.id ?? available[0]?.id
        if (target) await openSession(target)
      } finally {
        if (!cancelled) setHistoryReady(true)
      }
    }
    void load()
    return () => { cancelled = true }
  }, [openSession, refreshHistory])

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

  useEffect(() => {
    if (!activeSessionId || state.status === 'idle' || state.status === 'running') return
    void (async () => {
      await refreshHistory()
      await openSession(activeSessionId)
    })()
  }, [activeSessionId, openSession, refreshHistory, state.status])

  const send = useCallback(async (append: { content?: unknown }) => {
    const text = contentText(append.content).trim()
    if (!text || running || readOnly) return
    let sessionId = activeSessionIdRef.current
    if (!sessionId) {
      try { sessionId = await createSession() } catch { setState(previous => ({ ...previous, status: 'FAIL', error: '新しいチャットを開始できませんでした。' })); return }
      if (!sessionId) return
    }
    const clientId = `client-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`
    runIdRef.current = clientId
    setMessages(previous => [...previous, { id: clientId, role: 'user', text, optimistic: true }])
    setExpandedRunId(undefined)
    setState(previous => ({ status: 'running', runId: clientId, artifacts: previous.artifacts }))
    try {
      const response = await fetch('/run', { method: 'POST', headers: { origin: globalThis.location.origin, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ prompt: text, clientId, sessionId }) })
      if (!response.ok && response.status !== 202) setState(previous => ({ ...previous, status: 'FAIL', error: '依頼を開始できませんでした。' }))
    } catch {
      setState(previous => ({ ...previous, status: 'FAIL', error: '依頼を開始できませんでした。' }))
    }
  }, [createSession, readOnly, running])

  const cancel = useCallback(async () => {
    try { await fetch('/cancel', { method: 'POST', headers: { origin: globalThis.location.origin } }) } catch { /* connection close is handled by SSE */ }
  }, [])

  const runtime = useExternalStoreRuntime<UiMessage>({
    messages,
    convertMessage: toThreadMessage,
    isRunning: running,
    isSendDisabled: running || readOnly || !historyReady,
    onNew: send,
    onCancel: cancel,
  })

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <main className={`misen-shell ${hasConversation ? 'misen-shell--active' : 'misen-shell--empty'}`}>
        <HistoryPanel sessions={sessions} activeId={activeSessionId} disabled={running || !historyReady} onNew={() => { void createSession() }} onSelect={id => { void openSession(id) }} />
        <section className="conversation" aria-label="Conversation">
          <Conversation messages={messages} tools={tools} running={running} readOnly={readOnly} expandedRunId={expandedRunId} onToggle={runId => setExpandedRunId(value => value === runId ? undefined : runId)} artifacts={state.artifacts} activeRunId={state.runId} onCancel={cancel} />
          {state.status === 'FAIL' && <p className="error-note" role="alert">{state.error ?? '処理に失敗しました。'}</p>}
        </section>
      </main>
    </AssistantRuntimeProvider>
  )
}

const root = document.getElementById('root')
if (root) createRoot(root).render(<MisenApp />)
