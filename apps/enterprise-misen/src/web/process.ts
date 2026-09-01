export type ToolEvent = {
  id: string
  runId: string
  name: string
  detail?: string
  status: 'running' | 'success' | 'error'
}

/** Keep process evidence attached to the turn that produced it. */
export function processEventsForRun(tools: readonly ToolEvent[], runId: string | undefined): ToolEvent[] {
  return runId ? tools.filter(tool => tool.runId === runId) : []
}

export function runIdFromMessage(messageId: string, role: 'user' | 'assistant'): string {
  return role === 'assistant' && messageId.startsWith('assistant-') ? messageId.slice('assistant-'.length) : messageId
}

type VisibleMessage = {
  id: string
  role: 'user' | 'assistant'
  text: string
}

/** Show quiet feedback only during the active run's pre-activity gap. */
export function shouldShowThinkingPlaceholder(
  messages: readonly VisibleMessage[],
  tools: readonly ToolEvent[],
  running: boolean,
  activeRunId: string | undefined,
): boolean {
  if (!running || !activeRunId) return false
  const userIsVisible = messages.some(message => message.role === 'user' && message.id === activeRunId)
  const assistantIsVisible = messages.some(message => message.role === 'assistant' && message.id === `assistant-${activeRunId}` && message.text.trim().length > 0)
  return userIsVisible && !assistantIsVisible && processEventsForRun(tools, activeRunId).length === 0
}
