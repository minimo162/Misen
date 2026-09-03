import { Agent } from '@earendil-works/pi-agent-core'
import { createBrain } from './brain.js'
import { defaultSettingsPath, describeBrainProfile, loadBrainProfile, type BrainProfileIdentity } from './brain-profile.js'
import { prepareAgentCustomization } from './customized.js'

export interface LiveAgentOptions {
  /** Defaults to MISEN_SETTINGS_PATH or %LOCALAPPDATA%\Misen\config\settings.json. */
  readonly settingsPath?: string
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
  const customization = await prepareAgentCustomization(root)
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
