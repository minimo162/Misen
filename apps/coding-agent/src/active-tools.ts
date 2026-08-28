import type { ToolDef } from './tools'

/**
 * The active-tools pass is only a prompt-size optimisation.  The input is
 * expected to have already passed the normal capability/policy filter; this
 * module never grants a capability and never adds a tool to that input.
 */
export type ActiveToolsCategory =
  | 'read'
  | 'write'
  | 'read-write'
  | 'command'
  | 'read-command'
  | 'write-command'
  | 'read-write-command'
  | 'explicit-run-scoped'
  | 'uncertain'
  | 'full'

export interface SelectActiveToolsOptions {
  /** Policy-filtered definitions available for this turn. */
  readonly toolDefs: readonly ToolDef[]
  /** The current user request. It is never copied into the audit reason. */
  readonly userInput: string
  /** Preserve a caller-owned Computer Use/run-scoped contract verbatim. */
  readonly explicitRunScoped?: boolean
  /** Set false to keep the complete policy-filtered set for this turn. */
  readonly optimizationEnabled?: boolean
  /** Active-tools classification is defined for ordinary work turns. */
  readonly mode?: string
}

export interface ActiveToolsSelection {
  /** The definitions to expose to the model for this turn. */
  readonly toolDefs: readonly ToolDef[]
  /** Auditable, non-secret classification of the request. */
  readonly category: ActiveToolsCategory
  /** True only when intent was not classified and the set was widened. */
  readonly conservativeFallback: boolean
  /** Stable explanation; never includes request text or tool arguments. */
  readonly reason: string
}

type Intent = {
  read: boolean
  write: boolean
  command: boolean
  network: boolean
}

const READ_SIGNAL_PATTERNS: readonly RegExp[] = [
  /\bread\b/u,
  /\blist\b/u,
  /\bsearch\b/u,
  /\bfind\b/u,
  /\blook\s*up\b/u,
  /\blookup\b/u,
  /\binspect\b/u,
  /\bexamine\b/u,
  /\bshow\b/u,
  /\bview\b/u,
  /\bopen\b/u,
  /\bcheck\b/u,
  /\bscan\b/u,
  /\bget\b/u,
  /\bweather\b/u,
  /読む/u,
  /読み/u,
  /読んで/u,
  /一覧/u,
  /列挙/u,
  /検索/u,
  /探(?:す|して|したい)/u,
  /調べ/u,
  /確認/u,
  /表示/u,
  /閲覧/u,
  /開(?:く|いて|けて)/u,
  /見(?:る|せて|たい)/u,
  /天気/u
]

const WRITE_SIGNAL_PATTERNS: readonly RegExp[] = [
  /\bwrite\b/u,
  /\bcreate\b/u,
  /\bmake\b/u,
  /\bedit\b/u,
  /\bupdate\b/u,
  /\bmodify\b/u,
  /\bsave\b/u,
  /\bdelete\b/u,
  /\bremove\b/u,
  /\bappend\b/u,
  /\badd\b/u,
  /\bgenerate\b/u,
  /\bimplement\b/u,
  /\bfix\b/u,
  /\bpatch\b/u,
  /\brefactor\b/u,
  /\bbuild\b/u,
  /\bartifact\b/u,
  /\breport\b/u,
  /\bdraft\b/u,
  /\boverwrite\b/u,
  /\brename\b/u,
  /書(?:く|き|いて|け)/u,
  /作(?:成|る|って|りたい)/u,
  /生成/u,
  /編集/u,
  /更新/u,
  /修正/u,
  /変更/u,
  /保存/u,
  /削除/u,
  /追加/u,
  /実装/u,
  /直して/u
]

const COMMAND_SIGNAL_PATTERNS: readonly RegExp[] = [
  /\bopen\b/u,
  /\brun\b/u,
  /\bexecute\b/u,
  /\bexec\b/u,
  /\bcommand\b/u,
  /\bshell\b/u,
  /\bterminal\b/u,
  /\bprocess\b/u,
  /\bstart\b/u,
  /\bstop\b/u,
  /\bkill\b/u,
  /\blaunch\b/u,
  /\bspawn\b/u,
  /\bnetwork\b/u,
  /\bfetch\b/u,
  /\bdownload\b/u,
  /\binstall\b/u,
  /\bfix\b/u,
  /\bimplement\b/u,
  /\brefactor\b/u,
  /\bbuild\b/u,
  /\bcurl\b/u,
  /\bwget\b/u,
  /\bnpm\b/u,
  /\bpnpm\b/u,
  /\byarn\b/u,
  /\bbun\b/u,
  /\bgit\b/u,
  /\bhttps?\b/u,
  /\burl\b/u,
  /実行/u,
  /コマンド/u,
  /シェル/u,
  /ターミナル/u,
  /プロセス/u,
  /起動/u,
  /停止/u,
  /終了/u,
  /ネットワーク/u,
  /接続/u,
  /ダウンロード/u,
  /インストール/u,
  /実装/u,
  /バグ(?:を)?修正/u,
  /リファクタ/u,
  /ビルド/u,
  /外部(?:サイト|URL|サービス)/u,
  /ウェブ/u,
  /ブラウザ/u,
  /開(?:く|いて|けて)/u,
  /curl/u,
  /天気(?:を)?(?:取得|確認)/u
]

const NETWORK_SIGNAL_PATTERNS: readonly RegExp[] = [
  /\bnetwork\b/u,
  /\bfetch\b/u,
  /\bdownload\b/u,
  /\bhttps?\b/u,
  /\burl\b/u,
  /\bweb(?:site)?\b/u,
  /\bbrowser\b/u,
  /\bweather\b/u,
  /\bget\s+weather\b/u,
  /ネットワーク/u,
  /接続/u,
  /ダウンロード/u,
  /外部(?:サイト|URL|サービス)/u,
  /ウェブ/u,
  /ブラウザ/u,
  /URL/u,
  /天気/u
]

/**
 * Directives that ask only for the model's reply.  They are deliberately
 * kept separate from host-capability signals: a clause such as
 * "概要.txtを読んで、色を教えてください" contains a read action followed
 * by a response-only clause, not an unknown host operation.
 */
const RESPONSE_ONLY_PATTERNS: readonly RegExp[] = [
  /(?:教えて|答えて|回答して|報告して|説明して|要約して|短くまとめて|日本語で返して|結果だけ知らせて)ください/u,
  /\btell\s+me\b/u,
  /\banswer\s+briefly\b/u,
  /\breport\s+the\s+result\b/u,
  /\bsummarize\s+it\b/u,
  /\bexplain\s+the\s+result\b/u,
  /\brespond\s+in\s+japanese\b/u
]

/*
 * A read-kind tool can still be an external/network capability (for example
 * fetch_url or get_weather).  Such tools remain hidden during a local file
 * read unless the request names that capability or otherwise indicates a
 * network operation.  The kind remains authoritative for ordinary read/write
 * classification; this predicate only applies the explicit network guard.
 */
const NETWORK_TOOL_NAME_PATTERN = /(?:^|[_-])(?:fetch|request|http|https|url|web|browser|browse|download|network|weather)(?:$|[_-])/u
const NETWORK_TOOL_DESCRIPTION_PATTERN = /(?:\b(?:https?|url|network|external|download|weather|open[- ]?meteo)\b|ネットワーク|外部(?:サイト|URL|サービス)|ダウンロード|天気)/u

function normalize(value: string): string {
  return value.normalize('NFKC').toLowerCase()
}

function hasAnySignal(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text))
}

function stripResponseOnlyDirectives(text: string): string {
  return RESPONSE_ONLY_PATTERNS.reduce((remaining, pattern) => remaining.replace(pattern, ' '), text)
}

function classifyIntent(userInput: string): Intent {
  const text = normalize(userInput)
  // Response-only wording must not turn a read/report request into a write
  // capability.  Strip only the known directives; all other wording remains
  // subject to the normal intent signals and conservative fallback.
  const hostText = stripResponseOnlyDirectives(text)
  return {
    read: hasAnySignal(hostText, READ_SIGNAL_PATTERNS),
    write: hasAnySignal(hostText, WRITE_SIGNAL_PATTERNS),
    command: hasAnySignal(hostText, COMMAND_SIGNAL_PATTERNS),
    network: hasAnySignal(hostText, NETWORK_SIGNAL_PATTERNS)
  }
}

const CLAUSE_SEPARATOR = /(?:\b(?:and|then|also|but|plus|afterwards?|followed\s+by)\b|[,&;|]+|\r?\n|、|。|(?:してから|した後|その後|さらに|また|および|及び|ならびに|かつ))/u

function hasUnrecognizedMixedClause(request: string, toolDefs: readonly ToolDef[]): boolean {
  const clauses = normalize(request).split(CLAUSE_SEPARATOR).map((clause) => clause.trim()).filter(Boolean)
  if (clauses.length < 2) return false
  return clauses.some((clause) => {
    const intent = inferIntentFromToolNames(clause, toolDefs, classifyIntent(clause))
    if (intent.read || intent.write || intent.command || intent.network) return false
    // A response-only directive (for example, "色を教えてください") is not
    // an additional host action and therefore must not trigger fallback.
    return !hasAnySignal(clause, RESPONSE_ONLY_PATTERNS)
  })
}

function inferIntentFromToolNames(
  request: string,
  toolDefs: readonly ToolDef[],
  intent: Intent
): Intent {
  const inferred: Intent = { ...intent }
  for (const def of toolDefs) {
    if (!toolNameMentioned(request, def.name)) continue
    if (def.kind === 'read') inferred.read = true
    if (def.kind === 'write') inferred.write = true
    if (def.kind === 'command') inferred.command = true
    if (isNetworkTool(def)) inferred.network = true
  }
  return inferred
}

function normalizeToolName(value: string): string {
  const normalized = normalize(value).trim()
  return normalized.startsWith('host__') ? normalized.slice('host__'.length) : normalized
}

function toolNameMentioned(request: string, toolName: string): boolean {
  const normalizedName = normalizeToolName(toolName)
  if (!normalizedName) return false
  if (request.includes(normalizedName)) return true
  const spacedName = normalizedName.replace(/[_-]+/gu, ' ').trim()
  return spacedName.length > 0 && request.includes(spacedName)
}

function isNetworkTool(def: ToolDef): boolean {
  const name = normalizeToolName(def.name)
  const description = normalize(def.description)
  return NETWORK_TOOL_NAME_PATTERN.test(name) || NETWORK_TOOL_DESCRIPTION_PATTERN.test(description)
}

function networkToolRelevant(def: ToolDef, request: string, intent: Intent): boolean {
  const named = toolNameMentioned(request, def.name)
  if (named) return true
  if (!intent.network) return false
  // A domain-specific request (for example weather) should not expose every
  // unrelated external connector.  Broad network wording (URL/fetch/web,
  // etc.) is an explicit indication for the complete network subset.
  if (/weather|天気/u.test(request)) {
    const toolText = `${normalizeToolName(def.name)} ${normalize(def.description)}`
    return /weather|open[- ]?meteo|天気/u.test(toolText)
  }
  return true
}

function categoryForIntent(intent: Intent): ActiveToolsCategory {
  if (intent.read && intent.write && intent.command) return 'read-write-command'
  if (intent.read && intent.write) return 'read-write'
  if (intent.read && intent.command) return 'read-command'
  if (intent.write && intent.command) return 'write-command'
  if (intent.read) return 'read'
  if (intent.write) return 'write'
  return 'command'
}

function selectByIntent(toolDefs: readonly ToolDef[], request: string, intent: Intent): ToolDef[] {
  return toolDefs.filter((def) => {
    if (def.kind === 'read') {
      if (!intent.read && !intent.write && !intent.command) return false
      if (isNetworkTool(def) && !networkToolRelevant(def, request, intent)) return false
      return true
    }
    if (def.kind === 'write') return intent.write
    if (def.kind === 'command') return intent.command
    return false
  })
}

function allSelection(
  toolDefs: readonly ToolDef[],
  category: ActiveToolsCategory,
  conservativeFallback: boolean,
  reason: string
): ActiveToolsSelection {
  return { toolDefs, category, conservativeFallback, reason }
}

/**
 * Select the smallest obvious active set for an ordinary work turn.
 *
 * The overload accepting positional arguments is intentionally kept as a
 * convenience for small embedders/tests; the object form is the stable API.
 */
export function selectActiveTools(options: SelectActiveToolsOptions): ActiveToolsSelection
export function selectActiveTools(
  toolDefs: readonly ToolDef[],
  userInput: string,
  options?: Omit<SelectActiveToolsOptions, 'toolDefs' | 'userInput'>
): ActiveToolsSelection
export function selectActiveTools(
  first: SelectActiveToolsOptions | readonly ToolDef[],
  second?: string,
  third?: Omit<SelectActiveToolsOptions, 'toolDefs' | 'userInput'>
): ActiveToolsSelection {
  const options: SelectActiveToolsOptions = 'toolDefs' in (first as object)
    ? first as SelectActiveToolsOptions
    : { ...(third ?? {}), toolDefs: first as readonly ToolDef[], userInput: second ?? '' }
  const toolDefs = Array.isArray(options.toolDefs) ? options.toolDefs : []
  const request = typeof options.userInput === 'string' ? normalize(options.userInput) : ''

  // Explicit run-scoped definitions are a caller-owned contract.  Do not
  // filter, copy, or widen them here, even if their names look unusual.
  if (options.explicitRunScoped === true) {
    return allSelection(toolDefs, 'explicit-run-scoped', false, 'explicit run-scoped tool definitions preserved')
  }

  if (options.optimizationEnabled === false) {
    return allSelection(toolDefs, 'full', false, 'active-tools optimization disabled; all supplied policy-filtered tools retained')
  }

  if (options.mode !== undefined && options.mode !== 'work') {
    return allSelection(toolDefs, 'full', false, 'active-tools applies only to work turns; all supplied policy-filtered tools retained')
  }

  // A bare "open" request is ambiguous between reading and launching. Do not
  // guess away a process tool; normal permission/approval/guards remain the
  // authority if the model chooses it.
  if (/^(?:open|開く|開いて|開けて)$/u.test(request.trim())) {
    return allSelection(toolDefs, 'uncertain', true, 'bare open intent is ambiguous; all supplied policy-filtered tools retained conservatively')
  }

  // A recognized clause must not hide the capability required by an unknown
  // companion clause. Widen the policy-filtered set instead of guessing;
  // authorization and approval remain downstream.
  if (hasUnrecognizedMixedClause(request, toolDefs)) {
    return allSelection(toolDefs, 'uncertain', true, 'a mixed request contains an unrecognized clause; all supplied policy-filtered tools retained conservatively')
  }

  const intent = inferIntentFromToolNames(request, toolDefs, classifyIntent(request))
  if (!intent.read && !intent.write && !intent.command) {
    return allSelection(toolDefs, 'uncertain', true, 'intent was not recognized; all supplied policy-filtered tools retained conservatively')
  }

  const selected = selectByIntent(toolDefs, request, intent)
  const category = categoryForIntent(intent)
  const suffix = intent.network
    ? 'network indication present'
    : 'command/process/network tools withheld unless indicated'
  return {
    toolDefs: selected,
    category,
    conservativeFallback: false,
    reason: `${category} intent; ${suffix}`
  }
}

type ActiveToolSource = ActiveToolsSelection | readonly ToolDef[]

function sourceToolDefs(source: ActiveToolSource): readonly ToolDef[] {
  if (!('toolDefs' in (source as object))) return source as readonly ToolDef[]
  const selection = source as ActiveToolsSelection
  return Array.isArray(selection.toolDefs) ? selection.toolDefs : []
}

function sameToolName(left: string, right: string): boolean {
  const a = normalizeToolName(left)
  const b = normalizeToolName(right)
  if (!a || !b) return false
  return a === b || a.endsWith(`__${b}`) || b.endsWith(`__${a}`)
}

/** Return true when a requested tool is present in the selected active set. */
export function isToolSelected(source: ActiveToolSource, requestedToolName: string): boolean
export function isToolSelected(requestedToolName: string, source: ActiveToolSource): boolean
export function isToolSelected(
  first: ActiveToolSource | string,
  second: ActiveToolSource | string
): boolean {
  const requested = typeof first === 'string' ? first : second as string
  const source = typeof first === 'string' ? second as ActiveToolSource : first
  if (typeof requested !== 'string' || !requested.trim()) return false
  return sourceToolDefs(source).some((def) => sameToolName(def.name, requested))
}

export interface MissingActiveTool {
  readonly requestedToolName: string
  readonly selected: boolean
  readonly missing: boolean
  /** The caller may retry with a wider set or abort; nothing is auto-added. */
  readonly conservativeRetryRecommended: boolean
  readonly reason: string
}

/**
 * Inspect a model-requested tool without changing the active set.  A missing
 * tool is deliberately surfaced to the caller so it can choose its own
 * conservative retry/abort policy; this helper never executes or authorizes a
 * tool and never widens the set implicitly.
 */
export function detectMissingActiveTool(source: ActiveToolSource, requestedToolName: string): MissingActiveTool
export function detectMissingActiveTool(requestedToolName: string, source: ActiveToolSource): MissingActiveTool
export function detectMissingActiveTool(
  first: ActiveToolSource | string,
  second: ActiveToolSource | string
): MissingActiveTool {
  const requestedToolName = typeof first === 'string' ? first : second as string
  const source = typeof first === 'string' ? second as ActiveToolSource : first
  const selected = isToolSelected(source, requestedToolName)
  const normalizedName = typeof requestedToolName === 'string' ? requestedToolName.trim() : ''
  return {
    requestedToolName: normalizedName,
    selected,
    missing: !selected,
    conservativeRetryRecommended: !selected,
    reason: selected
      ? 'requested tool is present in the active set'
      : 'requested tool is absent; caller must choose a conservative retry or abort'
  }
}

/** Descriptive alias for callers that prefer an availability-oriented name. */
export const checkActiveTool = detectMissingActiveTool
