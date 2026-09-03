import {
  ErrorPrimitive,
  MessagePartPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useAuiState,
} from '@assistant-ui/react'
import type { AssistantCustomMetadata } from '../thread-store.js'
import { Composer } from './composer.js'
import { Icon } from './icons.js'
import { MarkdownText } from './markdown-text.js'
import { ToolFallback, ToolGroup } from './tool-fallback.js'

const TextPart = () => <MessagePartPrimitive.Text component="span" smooth={false} />
const HiddenPart = () => null
const PART_COMPONENTS = {
  Text: MarkdownText,
  Reasoning: HiddenPart,
  Image: HiddenPart,
  File: HiddenPart,
  Source: HiddenPart,
  Unstable_Audio: HiddenPart,
  tools: { Fallback: ToolFallback },
  ToolGroup,
}
const USER_PART_COMPONENTS = { ...PART_COMPONENTS, Text: TextPart }

const ArtifactRows = () => {
  const artifacts = useAuiState(s => (s.message.metadata.custom as Partial<AssistantCustomMetadata> | undefined)?.artifacts)
  if (!artifacts?.length) return null
  return (
    <section className="mt-5 space-y-2" aria-label="成果物">
      <h3 className="px-1 text-xs font-semibold tracking-wide text-stone-500">成果物</h3>
      {artifacts.map(artifact => artifact.available
        ? <a key={artifact.id} className="group flex items-center gap-3 rounded-2xl border border-stone-200 bg-white px-4 py-3 text-sm font-medium text-stone-700 shadow-sm transition hover:border-stone-300 hover:shadow" href={`/download/${encodeURIComponent(artifact.id)}`} download aria-label={`${artifact.filename}をダウンロード`}><span className="grid size-9 place-items-center rounded-xl bg-stone-100 text-stone-600"><Icon name="file" /></span><span className="min-w-0 flex-1 truncate">{artifact.filename}</span><Icon name="open" className="size-4 text-stone-400 transition group-hover:text-stone-700" /></a>
        : <span key={`${artifact.runId}-${artifact.filename}`} className="flex items-center gap-3 rounded-2xl border border-stone-200 bg-stone-50 px-4 py-3 text-sm text-stone-500" aria-label={`${artifact.filename}は利用できません`}><Icon name="file" /><span className="min-w-0 flex-1 truncate">{artifact.filename}</span><small>利用できません</small></span>)}
    </section>
  )
}

const UserMessage = () => (
  <MessagePrimitive.Root className="aui-user-message flex justify-end px-2">
    <div className="max-w-[85%] rounded-[1.35rem] bg-stone-100 px-4 py-2.5 text-[15px] leading-6 text-stone-800"><MessagePrimitive.Parts components={USER_PART_COMPONENTS} /></div>
  </MessagePrimitive.Root>
)

const AssistantMessage = () => (
  <MessagePrimitive.Root className="aui-assistant-message px-2">
    <div className="max-w-none text-stone-800">
      <MessagePrimitive.Parts components={PART_COMPONENTS} />
      <ThreadPrimitive.If running>
        <MessagePrimitive.If last hasContent={false}><div className="flex items-center gap-2 py-2 text-sm text-stone-500" role="status"><Icon name="running" />考えています…</div></MessagePrimitive.If>
      </ThreadPrimitive.If>
      <MessagePrimitive.Error><ErrorPrimitive.Root className="mt-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700" role="alert"><ErrorPrimitive.Message /></ErrorPrimitive.Root></MessagePrimitive.Error>
      <ArtifactRows />
    </div>
  </MessagePrimitive.Root>
)

/** Owned, Misen-trimmed copy of the styled assistant-ui Thread surface. */
export const Thread = () => (
  <ThreadPrimitive.Root className="aui-thread-root flex h-full flex-col bg-[#fbfaf8]">
    <ThreadPrimitive.Viewport className="relative flex flex-1 flex-col overflow-x-hidden overflow-y-auto scroll-smooth" autoScroll turnAnchor="bottom">
      <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col px-5 pt-8 md:px-8 md:pt-12">
        <ThreadPrimitive.Empty><div className="mb-7 mt-auto text-center"><span className="mb-4 inline-grid size-12 place-items-center rounded-2xl border border-stone-200 bg-white text-lg font-semibold shadow-sm">M</span><h1 className="text-2xl font-semibold tracking-tight text-stone-800">今日は何を進めますか？</h1><p className="mt-2 text-sm text-stone-500">作業内容を日本語で入力してください</p></div></ThreadPrimitive.Empty>
        <div className="mb-16 flex flex-col gap-7 empty:hidden"><ThreadPrimitive.Messages>{({ message }) => message.role === 'user' ? <UserMessage /> : <AssistantMessage />}</ThreadPrimitive.Messages></div>
        <ThreadPrimitive.ViewportFooter className="sticky bottom-0 mt-auto bg-gradient-to-t from-[#fbfaf8] via-[#fbfaf8] to-transparent pb-6 pt-10">
          <ThreadPrimitive.ScrollToBottom className="absolute -top-2 left-1/2 grid size-9 -translate-x-1/2 place-items-center rounded-full border border-stone-200 bg-white text-stone-600 shadow-md transition hover:bg-stone-50 disabled:invisible" aria-label="最新のメッセージへ移動"><Icon name="back" /></ThreadPrimitive.ScrollToBottom>
          <ThreadPrimitive.If disabled><p className="mb-2 text-center text-xs text-stone-500">過去の会話は閲覧のみです。続きは「新しいチャット」から開始してください。</p></ThreadPrimitive.If>
          <Composer />
          <p className="mt-2 text-center text-[11px] text-stone-400">内容を確認してから成果物をご利用ください</p>
        </ThreadPrimitive.ViewportFooter>
      </div>
    </ThreadPrimitive.Viewport>
  </ThreadPrimitive.Root>
)
