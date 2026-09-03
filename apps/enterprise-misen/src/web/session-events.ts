export type SessionEventShape = {
  type: string
  sessionId?: string
  state?: { sessionId?: string; [key: string]: unknown }
}

export type SessionSelectionGuard = { revision: number }

/** Start a session-selection request and return its monotonically increasing token. */
export function beginSessionSelection(guard: SessionSelectionGuard): number {
  guard.revision += 1
  return guard.revision
}

/** Only the most recently started selection may replace the active conversation. */
export function isCurrentSessionSelection(guard: SessionSelectionGuard, revision: number): boolean {
  return guard.revision === revision
}

/** Return the canonical session identity for every SSE event shape. */
export function sessionIdForEvent(event: SessionEventShape): string | undefined {
  return event.type === 'state' ? event.state?.sessionId : event.sessionId
}

/**
 * Session-scoped events apply only to their active session. Sessionless events
 * are startup-global and apply only before a conversation becomes active.
 */
export function eventAppliesToActiveSession(event: SessionEventShape, activeSessionId: string | undefined): boolean {
  const eventSessionId = sessionIdForEvent(event)
  return eventSessionId === undefined ? activeSessionId === undefined : eventSessionId === activeSessionId
}
