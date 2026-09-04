"use client";

import { MarkdownText } from "@/components/assistant-ui/elements/markdown-text.js";
import { File } from "@/components/assistant-ui/elements/file.js";
import { ComposerAddAttachment, ComposerAttachments, UserMessageAttachments } from "@/components/attachment.aui.js";
import { ToolFallback } from "@/components/assistant-ui/elements/tool-fallback.aui.js";
import {
  ToolGroupContent,
  ToolGroupRoot,
  ToolGroupTrigger,
} from "@/components/assistant-ui/elements/tool-group.aui.js";
import { TooltipIconButton } from "@/components/assistant-ui/elements/tooltip-icon-button.js";
import { Button } from "@/components/ui/button.js";
import { Skeleton } from "@/components/ui/skeleton.js";
import { cn } from "@/lib/utils.js";
import {
  ActionBarPrimitive,
  AuiIf,
  type AssistantState,
  ComposerPrimitive,
  ErrorPrimitive,
  groupPartByType,
  MessagePrimitive,
  SuggestionPrimitive,
  ThreadPrimitive,
  type ToolCallMessagePartComponent,
  useAuiState,
} from "@assistant-ui/react";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CheckIcon,
  CopyIcon,
  SquareIcon,
} from "lucide-react";
import {
  createContext,
  useContext,
  useState,
  type ComponentType,
  type FC,
  type PropsWithChildren,
  type ReactNode,
} from "react";

export type ThreadGroupPart = MessagePrimitive.GroupedParts.GroupPart;
type CheckpointCard = { id: string; verb: string; target: string; risk: "低" | "中" | "高"; reason: string; status: "pending" | "approved" | "rejected"; approveSimilar?: boolean };
type AssistantCustomMetadata = { plan?: { id: string; title: string; steps: { id: string; title: string; status: "pending" | "running" | "completed" }[] }; checkpoints: CheckpointCard[] };

/** Official assistant-ui Thread, trimmed only for Misen's deliberately absent features. */
export type ThreadComponents = {
  AssistantMessage?: ComponentType;
  Welcome?: ComponentType;
  ToolFallback?: ToolCallMessagePartComponent;
  ToolGroup?: ComponentType<PropsWithChildren<{ group: ThreadGroupPart }>>;
};

export type ThreadProps = {
  components?: ThreadComponents;
  autoFocus?: boolean;
  composerFooter?: ReactNode;
};

const EMPTY_COMPONENTS: ThreadComponents = {};
const ThreadComponentsContext = createContext<ThreadComponents>(EMPTY_COMPONENTS);

const isNewChatView = (s: AssistantState) =>
  s.thread.messages.length === 0 && (!s.thread.isLoading || s.threads.isLoading);

const isHistoryLoadingView = (s: AssistantState) =>
  s.thread.messages.length === 0 &&
  s.thread.isLoading &&
  !s.thread.isDisabled &&
  !s.threads.isLoading;

const ThreadHistorySkeleton: FC = () => (
  <div role="status" className="animate-in fade-in fill-mode-both flex flex-col gap-y-6 [animation-delay:150ms] [animation-duration:200ms]">
    <span className="sr-only">会話を読み込んでいます</span>
    <Skeleton className="ml-auto h-9 w-2/5 rounded-xl motion-reduce:animate-none" />
    <div className="flex flex-col gap-y-2">
      <Skeleton className="h-4 w-11/12 motion-reduce:animate-none" />
      <Skeleton className="h-4 w-4/5 motion-reduce:animate-none" />
      <Skeleton className="h-4 w-3/5 motion-reduce:animate-none" />
    </div>
  </div>
);

export const Thread: FC<ThreadProps> = ({ components = EMPTY_COMPONENTS, autoFocus = true, composerFooter }) => {
  const isEmpty = useAuiState(isNewChatView);
  return (
    <ThreadComponentsContext.Provider value={components}>
      <ThreadRoot isEmpty={isEmpty} autoFocus={autoFocus} composerFooter={composerFooter} />
    </ThreadComponentsContext.Provider>
  );
};

const ThreadRoot: FC<{ isEmpty: boolean; autoFocus: boolean; composerFooter?: ReactNode }> = ({ isEmpty, autoFocus, composerFooter }) => {
  const { Welcome = ThreadWelcome } = useContext(ThreadComponentsContext);
  return (
    <ThreadPrimitive.Root
      className="aui-root aui-thread-root bg-background @container flex h-full flex-col"
      style={{
        ["--thread-max-width" as string]: "44rem",
        ["--composer-bg" as string]: "var(--color-card)",
        ["--composer-radius" as string]: "1.5rem",
        ["--composer-padding" as string]: "8px",
      }}
    >
      <ThreadPrimitive.Viewport
        autoScroll
        turnAnchor="top"
        className="relative flex flex-1 flex-col overflow-x-auto overflow-y-scroll scroll-smooth"
      >
        <div className={cn("mx-auto flex w-full max-w-(--thread-max-width) flex-1 flex-col px-4 pt-4", isEmpty && "justify-center")}>
          <AuiIf condition={isNewChatView}><Welcome /></AuiIf>
          <AuiIf condition={isHistoryLoadingView}><ThreadHistorySkeleton /></AuiIf>
          <div className="mb-14 flex flex-col gap-y-6 empty:hidden">
            <ThreadPrimitive.Messages>{() => <ThreadMessage />}</ThreadPrimitive.Messages>
          </div>
          <ThreadPrimitive.ViewportFooter className={cn("bg-background flex flex-col gap-4 overflow-visible pb-4 md:pb-6", !isEmpty && "sticky bottom-0 mt-auto rounded-t-(--composer-radius)")}>
            <ThreadScrollToBottom />
            <Composer autoFocus={autoFocus} />
            {/* Misen modification: Cowork-aligned local project and approval controls. */}
            {composerFooter}
            <AuiIf condition={(s) => isNewChatView(s) && s.composer.isEmpty}><ThreadSuggestions /></AuiIf>
          </ThreadPrimitive.ViewportFooter>
        </div>
      </ThreadPrimitive.Viewport>
    </ThreadPrimitive.Root>
  );
};

const ThreadMessage: FC = () => {
  const { AssistantMessage: AssistantMessageComponent = AssistantMessage } = useContext(ThreadComponentsContext);
  const role = useAuiState((s) => s.message.role);
  // Misen modification: message editing is intentionally unavailable.
  return role === "user" ? <UserMessage /> : <AssistantMessageComponent />;
};

const ThreadScrollToBottom: FC = () => (
  <ThreadPrimitive.ScrollToBottom asChild>
    <TooltipIconButton tooltip="最下部へ" variant="outline" className="dark:border-border dark:bg-background dark:hover:bg-accent absolute -top-12 z-10 self-center rounded-full p-4 disabled:invisible">
      <ArrowDownIcon />
    </TooltipIconButton>
  </ThreadPrimitive.ScrollToBottom>
);

const ThreadWelcome: FC = () => (
  <div className="mb-6 flex flex-col items-center px-4 text-center">
    <h1 className="fade-in slide-in-from-bottom-1 animate-in fill-mode-both text-2xl font-medium tracking-tight duration-200">何をお手伝いしましょう？</h1>
  </div>
);

const ThreadSuggestions: FC = () => (
  <div className="flex w-full flex-wrap items-center justify-center gap-2 px-4">
    <ThreadPrimitive.Suggestions>{() => <ThreadSuggestionItem />}</ThreadPrimitive.Suggestions>
  </div>
);

const ThreadSuggestionItem: FC = () => (
  <div className="fade-in slide-in-from-bottom-2 animate-in fill-mode-both duration-200">
    <SuggestionPrimitive.Trigger send asChild>
      <Button variant="ghost" className="text-foreground hover:bg-muted border-border/60 h-auto gap-1.5 rounded-full border px-3.5 py-1.5 text-sm font-normal whitespace-nowrap transition-colors">
        <SuggestionPrimitive.Title />
        <SuggestionPrimitive.Description className="empty:hidden" />
      </Button>
    </SuggestionPrimitive.Trigger>
  </div>
);

const Composer: FC<{ autoFocus: boolean }> = ({ autoFocus }) => (
  <ComposerPrimitive.Root className="relative flex w-full flex-col">
    {/* Misen modification: official Attachments are the local-PC file import route; microphone remains absent. */}
    <ComposerPrimitive.AttachmentDropzone className="border-border/60 focus-within:border-border data-[dragging=true]:border-ring dark:border-muted-foreground/15 dark:focus-within:border-muted-foreground/30 flex w-full cursor-text flex-col gap-2 rounded-(--composer-radius) border bg-(--composer-bg) p-(--composer-padding) transition-[border-color]">
      <ComposerAttachments />
      <ComposerPrimitive.Input
        placeholder="メッセージを入力…"
        className="caret-primary placeholder:text-muted-foreground/60 max-h-48 min-h-10 w-full resize-none bg-transparent px-2.5 py-1 text-base leading-6 outline-none"
        rows={1}
        autoFocus={autoFocus}
        enterKeyHint="send"
        aria-label="メッセージ入力"
      />
      <ComposerAction />
      <p className="text-muted-foreground px-2 pb-1 text-[11px]">持ち込んだファイルはこの PC の作業フォルダーに置かれ、外へは出ません</p>
    </ComposerPrimitive.AttachmentDropzone>
  </ComposerPrimitive.Root>
);

const ComposerAction: FC = () => (
  <div className="relative flex items-center justify-between">
    <ComposerAddAttachment />
    <AuiIf condition={(s) => !s.thread.isRunning}>
      <ComposerPrimitive.Send asChild>
        <TooltipIconButton tooltip="送信" side="bottom" type="button" variant="default" size="icon" className="size-7 rounded-full" aria-label="送信">
          <ArrowUpIcon className="size-4" />
        </TooltipIconButton>
      </ComposerPrimitive.Send>
    </AuiIf>
    <AuiIf condition={(s) => s.thread.isRunning}>
      <ComposerPrimitive.Cancel asChild>
        <Button type="button" variant="default" size="icon" className="size-7 rounded-full" aria-label="停止">
          <SquareIcon className="size-3.5 fill-current" />
        </Button>
      </ComposerPrimitive.Cancel>
    </AuiIf>
  </div>
);

const MessageError: FC = () => (
  <MessagePrimitive.Error>
    <ErrorPrimitive.Root className="border-destructive bg-destructive/10 text-destructive mt-2 rounded-md border p-3 text-sm" role="alert">
      <ErrorPrimitive.Message className="line-clamp-2" />
    </ErrorPrimitive.Root>
  </MessagePrimitive.Error>
);

const AssistantMessage: FC = () => {
  const { ToolFallback: ToolFallbackComponent = ToolFallback, ToolGroup } = useContext(ThreadComponentsContext);
  return (
    <MessagePrimitive.Root className="fade-in slide-in-from-bottom-1 animate-in relative -mb-7.5 pb-7.5 duration-150 [contain-intrinsic-size:auto_200px] [content-visibility:auto]">
      <div className="text-foreground px-2 leading-relaxed wrap-break-word">
        {/* Misen modification: local plan and approval checkpoint events are rendered as first-class cards. */}
        <RunCards />
        <MessagePrimitive.GroupedParts groupBy={groupPartByType({ "tool-call": ["group-tool"], "standalone-tool-call": [] })}>
          {({ part, children }) => {
            switch (part.type) {
              case "group-tool":
                if (ToolGroup) return <ToolGroup group={part}>{children}</ToolGroup>;
                return <ToolGroupRoot variant="ghost"><ToolGroupTrigger count={part.indices.length} active={part.status.type === "running"} /><ToolGroupContent>{children}</ToolGroupContent></ToolGroupRoot>;
              case "text": return <MarkdownText />;
              case "tool-call": return part.toolUI ?? <ToolFallbackComponent {...part} />;
              case "data": return part.dataRendererUI;
              case "file": return <div className="py-1"><File {...part} /></div>;
              case "indicator": return <span className="animate-pulse font-sans" aria-label="処理中">●</span>;
              // Misen modification: reasoning and image parts are not presented.
              default: return null;
            }
          }}
        </MessagePrimitive.GroupedParts>
        <MessageError />
      </div>
      <div className="ms-2 flex min-h-7.5 items-center pt-1.5"><AssistantActionBar /></div>
    </MessagePrimitive.Root>
  );
};

const RunCards: FC = () => {
  const custom = useAuiState((s) => s.message.metadata?.custom as AssistantCustomMetadata | undefined);
  if (!custom?.plan && !custom?.checkpoints.length) return null;
  return (
    <div className="mb-4 flex flex-col gap-3">
      {custom.plan && (
        <section className="border-border bg-muted/30 rounded-xl border p-4" aria-label="実行計画">
          <h2 className="text-sm font-medium">{custom.plan.title}</h2>
          <ol className="mt-3 space-y-2 text-sm">
            {custom.plan.steps.map(step => (
              <li key={step.id} className="flex items-center gap-2">
                <span className={cn("flex size-5 shrink-0 items-center justify-center rounded-full border text-[11px]", step.status === "completed" && "border-primary bg-primary text-primary-foreground", step.status === "running" && "border-primary text-primary animate-pulse motion-reduce:animate-none")} aria-hidden>{step.status === "completed" ? <CheckIcon className="size-3" /> : step.status === "running" ? "●" : ""}</span>
                <span className={step.status === "pending" ? "text-muted-foreground" : ""}>{step.title}</span>
                {step.status === "running" && <span className="text-muted-foreground ml-auto text-xs">進行中</span>}
              </li>
            ))}
          </ol>
        </section>
      )}
      {custom.checkpoints.map(checkpoint => <Checkpoint key={checkpoint.id} checkpoint={checkpoint} />)}
    </div>
  );
};

const Checkpoint: FC<{ checkpoint: CheckpointCard }> = ({ checkpoint }) => {
  const [approveSimilar, setApproveSimilar] = useState(false);
  const [sending, setSending] = useState(false);
  const respond = async (decision: "approved" | "rejected") => {
    setSending(true);
    try {
      await fetch("/checkpoints/respond", { method: "POST", headers: { origin: globalThis.location.origin, "content-type": "application/json" }, body: JSON.stringify({ id: checkpoint.id, decision, approveSimilar: decision === "approved" && approveSimilar }) });
    } finally { setSending(false); }
  };
  return (
    <section className="border-border bg-card rounded-xl border p-4 shadow-sm" aria-label="承認チェックポイント">
      <div className="flex items-center justify-between gap-3"><h2 className="text-sm font-medium">確認が必要です</h2><span className="bg-muted rounded-full px-2 py-0.5 text-xs">リスク水準: {checkpoint.risk}</span></div>
      <dl className="mt-3 grid grid-cols-[5rem_1fr] gap-x-3 gap-y-1 text-sm"><dt className="text-muted-foreground">操作内容</dt><dd>{checkpoint.verb}</dd><dt className="text-muted-foreground">対象</dt><dd className="break-all">{checkpoint.target}</dd><dt className="text-muted-foreground">理由</dt><dd>{checkpoint.reason}</dd></dl>
      {checkpoint.status === "pending" ? (
        <div className="mt-4">
          <label className="flex items-start gap-2 text-xs"><input type="checkbox" className="mt-0.5" checked={approveSimilar} onChange={event => setApproveSimilar(event.target.checked)} />このセッションでは同種を承認済みにする</label>
          <div className="mt-3 flex justify-end gap-2"><Button type="button" variant="outline" size="sm" disabled={sending} onClick={() => void respond("rejected")}>拒否</Button><Button type="button" size="sm" disabled={sending} onClick={() => void respond("approved")}>承認</Button></div>
        </div>
      ) : <p className="text-muted-foreground mt-3 text-xs">{checkpoint.status === "approved" ? "承認しました" : "拒否しました"}{checkpoint.approveSimilar ? "（このセッションの同種操作を含む）" : ""}</p>}
    </section>
  );
};

const AssistantActionBar: FC = () => (
  <ActionBarPrimitive.Root hideWhenRunning autohide="not-last" className="text-muted-foreground animate-in fade-in -ms-1 flex gap-1 duration-200">
    <ActionBarPrimitive.Copy asChild>
      <TooltipIconButton tooltip="コピー">
        <AuiIf condition={(s) => s.message.isCopied}><CheckIcon className="animate-in zoom-in-50 fade-in duration-200 ease-out" /></AuiIf>
        <AuiIf condition={(s) => !s.message.isCopied}><CopyIcon className="animate-in zoom-in-75 fade-in duration-150" /></AuiIf>
      </TooltipIconButton>
    </ActionBarPrimitive.Copy>
  </ActionBarPrimitive.Root>
);

const UserMessage: FC = () => (
  <MessagePrimitive.Root className="grid auto-rows-auto grid-cols-[minmax(72px,1fr)_auto] gap-y-1 [&:where(>*)]:col-start-2">
    <UserMessageAttachments />
    <div className="bg-muted text-foreground max-w-[calc(var(--thread-max-width)*0.8)] rounded-xl px-4 py-2 wrap-break-word">
      <MessagePrimitive.Parts />
    </div>
  </MessagePrimitive.Root>
);
