import type { AfterToolCallContext, AfterToolCallResult, BeforeToolCallContext, BeforeToolCallResult } from '@earendil-works/pi-agent-core'
import { ENTERPRISE_TOOL_NAMES } from '../capabilities/tools.js'

export interface SessionPreparation {
  readonly workspaceRoot: string
  readonly systemPrompt: string
  readonly toolNames: readonly string[]
}

export interface LifecycleHook {
  readonly name: string
  readonly prepareSession?: (context: Readonly<SessionPreparation>) => void | Promise<void>
  readonly beforeTool?: (context: Readonly<BeforeToolCallContext>) => void | BeforeToolCallResult | Promise<void | BeforeToolCallResult>
  readonly afterTool?: (context: Readonly<AfterToolCallContext>) => void | AfterToolCallResult | Promise<void | AfterToolCallResult>
}

export const HOOK_TIMEOUT_MS = 1000
const FAILURE_REASON = 'Misen policy validation failed.'
const FAILURE_CONTENT = [{ type: 'text' as const, text: FAILURE_REASON }]
const allowedTools = new Set<string>(ENTERPRISE_TOOL_NAMES)

const capabilityAuthority: LifecycleHook = Object.freeze({
  name: 'misen-capability-authority',
  prepareSession(context) {
    if (context.toolNames.length !== ENTERPRISE_TOOL_NAMES.length || context.toolNames.some((name, index) => name !== ENTERPRISE_TOOL_NAMES[index])) throw new Error('tool roster mismatch')
  },
  beforeTool(context) {
    if (!allowedTools.has(context.toolCall.name)) return { block: true, reason: FAILURE_REASON, terminate: true }
  },
})

function timeout<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('hook timeout')), HOOK_TIMEOUT_MS)
    const abort = () => reject(new Error('hook aborted'))
    signal?.addEventListener('abort', abort, { once: true })
    operation.then(resolve, reject).finally(() => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
    })
  })
}

function validBefore(value: unknown): value is void | BeforeToolCallResult {
  if (value === undefined) return true
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const result = value as Record<string, unknown>
  return Object.keys(result).every(key => ['block', 'reason', 'terminate'].includes(key)) &&
    (result.block === undefined || typeof result.block === 'boolean') &&
    (result.reason === undefined || typeof result.reason === 'string') &&
    (result.terminate === undefined || typeof result.terminate === 'boolean')
}

function validAfter(value: unknown): value is void | AfterToolCallResult {
  if (value === undefined) return true
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const result = value as Record<string, unknown>
  if (!Object.keys(result).every(key => ['content', 'details', 'isError', 'usage', 'terminate'].includes(key))) return false
  if (result.isError !== undefined && typeof result.isError !== 'boolean') return false
  if (result.terminate !== undefined && typeof result.terminate !== 'boolean') return false
  return result.content === undefined || (Array.isArray(result.content) && result.content.every(part => {
    if (!part || typeof part !== 'object') return false
    const content = part as Record<string, unknown>
    if (content.type === 'text') return typeof content.text === 'string'
    if (content.type === 'image') return typeof content.data === 'string' && typeof content.mimeType === 'string'
    return false
  }))
}

export class StaticLifecycleHooks {
  readonly hooks: readonly LifecycleHook[]

  constructor(additional: readonly LifecycleHook[] = []) {
    this.hooks = Object.freeze([capabilityAuthority, ...additional.map(hook => Object.freeze({ ...hook }))])
    if (this.hooks.some(hook => !hook || typeof hook.name !== 'string' || hook.name.trim().length === 0)) throw new TypeError('hooks must be statically registered named objects')
  }

  async prepareSession(context: SessionPreparation): Promise<void> {
    try {
      for (const hook of this.hooks) if (hook.prepareSession) await timeout(Promise.resolve().then(() => hook.prepareSession!(Object.freeze(context))))
    } catch { throw new Error(FAILURE_REASON) }
  }

  readonly beforeToolCall = async (context: BeforeToolCallContext, signal?: AbortSignal): Promise<BeforeToolCallResult | undefined> => {
    try {
      for (const hook of this.hooks) {
        if (!hook.beforeTool) continue
        const result = await timeout(Promise.resolve().then(() => hook.beforeTool!(Object.freeze(context))), signal)
        if (!validBefore(result)) throw new Error('invalid before hook result')
        if (result?.block) return { block: true, reason: result.reason ?? FAILURE_REASON, terminate: result.terminate ?? true }
      }
      return undefined
    } catch { return { block: true, reason: FAILURE_REASON, terminate: true } }
  }

  readonly afterToolCall = async (context: AfterToolCallContext, signal?: AbortSignal): Promise<AfterToolCallResult | undefined> => {
    try {
      let merged: AfterToolCallResult | undefined
      for (const hook of this.hooks) {
        if (!hook.afterTool) continue
        const result = await timeout(Promise.resolve().then(() => hook.afterTool!(Object.freeze(context))), signal)
        if (!validAfter(result)) throw new Error('invalid after hook result')
        if (result) merged = { ...merged, ...result }
      }
      return merged
    } catch { return { content: FAILURE_CONTENT, details: { code: 'POLICY_VALIDATION_FAILED' }, isError: true, terminate: true } }
  }
}
