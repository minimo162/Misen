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
