import { useState, type PropsWithChildren } from 'react'
import { useAuiState, type ToolCallMessagePartProps } from '@assistant-ui/react'
import type { ToolCallArgs } from '../thread-store.js'
import { Icon } from './icons.js'

const TOOL_PRESENTATION: Record<string, string> = {
  workspace_list_files: 'ファイル一覧を確認', workspace_read_text: '業務ガイドを確認',
  spreadsheet_read: 'Excelを確認', spreadsheet_create_output: 'Excelを作成', spreadsheet_update: 'Excelを更新',
  document_read: 'Wordを確認', document_create_output: 'Wordを作成', document_update: 'Wordを更新',
  presentation_read: 'PowerPointを確認', presentation_create_output: 'PowerPointを作成', presentation_update: 'PowerPointを更新',
}

/** Owned copy of the assistant-ui ToolFallback pattern; raw args and provider output stay hidden. */
export const ToolFallback = (part: ToolCallMessagePartProps<ToolCallArgs, unknown>) => {
  const status = part.result === undefined ? 'running' : part.isError ? 'error' : 'success'
  const detail = typeof part.args?.detail === 'string' ? part.args.detail : undefined
  return (
    <div className="aui-tool-row flex items-center gap-2.5 rounded-xl px-3 py-2 text-sm text-stone-600" data-status={status}>
      <span className={`grid size-6 shrink-0 place-items-center rounded-full ${status === 'error' ? 'bg-red-50 text-red-600' : status === 'success' ? 'bg-emerald-50 text-emerald-700' : 'bg-stone-100 text-stone-500'}`}><Icon name={status} className="size-3.5" /></span>
      <span className="font-medium text-stone-700">{TOOL_PRESENTATION[part.toolName] ?? '操作'}</span>
      {detail && <span className="min-w-0 flex-1 truncate text-stone-500">{detail}</span>}
    </div>
  )
}

/** Completed Tool calls collapse into the same disclosure-card shape as official ToolFallback. */
export const ToolGroup = ({ startIndex, endIndex, children }: PropsWithChildren<{ startIndex: number; endIndex: number }>) => {
  const count = endIndex - startIndex + 1
  const running = useAuiState(s => s.message.status?.type === 'running')
  const [expanded, setExpanded] = useState(false)
  const open = running || expanded
  return (
    <section className="aui-tool-group my-3 overflow-hidden rounded-2xl border border-stone-200 bg-white shadow-sm" aria-label="操作履歴">
      <button className="flex w-full items-center justify-between gap-3 px-3.5 py-3 text-start text-sm font-medium text-stone-700 transition hover:bg-stone-50" type="button" onClick={() => !running && setExpanded(value => !value)} aria-expanded={open} disabled={running}>
        <span className="flex items-center gap-2"><span className="grid size-7 place-items-center rounded-lg bg-stone-100 text-stone-500"><Icon name={running ? 'running' : 'success'} className="size-4" /></span>{running ? '操作しています' : `${count}件の操作`}</span>
        {!running && <Icon name={open ? 'chevron-down' : 'chevron-right'} className="size-4 text-stone-400" />}
      </button>
      {open && <div className="border-t border-stone-100 p-1.5">{children}</div>}
    </section>
  )
}
