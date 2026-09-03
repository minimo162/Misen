export type SessionEventShape = {
  type: string
  sessionId?: string
  state?: { sessionId?: string; [key: string]: unknown }
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
