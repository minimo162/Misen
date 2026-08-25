import fs from 'node:fs'
import path from 'node:path'

export interface AutoApprove {
  write?: boolean
  command?: boolean
}

export type TurnMode = 'chat' | 'research' | 'work'

export interface CapabilityPolicy {
  mode: TurnMode
  hostTools: 'all' | 'none'
  nativeSearch: boolean
  nativeOffice: boolean
  maxModelDecisions: number
  maxHostExecutions: number
  maxWriteExecutions: number
  maxCommandExecutions: number
  maxNoProgress: number
  autoApproveWrite: boolean
  autoApproveCommand: boolean
  allowArbitraryCommands: boolean
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
  /** Dedicated Edge profile suffix; never reuse another mode's profile. */
  profileName?: string
  modelPriority?: string[]
}

export interface WeatherSettings {
  defaultLocation?: string
}

export interface AgentConfig {
  baseURL: string
  model: string
  apiKey?: string
  apiKeyEnv?: string
  temperature?: number
  maxToolIterations?: number
  maxToolExecutions?: number
  maxWriteExecutions?: number
  maxCommandExecutions?: number
  maxNoProgress?: number
  /** High-risk arbitrary shell execution. Disabled unless explicitly enabled. */
  allowArbitraryCommands?: boolean
  autoApprove?: AutoApprove
  restrictToWorkspace?: boolean
  systemPrompt?: string
  provider?: LlmProvider
  copilot?: CopilotSettingsPartial
  weather?: WeatherSettings
  chatTemplateKwargs?: Record<string, unknown>
  /** Internal per-turn capability lock. It is never selected by the model. */
  turnMode?: TurnMode
}

const DEFAULT_CONFIG: AgentConfig = {
  baseURL: '',
  model: '',
  provider: 'copilot-edge',
  maxToolIterations: 10,
  maxToolExecutions: 8,
  maxWriteExecutions: 3,
  maxCommandExecutions: 2,
  maxNoProgress: 2,
  allowArbitraryCommands: false,
  autoApprove: { write: false, command: false },
  copilot: { displayMode: 'foreground', agentMode: true }
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
  return {
    ...DEFAULT_CONFIG,
    ...raw,
    provider,
    autoApprove: { ...DEFAULT_CONFIG.autoApprove, ...(raw.autoApprove ?? {}) },
    copilot: { ...DEFAULT_CONFIG.copilot, ...(raw.copilot ?? {}) }
  }
}

export function capabilityPolicy(cfg: AgentConfig, mode: TurnMode = cfg.turnMode ?? 'work'): CapabilityPolicy {
  return {
    mode,
    hostTools: mode === 'work' ? 'all' : 'none',
    nativeSearch: mode === 'research',
    nativeOffice: false,
    maxModelDecisions: Math.max(1, cfg.maxToolIterations ?? 10),
    maxHostExecutions: Math.max(1, cfg.maxToolExecutions ?? 8),
    maxWriteExecutions: Math.max(0, cfg.maxWriteExecutions ?? 3),
    maxCommandExecutions: Math.max(0, cfg.maxCommandExecutions ?? 2),
    maxNoProgress: Math.max(1, cfg.maxNoProgress ?? 2),
    autoApproveWrite: cfg.autoApprove?.write === true,
    autoApproveCommand: cfg.autoApprove?.command === true,
    allowArbitraryCommands: cfg.allowArbitraryCommands === true
  }
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
