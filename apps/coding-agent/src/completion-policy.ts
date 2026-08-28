import type { ActiveToolsSelection } from './active-tools'

/**
 * Deterministic, ephemeral completion state for the ordinary v2 optimisation.
 * This is a prompt-loop hint only; it never authorises or executes a tool.
 */
export type CompletionPolicyMode =
  | 'single-read'
  | 'pure-list'
  | 'pure-search'
  | 'multi-read'
  | 'single-write'
  | 'multi-write'
  | 'read-write'
  | 'disabled'

export type CompletionPolicyReason =
  | 'single-read-complete'
  | 'list-complete'
  | 'search-complete'
  | 'single-write-complete'
  | 'read-write-complete'
  | 'disabled-multi-target'
  | 'disabled-discovery-chain'
  | 'disabled-uncertain'
  | 'disabled-command'
  | 'disabled-ambiguous-target'
  | 'disabled-optimization'
  | 'disabled-explicit-run-scoped'
  | 'disabled-verification'
  | 'disabled-unknown'

export interface CompletionPolicyState {
  readonly enabled: boolean
  readonly mode: CompletionPolicyMode
  readonly reason: CompletionPolicyReason
  /** Explicit read targets proved by the request. */
  readonly requiredReadTargets: readonly string[]
  /** Explicit output targets proved by the request. */
  readonly requiredWriteTargets: readonly string[]
  readonly successfulReadTargets: readonly string[]
  readonly successfulWriteTargets: readonly string[]
  readonly successfulList: boolean
  readonly successfulSearch: boolean
  /** Any failed/denied/unknown action makes the policy fail closed. */
  readonly failedOrDenied: boolean
}

export interface DeriveCompletionPolicyOptions {
  readonly optimizationEnabled?: boolean
}

type PathToken = { value: string; index: number; length: number; pattern: boolean }

const PATH_EXTENSIONS = [
  'xlsx', 'xlsm', 'json', 'html', 'jsx', 'tsx', 'yaml', 'toml', 'xml', 'log',
  'text', 'csv', 'md', 'pdf', 'js', 'ts', 'ps1', 'cmd', 'bat', 'yml', 'txt', 'xls'
] as const
// Japanese particles may immediately follow a filename (for example
// `概要_日本語.txtを読んで`).  Keep the boundary strict for ASCII path
// characters while allowing the surrounding natural-language text.
const PATH_EXTENSION_PATTERN = new RegExp(`\\.(${PATH_EXTENSIONS.join('|')})(?![A-Za-z0-9_-])`, 'giu')
const ASCII_PATH_SUFFIX_PATTERN = new RegExp(
  `(?:\\.{0,2}[\\\\/])?[A-Za-z0-9_*.-]+(?:[\\\\/][A-Za-z0-9_*.-]+)*\\.(?:${PATH_EXTENSIONS.join('|')})$`,
  'iu'
)

const READ_CONTENT_PATTERN = /(?:\bread\b|inspect|examine|view|open\s+(?:the\s+)?(?:file|document|workbook|README)|check\s+(?:the\s+)?(?:file|document|content)|読む|読み|読んで|閲覧|比較)/iu
const LIST_PATTERN = /(?:\blist\b|enumerate|一覧|列挙)/iu
const SEARCH_PATTERN = /(?:\bsearch\b|\bfind\b|look\s*up|lookup|検索|探(?:す|して|したい))/iu
const WRITE_PATTERN = /(?:\bwrite\b|\bcreate\b|\bmake\b|\bedit\b|\bupdate\b|\bmodify\b|\bsave\b|\bdelete\b|\bremove\b|\bappend\b|\badd\b|\bgenerate\b|\bdraft\b|\boverwrite\b|\brename\b|作(?:成|る|って|りたい)|書(?:く|き|いて|け)|生成|編集|更新|変更|保存|削除|追加|報告|出力|反映)/iu
const MULTI_ACTION_PATTERN = /(?:\band\b|\bthen\b|\balso\b|\bafter\b|\bfollowed\s+by\b|と|や|および|及び|ならびに|かつ|してから|した後|その後|さらに|また|、)/iu
const COMMAND_PATTERN = /(?:\brun\b|\bexecute\b|\bexec\b|\bcommand\b|\bshell\b|\bterminal\b|\bprocess\b|\bstart\b|\bstop\b|\bkill\b|\blaunch\b|\bspawn\b|\bnetwork\b|\bfetch\b|\bdownload\b|\binstall\b|\bcurl\b|\bwget\b|\bnpm\b|\bpnpm\b|\byarn\b|\bbun\b|\bgit\b|実行|コマンド|シェル|ターミナル|プロセス|起動|停止|終了|ネットワーク|接続|ダウンロード|インストール|ブラウザ|外部(?:サイト|URL|サービス)|リファクタ|ビルド)/iu
const VERIFICATION_PATTERN = /(?:\b(?:verify|verification|test|testing|build|coding|implement|refactor)\b|検証|テスト|実装|リファクタ|ビルド|動作確認)/iu
const DESTINATION_BEFORE_PATTERN = /(?:\b(?:to|into|onto|save\s+to|write\s+to|report\s+to)\b)\s*$/iu
const DESTINATION_AFTER_PATTERN = /^(?:へ|に)(?:保存|出力|反映|報告)?/u

function normalize(value: string): string {
  return value.normalize('NFKC').toLowerCase()
}

function canonicalPath(value: string): string {
  return value.trim().replaceAll('\\', '/').replace(/^\.\//u, '').replace(/\/+/gu, '/').replace(/\/$/u, '').toLowerCase()
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))]
}

/** Extract extension-bearing file paths without retaining them outside this module's ephemeral state. */
export function extractPathLikeTargets(input: string): readonly string[] {
  return unique(extractPathTokens(normalize(input)).map((token) => token.value))
}

function extractPathTokens(text: string): PathToken[] {
  const tokens: PathToken[] = []
  PATH_EXTENSION_PATTERN.lastIndex = 0
  for (const match of text.matchAll(PATH_EXTENSION_PATTERN)) {
    const extensionStart = match.index ?? 0
    const extensionLength = match[0].length
    let boundary = extensionStart - 1
    while (boundary >= 0 && !/[\s"'`([{、。！？]/u.test(text[boundary] ?? '')) boundary--
    let start = boundary + 1
    const prefix = text.slice(start, extensionStart)
    // When Japanese prose is directly adjacent to an ASCII path (e.g.
    // "結果をoutput.txt"), start after the particle rather than retaining
    // the prose as part of the target.
    const particle = prefix.match(/[をにへとやのがはもで](?=[A-Za-z0-9_*?.-])/gu)
    if (particle?.length) {
      const last = particle[particle.length - 1]
      const particleIndex = prefix.lastIndexOf(last)
      if (particleIndex >= 0) start += particleIndex + last.length
    }
    const value = text.slice(start, extensionStart + extensionLength).replace(/[),;:!?。！？]+$/u, '')
    if (!value) continue
    // Retain the suffix guard for malformed prose, while allowing Unicode
    // filenames such as 概要_日本語.txt.
    const guarded = value.match(ASCII_PATH_SUFFIX_PATTERN)?.[0] ?? value
    const index = extensionStart + extensionLength - guarded.length
    tokens.push({ value: canonicalPath(guarded), index, length: guarded.length, pattern: /[*?]/u.test(guarded) })
  }
  return tokens
}

function splitClauses(text: string): string[] {
  return text
    .split(/(?:\b(?:and|then|also|but|plus|afterwards?|followed\s+by)\b|[,&;|]+|\r?\n|、|。|(?:してから|した後|その後|さらに|また|および|及び|ならびに|かつ))/u)
    .map((clause) => clause.trim())
    .filter(Boolean)
}

function clauseForToken(text: string, token: PathToken): string {
  const clauses = splitClauses(text)
  let offset = 0
  for (const clause of clauses) {
    const index = text.indexOf(clause, offset)
    if (index >= 0 && token.index >= index && token.index <= index + clause.length) return clause
    offset = Math.max(offset, index + clause.length)
  }
  return text
}

function isDestination(text: string, token: PathToken): boolean {
  const before = text.slice(Math.max(0, token.index - 80), token.index)
  const after = text.slice(token.index + token.length, token.index + token.length + 24)
  return DESTINATION_BEFORE_PATTERN.test(before) || DESTINATION_AFTER_PATTERN.test(after)
}

function classifyRoles(text: string, tokens: readonly PathToken[]): { sources: string[]; outputs: string[]; complete: boolean } {
  const sources: string[] = []
  const outputs: string[] = []
  for (const token of tokens) {
    const clause = clauseForToken(text, token)
    const clauseReads = READ_CONTENT_PATTERN.test(clause)
    const clauseWrites = WRITE_PATTERN.test(clause)
    if (isDestination(text, token) || (clauseWrites && !clauseReads)) outputs.push(token.value)
    else if (clauseReads && !clauseWrites) sources.push(token.value)
  }
  const assigned = new Set([...sources, ...outputs])
  return { sources: unique(sources), outputs: unique(outputs), complete: assigned.size === unique(tokens.map((token) => token.value)).length }
}

function baseState(
  mode: CompletionPolicyMode,
  reason: CompletionPolicyReason,
  requiredReadTargets: readonly string[] = [],
  requiredWriteTargets: readonly string[] = [],
  enabled = true
): CompletionPolicyState {
  return {
    enabled,
    mode,
    reason,
    requiredReadTargets: unique(requiredReadTargets),
    requiredWriteTargets: unique(requiredWriteTargets),
    successfulReadTargets: [],
    successfulWriteTargets: [],
    successfulList: false,
    successfulSearch: false,
    failedOrDenied: false
  }
}

function disabled(reason: CompletionPolicyReason): CompletionPolicyState {
  return baseState('disabled', reason, [], [], false)
}

function categoryHas(category: string, value: string): boolean {
  return category === value || category.includes(value)
}

/** Derive a conservative completion policy from only the request and active selection. */
export function deriveCompletionPolicy(
  userInput: string,
  activeSelection: ActiveToolsSelection,
  options: DeriveCompletionPolicyOptions = {}
): CompletionPolicyState {
  if (options.optimizationEnabled === false) return disabled('disabled-optimization')
  if (activeSelection.category === 'explicit-run-scoped') return disabled('disabled-explicit-run-scoped')
  if (activeSelection.conservativeFallback || activeSelection.category === 'uncertain' || activeSelection.category === 'full') {
    return disabled('disabled-uncertain')
  }

  const text = normalize(userInput)
  const category = activeSelection.category
  const hasCommand = categoryHas(category, 'command') || COMMAND_PATTERN.test(text)
  if (hasCommand) return disabled('disabled-command')
  if (VERIFICATION_PATTERN.test(text)) return disabled('disabled-verification')

  const tokens = extractPathTokens(text)
  const targets = unique(tokens.map((token) => token.value))
  const hasList = LIST_PATTERN.test(text)
  const hasSearch = SEARCH_PATTERN.test(text)
  const hasContentRead = READ_CONTENT_PATTERN.test(text)
  const hasWrite = categoryHas(category, 'write') || WRITE_PATTERN.test(text)
  const hasRead = hasContentRead || (categoryHas(category, 'read') && !hasList && !hasSearch)

  // Discovery actions are terminal only when no subsequent content action is
  // requested. A discovery + read chain must continue after the discovery.
  if (hasList && !hasSearch && !hasContentRead && !hasWrite) return baseState('pure-list', 'list-complete')
  if (hasSearch && !hasList && !hasContentRead && !hasWrite) return baseState('pure-search', 'search-complete')
  if ((hasList || hasSearch) && (hasContentRead || hasWrite)) return disabled('disabled-discovery-chain')
  if (hasList && hasSearch) return disabled('disabled-uncertain')

  if (hasRead && hasWrite) {
    const roles = classifyRoles(text, tokens)
    if (roles.complete && roles.sources.length === 1 && roles.outputs.length === 1 && !roles.sources.some((source) => roles.outputs.includes(source))) {
      return baseState('read-write', 'read-write-complete', roles.sources, roles.outputs)
    }
    return disabled('disabled-ambiguous-target')
  }

  if (hasWrite) {
    if (targets.length === 1 && !tokens.some((token) => token.pattern)) return baseState('single-write', 'single-write-complete', [], targets)
    if (targets.length >= 2 && !tokens.some((token) => token.pattern)) return baseState('multi-write', 'disabled-multi-target', [], targets)
    // Preserve the established singular-write path when the user asks for
    // exactly one write action but omits a path-like name (for example,
    // "日本語ファイルを書いて").  The first successful write is the only
    // completion evidence available; any multi-action wording remains closed
    // by the conservative fallback below.
    if (targets.length === 0 && !MULTI_ACTION_PATTERN.test(text) && !hasRead && !hasList && !hasSearch) {
      return baseState('single-write', 'single-write-complete')
    }
    return disabled('disabled-uncertain')
  }

  if (hasRead) {
    if (targets.length >= 2 || tokens.some((token) => token.pattern)) return baseState('multi-read', 'disabled-multi-target', targets, [])
    if (targets.length === 1) return baseState('single-read', 'single-read-complete', targets, [])
    return disabled('disabled-uncertain')
  }

  return disabled('disabled-unknown')
}

function bareToolName(name: string): string {
  const normalized = normalize(name).trim()
  const marker = normalized.lastIndexOf('__')
  return marker >= 0 ? normalized.slice(marker + 2) : normalized.replace(/^host[.:]/u, '')
}

function explicitReadTargets(args: Record<string, unknown>): string[] {
  if (typeof args.path === 'string' && args.path.trim()) return [canonicalPath(args.path)]
  if (Array.isArray(args.paths)) return args.paths.filter((value): value is string => typeof value === 'string' && value.trim().length > 0).map(canonicalPath)
  // A pattern/glob does not prove which explicit files were read.
  return []
}

function explicitWriteTargets(args: Record<string, unknown>): string[] {
  return typeof args.path === 'string' && args.path.trim() ? [canonicalPath(args.path)] : []
}

function mergeState(state: CompletionPolicyState, patch: Partial<CompletionPolicyState>): CompletionPolicyState {
  return { ...state, ...patch }
}

/** Record a terminal result. Any non-success status permanently fails closed. */
export function recordToolOutcome(
  state: CompletionPolicyState,
  toolName: string,
  args: Record<string, unknown> | undefined,
  status: 'succeeded' | 'failed' | 'denied' | 'unknown'
): CompletionPolicyState {
  if (status !== 'succeeded') return mergeState(state, { failedOrDenied: true })
  const bare = bareToolName(toolName)
  if (bare === 'list_files') return mergeState(state, { successfulList: true })
  if (bare === 'search_files') return mergeState(state, { successfulSearch: true })
  const safeArgs = args ?? {}
  if (bare === 'read_file' || bare === 'read_xlsx' || bare === 'read_files') {
    return mergeState(state, { successfulReadTargets: unique([...state.successfulReadTargets, ...explicitReadTargets(safeArgs)]) })
  }
  if (bare === 'write_file' || bare === 'edit_file') {
    return mergeState(state, { successfulWriteTargets: unique([...state.successfulWriteTargets, ...explicitWriteTargets(safeArgs)]) })
  }
  return state
}

/** Convenience wrapper for the successful-tool path used by the v2 loop. */
export function recordSuccessfulTool(
  state: CompletionPolicyState,
  toolName: string,
  args: Record<string, unknown> | undefined
): CompletionPolicyState {
  return recordToolOutcome(state, toolName, args, 'succeeded')
}

function includesAll(have: readonly string[], required: readonly string[]): boolean {
  const set = new Set(have)
  return required.every((target) => set.has(target))
}

/** Return true only when every statically provable target/action is complete. */
export function shouldEnterToolsClosedFinal(state: CompletionPolicyState): boolean {
  if (!state.enabled || state.failedOrDenied) return false
  switch (state.mode) {
    case 'single-read':
    case 'multi-read':
      return includesAll(state.successfulReadTargets, state.requiredReadTargets)
    case 'pure-list':
      return state.successfulList
    case 'pure-search':
      return state.successfulSearch
    case 'single-write':
      return state.requiredWriteTargets.length > 0
        ? includesAll(state.successfulWriteTargets, state.requiredWriteTargets)
        : state.successfulWriteTargets.length === 1
    case 'multi-write':
      return includesAll(state.successfulWriteTargets, state.requiredWriteTargets)
    case 'read-write':
      return includesAll(state.successfulReadTargets, state.requiredReadTargets) && includesAll(state.successfulWriteTargets, state.requiredWriteTargets)
    default:
      return false
  }
}
