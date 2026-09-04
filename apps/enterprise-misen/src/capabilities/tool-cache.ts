import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core'

export const READ_TOOL_NAMES = Object.freeze([
  'workspace_list_files',
  'workspace_read_text',
  'office_get',
  'office_query',
  'office_inspect',
  'spreadsheet_read',
  'document_read',
  'presentation_read',
  'pdf_read',
  'pdf_render',
] as const)

const readTools = new Set<string>(READ_TOOL_NAMES)

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, item]) => [key, canonical(item)]))
}

function cacheKey(name: string, args: unknown): string {
  return `${name}\n${JSON.stringify(canonical(args))}`
}

function cachedResult(result: AgentToolResult<any>): AgentToolResult<any> {
  const copy = structuredClone(result)
  const details = copy.details && typeof copy.details === 'object' && !Array.isArray(copy.details)
    ? { ...copy.details, cached: true }
    : { value: copy.details, cached: true }
  return { ...copy, details }
}

/** Session-local gateway immediately before Tool execution. */
export function withSessionReadCache(tools: readonly AgentTool[]): AgentTool[] {
  const cache = new Map<string, AgentToolResult<any>>()
  return tools.map(tool => Object.freeze({
    ...tool,
    execute: async (...args: Parameters<AgentTool['execute']>) => {
      const params = args[1]
      if (!readTools.has(tool.name)) {
        cache.clear()
        return await tool.execute(...args)
      }
      const key = cacheKey(tool.name, params)
      const previous = cache.get(key)
      if (previous) return cachedResult(previous)
      const result = await tool.execute(...args)
      cache.set(key, structuredClone(result))
      return result
    },
  }))
}
