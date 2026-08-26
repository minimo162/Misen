import fs from 'node:fs'
import path from 'node:path'

export interface AutoApprove {
  write?: boolean
  command?: boolean
}

export interface PermissionRule {
  permission: string
  pattern: string
  action: 'allow' | 'ask' | 'deny'
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
export type AgentLoop = 'v1' | 'v2'

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

/** Optional loopback-only llama.cpp post-processor for Copilot's raw reply. */
export interface LocalResponseConverterSettings {
  enabled?: boolean
  /** OpenAI-compatible llama-server URL.  Non-loopback URLs are rejected. */
  baseURL?: string
  model?: string
  timeoutMs?: number
  /** Loopback server token; not a remote service credential. */
  apiKey?: string
}

export interface AgentConfig {
  /** Runtime-selectable agent loop. v1 remains the production default. */
  agentLoop?: AgentLoop
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
  /** Declarative permissions applied only by the agent-loop v2 before-hook. */
  permissions?: PermissionRule[]
  /** When enabled, command tools accept only the explicit workspace-file open allowlist. */
  safeCommandOnly?: boolean
  autoApprove?: AutoApprove
  restrictToWorkspace?: boolean
  systemPrompt?: string
  provider?: LlmProvider
  copilot?: CopilotSettingsPartial
  localResponseConverter?: LocalResponseConverterSettings
  weather?: WeatherSettings
  chatTemplateKwargs?: Record<string, unknown>
  /** Internal per-turn capability lock. It is never selected by the model. */
  turnMode?: TurnMode
}

const DEFAULT_CONFIG: AgentConfig = {
  agentLoop: 'v1',
  baseURL: '',
  model: '',
  provider: 'copilot-edge',
  maxToolIterations: 10,
  maxToolExecutions: 8,
  maxWriteExecutions: 3,
  maxCommandExecutions: 2,
  maxNoProgress: 2,
  allowArbitraryCommands: false,
  permissions: [],
  autoApprove: { write: false, command: false },
  copilot: { displayMode: 'foreground', agentMode: true },
  localResponseConverter: { enabled: false, baseURL: 'http://127.0.0.1:8080/v1', model: 'Qwen3.5-4B-Q4_K_M.gguf', timeoutMs: 30000, apiKey: 'company-apps-flex-local' }
}

function appDataConfigPath(): string {
  return path.join(process.env.APPDATA ?? process.env.USERPROFILE ?? '.', 'CompanyApps', 'coding-agent', 'config.json')
}

function parseConfig(found: string): AgentConfig {
  const raw = JSON.parse(fs.readFileSync(found, 'utf8')) as AgentConfig
  if (raw.agentLoop !== undefined && raw.agentLoop !== 'v1' && raw.agentLoop !== 'v2') {
    throw new Error(`agentLoop は v1 または v2 を指定してください: ${found}`)
  }
  const provider = raw.provider ?? 'openai'
  if (provider === 'openai' && (!raw.baseURL || !raw.model)) {
    throw new Error(`provider=openai には baseURL / model が必要です: ${found}`)
  }
  const configuredPermissions = (raw as unknown as { permissions?: unknown }).permissions
  let permissions: PermissionRule[] | undefined
  if (configuredPermissions !== undefined) {
    if (!Array.isArray(configuredPermissions)) throw new Error(`permissions は配列で指定してください: ${found}`)
    permissions = configuredPermissions.map((candidate, index) => {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
        throw new Error(`permissions[${index}] は permission / pattern / action を持つオブジェクトで指定してください: ${found}`)
      }
      const rule = candidate as { permission?: unknown; pattern?: unknown; action?: unknown }
      if (typeof rule.permission !== 'string' || typeof rule.pattern !== 'string') {
        throw new Error(`permissions[${index}] の permission / pattern は文字列で指定してください: ${found}`)
      }
      if (rule.action !== 'allow' && rule.action !== 'ask' && rule.action !== 'deny') {
        throw new Error(`permissions[${index}].action は allow / ask / deny で指定してください: ${found}`)
      }
      return { permission: rule.permission, pattern: rule.pattern, action: rule.action }
    })
  }
  return {
    ...DEFAULT_CONFIG,
    ...raw,
    provider,
    permissions: permissions ?? DEFAULT_CONFIG.permissions,
    autoApprove: { ...DEFAULT_CONFIG.autoApprove, ...(raw.autoApprove ?? {}) },
    copilot: { ...DEFAULT_CONFIG.copilot, ...(raw.copilot ?? {}) },
    localResponseConverter: { ...DEFAULT_CONFIG.localResponseConverter, ...(raw.localResponseConverter ?? {}) }
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
