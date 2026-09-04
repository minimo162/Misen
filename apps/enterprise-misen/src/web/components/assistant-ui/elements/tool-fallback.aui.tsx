"use client";

import { memo, useCallback, useRef, useState } from "react";
import { AlertCircleIcon, CheckIcon, ChevronDownIcon, LoaderIcon, XCircleIcon } from "lucide-react";
import {
  useScrollLock,
  useToolCallElapsed,
  type ToolCallMessagePartComponent,
  type ToolCallMessagePartProps,
  type ToolCallMessagePartStatus,
} from "@assistant-ui/react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible.js";
import { cn } from "@/lib/utils.js";

const ANIMATION_DURATION = 200;
const TOOL_LABELS: Record<string, string> = {
  workspace_list_files: "ファイル一覧を確認",
  workspace_read_text: "業務ガイドを確認",
  spreadsheet_read: "Excelを確認",
  document_read: "Wordを確認",
  presentation_read: "PowerPointを確認",
  office_get: "Officeの内容を確認",
  office_query: "Officeの要素を検索",
  office_inspect: "Officeファイルを検証",
  office_create_output: "Officeファイルを作成",
  office_set: "Officeの書式・値を更新",
  office_add: "Officeの要素を追加",
  office_remove: "Officeの要素を削除",
  office_move: "Officeの要素を移動",
  office_swap: "Officeの要素を入れ替え",
  office_batch: "Officeファイルを一括更新",
  office_import: "表データを取り込み",
};

function ToolFallbackRoot({ className, open: controlledOpen, onOpenChange: controlledOnOpenChange, defaultOpen = false, children, ...props }: Omit<React.ComponentProps<typeof Collapsible>, "open" | "onOpenChange"> & { open?: boolean; onOpenChange?: (open: boolean) => void; defaultOpen?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const lockScroll = useScrollLock(ref, ANIMATION_DURATION);
  const isControlled = controlledOpen !== undefined;
  const open = isControlled ? controlledOpen : uncontrolledOpen;
  const onOpenChange = useCallback((next: boolean) => {
    lockScroll();
    if (!isControlled) setUncontrolledOpen(next);
    controlledOnOpenChange?.(next);
  }, [controlledOnOpenChange, isControlled, lockScroll]);
  return <Collapsible ref={ref} open={open} onOpenChange={onOpenChange} className={cn("aui-tool-fallback-root group/tool-fallback-root w-full", className)} style={{ "--animation-duration": `${ANIMATION_DURATION}ms` } as React.CSSProperties} {...props}>{children}</Collapsible>;
}

const statusIconMap = {
  running: LoaderIcon,
  complete: CheckIcon,
  incomplete: XCircleIcon,
  "requires-action": AlertCircleIcon,
};

function ToolFallbackDuration({ className, ...props }: React.ComponentProps<"span">) {
  const elapsed = useToolCallElapsed();
  if (elapsed == null) return null;
  const seconds = elapsed / 1000;
  const label = elapsed < 1000 ? "1秒未満" : seconds < 60 ? `${Math.floor(seconds)}秒` : `${Math.floor(seconds / 60)}分${Math.floor(seconds % 60)}秒`;
  return <span className={cn("text-muted-foreground text-xs tabular-nums", className)} {...props}>{label}</span>;
}

function ToolFallbackTrigger({ toolName, status, className, ...props }: React.ComponentProps<typeof CollapsibleTrigger> & { toolName: string; status?: ToolCallMessagePartStatus }) {
  const statusType = status?.type ?? "complete";
  const isRunning = statusType === "running";
  const isCancelled = status?.type === "incomplete" && status.reason === "cancelled";
  const Icon = statusIconMap[statusType];
  const label = isCancelled ? "中止した操作" : isRunning ? "操作中" : "実行した操作";
  return (
    <CollapsibleTrigger className={cn("group/trigger text-muted-foreground hover:text-foreground flex w-fit origin-left items-center gap-2 py-1.5 text-sm transition-[color,scale] active:scale-[0.98]", className)} {...props}>
      <Icon className={cn("size-4 shrink-0", isRunning && "animate-spin [animation-duration:0.6s]")} />
      <span className={cn("inline-block text-start leading-none", isCancelled && "line-through", isRunning && "shimmer motion-reduce:animate-none")}>{label}: <b>{TOOL_LABELS[toolName] ?? "操作"}</b></span>
      <ToolFallbackDuration />
      <ChevronDownIcon className="size-4 shrink-0 -rotate-90 transition-transform duration-(--animation-duration) group-data-open/trigger:rotate-0 motion-reduce:transition-none" />
    </CollapsibleTrigger>
  );
}

function ToolFallbackContent({ className, children, ...props }: React.ComponentProps<typeof CollapsibleContent>) {
  return (
    <CollapsibleContent className={cn("group/collapsible-content relative overflow-hidden text-sm outline-none data-closed:animate-collapsible-up data-open:animate-collapsible-down motion-reduce:animate-none", className)} {...props}>
      <div className="flex flex-col gap-2 ps-6 pt-1 pb-2">{children}</div>
    </CollapsibleContent>
  );
}

function ToolFallbackArgs({ argsText, className, ...props }: React.ComponentProps<"div"> & { argsText?: string }) {
  if (!argsText) return null;
  return <div className={className} {...props}><p className="text-muted-foreground text-xs font-medium">内容:</p><pre className="bg-muted/50 text-foreground/90 mt-1 rounded-md p-2.5 text-xs whitespace-pre-wrap">{argsText}</pre></div>;
}

function ToolFallbackResult({ result, className, ...props }: React.ComponentProps<"div"> & { result?: unknown }) {
  if (result === undefined) return null;
  const value = result === "success" ? "完了" : result === "error" ? "失敗" : typeof result === "string" ? result : JSON.stringify(result, null, 2);
  return <div className={className} {...props}><p className="text-muted-foreground text-xs font-medium">結果:</p><pre className="bg-muted/50 text-foreground/90 mt-1 rounded-md p-2.5 text-xs whitespace-pre-wrap">{value}</pre></div>;
}

function ToolFallbackError({ status, className, ...props }: React.ComponentProps<"div"> & { status?: ToolCallMessagePartStatus }) {
  if (status?.type !== "incomplete" || !status.error) return null;
  const value = typeof status.error === "string" ? status.error : JSON.stringify(status.error);
  return <div className={className} {...props}><p className="text-muted-foreground font-semibold">{status.reason === "cancelled" ? "中止理由:" : "エラー:"}</p><p className="text-muted-foreground">{value}</p></div>;
}

const ToolFallbackImpl: ToolCallMessagePartComponent = ({ toolName, argsText, result, status }: ToolCallMessagePartProps) => {
  const [open, setOpen] = useState(status?.type === "running");
  return (
    <ToolFallbackRoot open={open} onOpenChange={setOpen}>
      <ToolFallbackTrigger toolName={toolName} status={status} />
      <ToolFallbackContent>
        <ToolFallbackError status={status} />
        <ToolFallbackArgs argsText={argsText} />
        <ToolFallbackResult result={result} />
      </ToolFallbackContent>
    </ToolFallbackRoot>
  );
};

const ToolFallback = memo(ToolFallbackImpl) as unknown as ToolCallMessagePartComponent & {
  Root: typeof ToolFallbackRoot;
  Trigger: typeof ToolFallbackTrigger;
  Content: typeof ToolFallbackContent;
  Args: typeof ToolFallbackArgs;
  Result: typeof ToolFallbackResult;
  Error: typeof ToolFallbackError;
};
ToolFallback.displayName = "ToolFallback";
ToolFallback.Root = ToolFallbackRoot;
ToolFallback.Trigger = ToolFallbackTrigger;
ToolFallback.Content = ToolFallbackContent;
ToolFallback.Args = ToolFallbackArgs;
ToolFallback.Result = ToolFallbackResult;
ToolFallback.Error = ToolFallbackError;

export { ToolFallback, ToolFallbackRoot, ToolFallbackTrigger, ToolFallbackContent, ToolFallbackArgs, ToolFallbackResult, ToolFallbackError };
