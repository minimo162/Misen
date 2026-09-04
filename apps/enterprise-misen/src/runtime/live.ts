import { Agent } from '@earendil-works/pi-agent-core'
import { createBrain } from './brain.js'
import { defaultSettingsPath, describeBrainProfile, loadBrainProfile, type BrainProfileIdentity } from './brain-profile.js'
import { prepareAgentCustomization } from './customized.js'
import type { LifecycleHook } from '../customization/hooks.js'

export type ApprovalMode = 'confirm' | 'session-auto'
export type BlockedCheckpoint = { verb: string; target: string; risk: '中' | '高'; reason: string }

export interface LiveAgentOptions {
  /** Defaults to MISEN_SETTINGS_PATH or %LOCALAPPDATA%\Misen\config\settings.json. */
  readonly settingsPath?: string
  /** Session-only approval state supplied by the local UI host; never persisted in the Agent. */
  readonly approvalMode?: ApprovalMode
  readonly onCheckpointBlocked?: (checkpoint: BlockedCheckpoint) => void | Promise<void>
}

export function checkpointFor(name: string, args: unknown): BlockedCheckpoint | undefined {
  const values = args && typeof args === 'object' ? args as Record<string, unknown> : {}
  if (name === 'office_create_output' && values.overwrite === true) {
    return { verb: '上書き', target: typeof values.output === 'string' ? values.output : '成果物', risk: '中', reason: '既存ファイルの内容が置き換わります。' }
  }
  const batchRemoves = name === 'office_batch' && Array.isArray(values.items) && values.items.some(item => item && typeof item === 'object' && (item as Record<string, unknown>).command === 'remove')
  if (name === 'office_remove' || batchRemoves) {
    return { verb: '削除', target: typeof values.file === 'string' ? values.file : 'Office 要素', risk: '高', reason: '既存の要素が削除されます。' }
  }
  return undefined
}

export function approvalHook(options: LiveAgentOptions): LifecycleHook {
  return {
    name: 'misen-session-approval',
    async beforeTool(context) {
      const checkpoint = checkpointFor(context.toolCall.name, context.args)
      if (!checkpoint || options.approvalMode === 'session-auto') return
      await options.onCheckpointBlocked?.(checkpoint)
      return { block: true, reason: `確認が必要な操作を止めました: ${checkpoint.verb}（${checkpoint.reason}）`, terminate: false }
    },
  }
}

/**
 * Live route (Issue #93 B / Issue #86): the Brain comes from the deployment-managed per-user
 * settings file, never from source, the prompt, or the UI. One provider, one model, no fallback,
 * maxRetries 0. The credential reaches Pi only through `getApiKey`, so it is never in the Agent
 * state, events, logs, or artifacts.
 */
export async function liveAgent(root: string, options: LiveAgentOptions = {}) {
  const profile = await loadBrainProfile(options.settingsPath ?? defaultSettingsPath())
  const brain = createBrain(profile)
  const streamFn = (activeModel: any, context: any, streamOptions: any) => brain.models.streamSimple(activeModel, context, { ...streamOptions, maxRetries: 0 } as any)
  const customization = await prepareAgentCustomization(root, [approvalHook(options)])
  return new Agent({
    initialState: { systemPrompt: customization.systemPrompt, model: brain.model, thinkingLevel: profile.thinkingLevel, tools: [...customization.tools] },
    streamFn,
    getApiKey: provider => (provider === brain.providerId ? profile.credential() : undefined),
    toolExecution: 'sequential',
    maxRetryDelayMs: 0,
    beforeToolCall: customization.hooks.beforeToolCall,
    afterToolCall: customization.hooks.afterToolCall,
  })
}

/** Audit-safe identity of the Brain the live route would use (no secret). */
export async function liveBrainIdentity(options: LiveAgentOptions = {}): Promise<BrainProfileIdentity> {
  return describeBrainProfile(await loadBrainProfile(options.settingsPath ?? defaultSettingsPath()))
}
