import fs from 'node:fs'
import path from 'node:path'

export interface AutoApprove {
  write?: boolean
  command?: boolean
}

export type LlmProvider = 'openai' | 'copilot-edge'

export interface CopilotSettingsPartial {
  url?: string
  cdpPort?: number
  reuseExistingEdge?: boolean
  maxPromptChars?: number
  pollIntervalMs?: number
  responseTimeoutSec?: number
  stallTimeoutSec?: number
  displayMode?: 'minimized' | 'foreground'
  endMarker?: string
  agentMode?: boolean
  modelPriority?: string[]
}

export interface AgentConfig {
  baseURL: string
  model: string
  apiKey?: string
  apiKeyEnv?: string
  temperature?: number
  maxToolIterations?: number
  autoApprove?: AutoApprove
  restrictToWorkspace?: boolean
  systemPrompt?: string
  provider?: LlmProvider
  copilot?: CopilotSettingsPartial
  chatTemplateKwargs?: Record<string, unknown>
}

const DEFAULT_CONFIG: AgentConfig = {
  baseURL: '',
  model: '',
  provider: 'copilot-edge',
  copilot: { displayMode: 'foreground' }
}

function appDataConfigPath(): string {
  return path.join(process.env.APPDATA ?? process.env.USERPROFILE ?? '.', 'CompanyApps', 'coding-agent', 'config.json')
}

function parseConfig(found: string): AgentConfig {
  const raw = JSON.parse(fs.readFileSync(found, 'utf8')) as AgentConfig
  const provider = raw.provider ?? 'openai'
  if (provider === 'openai' && (!raw.baseURL || !raw.model)) {
    throw new Error(`provider=openai には baseURL / model が必要です: ${found}`)
  }
  return { ...raw, provider }
}

export function loadConfig(explicitPath?: string): AgentConfig {
  if (explicitPath) {
    if (!fs.existsSync(explicitPath)) throw new Error(`指定された config が見つかりません: ${explicitPath}`)
    return parseConfig(explicitPath)
  }
  const appDataPath = appDataConfigPath()
  const candidates = [path.join(process.cwd(), 'config.json'), appDataPath]
  const found = candidates.find((p) => fs.existsSync(p))
  if (found) return parseConfig(found)
  const dir = path.dirname(appDataPath)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(appDataPath, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n', 'utf8')
  console.log(`既定の設定を作成しました: ${appDataPath}`)
  return DEFAULT_CONFIG
}

export function resolveApiKey(cfg: AgentConfig): string | undefined {
  if (cfg.apiKey) return cfg.apiKey
  return process.env[cfg.apiKeyEnv ?? 'COMPANY_LLM_API_KEY']
}
