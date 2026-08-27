/// <reference lib="dom" />

// The default UI is intentionally a presentation adapter. The server remains the
// owner of transport, tool validation, approval, execution, and audit events.
// This file uses assistant-ui's external-store runtime only to render messages
// and compose the next user request; it does not register client-side tools.

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useAui,
  useExternalStoreRuntime
} from '@assistant-ui/react'
import type { AppendMessage, ExternalStoreAdapter, ThreadMessageLike } from '@assistant-ui/react'

import './styles.css'

const h = React.createElement

type Role = 'user' | 'assistant'
type UiMessage = { id: string; role: Role; content: string; createdAt?: number }
type SessionSummary = {
  id: string
  title: string
  runCount?: number
  latestRun?: RunSnapshot | null
}
type RunEvent = {
  sequence: number
  type: string
  tool?: string
  summary?: string
  approved?: boolean
  durationMs?: number
  metadata?: Record<string, unknown> | null
}
type RunSnapshot = {
  id: string
  sessionId: string
  parentRunId?: string
  title?: string
  request?: string
  mode?: 'work' | 'research' | 'chat'
  status: string
  phase?: string
  currentStep?: string
  nextAction?: string
  completedSteps?: number
  plan?: Array<{ id: string; title: string; status: string }>
  events?: RunEvent[]
  changedFiles?: Array<{ path: string; changed: boolean; status: string; readBack?: boolean; addedLines?: number; removedLines?: number }>
  artifacts?: Array<{ id: string; name: string; type: string; url?: string }>
  verification?: { machinePassed?: boolean; userConfirmed?: boolean; checks?: Array<{ id: string; label: string; status: string; evidence?: string }> }
  budget?: { hostExecutions?: number }
  policy?: { maxHostExecutions?: number }
}
type Approval = {
  id: string
  runId?: string
  stepId?: string
  toolName?: string
  question?: string
  risk?: string
  scope?: string
  expiresAt?: number
  binding?: { path?: string; command?: string }
}

const TERMINAL = new Set(['verified', 'rolled_back', 'failed', 'canceled', 'paused', 'waiting_user', 'applied_unverified'])
const STATUS_LABEL: Record<string, string> = {
  queued: '開始待ち', planning: '計画中', running: '実行中', waiting_approval: '確認待ち',
  waiting_user: '利用者の確認待ち', paused: '一時停止', canceling: 'キャンセル中',
  canceled: 'キャンセル済み', failed: '失敗', applied_unverified: '適用済み・未検証',
  verifying: '検証中', verified: '検証済み', rolled_back: 'ロールバック済み'
}
const MODE_LABEL: Record<string, string> = { work: '作業', research: '調査', chat: '回答' }
const MODE_HELP: Record<string, string> = {
  work: 'このPCの許可済みツールを使います',
  research: 'Copilot内で調べます。PCのファイルは変更しません',
  chat: 'ツールを使わずに回答します'
}
const TOOL_LABEL: Record<string, string> = {
  list_files: 'ファイル一覧を確認', read_file: 'ファイルを読み取り', read_files: 'ファイルを読み取り',
  read_xlsx: 'Excelを読み取り', write_file: 'ファイルへ書き込み', edit_file: 'ファイルを更新',
  search_files: 'ファイルを検索', run_command: 'ファイルを開く', start_process: 'ファイルを開く',
  read_process_log: '実行結果を確認', stop_process: '実行を停止', get_weather: '天気を確認'
}
const PHASE_LABEL: Record<string, string> = { request: '受付', plan: '計画', inspect: '調査', edit: '編集', verify: '検証', finalize: '完了' }
PHASE_LABEL['execute'] = '実行'

const TASK_PATHS = [
  { id: 'list', label: '一覧', text: 'このフォルダのファイル一覧を確認して' },
  { id: 'read', label: '読み取り', text: 'README.mdを読み取って要点を教えて' },
  { id: 'search', label: '検索', text: '「請求」という語をファイルから検索して' },
  { id: 'write', label: '新規作成', text: '新しいメモ.txtを作成して内容を書き込んで' },
  { id: 'open', label: 'ファイルを開く', text: '集計台帳.xlsxを既定アプリで開いて' }
]

function bareTool(value: unknown): string {
  return String(value ?? '').replace(/^host\./, '').replace(/^native\./, '')
}

function friendlyTool(value: unknown): string {
  return TOOL_LABEL[bareTool(value)] ?? '作業を進行'
}

function friendlyEvent(event: RunEvent): { text: string; state: 'running' | 'success' | 'warning' | 'neutral' } | null {
  const tool = bareTool(event.tool)
  if (event.type === 'tool.started' || event.type === 'step.started') return { text: friendlyTool(tool), state: 'running' }
  if (event.type === 'tool.succeeded' || event.type === 'step.completed') return { text: `${friendlyTool(tool)}しました`, state: 'success' }
  if (event.type === 'tool.failed' || event.type === 'step.failed') return { text: `${friendlyTool(tool)}を確認中`, state: 'warning' }
  if (event.type === 'approval.requested') return { text: '許可を確認しています', state: 'warning' }
  if (event.type === 'approval.resolved') return { text: event.approved ? '許可を受け取りました' : '拒否を受け取りました', state: event.approved ? 'success' : 'warning' }
  if (event.type === 'plan.created') return { text: '作業の段取りを作成しました', state: 'neutral' }
  if (event.type === 'run.warning') return { text: '安全上限により停止しました', state: 'warning' }
  if (event.type === 'verification.started') return { text: '変更後の状態を検証しています', state: 'running' }
  if (event.type === 'verification.completed') return { text: '検証結果をまとめました', state: 'success' }
  if (event.type === 'run.created') return { text: '依頼を受け付けました', state: 'neutral' }
  return null
}

function safeApprovalText(value: unknown): string {
  if (typeof value !== 'string') return ''
  const normalized = value.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim()
  return normalized.length > 320 ? `${normalized.slice(0, 320)}…` : normalized
}

function approvalTarget(approval: Approval): string {
  const path = safeApprovalText(approval.binding?.path)
  if (path) return `対象パス: ${path}`
  const command = safeApprovalText(approval.binding?.command)
  if (command) return `実行内容: ${command}`
  const question = safeApprovalText(approval.question)
  return question ? `確認内容: ${question}` : '対象の詳細はサーバーで確認してください'
}

function formatTime(value?: number): string {
  if (!value) return ''
  return new Date(value).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: { accept: 'application/json' } })
  const body = await response.json().catch(() => ({})) as T & { error?: string }
  if (!response.ok) throw new Error(typeof body?.error === 'string' ? body.error : `HTTP ${response.status}`)
  return body
}

async function postJson<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body ?? {})
  })
  const payload = await response.json().catch(() => ({})) as T & { error?: string }
  if (!response.ok) throw new Error(typeof payload?.error === 'string' ? payload.error : `HTTP ${response.status}`)
  return payload
}

function messageText(message: { content?: unknown }): string {
  if (typeof message.content === 'string') return message.content.trim()
  if (!Array.isArray(message.content)) return ''
  return message.content
    .filter((part) => part && typeof part === 'object' && (part as { type?: string }).type === 'text')
    .map((part) => String((part as { text?: unknown }).text ?? ''))
    .join('')
    .trim()
}

function messageFromServer(role: unknown, content: unknown, id: string, index: number): UiMessage | null {
  if ((role !== 'user' && role !== 'assistant') || typeof content !== 'string') return null
  return { id: `${id}-${index}`, role, content, createdAt: Date.now() }
}

function MessageView({ message }: { message: { role: Role } }): React.ReactElement {
  return h(MessagePrimitive.Root, { className: `aui-message aui-${message.role}` },
    h('div', { className: 'aui-message-inner' },
      h('span', { className: 'aui-message-label' }, message.role === 'user' ? 'あなた' : 'アシスタント'),
      h(MessagePrimitive.Parts, {
        components: {
          // Server-side AgentEvent progress is rendered separately below. A
          // defensive override keeps unknown tool parts out of the demo view.
          tools: { Override: () => null }
        }
      })
    )
  )
}

type MessageRenderValue = { message: { role: Role } }
const MessageList = ThreadPrimitive.Messages as unknown as React.ComponentType<{
  children: (value: MessageRenderValue) => React.ReactNode
}>

function useComposerSuggestion(): (text: string) => void {
  const aui = useAui()
  return useCallback((text: string) => {
    // Use assistant-ui's public composer state so the controlled input and its
    // send affordance stay synchronized. This only stages text; it never sends.
    aui.composer.setText(text)
    const input = document.getElementById('composer-input')
    if (input instanceof HTMLElement) input.focus()
  }, [aui])
}

function Welcome(): React.ReactElement {
  const onTask = useComposerSuggestion()
  return h('section', { className: 'welcome', 'aria-labelledby': 'welcome-title' },
    h('p', { className: 'welcome-kicker' }, '社内コーディング支援'),
    h('h1', { id: 'welcome-title' }, '今日は何をしますか？'),
    h('p', { className: 'welcome-copy' }, 'ファイルの確認、検索、作成、ファイルを開く操作を日本語で依頼できます。'),
    h('div', { className: 'task-paths', 'aria-label': 'よく使う依頼' },
      TASK_PATHS.map((task) => h('button', {
        key: task.id,
        type: 'button',
        className: 'task-path',
        onClick: () => onTask(task.text)
      }, h('span', { className: 'task-path-label' }, task.label), h('span', { className: 'task-path-text' }, task.text)))
    )
  )
}

function ProgressPanel({ run }: { run: RunSnapshot | null }): React.ReactElement | null {
  const events = (run?.events ?? []).map(friendlyEvent).filter((item): item is NonNullable<ReturnType<typeof friendlyEvent>> => Boolean(item))
  const recent = events.slice(-12)
  if (!run || recent.length === 0) return null
  return h('details', { className: 'progress-panel', open: run.status === 'running' || run.status === 'waiting_approval' },
    h('summary', { className: 'progress-summary' },
      h('span', { className: 'progress-summary-mark', 'aria-hidden': 'true' }, run.status === 'running' ? '◌' : '✓'),
      h('span', null, run.status === 'running' ? '作業の進み具合' : '作業の記録'),
      h('span', { className: 'progress-summary-count' }, `${recent.length}件`)
    ),
    h('ol', { className: 'progress-list', 'aria-label': '作業の進み具合' },
      recent.map((item, index) => h('li', { key: `${run.id}-${index}`, className: `progress-item ${item.state}` },
        h('span', { className: 'progress-icon', 'aria-hidden': 'true' }, item.state === 'success' ? '✓' : item.state === 'warning' ? '!' : item.state === 'running' ? '◌' : '·'),
        h('span', null, item.text)
      ))
    )
  )
}

function ApprovalPanel({ approvals, onResolve }: { approvals: Approval[]; onResolve: (approval: Approval, approved: boolean) => void }): React.ReactElement | null {
  if (!approvals.length) return null
  return h('section', { className: 'approval-panel', 'aria-live': 'assertive', 'aria-label': '操作の許可' },
    h('div', { className: 'approval-heading' }, h('strong', null, '操作の許可が必要です'), h('span', null, '内容を確認してください')),
    approvals.slice(0, 4).map((approval) => h('div', { className: 'approval-card', key: approval.id },
      h('p', { className: 'approval-question' }, `${friendlyTool(approval.toolName)}を行います。許可しますか？`),
      h('p', { className: 'approval-scope approval-target' }, approvalTarget(approval)),
      h('p', { className: 'approval-scope' }, approval.scope ? `許可範囲: ${safeApprovalText(approval.scope)}` : '許可範囲を確認してください'),
      h('div', { className: 'approval-actions' },
        h('button', { type: 'button', className: 'approval-allow', onClick: () => onResolve(approval, true) }, '許可'),
        h('button', { type: 'button', className: 'approval-deny', onClick: () => onResolve(approval, false) }, '拒否')
      )
    ))
  )
}

function RunSummary({ run, onAction }: { run: RunSnapshot | null; onAction: (action: string) => void }): React.ReactElement | null {
  if (!run) return null
  const status = STATUS_LABEL[run.status] ?? '実行中'
  const terminal = TERMINAL.has(run.status)
  const phase = PHASE_LABEL[run.phase ?? ''] ?? ''
  const progress = Math.min(100, Math.round(((run.completedSteps ?? 0) / Math.max(1, run.plan?.length ?? 6)) * 100))
  return h('section', { className: `run-summary ${run.status}`, 'aria-live': 'polite' },
    h('div', { className: 'run-summary-top' },
      h('div', { className: 'run-summary-copy' },
        h('span', { className: 'run-eyebrow' }, run.mode ? `${MODE_LABEL[run.mode]}モード` : '現在の作業'),
        h('strong', { className: 'run-title' }, run.title || run.request || '現在の作業'),
        h('span', { className: 'run-meta' }, `${status}${phase ? ` · ${phase}` : ''}`)
      ),
      h('span', { className: 'run-status' }, status)
    ),
    h('div', { className: 'run-progress', 'aria-label': `作業の進捗 ${progress}%` }, h('span', { style: { width: `${progress}%` } })),
    !terminal ? h('div', { className: 'run-actions' },
      h('button', { type: 'button', className: 'run-action', onClick: () => onAction('pause'), disabled: run.status === 'waiting_approval' }, '一時停止'),
      h('button', { type: 'button', className: 'run-action danger', onClick: () => onAction('cancel') }, 'キャンセル')
    ) : h('div', { className: 'run-actions' },
      (run.status === 'applied_unverified' || run.status === 'waiting_user') ? h('button', { type: 'button', className: 'run-action primary', onClick: () => onAction('verify') }, '検証を実行') : null,
      run.status === 'waiting_user' ? h('button', { type: 'button', className: 'run-action primary', onClick: () => onAction('confirm') }, '確認済みで完了') : null,
      run.status === 'paused' ? h('button', { type: 'button', className: 'run-action primary', onClick: () => onAction('resume') }, '再開') : null,
      (run.status === 'failed' || run.status === 'canceled') ? h('button', { type: 'button', className: 'run-action', onClick: () => onAction('retry') }, '再試行') : null
    )
  )
}

function Sidebar({ sessions, activeId, onNew, onSelect }: { sessions: SessionSummary[]; activeId: string; onNew: () => void; onSelect: (id: string) => void }): React.ReactElement {
  return h('aside', { className: 'sidebar', 'aria-label': 'セッション' },
    h('div', { className: 'brand' }, h('span', { className: 'brand-mark', 'aria-hidden': 'true' }, '◎'), h('span', null, '社内アシスタント')),
    h('button', { type: 'button', className: 'new-session', onClick: onNew }, '＋ 新しいチャット'),
    h('div', { className: 'sidebar-heading' }, '最近のチャット'),
    h('nav', { className: 'session-list', 'aria-label': 'チャット一覧' },
      sessions.map((session) => h('button', {
        type: 'button', key: session.id, className: `session-item ${session.id === activeId ? 'active' : ''}`,
        onClick: () => onSelect(session.id)
      }, h('span', { className: 'session-title' }, session.title || '新しいセッション'), h('span', { className: 'session-status' }, session.latestRun ? (STATUS_LABEL[session.latestRun.status] ?? '記録あり') : '待機中')))
    ),
    h('div', { className: 'sidebar-foot' }, h('a', { href: '/classic' }, '従来画面（classic）'), h('span', null, '安全な操作確認は別枠で表示します'))
  )
}

function Composer({ mode, setMode }: { mode: 'work' | 'research' | 'chat'; setMode: (mode: 'work' | 'research' | 'chat') => void }): React.ReactElement {
  const onSuggestion = useComposerSuggestion()
  return h('div', { className: 'composer-dock' },
    h('div', { className: 'mode-row' },
      h('label', { htmlFor: 'mode-select' }, 'モード'),
      h('select', { id: 'mode-select', value: mode, onChange: (event: React.ChangeEvent<HTMLSelectElement>) => setMode(event.target.value as 'work' | 'research' | 'chat') },
        h('option', { value: 'work' }, '作業（このPCのツール）'),
        h('option', { value: 'research' }, '調査（Copilot検索）'),
        h('option', { value: 'chat' }, '回答（ツールなし）')
      ),
      h('span', { className: 'mode-help' }, MODE_HELP[mode]),
      h('button', { type: 'button', className: 'small-suggestion', onClick: () => onSuggestion('今の作業状況を簡潔に教えて') }, '状況を確認')
    ),
    h(ComposerPrimitive.Root, { className: 'composer-form', compact: true },
      h(ComposerPrimitive.Input, { id: 'composer-input', 'aria-label': '依頼内容', placeholder: '日本語で依頼を入力…', submitMode: 'enter', rows: 1 }),
      h(ComposerPrimitive.Send, { className: 'composer-send', 'aria-label': '送信', title: '送信' }, '↑')
    ),
    h('p', { className: 'composer-note' }, 'Enterで送信、Shift+Enterで改行。ファイル変更やアプリ起動は許可を確認してから行います。')
  )
}

function App(): React.ReactElement {
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [activeId, setActiveId] = useState('')
  const [messages, setMessages] = useState<UiMessage[]>([])
  const [run, setRun] = useState<RunSnapshot | null>(null)
  const [approvals, setApprovals] = useState<Approval[]>([])
  const [mode, setMode] = useState<'work' | 'research' | 'chat'>('work')
  const [isRunning, setIsRunning] = useState(false)
  const [notice, setNotice] = useState('')

  const loadSessions = useCallback(async () => {
    const response = await getJson<{ active?: string; sessions?: SessionSummary[]; activeRun?: RunSnapshot | null }>('/api/sessions')
    const list = Array.isArray(response.sessions) ? response.sessions : []
    setSessions(list)
    const nextId = response.active || list[0]?.id || ''
    if (nextId && nextId !== activeId) await loadSession(nextId)
    if (response.activeRun) setRun(response.activeRun)
  }, [activeId])

  const loadSession = useCallback(async (id: string) => {
    const response = await getJson<{ id: string; messages?: Array<{ role: string; content: string }>; runs?: RunSnapshot[]; activeRun?: RunSnapshot | null }>(`/api/session?id=${encodeURIComponent(id)}`)
    const nextMessages = (response.messages ?? []).map((message, index) => messageFromServer(message.role, message.content, id, index)).filter((message): message is UiMessage => Boolean(message))
    setActiveId(id)
    setMessages(nextMessages)
    const nextRun = response.activeRun ?? response.runs?.[0] ?? null
    setRun(nextRun)
    if (nextRun?.mode) setMode(nextRun.mode)
  }, [])

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const response = await getJson<{ active?: string; sessions?: SessionSummary[] }>('/api/sessions')
        if (!alive) return
        const list = Array.isArray(response.sessions) ? response.sessions : []
        setSessions(list)
        const first = response.active || list[0]?.id
        if (first) await loadSession(first)
      } catch (error) {
        if (alive) setNotice('サーバーに接続できません。しばらくしてから再読み込みしてください。')
      }
    })()
    return () => { alive = false }
  }, [loadSession])

  useEffect(() => {
    const refresh = async () => {
      try {
        const response = await getJson<{ run?: RunSnapshot | null }>('/api/active-run')
        if (response.run && (!activeId || response.run.sessionId === activeId)) setRun(response.run)
      } catch {}
    }
    void refresh()
    const timer = window.setInterval(refresh, isRunning || (run && !TERMINAL.has(run.status)) ? 500 : 1500)
    return () => window.clearInterval(timer)
  }, [activeId, isRunning, run?.status])

  useEffect(() => {
    const refresh = async () => {
      try {
        const response = await getJson<{ approvals?: Approval[] }>('/api/approvals')
        setApprovals(Array.isArray(response.approvals) ? response.approvals : [])
      } catch {}
    }
    void refresh()
    const timer = window.setInterval(refresh, 900)
    return () => window.clearInterval(timer)
  }, [])

  const onNew = useCallback(async () => {
    try {
      const response = await postJson<{ id?: string }>('/api/sessions')
      const id = response.id
      if (id) await loadSession(id)
      setNotice('新しいチャットを開始しました。')
    } catch { setNotice('新しいチャットを開始できませんでした。') }
  }, [loadSession])

  const onSelect = useCallback(async (id: string) => {
    if (isRunning) return
    try { await loadSession(id) } catch { setNotice('チャットを読み込めませんでした。') }
  }, [isRunning, loadSession])

  const onResolve = useCallback(async (approval: Approval, approved: boolean) => {
    try {
      await postJson('/api/approvals/resolve', { id: approval.id, approved, ...(approved ? {} : { reason: '利用者が拒否しました' }) })
      setApprovals((current) => current.filter((item) => item.id !== approval.id))
      setNotice(approved ? '操作を許可しました。' : '操作を拒否しました。')
    } catch { setNotice('許可の反映に失敗しました。もう一度確認してください。') }
  }, [])

  const onAction = useCallback(async (action: string) => {
    if (!run) return
    try {
      const response = await postJson<{ run?: RunSnapshot }>(`/api/runs/${encodeURIComponent(run.id)}/${action}`, action === 'retry' || action === 'resume' ? { message: run.request } : action === 'verify' ? { profile: 'auto' } : undefined)
      if (response.run) setRun(response.run)
      setNotice(action === 'confirm' ? '利用者確認を記録しました。' : action === 'verify' ? '検証結果を取得しました。' : '操作を受け付けました。')
      void loadSessions()
    } catch (error) { setNotice(error instanceof Error ? error.message : '操作に失敗しました。') }
  }, [loadSessions, run])

  const onNewMessage = useCallback(async (append: { content?: unknown }) => {
    const text = messageText(append)
    if (!text || !activeId || isRunning) return
    const userMessage: UiMessage = { id: `local-${Date.now().toString(36)}`, role: 'user', content: text, createdAt: Date.now() }
    setMessages((current) => [...current, userMessage])
    setIsRunning(true)
    setNotice('')
    const parentRunId = run && TERMINAL.has(run.status) ? run.id : undefined
    try {
      const response = await postJson<{ reply?: string; run?: RunSnapshot; aborted?: boolean }>('/api/turn', { message: text, mode, sessionId: activeId, ...(parentRunId ? { parentRunId } : {}) })
      if (response.run) setRun(response.run)
      const reply = response.reply || (response.aborted ? '処理を中断しました。履歴は保持されています。' : '応答を受け取りました。')
      setMessages((current) => [...current, { id: `assistant-${Date.now().toString(36)}`, role: 'assistant', content: reply, createdAt: Date.now() }])
      void loadSessions()
    } catch (error) {
      setMessages((current) => [...current, { id: `assistant-error-${Date.now().toString(36)}`, role: 'assistant', content: '処理に失敗しました。内容を確認して、もう一度お試しください。', createdAt: Date.now() }])
      setNotice(error instanceof Error ? error.message : '処理に失敗しました。')
    } finally {
      setIsRunning(false)
    }
  }, [activeId, isRunning, loadSessions, mode, run])

  const adapter: ExternalStoreAdapter<UiMessage> = useMemo(() => ({
    messages,
    isRunning,
    isSendDisabled: isRunning || !activeId,
    convertMessage: (message: UiMessage): ThreadMessageLike => ({ id: message.id, role: message.role, content: message.content }),
    onNew: onNewMessage,
  }), [activeId, isRunning, messages, onNewMessage])
  const runtime = useExternalStoreRuntime<UiMessage>(adapter)

  return h(AssistantRuntimeProvider, { runtime },
    h('div', { className: 'app-shell' },
      h(Sidebar, { sessions, activeId, onNew, onSelect }),
      h('main', { className: 'main-panel' },
        h('header', { className: 'topbar' }, h('div', null, h('span', { className: 'topbar-kicker' }, '安全に確認しながら進めます'), h('strong', null, 'コーディングアシスタント')), h('a', { className: 'classic-link', href: '/classic' }, '従来画面')),
        h(RunSummary, { run, onAction }),
        h('div', { className: 'thread-region' },
          h(ThreadPrimitive.Root, { className: 'aui-thread' },
            h(ThreadPrimitive.Viewport, { className: 'aui-viewport', autoScroll: true, 'aria-label': '会話' },
              messages.length === 0 ? h(Welcome) : null,
              h(MessageList, { children: ({ message }: MessageRenderValue) => h(MessageView, { message }) }),
              h(ProgressPanel, { run }),
              h(ThreadPrimitive.ViewportFooter, null)
            )
          )
        ),
        h(ApprovalPanel, { approvals, onResolve }),
        h(Composer, { mode, setMode }),
        notice ? h('p', { className: 'notice', role: 'status' }, notice) : null
      )
    )
  )
}

const root = document.getElementById('app')
if (root) createRoot(root).render(h(App))
