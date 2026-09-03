import { MarkdownTextPrimitive } from '@assistant-ui/react-markdown'

/** Official-style Markdown typography without turning generated URLs into navigation authority. */
export const MarkdownText = () => (
  <MarkdownTextPrimitive
    className="aui-md text-[15px] leading-7 text-stone-800 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_h1]:my-4 [&_h1]:text-2xl [&_h1]:font-semibold [&_h2]:my-3 [&_h2]:text-xl [&_h2]:font-semibold [&_h3]:my-3 [&_h3]:text-lg [&_h3]:font-semibold [&_p]:my-3 [&_ul]:my-3 [&_ul]:list-disc [&_ul]:ps-6 [&_ol]:my-3 [&_ol]:list-decimal [&_ol]:ps-6 [&_li]:my-1 [&_strong]:font-semibold [&_code]:rounded-md [&_code]:bg-stone-100 [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[.9em] [&_pre]:my-4 [&_pre]:overflow-x-auto [&_pre]:rounded-xl [&_pre]:border [&_pre]:border-stone-200 [&_pre]:bg-stone-50 [&_pre]:p-4 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_blockquote]:my-4 [&_blockquote]:border-s-2 [&_blockquote]:border-stone-300 [&_blockquote]:ps-4 [&_blockquote]:text-stone-600 [&_table]:my-4 [&_table]:w-full [&_table]:border-collapse [&_th]:border [&_th]:border-stone-200 [&_th]:bg-stone-50 [&_th]:px-3 [&_th]:py-2 [&_th]:text-start [&_td]:border [&_td]:border-stone-200 [&_td]:px-3 [&_td]:py-2"
    components={{
      a: ({ children }) => <span className="font-medium underline decoration-stone-300 underline-offset-4">{children}</span>,
      img: ({ alt }) => <span>{alt ?? ''}</span>,
    }}
  />
)
