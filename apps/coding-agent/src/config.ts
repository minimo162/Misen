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

export type LlmProvider = 'openai' | 'copilot-edge' | 'ollama' | 'external-openai'
export type AgentLoop = 'v1' | 'v2'
export type ReasoningEffort = 'high' | 'medium' | 'low' | 'none'
export type AgentOptimizationMode = 'on' | 'off'

/** Settings for the explicitly opt-in, generic external OpenAI-compatible path. */
export interface ExternalProviderSettings {
  enabled?: boolean
  /** Workspace containing only invented synthetic data for external model calls. */
  syntheticWorkspace?: string
}

/** Marker contract used at the synthetic-workspace boundary. */
export const SYNTHETIC_WORKSPACE_MARKER = '.company-apps-synthetic.json'
export const SYNTHETIC_WORKSPACE_MARKER_EXPECTED = Object.freeze({
  schema: 'company-apps.synthetic-workspace/v1',
  classification: 'synthetic',
  purpose: 'external-provider-validation'
})

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
  /** Generic external OpenAI-compatible provider; never enabled implicitly. */
  externalProvider?: ExternalProviderSettings
  /** Optional provider-specific reasoning budget. Ollama sends this as reasoning_effort. */
  reasoningEffort?: ReasoningEffort
  /** Deterministic v2 prompt/context optimization toggle. Telemetry remains enabled in both modes. */
  agentOptimization?: AgentOptimizationMode
  copilot?: CopilotSettingsPartial
  localResponseConverter?: LocalResponseConverterSettings
  weather?: WeatherSettings
  chatTemplateKwargs?: Record<string, unknown>
  /** Internal per-turn capability lock. It is never selected by the model. */
  turnMode?: TurnMode
  /** Optional append-only audit directory. It must resolve outside the workspace. */
  auditLogDir?: string
  /** Internal source config path used to resolve relative external boundaries. */
  configPath?: string
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
  agentOptimization: 'on',
  permissions: [],
  autoApprove: { write: false, command: false },
  copilot: { displayMode: 'foreground', agentMode: true },
  localResponseConverter: { enabled: false, baseURL: 'http://127.0.0.1:8080/v1', model: 'Qwen3.5-4B-Q4_K_M.gguf', timeoutMs: 30000, apiKey: 'company-apps-flex-local' }
}

function appDataConfigPath(): string {
  return path.join(process.env.APPDATA ?? process.env.USERPROFILE ?? '.', 'CompanyApps', 'coding-agent', 'config.json')
}

export function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/gu, '')
  if (normalized === 'localhost' || normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') return true
  // URL.hostname returns a canonical dotted IPv4 string for normal IPv4 literals.
  const octets = normalized.split('.')
  if (octets.length !== 4 || octets.some((octet) => !/^\d{1,3}$/u.test(octet) || Number(octet) > 255)) return false
  return Number(octets[0]) === 127
}

function validateProviderConfig(provider: unknown, raw: AgentConfig, found: string): LlmProvider {
  if (provider !== 'openai' && provider !== 'copilot-edge' && provider !== 'ollama' && provider !== 'external-openai') {
    throw new Error(`サポートされていない provider です: ${String(provider)}: ${found}`)
  }
  if (provider === 'openai' && (!raw.baseURL || !raw.model)) {
    throw new Error(`provider=openai には baseURL / model が必要です: ${found}`)
  }
  if (provider === 'ollama') {
    if (!raw.baseURL || !raw.model) throw new Error(`provider=ollama には baseURL / model が必要です: ${found}`)
    let parsed: URL
    try { parsed = new URL(raw.baseURL) } catch { throw new Error(`provider=ollama の baseURL が不正です: ${found}`) }
    if (!['http:', 'https:'].includes(parsed.protocol) || !isLoopbackHostname(parsed.hostname)) {
      throw new Error(`provider=ollama の baseURL は loopback URL でなければなりません: ${found}`)
    }
  }
  if (provider === 'external-openai') {
    if (raw.agentLoop !== 'v2') throw new Error(`provider=external-openai には agentLoop=v2 が必要です: ${found}`)
    if (!raw.baseURL || !raw.model) throw new Error(`provider=external-openai には baseURL / model が必要です: ${found}`)
    if (Object.prototype.hasOwnProperty.call(raw, 'apiKey')) throw new Error(`provider=external-openai は plaintext apiKey を受け付けません: ${found}`)
    if (raw.restrictToWorkspace === false) throw new Error(`provider=external-openai では restrictToWorkspace=false を指定できません: ${found}`)
    if (raw.safeCommandOnly === false) throw new Error(`provider=external-openai では safeCommandOnly=false を指定できません: ${found}`)
    if (typeof raw.apiKeyEnv !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(raw.apiKeyEnv)) throw new Error(`provider=external-openai には apiKeyEnv が必要です: ${found}`)
    const external = raw.externalProvider
    if (!external || external.enabled !== true) throw new Error(`provider=external-openai には externalProvider.enabled=true が必要です: ${found}`)
    if (typeof external.syntheticWorkspace !== 'string' || !external.syntheticWorkspace.trim()) throw new Error(`provider=external-openai には externalProvider.syntheticWorkspace が必要です: ${found}`)
    let parsed: URL
    try { parsed = new URL(raw.baseURL) } catch { throw new Error(`provider=external-openai の baseURL が不正です: ${found}`) }
    if (parsed.username || parsed.password) throw new Error(`provider=external-openai の baseURL に URL credentials は指定できません: ${found}`)
    if (parsed.protocol === 'https:') {
      // HTTPS endpoints may be remote or loopback.
    } else if (parsed.protocol === 'http:' && isLoopbackHostname(parsed.hostname)) {
      // Loopback HTTP is retained for deterministic local tests only.
    } else {
      throw new Error(`provider=external-openai の baseURL は HTTPS、または loopback HTTP でなければなりません: ${found}`)
    }
  }
  if (raw.reasoningEffort !== undefined && !['high', 'medium', 'low', 'none'].includes(raw.reasoningEffort)) {
    throw new Error(`reasoningEffort は high / medium / low / none で指定してください: ${found}`)
  }
  return provider
}

function parseConfig(found: string): AgentConfig {
  const raw = JSON.parse(fs.readFileSync(found, 'utf8')) as AgentConfig
  if (raw.agentLoop !== undefined && raw.agentLoop !== 'v1' && raw.agentLoop !== 'v2') {
    throw new Error(`agentLoop は v1 または v2 を指定してください: ${found}`)
  }
  if (raw.agentOptimization !== undefined && raw.agentOptimization !== 'on' && raw.agentOptimization !== 'off') {
    throw new Error(`agentOptimization は on または off を指定してください: ${found}`)
  }
  // Existing config files without an explicit provider remain on the generic
  // OpenAI-compatible path. The generated no-config default is still Copilot.
  const provider = validateProviderConfig(raw.provider ?? 'openai', raw, found)
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
    ...(provider === 'external-openai' ? { restrictToWorkspace: true, safeCommandOnly: true } : {}),
    permissions: permissions ?? DEFAULT_CONFIG.permissions,
    autoApprove: { ...DEFAULT_CONFIG.autoApprove, ...(raw.autoApprove ?? {}) },
    copilot: { ...DEFAULT_CONFIG.copilot, ...(raw.copilot ?? {}) },
    localResponseConverter: { ...DEFAULT_CONFIG.localResponseConverter, ...(raw.localResponseConverter ?? {}) },
    configPath: path.resolve(found)
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

/** Resolve the configured synthetic workspace against the source config file. */
export function resolveSyntheticWorkspace(cfg: AgentConfig): string {
  const configured = cfg.externalProvider?.syntheticWorkspace
  if (!configured || !configured.trim()) throw new Error('externalProvider.syntheticWorkspace が設定されていません')
  const base = cfg.configPath ? path.dirname(path.resolve(cfg.configPath)) : process.cwd()
  return path.resolve(base, configured)
}

/** Validate the marker contract for any generated synthetic fixture workspace. */
export function assertSyntheticWorkspaceMarker(currentWorkspace: string): void {
  const current = path.resolve(currentWorkspace)
  let currentStat: fs.Stats
  try { currentStat = fs.lstatSync(current) } catch { throw new Error('合成ワークスペースを安全に確認できないため停止しました') }
  if (!currentStat.isDirectory() || currentStat.isSymbolicLink()) {
    throw new Error('合成ワークスペースのディレクトリ junction／シンボリックリンクは利用できません')
  }
  const marker = path.join(current, SYNTHETIC_WORKSPACE_MARKER)
  let markerStat: fs.Stats
  try { markerStat = fs.lstatSync(marker) } catch { throw new Error('合成ワークスペースの確認マーカーがありません') }
  if (!markerStat.isFile() || markerStat.isSymbolicLink()) throw new Error('合成ワークスペースの確認マーカーが不正です')
  let parsed: unknown
  try { parsed = JSON.parse(fs.readFileSync(marker, 'utf8')) as unknown } catch { throw new Error('合成ワークスペースの確認マーカーを読めません') }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('合成ワークスペースの確認マーカーが不正です')
  const record = parsed as Record<string, unknown>
  const expectedKeys = Object.keys(SYNTHETIC_WORKSPACE_MARKER_EXPECTED)
  const keys = Object.keys(record)
  if (keys.length !== expectedKeys.length || expectedKeys.some((key) => !Object.prototype.hasOwnProperty.call(record, key) || record[key] !== SYNTHETIC_WORKSPACE_MARKER_EXPECTED[key as keyof typeof SYNTHETIC_WORKSPACE_MARKER_EXPECTED])) {
    throw new Error('合成ワークスペースの確認マーカーが不正です')
  }
}

/**
 * Fail closed before an external model request unless the caller is exactly in
 * the configured synthetic workspace and its marker has the expected contract.
 */
export function assertSyntheticWorkspaceBoundary(cfg: AgentConfig, currentWorkspace: string): void {
  if (cfg.provider !== 'external-openai') return
  if (cfg.externalProvider?.enabled !== true) throw new Error('外部AIは明示的に有効化されていません')
  const configured = resolveSyntheticWorkspace(cfg)
  let configuredReal: string
  let currentReal: string
  try {
    configuredReal = fs.realpathSync.native(configured)
  } catch {
    throw new Error('外部AI用の合成ワークスペースが見つかりません')
  }
  try {
    currentReal = fs.realpathSync.native(path.resolve(currentWorkspace))
  } catch {
    throw new Error('現在のワークスペースを確認できないため、外部AIを停止しました')
  }
  if (configuredReal !== currentReal) throw new Error('外部AIは設定済みの合成ワークスペースでのみ利用できます')

  // A directory junction/symlink can make the configured path resolve to a
  // different tree while keeping configuredReal === currentReal. Reject the
  // reparse point itself so replacing the workspace between model calls cannot
  // redirect a later request to a newly mounted tree.
  let configuredStat: fs.Stats
  let currentStat: fs.Stats
  try {
    configuredStat = fs.lstatSync(configured)
    currentStat = fs.lstatSync(path.resolve(currentWorkspace))
  } catch {
    throw new Error('合成ワークスペースを安全に確認できないため、外部AIを停止しました')
  }
  if (!configuredStat.isDirectory() || configuredStat.isSymbolicLink() || !currentStat.isDirectory() || currentStat.isSymbolicLink()) {
    throw new Error('合成ワークスペースのディレクトリ junction／シンボリックリンクは利用できません')
  }

  assertSyntheticWorkspaceMarker(configuredReal)
}
