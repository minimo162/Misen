import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { AssistantRuntimeProvider, useAuiState, useExternalStoreRuntime, type ExternalStoreThreadListAdapter, type ThreadMessageLike } from '@assistant-ui/react'
import './client.css'
import { Thread } from '@/components/assistant-ui/elements/thread.aui.js'
import { ThreadListItems, ThreadListNew, ThreadListRoot } from '@/components/assistant-ui/elements/thread-list.aui.js'
import { TooltipIconButton } from '@/components/assistant-ui/elements/tooltip-icon-button.js'
import { TooltipProvider } from '@/components/ui/tooltip.js'
import { MessageSquareIcon, PanelLeftIcon } from 'lucide-react'
import { misenAttachmentAdapter } from './attachment-adapter.js'
import { ProjectControls } from './project-controls.js'
import { applyServerEvent, emptyThreadStore, failRun, RUN_START_FAILED_TEXT, SESSION_START_FAILED_TEXT, startRun, threadListThreads, threadStoreFromSession, type AssistantCustomMetadata, type ServerEvent, type SessionSnapshot, type SessionSummary, type ThreadStore } from './thread-store.js'
import { beginSessionSelection, eventAppliesToActiveSession, isCurrentSessionSelection } from './session-events.js'

function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter(part => Boolean(part && typeof part === 'object' && (part as any).type === 'text')).map(part => String((part as any).text ?? '')).join('')
}

function importedPaths(attachments: unknown): string[] {
  if (!Array.isArray(attachments)) return []
  const paths: string[] = []
  for (const attachment of attachments) {
    const content = attachment && typeof attachment === 'object' ? (attachment as { content?: unknown }).content : undefined
    if (!Array.isArray(content)) continue
    for (const part of content) {
      const text = part && typeof part === 'object' && (part as { type?: unknown }).type === 'text' ? (part as { text?: unknown }).text : undefined
      const match = typeof text === 'string' ? /^持ち込んだファイル: (input\/[\p{L}\p{N} ._()\/-]+)$/u.exec(text) : undefined
      if (match) paths.push(match[1])
    }
  }
  return paths
}

const Shell = ({ running, onProjectChanged }: { running: boolean; onProjectChanged: () => Promise<void> }) => {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const title = useAuiState(s => s.threads.threadItems.find(thread => thread.id === s.threads.mainThreadId)?.title)
  return (
    <main className="bg-muted/30 text-foreground flex h-dvh min-h-0 overflow-hidden">
      <aside className={`${sidebarCollapsed ? 'w-0 opacity-0' : 'w-64'} flex shrink-0 flex-col overflow-hidden transition-[width,opacity] duration-200`} aria-hidden={sidebarCollapsed}>
        <div className="flex h-12 shrink-0 items-center gap-2 px-4 text-sm font-medium">
          <MessageSquareIcon className="size-5 shrink-0" aria-hidden />
          <span className="truncate">Misen</span>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          <ThreadListRoot>
            <ThreadListNew />
            <ThreadListItems />
          </ThreadListRoot>
        </div>
      </aside>
      <div className={`flex min-w-0 flex-1 flex-col overflow-hidden p-2 ${sidebarCollapsed ? '' : 'pl-0'}`}>
        <div className="bg-background flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg">
          <header className="flex h-12 shrink-0 items-center gap-2 px-4">
            <TooltipIconButton variant="ghost" size="icon" tooltip={sidebarCollapsed ? 'サイドバーを表示' : 'サイドバーを隠す'} side="bottom" onClick={() => setSidebarCollapsed(value => !value)} className="size-8 shrink-0">
              <PanelLeftIcon className="size-4" />
            </TooltipIconButton>
            <span className="min-w-0 truncate text-sm font-medium">{title ?? '新しいチャット'}</span>
          </header>
          <section className="min-h-0 min-w-0 flex-1 overflow-hidden" aria-label="会話"><Thread composerFooter={<ProjectControls running={running} onProjectChanged={onProjectChanged} />} /></section>
        </div>
      </div>
    </main>
  )
}

const artifactMimeType = (filename: string): string => {
  const extension = filename.split('.').at(-1)?.toLowerCase()
  if (extension === 'pdf') return 'application/pdf'
  if (extension === 'docx') return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  if (extension === 'xlsx') return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  if (extension === 'pptx') return 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
  return 'application/octet-stream'
}

const convertMessage = (message: ThreadMessageLike): ThreadMessageLike => {
  if (message.role !== 'assistant') return message
  const artifacts = (message.metadata?.custom as Partial<AssistantCustomMetadata> | undefined)?.artifacts?.filter(artifact => artifact.available)
  if (!artifacts?.length) return message
  const content = typeof message.content === 'string' ? [{ type: 'text' as const, text: message.content }] : message.content
  return { ...message, content: [...content, ...artifacts.map(artifact => ({ type: 'file' as const, filename: artifact.filename, mimeType: artifactMimeType(artifact.filename), sourceType: 'url' as const, data: new URL(`/download/${encodeURIComponent(artifact.id)}`, globalThis.location.origin).href }))] }
}

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

  const deleteSession = useCallback(async (id: string) => {
    const response = await fetch(`/sessions/${encodeURIComponent(id)}`, { method: 'DELETE', headers: { origin: globalThis.location.origin } })
    if (!response.ok) throw new Error('session delete')
    const available = await refreshHistory()
    if (activeSessionIdRef.current !== id) return
    const selection = beginSessionSelection(sessionSelectionRef.current)
    activeSessionIdRef.current = undefined
    globalThis.localStorage?.removeItem('misen.activeSessionId')
    const next = available[0]?.id
    if (next && isCurrentSessionSelection(sessionSelectionRef.current, selection)) await openSession(next)
    else if (isCurrentSessionSelection(sessionSelectionRef.current, selection)) setStore(emptyThreadStore())
  }, [openSession, refreshHistory])

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

  const send = useCallback(async (append: { content?: unknown; attachments?: unknown }) => {
    const text = contentText(append.content).trim()
    const imports = importedPaths(append.attachments)
    if ((!text && imports.length === 0) || running || readOnly) return
    const visibleText = text || '持ち込んだファイルを確認してください。'
    let targetSession = activeSessionIdRef.current
    if (!targetSession) {
      try { targetSession = await createSession() } catch { setStore(previous => failRun(previous, SESSION_START_FAILED_TEXT)); return }
      if (!targetSession) return
    }
    const clientId = `client-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`
    setStore(previous => startRun(previous, clientId, visibleText))
    try {
      const response = await fetch('/run', { method: 'POST', headers: { origin: globalThis.location.origin, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ prompt: visibleText, imports: JSON.stringify(imports), clientId, sessionId: targetSession }) })
      if (!response.ok && response.status !== 202) setStore(previous => failRun(previous, RUN_START_FAILED_TEXT))
    } catch { setStore(previous => failRun(previous, RUN_START_FAILED_TEXT)) }
  }, [createSession, readOnly, running])

  const cancel = useCallback(async () => { try { await fetch('/cancel', { method: 'POST', headers: { origin: globalThis.location.origin } }) } catch { /* connection close is folded through SSE */ } }, [])
  const projectChanged = useCallback(async () => {
    const selection = beginSessionSelection(sessionSelectionRef.current)
    activeSessionIdRef.current = undefined
    globalThis.localStorage?.removeItem('misen.activeSessionId')
    setStore(emptyThreadStore())
    if (isCurrentSessionSelection(sessionSelectionRef.current, selection)) await createSession()
  }, [createSession])
  const threads = useMemo(() => threadListThreads(sessions), [sessions])
  const threadList = useMemo<ExternalStoreThreadListAdapter>(() => ({ threadId: sessionId, isLoading: !historyReady, threads, onSwitchToNewThread: async () => { await createSession() }, onSwitchToThread: async id => { await openSession(id) }, onDelete: deleteSession }), [createSession, deleteSession, historyReady, openSession, sessionId, threads])
  const runtime = useExternalStoreRuntime<ThreadMessageLike>({ messages: store.messages, convertMessage, isRunning: running, isDisabled: readOnly, isSendDisabled: running || readOnly || !historyReady, onNew: send, onCancel: cancel, adapters: { threadList, attachments: misenAttachmentAdapter } })
  return <AssistantRuntimeProvider runtime={runtime}><TooltipProvider><Shell running={running} onProjectChanged={projectChanged} /></TooltipProvider></AssistantRuntimeProvider>
}

const root = document.getElementById('root')
if (root) createRoot(root).render(<MisenApp />)
