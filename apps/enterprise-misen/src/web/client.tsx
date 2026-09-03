import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { AssistantRuntimeProvider, useAuiState, useExternalStoreRuntime, type ExternalStoreThreadListAdapter, type ThreadMessageLike } from '@assistant-ui/react'
import './client.css'
import { Thread } from './components/thread.js'
import { ThreadList } from './components/thread-list.js'
import { applyServerEvent, emptyThreadStore, failRun, RUN_START_FAILED_TEXT, SESSION_START_FAILED_TEXT, startRun, threadListThreads, threadStoreFromSession, type ServerEvent, type SessionSnapshot, type SessionSummary, type ThreadStore } from './thread-store.js'
import { beginSessionSelection, eventAppliesToActiveSession, isCurrentSessionSelection } from './session-events.js'

function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter(part => Boolean(part && typeof part === 'object' && (part as any).type === 'text')).map(part => String((part as any).text ?? '')).join('')
}

const Shell = () => {
  const isEmpty = useAuiState(s => s.thread.isEmpty)
  return <main className={`flex h-dvh min-h-0 bg-[#fbfaf8] ${isEmpty ? 'is-empty' : 'is-active'}`}><ThreadList /><section className="min-w-0 flex-1" aria-label="会話"><Thread /></section></main>
}

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
    try {
      const response = await fetch('/state')
      if (response.ok) handleEvent({ type: 'state', state: await response.json() as Extract<ServerEvent, { type: 'state' }>['state'] })
    } catch { /* the event stream remains authoritative */ }
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
    void (async () => {
      try {
        const available = await refreshHistory()
        if (cancelled) return
        const remembered = globalThis.localStorage?.getItem('misen.activeSessionId') ?? undefined
        const target = available.find(session => session.id === remembered)?.id ?? available[0]?.id
        if (target) await openSession(target)
      } finally { if (!cancelled) setHistoryReady(true) }
    })()
    return () => { cancelled = true }
  }, [openSession, refreshHistory])

  useEffect(() => {
    const source = new EventSource('/events')
    const receive = (event: MessageEvent<string>) => { try { handleEvent(JSON.parse(event.data) as ServerEvent) } catch { /* ignore malformed event */ } }
    for (const type of ['state', 'status', 'user', 'assistant', 'tool']) source.addEventListener(type, receive)
    source.onerror = () => { /* browser reconnects without exposing provider data */ }
    return () => { source.close() }
  }, [handleEvent])

  const sessionId = store.sessionId
  const status = store.status
  useEffect(() => {
    if (!sessionId || status === 'idle' || status === 'running') return
    void (async () => { await refreshHistory(); await openSession(sessionId) })()
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
    } catch { setStore(previous => failRun(previous, RUN_START_FAILED_TEXT)) }
  }, [createSession, readOnly, running])

  const cancel = useCallback(async () => { try { await fetch('/cancel', { method: 'POST', headers: { origin: globalThis.location.origin } }) } catch { /* connection close is folded through SSE */ } }, [])
  const threads = useMemo(() => threadListThreads(sessions), [sessions])
  const threadList = useMemo<ExternalStoreThreadListAdapter>(() => ({ threadId: sessionId, isLoading: !historyReady, threads, onSwitchToNewThread: async () => { await createSession() }, onSwitchToThread: async id => { await openSession(id) } }), [createSession, historyReady, openSession, sessionId, threads])
  const runtime = useExternalStoreRuntime<ThreadMessageLike>({ messages: store.messages, convertMessage, isRunning: running, isDisabled: readOnly, isSendDisabled: running || readOnly || !historyReady, onNew: send, onCancel: cancel, adapters: { threadList } })
  return <AssistantRuntimeProvider runtime={runtime}><Shell /></AssistantRuntimeProvider>
}

const root = document.getElementById('root')
if (root) createRoot(root).render(<MisenApp />)
