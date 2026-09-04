import { useEffect, useRef, useState } from 'react'
import { ChevronDownIcon, FolderIcon, FolderOpenIcon, InfoIcon } from 'lucide-react'

type ApprovalMode = 'confirm' | 'session-auto'
type ProjectInfo = { current: string; name: string; recent: { path: string; name: string }[]; running: boolean; approvalMode: ApprovalMode; provider: string; model: string }

async function messageFrom(response: Response, fallback: string): Promise<string> {
  return (await response.json().catch(() => ({})) as { error?: string }).error ?? fallback
}

export function ProjectControls({ running, onProjectChanged }: { running: boolean; onProjectChanged: () => Promise<void> }) {
  const [info, setInfo] = useState<ProjectInfo>()
  const [message, setMessage] = useState('')
  const projectMenu = useRef<HTMLDetailsElement>(null)
  const approvalMenu = useRef<HTMLDetailsElement>(null)
  const load = async () => { const response = await fetch('/project'); if (response.ok) setInfo(await response.json() as ProjectInfo) }
  useEffect(() => { void load() }, [])

  const switchProject = async (action: '/project/pick' | '/project/select', path?: string) => {
    setMessage('')
    const response = await fetch(action, { method: 'POST', headers: { origin: globalThis.location.origin, ...(path ? { 'content-type': 'application/json' } : {}) }, ...(path ? { body: JSON.stringify({ path }) } : {}) })
    projectMenu.current?.removeAttribute('open')
    if (response.status === 204) return
    if (!response.ok) { setMessage(await messageFrom(response, '作業フォルダーを切り替えられませんでした。')); return }
    await load()
    await onProjectChanged()
  }

  const setApproval = async (mode: ApprovalMode) => {
    const response = await fetch('/approval', { method: 'POST', headers: { origin: globalThis.location.origin, 'content-type': 'application/json' }, body: JSON.stringify({ mode }) })
    approvalMenu.current?.removeAttribute('open')
    if (!response.ok) { setMessage(await messageFrom(response, '承認設定を変更できませんでした。')); return }
    await load()
  }

  return (
    <div className="px-1">
      <div className="text-muted-foreground flex min-h-8 items-center gap-1 text-xs">
        <details ref={projectMenu} className="group relative">
          <summary className="hover:bg-muted focus-visible:ring-ring flex h-8 cursor-pointer list-none items-center gap-1 rounded-md px-2 outline-none focus-visible:ring-2 aria-disabled:pointer-events-none aria-disabled:opacity-50" aria-disabled={running} onClick={event => { if (running) { event.preventDefault(); setMessage('処理が終わってから切り替えてください。') } }}>
            <FolderIcon className="size-3.5" /><span className="max-w-36 truncate">{info?.name ?? 'プロジェクト'}</span><ChevronDownIcon className="size-3" />
          </summary>
          <div className="bg-popover text-popover-foreground border-border absolute bottom-9 left-0 z-50 min-w-64 rounded-md border p-1 shadow-md">
            <p className="text-muted-foreground px-2 py-1 text-[11px]">最近使ったフォルダー</p>
            {info?.recent.map(project => <button key={project.path} type="button" className="hover:bg-accent flex w-full items-center rounded-sm px-2 py-1.5 text-left text-sm" onClick={() => void switchProject('/project/select', project.path)}>{project.name}</button>)}
            <button type="button" className="hover:bg-accent flex w-full items-center rounded-sm px-2 py-1.5 text-left text-sm" onClick={() => void switchProject('/project/pick')}>フォルダーを選ぶ…</button>
            <div className="bg-border my-1 h-px" />
            <button type="button" className="hover:bg-accent flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm" onClick={() => { projectMenu.current?.removeAttribute('open'); void fetch('/project/open', { method: 'POST', headers: { origin: globalThis.location.origin } }) }}><FolderOpenIcon className="size-4" />エクスプローラーで開く</button>
          </div>
        </details>
        <details ref={approvalMenu} className="group relative">
          <summary className="hover:bg-muted focus-visible:ring-ring flex h-8 cursor-pointer list-none items-center gap-1 rounded-md px-2 outline-none focus-visible:ring-2">承認<ChevronDownIcon className="size-3" /></summary>
          <div className="bg-popover text-popover-foreground border-border absolute bottom-9 left-0 z-50 min-w-56 rounded-md border p-1 shadow-md">
            <button type="button" className="hover:bg-accent flex w-full justify-between rounded-sm px-2 py-1.5 text-left text-sm" onClick={() => void setApproval('confirm')}><span>毎回確認</span>{info?.approvalMode === 'confirm' && <span className="text-muted-foreground">選択中</span>}</button>
            <button type="button" className="hover:bg-accent flex w-full justify-between rounded-sm px-2 py-1.5 text-left text-sm" onClick={() => void setApproval('session-auto')}><span>このセッションは自動</span>{info?.approvalMode === 'session-auto' && <span className="text-muted-foreground">選択中</span>}</button>
          </div>
        </details>
        <details className="group relative ml-auto">
          <summary className="hover:bg-muted focus-visible:ring-ring flex size-8 cursor-pointer list-none items-center justify-center rounded-md outline-none focus-visible:ring-2" aria-label="プロジェクト情報"><InfoIcon className="size-4" /></summary>
          <div className="bg-popover text-popover-foreground border-border absolute right-0 bottom-9 z-50 w-72 rounded-md border p-3 text-xs shadow-md">
            <p>このプロジェクトのファイルは PC から出ません。</p>
            <p className="text-muted-foreground mt-2">接続先: {info?.provider ?? '確認中'} / {info?.model ?? '確認中'}</p>
          </div>
        </details>
      </div>
      <p className="text-muted-foreground px-2 text-[11px]">成果物は output に入ります。</p>
      {message && <p role="alert" className="text-destructive px-2 pt-1 text-xs">{message}</p>}
    </div>
  )
}
