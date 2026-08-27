export type SessionBoundRun = { sessionId?: string } | null | undefined

/** Reject stale async responses after the selected session changes. */
export function isCurrentSessionRun(run: SessionBoundRun, requestedSessionId: string | null | undefined, currentSessionId: string | null | undefined): boolean {
  return Boolean(run?.sessionId && requestedSessionId && requestedSessionId === currentSessionId && run.sessionId === currentSessionId)
}
