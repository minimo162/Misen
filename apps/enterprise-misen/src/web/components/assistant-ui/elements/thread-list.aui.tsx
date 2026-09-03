"use client";

import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Skeleton } from "@/components/ui/skeleton.js";
import { cn } from "@/lib/utils.js";
import {
  AuiIf,
  ThreadListItemMorePrimitive,
  ThreadListItemPrimitive,
  ThreadListPrimitive,
  useAuiState,
} from "@assistant-ui/react";
import { Loader2Icon, MoreHorizontalIcon, PlusIcon, SearchIcon, TrashIcon } from "lucide-react";
import { forwardRef, Fragment, useMemo, useState, type ComponentPropsWithoutRef, type FC } from "react";

/** Official assistant-ui ThreadList, localized and trimmed to Misen's supported actions. */
export const ThreadList: FC = () => {
  const [search, setSearch] = useState("");
  const hasThreads = useAuiState((s) => s.threads.threadIds.length > 0);
  return (
    <ThreadListRoot>
      <ThreadListNew />
      {hasThreads && <ThreadListSearch value={search} onValueChange={setSearch} />}
      <ThreadListItems searchQuery={hasThreads ? search : ""} />
    </ThreadListRoot>
  );
};

export const ThreadListSearch = forwardRef<
  HTMLInputElement,
  Omit<ComponentPropsWithoutRef<typeof Input>, "value" | "onChange"> & { value: string; onValueChange: (value: string) => void }
>(({ className, value, onValueChange, ...props }, ref) => (
  <div className="relative px-0.5 py-1">
    <SearchIcon className="text-muted-foreground pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2" />
    <Input ref={ref} type="search" value={value} onChange={(event) => onValueChange(event.target.value)} aria-label="会話を検索" placeholder="会話を検索" className={cn("h-8 ps-8 text-sm", className)} {...props} />
  </div>
));
ThreadListSearch.displayName = "ThreadListSearch";

export const ThreadListRoot: FC<ComponentPropsWithoutRef<typeof ThreadListPrimitive.Root>> = ({ className, ...props }) => (
  <ThreadListPrimitive.Root className={cn("flex flex-col gap-0.5", className)} {...props} />
);

export const ThreadListItems: FC<ComponentPropsWithoutRef<"div"> & { searchQuery?: string }> = ({ className, searchQuery = "", ...props }) => (
  <div className={cn("flex flex-col gap-0.5", className)} {...props}>
    <AuiIf condition={(s) => s.threads.isLoading}><ThreadListSkeleton /></AuiIf>
    <AuiIf condition={(s) => !s.threads.isLoading}><ThreadListItemGroups searchQuery={searchQuery} /></AuiIf>
  </div>
);

const DAY_IN_MS = 86_400_000;
const dateGroupLabel = (date: Date | undefined, startOfToday: number): string => {
  if (!date || date.getTime() >= startOfToday) return "今日";
  if (date.getTime() >= startOfToday - DAY_IN_MS) return "昨日";
  return "以前";
};

export type ThreadListGroup = { label: string; indices: number[] };

export const useThreadListGroups = (searchQuery = "") => {
  const threadIds = useAuiState((s) => s.threads.threadIds);
  const threadItems = useAuiState((s) => s.threads.threadItems);
  const query = searchQuery.trim().toLowerCase();
  return useMemo(() => {
    const itemsById = new Map(threadItems.map((item) => [item.id, item]));
    const dates = threadIds.map((id) => itemsById.get(id)?.lastMessageAt);
    const filteredIndices = threadIds.map((id, index) => ({ id, index })).filter(({ id }) => !query || (itemsById.get(id)?.title || "新しいチャット").toLowerCase().includes(query)).map(({ index }) => index);
    if (!filteredIndices.some((index) => dates[index])) return { threadIds, filteredIndices, groups: null };
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const time = (index: number) => dates[index]?.getTime() ?? Number.MAX_SAFE_INTEGER;
    const result: ThreadListGroup[] = [];
    for (const index of [...filteredIndices].sort((a, b) => time(b) - time(a))) {
      const label = dateGroupLabel(dates[index], startOfToday);
      const lastGroup = result[result.length - 1];
      if (lastGroup?.label === label) lastGroup.indices.push(index);
      else result.push({ label, indices: [index] });
    }
    return { threadIds, filteredIndices, groups: result };
  }, [threadIds, threadItems, query]);
};

const ThreadListItemGroups: FC<{ searchQuery?: string }> = ({ searchQuery = "" }) => {
  const { threadIds, filteredIndices, groups } = useThreadListGroups(searchQuery);
  if (searchQuery.trim() && filteredIndices.length === 0) return <div className="text-muted-foreground px-2.5 py-4 text-sm">該当する会話はありません</div>;
  if (!groups) return filteredIndices.map((index) => <ThreadListPrimitive.ItemByIndex key={threadIds[index]} index={index} components={{ ThreadListItem }} />);
  return groups.map((group) => (
    <Fragment key={group.label}>
      <div className="text-muted-foreground px-2.5 pt-3 pb-1 text-xs font-medium">{group.label}</div>
      {group.indices.map((index) => <ThreadListPrimitive.ItemByIndex key={threadIds[index]} index={index} components={{ ThreadListItem }} />)}
    </Fragment>
  ));
};

export const ThreadListNew = forwardRef<HTMLButtonElement, ComponentPropsWithoutRef<typeof Button>>(({ className, children, ...props }, ref) => (
  <ThreadListPrimitive.New asChild>
    <Button ref={ref} variant="ghost" className={cn("hover:bg-muted data-active:bg-muted h-8 justify-start gap-2 rounded-md px-2.5 text-sm font-normal", className)} {...props}>
      {children ?? <><PlusIcon className="size-4 shrink-0" /><span className="whitespace-nowrap">新しいチャット</span></>}
    </Button>
  </ThreadListPrimitive.New>
));
ThreadListNew.displayName = "ThreadListNew";

const ThreadListSkeleton: FC = () => (
  <div className="flex flex-col gap-0.5">
    {Array.from({ length: 5 }, (_, index) => <div key={index} role="status" aria-label="会話を読み込んでいます" className="flex h-8 items-center px-2.5"><Skeleton className="h-3.5 w-full" /></div>)}
  </div>
);

export const ThreadListItem: FC = () => {
  const isRunning = useAuiState((s) => s.threadListItem.isRunning);
  return (
    <ThreadListItemPrimitive.Root className="group hover:bg-muted focus-visible:bg-muted data-active:bg-muted has-focus-visible:bg-muted has-data-[state=open]:bg-muted relative flex h-8 items-center rounded-md transition-colors focus-visible:outline-none">
      <ThreadListItemPrimitive.Trigger className="focus-visible:ring-ring/50 flex h-full min-w-0 flex-1 items-center rounded-md px-2.5 text-start text-sm outline-none group-hover:pe-9 group-data-active:pe-9 focus-visible:ring-1">
        {isRunning && <Loader2Icon aria-hidden className="text-muted-foreground me-1.5 size-3.5 shrink-0 animate-spin" />}
        <span className="min-w-0 flex-1 truncate"><ThreadListItemPrimitive.Title fallback="新しいチャット" /></span>
        {isRunning && <span className="sr-only">実行中</span>}
      </ThreadListItemPrimitive.Trigger>
      <ThreadListItemMore />
    </ThreadListItemPrimitive.Root>
  );
};

const ThreadListItemMore: FC = () => (
  <ThreadListItemMorePrimitive.Root sharedFocusGroup>
    <ThreadListItemMorePrimitive.Trigger asChild>
      <Button variant="ghost" size="icon" className="data-[state=open]:bg-accent absolute end-1.5 top-1/2 size-6 -translate-y-1/2 p-0 opacity-0 group-hover:opacity-100 group-has-focus-visible:opacity-100 group-data-active:opacity-100 data-[state=open]:opacity-100">
        <MoreHorizontalIcon className="size-3.5" /><span className="sr-only">その他の操作</span>
      </Button>
    </ThreadListItemMorePrimitive.Trigger>
    <ThreadListItemMorePrimitive.Content side="right" align="start" sideOffset={6} className="bg-popover text-popover-foreground data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=open]:animate-in z-50 min-w-32 overflow-hidden rounded-xl border p-1.5">
      <ThreadListItemPrimitive.Delete asChild>
        <ThreadListItemMorePrimitive.Item className="text-destructive hover:bg-destructive/10 focus:bg-destructive/10 flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm outline-none select-none">
          <TrashIcon className="size-4" />削除
        </ThreadListItemMorePrimitive.Item>
      </ThreadListItemPrimitive.Delete>
    </ThreadListItemMorePrimitive.Content>
  </ThreadListItemMorePrimitive.Root>
);
