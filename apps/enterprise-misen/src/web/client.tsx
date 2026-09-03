import { useCallback, useEffect, useMemo, useRef, useState, type PropsWithChildren } from 'react'
import { createRoot } from 'react-dom/client'
import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  ErrorPrimitive,
  MessagePrimitive,
  MessagePartPrimitive,
  ThreadListItemPrimitive,
  ThreadListPrimitive,
  ThreadPrimitive,
  useAuiState,
  useExternalStoreRuntime,
  type ExternalStoreThreadListAdapter,
  type ThreadMessageLike,
  type ToolCallMessagePartProps,
} from '@assistant-ui/react'
import { MarkdownTextPrimitive } from '@assistant-ui/react-markdown'
import './client.css'
import {
  applyServerEvent,
  emptyThreadStore,
  failRun,
  RUN_START_FAILED_TEXT,
  SESSION_START_FAILED_TEXT,
  startRun,
  threadListThreads,
  threadStoreFromSession,
  updatedTimeLabel,
  type AssistantCustomMetadata,
  type ServerEvent,
  type SessionSnapshot,
  type SessionSummary,
  type ThreadListCustom,
  type ThreadStore,
  type ToolCallArgs,
} from './thread-store.js'
import { beginSessionSelection, eventAppliesToActiveSession, isCurrentSessionSelection } from './session-events.js'

const TOOL_PRESENTATION: Record<string, string> = {
  workspace_list_files: 'ファイル一覧を確認',
  workspace_read_text: '業務ガイドを確認',
  spreadsheet_read: 'Excelを確認',
  spreadsheet_create_output: 'Excelを作成',
  spreadsheet_update: 'Excelを更新',
  document_read: 'Wordを確認',
  document_create_output: 'Wordを作成',
  document_update: 'Wordを更新',
  presentation_read: 'PowerPointを確認',
  presentation_create_output: 'PowerPointを作成',
  presentation_update: 'PowerPointを更新',
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

// ---------------------------------------------------------------------------
// Message parts. Every component reads its own context through assistant-ui
// hooks; nothing is closed over from the application shell.
// ---------------------------------------------------------------------------

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

/** One allowlisted Tool call. Raw args/result JSON is never rendered; only the label and short summary. */
const ToolCallRow = (part: ToolCallMessagePartProps<ToolCallArgs, unknown>) => {
  const status = part.result === undefined ? 'running' : part.isError ? 'error' : 'success'
  const detail = typeof part.args?.detail === 'string' ? part.args.detail : undefined
  return (
    <div className={`process-row process-row--${status}`}>
      <span className="process-icon" aria-hidden="true"><Icon name={status} /></span>
      <span className="process-label">{TOOL_PRESENTATION[part.toolName] ?? '操作'}</span>
      {detail && <span className="process-detail">{detail}</span>}
    </div>
  )
}

/** Consecutive Tool calls fold into "N件の操作" once the message stops running. */
const ToolGroup = ({ startIndex, endIndex, children }: PropsWithChildren<{ startIndex: number; endIndex: number }>) => {
  const count = endIndex - startIndex + 1
  const running = useAuiState(s => s.message.status?.type === 'running')
  const [expanded, setExpanded] = useState(false)
  const toggle = () => setExpanded(value => !value)
  if (!running && !expanded) {
    return <button className="process-disclosure" type="button" onClick={toggle} aria-expanded="false"><span>{count}件の操作</span><Icon name="chevron-right" /></button>
  }
  return (
    <div className="process-stack" aria-label="操作履歴">
      {!running && <button className="process-disclosure process-disclosure--open" type="button" onClick={toggle} aria-expanded="true"><span>{count}件の操作</span><Icon name="chevron-down" /></button>}
      {children}
    </div>
  )
}

const PART_COMPONENTS = {
  Text: MarkdownTextPart,
  Reasoning: HiddenPart,
  Image: HiddenPart,
  File: HiddenPart,
  Source: HiddenPart,
  Unstable_Audio: HiddenPart,
  tools: { Fallback: ToolCallRow },
  ToolGroup,
}

const USER_PART_COMPONENTS = { ...PART_COMPONENTS, Text: TextPart }

/** Validated artifacts travel on `metadata.custom.artifacts`; downloads go only through `/download/:id`. */
const ArtifactRows = () => {
  const artifacts = useAuiState(s => (s.message.metadata.custom as Partial<AssistantCustomMetadata> | undefined)?.artifacts)
  if (!artifacts || artifacts.length === 0) return null
  return <>{artifacts.map(artifact => artifact.available
    ? <a key={artifact.id} className="artifact-row" href={`/download/${encodeURIComponent(artifact.id)}`} download aria-label={`${artifact.filename}をダウンロード`}><Icon name="file" className="artifact-icon" /><span>{artifact.filename}</span><Icon name="open" className="artifact-arrow" /></a>
    : <span key={`${artifact.runId}-${artifact.filename}`} className="artifact-row artifact-row--unavailable" aria-label={`${artifact.filename}は利用できません`}><Icon name="file" className="artifact-icon" /><span>{artifact.filename}</span><small>利用できません</small></span>)}</>
}

const UserMessage = () => (
  <MessagePrimitive.Root className="message message--user">
    <div className="user-bubble"><MessagePrimitive.Parts components={USER_PART_COMPONENTS} /></div>
  </MessagePrimitive.Root>
)

const AssistantMessage = () => (
  <MessagePrimitive.Root className="message message--assistant">
    <div className="assistant-copy">
      <MessagePrimitive.Parts components={PART_COMPONENTS} />
      <ThreadPrimitive.If running>
        <MessagePrimitive.If last hasContent={false}>
          <div className="thinking-status" role="status"><span className="thinking-dot" aria-hidden="true">•</span>考えています…</div>
        </MessagePrimitive.If>
      </ThreadPrimitive.If>
      <MessagePrimitive.Error>
        <ErrorPrimitive.Root className="error-note" role="alert"><ErrorPrimitive.Message /></ErrorPrimitive.Root>
      </MessagePrimitive.Error>
      <ArtifactRows />
    </div>
  </MessagePrimitive.Root>
)

// ---------------------------------------------------------------------------
// Composer and thread surface.
// ---------------------------------------------------------------------------

const Composer = () => {
  const readOnly = useAuiState(s => s.thread.isDisabled)
  return (
    <ComposerPrimitive.Root className="composer" compact={false}>
      <ComposerPrimitive.Input aria-label="依頼" placeholder={readOnly ? '過去の会話は閲覧のみです' : '何をお手伝いしましょう？'} submitMode="enter" maxRows={8} />
      <ThreadPrimitive.If running>
        <ComposerPrimitive.Cancel className="composer-action composer-action--stop" aria-label="停止"><Icon name="stop" /></ComposerPrimitive.Cancel>
      </ThreadPrimitive.If>
      <ThreadPrimitive.If running={false}>
        <ComposerPrimitive.Send className="composer-action" aria-label="送信"><Icon name="send" /></ComposerPrimitive.Send>
      </ThreadPrimitive.If>
    </ComposerPrimitive.Root>
  )
}

const Thread = () => (
  <ThreadPrimitive.Root className="thread-root">
    <ThreadPrimitive.Viewport className="thread-viewport" autoScroll turnAnchor="bottom">
      <div className="thread-content">
        <ThreadPrimitive.Empty>
          <div className="empty-hero" aria-hidden="true"><h1>Misen</h1></div>
        </ThreadPrimitive.Empty>
        <ThreadPrimitive.Messages>
          {({ message }) => message.role === 'user' ? <UserMessage /> : <AssistantMessage />}
        </ThreadPrimitive.Messages>
      </div>
      <ThreadPrimitive.ViewportFooter className="composer-region">
        <ThreadPrimitive.ScrollToBottom className="back-to-bottom" aria-label="最新のメッセージへ移動"><Icon name="back" /></ThreadPrimitive.ScrollToBottom>
        <ThreadPrimitive.If disabled>
          <p className="read-only-note">過去の会話は閲覧のみです。続きは「新しいチャット」から開始してください。</p>
        </ThreadPrimitive.If>
        <Composer />
      </ThreadPrimitive.ViewportFooter>
    </ThreadPrimitive.Viewport>
  </ThreadPrimitive.Root>
)

// ---------------------------------------------------------------------------
// Thread list (local-only conversation history).
// ---------------------------------------------------------------------------

const ThreadListRow = () => {
  const custom = useAuiState(s => s.threadListItem.custom as Partial<ThreadListCustom> | undefined)
  const isActive = useAuiState(s => s.threads.mainThreadId === s.threadListItem.id)
  const disabled = useAuiState(s => s.thread.isRunning || s.threads.isLoading)
  return (
    <ThreadListItemPrimitive.Root className="history-item">
      {custom?.showGroup && custom.group && <h2 className="history-group">{custom.group}</h2>}
      <ThreadListItemPrimitive.Trigger className={`history-row${isActive ? ' history-row--active' : ''}`} disabled={disabled} aria-current={isActive ? 'page' : undefined}>
        <span className="history-title"><ThreadListItemPrimitive.Title fallback="新しいチャット" /></span>
        {custom?.updatedAt && <time dateTime={custom.updatedAt}>{updatedTimeLabel(custom.updatedAt)}</time>}
      </ThreadListItemPrimitive.Trigger>
    </ThreadListItemPrimitive.Root>
  )
}

const ThreadListEmpty = () => {
  const isEmpty = useAuiState(s => s.threads.threadIds.length === 0 && !s.threads.isLoading)
  return isEmpty ? <p className="history-empty">会話履歴はまだありません</p> : null
}

const ThreadList = () => {
  const newDisabled = useAuiState(s => s.thread.isRunning || s.threads.isLoading)
  return (
    <ThreadListPrimitive.Root asChild>
      <aside className="history-panel" aria-label="会話履歴">
        <div className="history-brand"><span className="misen-mark" aria-hidden="true">M</span><span>Misen</span></div>
        <ThreadListPrimitive.New className="new-chat" disabled={newDisabled}><Icon name="plus" /><span>新しいチャット</span></ThreadListPrimitive.New>
        <div className="history-list">
          <ThreadListEmpty />
          <ThreadListPrimitive.Items>{() => <ThreadListRow />}</ThreadListPrimitive.Items>
        </div>
        <p className="local-only-note">このPCにのみ保存</p>
      </aside>
    </ThreadListPrimitive.Root>
  )
}

const Shell = () => {
  const isEmpty = useAuiState(s => s.thread.isEmpty)
  return (
    <main className={`misen-shell ${isEmpty ? 'misen-shell--empty' : 'misen-shell--active'}`}>
      <ThreadList />
      <section className="conversation" aria-label="Conversation"><Thread /></section>
    </main>
  )
}

// ---------------------------------------------------------------------------
// Runtime adapter: the single source of UI state. `/sessions`, `/run`,
// `/cancel`, and `/events` are owned here and folded into `ThreadStore`.
// ---------------------------------------------------------------------------

const convertMessage = (message: ThreadMessageLike): ThreadMessageLike => message

function MisenApp() {
  const [store, setStore] = useState<ThreadStore>(() => emptyThreadStore())
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [historyReady, setHistoryReady] = useState(false)
  const activeSessionIdRef = useRef<string | undefined>(undefined)
  const sessionSelectionRef = useRef({ revision: 0 })

  const running = store.status === 'running'
  const readOnly = store.messages.length > 0 && !running

  const handleEvent = useCallback((event: ServerEvent) => {
    if (!eventAppliesToActiveSession(event, activeSessionIdRef.current)) return
    setStore(previous => applyServerEvent(previous, event))
  }, [])

  const activateSession = useCallback(async (session: SessionSnapshot) => {
    activeSessionIdRef.current = session.id
    globalThis.localStorage?.setItem('misen.activeSessionId', session.id)
    setStore(threadStoreFromSession(session))
    // The SSE snapshot may have arrived before this session became active;
    // re-read the host state so a run still in progress resumes as running.
    try {
      const response = await fetch('/state')
      if (response.ok) handleEvent({ type: 'state', state: await response.json() as Extract<ServerEvent, { type: 'state' }>['state'] })
    } catch { /* the live stream remains authoritative */ }
  }, [handleEvent])

  const openSession = useCallback(async (id: string) => {
    const selection = beginSessionSelection(sessionSelectionRef.current)
    const response = await fetch(`/sessions/${encodeURIComponent(id)}`)
    if (!response.ok) return false
    const session = await response.json() as SessionSnapshot
    if (!isCurrentSessionSelection(sessionSelectionRef.current, selection)) return false
    await activateSession(session)
    return true
  }, [activateSession])

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
    const session = await response.json() as SessionSnapshot
    if (!isCurrentSessionSelection(sessionSelectionRef.current, selection)) return activeSessionIdRef.current
    await activateSession(session)
    await refreshHistory()
    return session.id
  }, [activateSession, refreshHistory])

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
    const receive = (event: MessageEvent<string>) => {
      try { handleEvent(JSON.parse(event.data) as ServerEvent) } catch { /* ignore malformed event */ }
    }
    for (const type of ['state', 'status', 'user', 'assistant', 'tool']) source.addEventListener(type, receive)
    source.onerror = () => { /* browser reconnects; no provider data is exposed */ }
    return () => { source.close() }
  }, [handleEvent])

  const sessionId = store.sessionId
  const status = store.status
  useEffect(() => {
    if (!sessionId || status === 'idle' || status === 'running') return
    void (async () => {
      await refreshHistory()
      await openSession(sessionId)
    })()
  }, [sessionId, openSession, refreshHistory, status])

  const send = useCallback(async (append: { content?: unknown }) => {
    const text = contentText(append.content).trim()
    if (!text || running || readOnly) return
    let targetSession = activeSessionIdRef.current
    if (!targetSession) {
      try { targetSession = await createSession() } catch { setStore(previous => failRun(previous, SESSION_START_FAILED_TEXT)); return }
      if (!targetSession) return
    }
    const clientId = `client-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`
    setStore(previous => startRun(previous, clientId, text))
    try {
      const response = await fetch('/run', { method: 'POST', headers: { origin: globalThis.location.origin, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ prompt: text, clientId, sessionId: targetSession }) })
      if (!response.ok && response.status !== 202) setStore(previous => failRun(previous, RUN_START_FAILED_TEXT))
    } catch {
      setStore(previous => failRun(previous, RUN_START_FAILED_TEXT))
    }
  }, [createSession, readOnly, running])

  const cancel = useCallback(async () => {
    try { await fetch('/cancel', { method: 'POST', headers: { origin: globalThis.location.origin } }) } catch { /* connection close is handled by SSE */ }
  }, [])

  const threads = useMemo(() => threadListThreads(sessions), [sessions])
  const threadList = useMemo<ExternalStoreThreadListAdapter>(() => ({
    threadId: sessionId,
    isLoading: !historyReady,
    threads,
    onSwitchToNewThread: async () => { await createSession() },
    onSwitchToThread: async id => { await openSession(id) },
  }), [createSession, historyReady, openSession, sessionId, threads])

  const runtime = useExternalStoreRuntime<ThreadMessageLike>({
    messages: store.messages,
    convertMessage,
    isRunning: running,
    isDisabled: readOnly,
    isSendDisabled: running || readOnly || !historyReady,
    onNew: send,
    onCancel: cancel,
    adapters: { threadList },
  })

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Shell />
    </AssistantRuntimeProvider>
  )
}

const root = document.getElementById('root')
if (root) createRoot(root).render(<MisenApp />)
