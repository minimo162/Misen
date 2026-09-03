import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { AgentEvent } from '@earendil-works/pi-agent-core'
import { runOfficeReplay } from '../src/runtime/agent.js'
import { createDemoServer, textFromAssistantMessage, type AgentRunner } from '../src/web/server.js'

export function officeReplayRunner(kind: 'word' | 'powerpoint'): AgentRunner {
  return async (root, prompt, context) => {
    const tools: string[] = []
    const observe = (event: AgentEvent) => {
      if (event.type === 'tool_execution_start') {
        tools.push(event.toolName)
        context?.emit({ type: 'tool', phase: 'start', id: event.toolCallId, name: event.toolName })
      } else if (event.type === 'tool_execution_end') {
        context?.emit({ type: 'tool', phase: 'end', id: event.toolCallId, name: event.toolName, status: event.isError ? 'error' : 'success' })
      } else if (event.type === 'message_update' || event.type === 'message_end') {
        const text = textFromAssistantMessage(event.message)
        if (text) context?.emit({ type: 'assistant', text })
      }
    }
    const replay = await runOfficeReplay(root, kind, prompt, observe)
    return { tools, status: replay.agent.state.errorMessage ? 'FAIL' : 'COMPLETED' }
  }
}

if (process.argv[1]?.endsWith('office-ui.js')) {
  const root = process.argv[2]
  const kind = process.argv[3]
  const port = Number(process.argv[4] ?? '8788')
  if (!root || (kind !== 'word' && kind !== 'powerpoint') || !Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error('usage: office-ui <absolute-workspace> <word|powerpoint> [port]')
  }
  await mkdir(root, { recursive: true })
  const server = createDemoServer(root, officeReplayRunner(kind), undefined, {
    sessionDirectory: join(root, '.misen-sessions'),
  })
  server.listen(port, '127.0.0.1')
}
