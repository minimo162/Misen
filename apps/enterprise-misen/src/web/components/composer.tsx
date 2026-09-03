import { ComposerPrimitive, ThreadPrimitive, useAuiState } from '@assistant-ui/react'
import { Icon } from './icons.js'

/** The composer contains only the Japanese request field and send/stop actions. */
export const Composer = () => {
  const readOnly = useAuiState(s => s.thread.isDisabled)
  return (
    <ComposerPrimitive.Root className="aui-composer relative flex w-full items-end gap-2 rounded-[1.5rem] border border-stone-200 bg-white p-2 shadow-[0_8px_30px_rgba(28,25,23,.08)] transition focus-within:border-stone-300 focus-within:shadow-[0_10px_36px_rgba(28,25,23,.12)]" compact={false}>
      <ComposerPrimitive.Input className="max-h-48 min-h-10 flex-1 resize-none bg-transparent px-2.5 py-2 text-[15px] leading-6 text-stone-800 outline-none placeholder:text-stone-400 disabled:cursor-not-allowed" aria-label="依頼" placeholder={readOnly ? '過去の会話は閲覧のみです' : 'Misenに依頼する'} submitMode="enter" maxRows={8} />
      <ThreadPrimitive.If running>
        <ComposerPrimitive.Cancel className="grid size-9 shrink-0 place-items-center rounded-full bg-stone-900 text-white transition hover:bg-stone-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-600" aria-label="停止"><Icon name="stop" /></ComposerPrimitive.Cancel>
      </ThreadPrimitive.If>
      <ThreadPrimitive.If running={false}>
        <ComposerPrimitive.Send className="grid size-9 shrink-0 place-items-center rounded-full bg-stone-900 text-white transition hover:bg-stone-700 disabled:bg-stone-200 disabled:text-stone-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-600" aria-label="送信"><Icon name="send" /></ComposerPrimitive.Send>
      </ThreadPrimitive.If>
    </ComposerPrimitive.Root>
  )
}
