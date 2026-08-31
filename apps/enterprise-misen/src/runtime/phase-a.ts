import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import type { Config as LlmPiAiConfig } from '@deepseek-ai/dsh-llm-pi-ai'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SessionStore from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'

/**
 * The deliberately small public DSH composition used by the Phase A spike.
 *
 * The `agent-spine-demo` example is a useful reference architecture, but it
 * also mounts optional product surfaces (jobs, skills, goals, bash, and
 * discovery). Misen owns this composition so the model-facing capability
 * boundary remains explicit and reviewable.
 */
export const PHASE_A_COMPONENTS = Object.freeze([
  '@deepseek-ai/cordis@4.0.2',
  '@deepseek-ai/dsh-llm@0.1.2-alpha.2',
  '@deepseek-ai/dsh-session@0.1.2-alpha.2',
  '@deepseek-ai/dsh-session-projection@0.1.2-alpha.2',
  '@deepseek-ai/dsh-system-prompt@0.1.2-alpha.2',
  '@deepseek-ai/dsh-tools@0.1.2-alpha.2',
  '@deepseek-ai/dsh-agent@0.1.2-alpha.2',
  '@deepseek-ai/dsh-agent-loop@0.1.2-alpha.2',
] as const)

export interface PhaseACompositionOptions {
  /** Optional deployment persona; tool schemas are still assembled by DSH. */
  readonly persona?: string
}

/**
 * The first Enterprise Brain route. The provider adapter is DSH's public
 * pi-ai composition seam; Misen owns only this declarative deployment profile.
 * The environment reference is resolved per request by DSH and is never
 * copied into this module's state or logs.
 */
export const ENTERPRISE_BRAIN_PROFILE: LlmPiAiConfig = {
  providers: {
    openai: {
      apiKeyEnv: 'OPENAI_API_KEY',
      api: 'openai-responses',
      baseURL: 'https://api.openai.com/v1',
      reasoning: 'off',
      models: [{
        id: 'gpt-5.6-luna',
        name: 'GPT-5.6 Luna',
        contextWindow: 1_050_000,
        maxTokens: 128_000,
        input: ['text', 'image'],
        reasoningEfforts: {
          off: 'none',
          low: 'low',
          medium: 'medium',
          high: 'high',
          xhigh: 'xhigh',
          max: 'max',
        },
      }],
    },
  },
}

/** Exact public DSH packages used by the optional live Brain composition. */
export const ENTERPRISE_BRAIN_COMPONENTS = Object.freeze([
  '@deepseek-ai/dsh-llm-pi-ai@0.1.2-alpha.2',
] as const)

export interface EnterpriseBrainCompositionOptions {
  /** Generic persona; business semantics come from the handoff/workspace. */
  readonly persona?: string
}

/**
 * Mount the standard DSH Agent Loop from public package seams only.
 *
 * No adapter is registered here: provider routing is a deployment concern and
 * is injected by the caller through `ctx.llm.registerAdapter()`. This keeps
 * the production composition provider-neutral while tests can use a public
 * `LlmAdapter` implementation as a deterministic local provider.
 */
export async function createPhaseAContext(
  options: PhaseACompositionOptions = {},
): Promise<Context> {
  const ctx = new Context()

  // AgentLoop's public static injection contract requires exactly these
  // services. Mounting order follows the dependency direction documented by
  // DSH's own agent-spine example.
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt, { persona: options.persona ?? '' })
  await ctx.plugin(ToolRuntime, { mode: 'native' })
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })

  return ctx
}

/**
 * Mount the standard provider after the minimal Agent Loop.
 * This is deliberately a second composition entry point so deterministic
 * Phase A tests remain provider-neutral while live acceptance can select the
 * configured OpenAI route without changing the loop or tool registry.
 */
export async function createEnterpriseBrainContext(
  options: EnterpriseBrainCompositionOptions = {},
): Promise<Context> {
  const ctx = await createPhaseAContext({
    persona: options.persona ?? 'General enterprise workspace assistant.',
  })
  await ctx.plugin(LlmPiAi, ENTERPRISE_BRAIN_PROFILE)
  return ctx
}

/**
 * Model-facing service names intentionally absent from this composition.
 * Keeping this list beside the mount makes the Phase A acceptance assertion
 * resistant to accidental reintroduction of the demo's optional surfaces.
 */
export const PHASE_A_FORBIDDEN_SERVICES = Object.freeze([
  'bash',
  'jobs',
  'skills',
  'goals',
  'shell',
  'codeRuntime',
  'pluginRegistry',
  'pluginInventory',
  'telemetry',
] as const)
