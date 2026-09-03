/**
 * Deployment-managed Brain profile (Issue #93 B, aligned with Issue #86).
 *
 * The Brain (LLM endpoint, model, credential) is host runtime infrastructure. It is read from one
 * per-user settings file, %LOCALAPPDATA%\Misen\config\settings.json, never from the share, the
 * manifest, the workspace, the prompt, or the browser UI. Exactly one profile is active per run;
 * there is no fallback provider or model. Anything malformed fails closed before a provider request.
 *
 * The credential is held behind a closure so that JSON.stringify(profile), console output, audit
 * records and error messages can never carry the key.
 */
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { ThinkingLevel } from '@earendil-works/pi-ai'

export const SETTINGS_SCHEMA = 'misen-settings/1'
export const BRAIN_PROVIDER_KINDS = ['openai', 'anthropic', 'openai-compatible'] as const
export type BrainProviderKind = (typeof BRAIN_PROVIDER_KINDS)[number]
export const THINKING_LEVELS: readonly ThinkingLevel[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']
export const API_KEY_PLACEHOLDER = 'ここにAPIキーを貼り付ける'
/** Sent as the bearer token to keyless openai-compatible endpoints: Pi requires a non-empty key. Not a secret. */
export const KEYLESS_CREDENTIAL = 'misen-no-credential'
const BRAIN_KEYS = new Set(['provider', 'model', 'baseUrl', 'apiKey', 'thinkingLevel', 'contextWindow', 'maxTokens'])
const DEFAULT_CONTEXT_WINDOW = 32_768
const DEFAULT_MAX_TOKENS = 8_192

export type BrainCredentialSource = 'settings' | 'env' | 'none'

export interface BrainProfile {
  readonly provider: BrainProviderKind
  readonly model: string
  /** Only present for `openai-compatible`; official providers always use their official endpoint. */
  readonly baseUrl: string | undefined
  readonly thinkingLevel: ThinkingLevel
  readonly contextWindow: number
  readonly maxTokens: number
  readonly credentialSource: BrainCredentialSource
  /** Environment variable name when `credentialSource` is `env`. */
  readonly credentialEnv: string | undefined
  readonly settingsPath: string
  /** Returns the secret for the provider request (KEYLESS_CREDENTIAL when none is configured). Non-enumerable: never serialized. */
  readonly credential: () => string | undefined
}

export type BrainProfileErrorCode = 'missing' | 'invalid' | 'unsupported' | 'credential'

export class BrainProfileError extends Error {
  readonly code: BrainProfileErrorCode
  readonly settingsPath: string
  constructor(code: BrainProfileErrorCode, message: string, settingsPath: string) {
    super(message)
    this.name = 'BrainProfileError'
    this.code = code
    this.settingsPath = settingsPath
  }
}

/** %LOCALAPPDATA%\Misen\config\settings.json, or MISEN_SETTINGS_PATH when the launcher sets it. */
export function defaultSettingsPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.MISEN_SETTINGS_PATH) return env.MISEN_SETTINGS_PATH
  const localAppData = env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')
  return join(localAppData, 'Misen', 'config', 'settings.json')
}

/** Template written on first start. JSON with comments (JSONC); comments are stripped before parsing. */
export const SETTINGS_TEMPLATE = `// Misen の LLM 接続設定（この PC のあなた専用）。共有フォルダーには置かないでください。
// 保存場所: %LOCALAPPDATA%\\Misen\\config\\settings.json
// 記入したら保存し、Misen起動.cmd をもう一度ダブルクリックしてください。
{
  "schema": "misen-settings/1",
  "brain": {
    // プロバイダー種別。次のいずれかを指定します。
    //   "openai"            OpenAI 公式 API
    //   "anthropic"         Anthropic 公式 API
    //   "openai-compatible" 社内 LLM や llama.cpp など、OpenAI 互換 API（baseUrl が必須）
    "provider": "openai",

    // モデル名。openai / anthropic は Pi の公式カタログにあるモデル ID を指定します。
    "model": "gpt-5.6-luna",

    // API キー。次のどちらかで指定します。
    //   1. 文字列で直接書く:        "apiKey": "sk-..."
    //   2. 環境変数名を参照する:    "apiKey": { "env": "OPENAI_API_KEY" }   （IT 部門が配布した環境変数を使う場合）
    // 認証が不要な openai-compatible エンドポイントでは、この行ごと削除します（固定文字列 misen-no-credential が送られます）。
    "apiKey": "${API_KEY_PLACEHOLDER}",

    // openai-compatible のときだけ必須。例: "http://127.0.0.1:11434/v1"
    // "baseUrl": "http://127.0.0.1:11434/v1",

    // 推論の深さ（省略可）: "minimal" / "low" / "medium" / "high"
    "thinkingLevel": "medium"
  }
}
`

/** Remove line comments and block comments that sit outside string literals. */
export function stripJsonComments(text: string): string {
  let output = ''
  let index = 0
  while (index < text.length) {
    const char = text[index]!
    if (char === '"') {
      let end = index + 1
      while (end < text.length && text[end] !== '"') {
        if (text[end] === '\\') end += 1
        end += 1
      }
      output += text.slice(index, end + 1)
      index = end + 1
      continue
    }
    if (char === '/' && text[index + 1] === '/') {
      while (index < text.length && text[index] !== '\n') index += 1
      continue
    }
    if (char === '/' && text[index + 1] === '*') {
      const end = text.indexOf('*/', index + 2)
      index = end < 0 ? text.length : end + 2
      continue
    }
    output += char
    index += 1
  }
  return output
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireBrainString(value: unknown, field: string, settingsPath: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new BrainProfileError('invalid', `brain.${field} は空でない文字列で指定してください`, settingsPath)
  if (value.length > 200 || /[\u0000-\u001f\s]/u.test(value)) throw new BrainProfileError('invalid', `brain.${field} に使えない文字が含まれています`, settingsPath)
  return value
}

function parseBaseUrl(value: unknown, settingsPath: string): string {
  const text = requireBrainString(value, 'baseUrl', settingsPath)
  let url: URL
  try {
    url = new URL(text)
  } catch {
    throw new BrainProfileError('invalid', 'brain.baseUrl は http:// または https:// で始まる URL で指定してください', settingsPath)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new BrainProfileError('invalid', 'brain.baseUrl は http:// または https:// で始まる URL で指定してください', settingsPath)
  if (url.username || url.password) throw new BrainProfileError('invalid', 'brain.baseUrl に認証情報を含めることはできません（apiKey を使ってください）', settingsPath)
  if (url.search || url.hash) throw new BrainProfileError('invalid', 'brain.baseUrl にクエリや # を含めることはできません', settingsPath)
  return text.replace(/\/+$/u, '')
}

function parsePositiveInteger(value: unknown, field: string, fallback: number, settingsPath: string): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new BrainProfileError('invalid', `brain.${field} は正の整数で指定してください`, settingsPath)
  return value as number
}

/** Validate settings text into a frozen profile. The secret is captured by a closure, not a property. */
export function parseBrainSettings(text: string, settingsPath: string, env: NodeJS.ProcessEnv = process.env): BrainProfile {
  let parsed: unknown
  try {
    parsed = JSON.parse(stripJsonComments(text))
  } catch {
    throw new BrainProfileError('invalid', 'settings.json を JSON として読み取れません（カンマや引用符を確認してください）', settingsPath)
  }
  if (!isPlainObject(parsed)) throw new BrainProfileError('invalid', 'settings.json の最上位はオブジェクトである必要があります', settingsPath)
  if (parsed.schema !== SETTINGS_SCHEMA) throw new BrainProfileError('invalid', `schema は "${SETTINGS_SCHEMA}" を指定してください`, settingsPath)
  const brain = parsed.brain
  if (!isPlainObject(brain)) throw new BrainProfileError('invalid', 'brain セクションがありません', settingsPath)
  for (const key of Object.keys(brain)) {
    if (!BRAIN_KEYS.has(key)) throw new BrainProfileError('invalid', `brain.${key} は未知の設定項目です（使える項目: ${[...BRAIN_KEYS].join(', ')}）`, settingsPath)
  }

  const provider = brain.provider
  if (typeof provider !== 'string' || !(BRAIN_PROVIDER_KINDS as readonly string[]).includes(provider)) {
    throw new BrainProfileError('unsupported', `brain.provider は ${BRAIN_PROVIDER_KINDS.map(kind => `"${kind}"`).join(' / ')} のいずれかを指定してください`, settingsPath)
  }
  const kind = provider as BrainProviderKind
  const model = requireBrainString(brain.model, 'model', settingsPath)

  let baseUrl: string | undefined
  if (kind === 'openai-compatible') {
    if (brain.baseUrl === undefined) throw new BrainProfileError('invalid', 'provider が "openai-compatible" のときは brain.baseUrl が必須です', settingsPath)
    baseUrl = parseBaseUrl(brain.baseUrl, settingsPath)
  } else if (brain.baseUrl !== undefined) {
    throw new BrainProfileError('unsupported', `provider "${kind}" では公式エンドポイントだけを使います。brain.baseUrl は指定できません`, settingsPath)
  }

  const thinkingLevel = brain.thinkingLevel === undefined ? 'medium' : brain.thinkingLevel
  if (typeof thinkingLevel !== 'string' || !THINKING_LEVELS.includes(thinkingLevel as ThinkingLevel)) {
    throw new BrainProfileError('invalid', `brain.thinkingLevel は ${THINKING_LEVELS.map(level => `"${level}"`).join(' / ')} のいずれかです`, settingsPath)
  }
  const contextWindow = parsePositiveInteger(brain.contextWindow, 'contextWindow', DEFAULT_CONTEXT_WINDOW, settingsPath)
  const maxTokens = parsePositiveInteger(brain.maxTokens, 'maxTokens', DEFAULT_MAX_TOKENS, settingsPath)
  if ((brain.contextWindow !== undefined || brain.maxTokens !== undefined) && kind !== 'openai-compatible') {
    throw new BrainProfileError('unsupported', 'brain.contextWindow / brain.maxTokens は openai-compatible のときだけ指定できます（公式カタログの値を使います）', settingsPath)
  }

  let credentialSource: BrainCredentialSource = 'none'
  let credentialEnv: string | undefined
  let literalKey: string | undefined
  const apiKey = brain.apiKey
  if (apiKey !== undefined) {
    if (typeof apiKey === 'string') {
      if (apiKey.trim().length === 0 || apiKey === API_KEY_PLACEHOLDER) {
        throw new BrainProfileError('credential', 'brain.apiKey に API キーを記入してください（テンプレートの文字列のままです）', settingsPath)
      }
      if (/[\u0000-\u001f\s]/u.test(apiKey)) throw new BrainProfileError('invalid', 'brain.apiKey に空白や制御文字が含まれています', settingsPath)
      credentialSource = 'settings'
      literalKey = apiKey
    } else if (isPlainObject(apiKey) && typeof apiKey.env === 'string' && Object.keys(apiKey).length === 1) {
      if (!/^[A-Z_][A-Z0-9_]*$/u.test(apiKey.env)) throw new BrainProfileError('invalid', 'brain.apiKey.env は環境変数名（英大文字・数字・_）で指定してください', settingsPath)
      credentialSource = 'env'
      credentialEnv = apiKey.env
      if (!env[credentialEnv]) throw new BrainProfileError('credential', `環境変数 ${credentialEnv} が設定されていません（brain.apiKey.env）`, settingsPath)
    } else {
      throw new BrainProfileError('invalid', 'brain.apiKey は文字列か { "env": "環境変数名" } で指定してください', settingsPath)
    }
  } else if (kind !== 'openai-compatible') {
    throw new BrainProfileError('credential', `provider "${kind}" では brain.apiKey が必須です`, settingsPath)
  }

  const profile: BrainProfile = {
    provider: kind,
    model,
    baseUrl,
    thinkingLevel: thinkingLevel as ThinkingLevel,
    contextWindow,
    maxTokens,
    credentialSource,
    credentialEnv,
    settingsPath,
    credential: () => undefined,
  }
  Object.defineProperty(profile, 'credential', {
    enumerable: false,
    configurable: false,
    writable: false,
    value: (): string | undefined => {
      if (credentialSource === 'settings') return literalKey
      if (credentialSource === 'env') return env[credentialEnv!] || undefined
      return KEYLESS_CREDENTIAL
    },
  })
  return Object.freeze(profile)
}

/** Load and validate the per-user settings file. Missing file -> `missing` (the launcher writes the template). */
export async function loadBrainProfile(settingsPath: string = defaultSettingsPath(), env: NodeJS.ProcessEnv = process.env): Promise<BrainProfile> {
  let text: string
  try {
    text = await readFile(settingsPath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new BrainProfileError('missing', `LLM 接続設定がありません: ${settingsPath}`, settingsPath)
    }
    throw new BrainProfileError('invalid', `settings.json を読み込めません: ${settingsPath}`, settingsPath)
  }
  return parseBrainSettings(text.replace(/^\uFEFF/u, ''), settingsPath, env)
}

/** Write the commented template if, and only if, no settings file exists yet. */
export async function ensureSettingsTemplate(settingsPath: string = defaultSettingsPath()): Promise<'exists' | 'created'> {
  try {
    await access(settingsPath)
    return 'exists'
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  await mkdir(dirname(settingsPath), { recursive: true })
  await writeFile(settingsPath, SETTINGS_TEMPLATE, { encoding: 'utf8', flag: 'wx' })
  return 'created'
}

export interface BrainProfileIdentity {
  readonly provider: BrainProviderKind
  readonly model: string
  readonly baseUrl: string | undefined
  readonly thinkingLevel: ThinkingLevel
  readonly credentialSource: BrainCredentialSource
  readonly credentialEnv: string | undefined
  readonly settingsPath: string
}

/** Audit-safe identity of the active profile: never includes the secret. */
export function describeBrainProfile(profile: BrainProfile): BrainProfileIdentity {
  return {
    provider: profile.provider,
    model: profile.model,
    baseUrl: profile.baseUrl,
    thinkingLevel: profile.thinkingLevel,
    credentialSource: profile.credentialSource,
    credentialEnv: profile.credentialEnv,
    settingsPath: profile.settingsPath,
  }
}
