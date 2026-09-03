/**
 * Instantiate exactly one Pi provider + model from a Brain profile (Issue #93 B / Issue #86).
 *
 * Every provider kind is composed through Pi's public `createProvider` seam with a credential
 * resolver that reads only the profile. Ambient environment variables such as OPENAI_API_KEY are
 * never consulted, so a stale key on the machine can never be used silently, and a missing
 * credential fails before any provider request. There is no fallback provider or model.
 */
import { createModels, createProvider, type Api, type ApiKeyAuth, type Model, type Models } from '@earendil-works/pi-ai'
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy'
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic'
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai'
import { BrainProfileError, KEYLESS_CREDENTIAL, type BrainProfile } from './brain-profile.js'

export interface Brain {
  readonly models: Models
  readonly model: Model<Api>
  readonly providerId: string
}

/** Credential resolver bound to the profile: settings file or the referenced environment variable only. */
function profileApiKeyAuth(profile: BrainProfile): ApiKeyAuth {
  return {
    name: 'Misen settings.json',
    resolve: async ({ credential, signal }) => {
      signal.throwIfAborted()
      const key = credential?.key ?? profile.credential()
      if (key) return { auth: { apiKey: key }, source: profile.credentialSource === 'env' ? `settings.json (env ${profile.credentialEnv})` : 'settings.json' }
      if (profile.credentialSource === 'none') return { auth: { apiKey: KEYLESS_CREDENTIAL }, source: 'settings.json (認証なし)' }
      return undefined
    },
  }
}

export function createBrain(profile: BrainProfile): Brain {
  const auth = { apiKey: profileApiKeyAuth(profile) }
  let providerId: string
  let provider
  if (profile.provider === 'openai') {
    const official = openaiProvider()
    const catalog = official.getModels()
    if (!catalog.some(model => model.id === profile.model)) throw new BrainProfileError('unsupported', `OpenAI 公式カタログにないモデルです: ${profile.model}`, profile.settingsPath)
    providerId = 'openai'
    provider = createProvider({ id: providerId, name: 'OpenAI', baseUrl: official.baseUrl, auth, models: catalog, api: openAIResponsesApi() })
  } else if (profile.provider === 'anthropic') {
    const official = anthropicProvider()
    const catalog = official.getModels()
    if (!catalog.some(model => model.id === profile.model)) throw new BrainProfileError('unsupported', `Anthropic 公式カタログにないモデルです: ${profile.model}`, profile.settingsPath)
    providerId = 'anthropic'
    provider = createProvider({ id: providerId, name: 'Anthropic', baseUrl: official.baseUrl, auth, models: catalog, api: anthropicMessagesApi() })
  } else {
    providerId = 'openai-compatible'
    const model: Model<'openai-completions'> = {
      id: profile.model,
      name: profile.model,
      api: 'openai-completions',
      provider: providerId,
      baseUrl: profile.baseUrl!,
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: profile.contextWindow,
      maxTokens: profile.maxTokens,
    }
    provider = createProvider({ id: providerId, name: 'OpenAI互換', baseUrl: profile.baseUrl, auth, models: [model], api: openAICompletionsApi() })
  }
  const models = createModels()
  models.setProvider(provider)
  const model = models.getModel(providerId, profile.model)
  if (!model) throw new BrainProfileError('unsupported', `モデルを解決できません: ${profile.model}`, profile.settingsPath)
  return Object.freeze({ models, model, providerId })
}
