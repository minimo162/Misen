import { ThreadListItemPrimitive, ThreadListPrimitive, useAuiState } from '@assistant-ui/react'
import { updatedTimeLabel, type ThreadListCustom } from '../thread-store.js'
import { Icon } from './icons.js'

const ThreadListRow = () => {
  const custom = useAuiState(s => s.threadListItem.custom as Partial<ThreadListCustom> | undefined)
  const isActive = useAuiState(s => s.threads.mainThreadId === s.threadListItem.id)
  const disabled = useAuiState(s => s.thread.isRunning || s.threads.isLoading)
  return (
    <ThreadListItemPrimitive.Root>
      {custom?.showGroup && custom.group && <h2 className="mb-1 mt-5 px-2 text-[11px] font-semibold tracking-wide text-stone-400 first:mt-1">{custom.group}</h2>}
      <ThreadListItemPrimitive.Trigger className={`group flex w-full flex-col gap-0.5 rounded-xl px-3 py-2.5 text-start transition ${isActive ? 'bg-white text-stone-900 shadow-sm ring-1 ring-stone-200' : 'text-stone-600 hover:bg-white/70 hover:text-stone-900'}`} disabled={disabled} aria-current={isActive ? 'page' : undefined}>
        <span className="w-full truncate text-[13px] font-medium"><ThreadListItemPrimitive.Title fallback="新しいチャット" /></span>
        {custom?.updatedAt && <time className="text-[11px] text-stone-400" dateTime={custom.updatedAt}>{updatedTimeLabel(custom.updatedAt)}</time>}
      </ThreadListItemPrimitive.Trigger>
    </ThreadListItemPrimitive.Root>
  )
}

const ThreadListEmpty = () => {
  const isEmpty = useAuiState(s => s.threads.threadIds.length === 0 && !s.threads.isLoading)
  return isEmpty ? <p className="px-3 py-5 text-center text-xs text-stone-400">会話履歴はまだありません</p> : null
}

/** Styled local ThreadList with only selection and new-chat actions. */
export const ThreadList = () => {
  const newDisabled = useAuiState(s => s.thread.isRunning || s.threads.isLoading)
  return (
    <ThreadListPrimitive.Root asChild>
      <aside className="flex min-h-0 w-64 shrink-0 flex-col border-e border-stone-200 bg-[#f3f1ed] p-3" aria-label="会話履歴">
        <div className="flex h-11 items-center gap-2.5 px-2 text-sm font-semibold text-stone-800"><span className="grid size-7 place-items-center rounded-lg border border-stone-200 bg-white text-xs shadow-sm">M</span><span>Misen</span></div>
        <ThreadListPrimitive.New className="mt-3 flex h-10 w-full items-center justify-center gap-2 rounded-xl bg-stone-900 px-3 text-sm font-medium text-white shadow-sm transition hover:bg-stone-700 disabled:opacity-45"><Icon name="plus" /><span>新しいチャット</span></ThreadListPrimitive.New>
        <div className="mt-3 min-h-0 flex-1 overflow-y-auto"><ThreadListEmpty /><ThreadListPrimitive.Items>{() => <ThreadListRow />}</ThreadListPrimitive.Items></div>
        <div className="mt-3 flex items-center gap-2 rounded-xl border border-stone-200 bg-white/65 px-3 py-2 text-[11px] text-stone-500"><span className="size-1.5 rounded-full bg-emerald-500" aria-hidden="true" />このPCにのみ保存</div>
      </aside>
    </ThreadListPrimitive.Root>
  )
}
