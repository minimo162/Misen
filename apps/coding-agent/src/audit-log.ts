import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export type AuditPermissionDecision = 'allow' | 'ask' | 'deny'
export type AuditResultOutcome = 'success' | 'failure' | 'refused'
export type AuditApprovalOutcome = 'not_required' | 'approved' | 'denied'

export interface AuditArguments {
  summary: string
  sha256: string
}

export interface AuditPermission {
  decision: AuditPermissionDecision
}

export interface AuditApproval {
  required: boolean
  outcome: AuditApprovalOutcome
  actor: 'policy' | 'user'
  automatic: boolean
}

export interface AuditTarget {
  path: string | null
  before_sha256: string | null
  after_sha256: string | null
}

export interface AuditResult {
  outcome: AuditResultOutcome
  duration_ms: number | null
  error: string | null
}

/** The persisted issue #37 schema. Keep this flat and deliberately redacted. */
export interface AuditRecord {
  schema_version: 1
  event_id: string
  timestamp: string
  session_id: string
  run_id: string
  call_id: string | null
  tool_name: string
  arguments: AuditArguments
  permission: AuditPermission
  approval: AuditApproval
  result: AuditResult
  target: AuditTarget
}

export interface AuditMetadata {
  arguments: AuditArguments
  permission: AuditPermission
  approval: AuditApproval
  target: AuditTarget
}

export interface AuditLogOptions {
  workspace: string
  /** Optional override. Empty/whitespace means use the platform default. */
  directory?: string
  fileName?: string
}

export interface AuditFilters {
  tool?: string
  result?: AuditResultOutcome
  permission?: AuditPermissionDecision
}

const DEFAULT_FILE_NAME = 'audit.jsonl'
const DEFAULT_MAX_RECORDS = 200
const MAX_QUERY_RECORDS = 500

function existingAncestor(value: string): string {
  let cursor = path.resolve(value)
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor)
    if (parent === cursor) return cursor
    cursor = parent
  }
  return cursor
}

function realPathWithMissingTail(value: string): string {
  const absolute = path.resolve(value)
  const ancestor = existingAncestor(absolute)
  const tail = path.relative(ancestor, absolute)
  let realAncestor: string
  try {
    realAncestor = fs.realpathSync.native(ancestor)
  } catch {
    realAncestor = path.resolve(ancestor)
  }
  return path.resolve(realAncestor, tail)
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(realPathWithMissingTail(root), realPathWithMissingTail(candidate))
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

function assertNoReparseComponents(value: string): void {
  let cursor = path.resolve(value)
  while (true) {
    if (fs.existsSync(cursor)) {
      const stat = fs.lstatSync(cursor)
      if (stat.isSymbolicLink()) throw new Error(`監査ログ保存先にシンボリックリンク／再解析点は指定できません: ${cursor}`)
    }
    const parent = path.dirname(cursor)
    if (parent === cursor) return
    cursor = parent
  }
}

function fallbackDirectory(workspace: string): string {
  const candidates = process.platform === 'win32'
    ? [
        process.env.LOCALAPPDATA,
        process.env.APPDATA,
        os.homedir() ? path.join(os.homedir(), '.company-apps-share') : undefined,
        os.tmpdir()
      ]
    : [
        process.env.XDG_STATE_HOME,
        os.homedir() ? path.join(os.homedir(), '.local', 'state') : undefined,
        os.tmpdir()
      ]
  for (const base of candidates) {
    if (!base) continue
    const candidate = process.platform === 'win32'
      ? path.join(base, 'CompanyAppsShare', 'audit')
      : path.join(base, 'company-apps-share', 'audit')
    if (!isInside(workspace, candidate)) return candidate
  }
  throw new Error('監査ログの既定保存先をワークスペース外に決定できません')
}

/** Resolve and validate a destination before accepting any work turns. */
export function resolveAuditDirectory(workspace: string, configured?: string): string {
  const root = path.resolve(workspace)
  const requested = typeof configured === 'string' && configured.trim()
    ? path.resolve(configured)
    : fallbackDirectory(root)
  if (isInside(root, requested)) {
    throw new Error(`監査ログ保存先はワークスペース外でなければなりません: ${requested}`)
  }
  return requested
}

export function canonicalizeAuditValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeAuditValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalizeAuditValue(item)]))
  }
  return value
}

export function auditArgsSha256(args: Record<string, unknown>): string {
  const canonical = JSON.stringify(canonicalizeAuditValue(args))
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex')
}

export function makeAuditArguments(summary: string, args: Record<string, unknown>): AuditArguments {
  return { summary, sha256: auditArgsSha256(args) }
}

export function nullAuditTarget(target?: Partial<AuditTarget>): AuditTarget {
  return {
    path: typeof target?.path === 'string' ? target.path : null,
    before_sha256: typeof target?.before_sha256 === 'string' ? target.before_sha256 : null,
    after_sha256: typeof target?.after_sha256 === 'string' ? target.after_sha256 : null
  }
}

export interface AuditEventLike {
  type: string
  origin?: string
  authority?: string
  eventId?: string
  at?: number
  runId?: string
  sessionId?: string
  callId?: string
  tool?: string
  summary?: string
  output?: string
  error?: string
  approved?: boolean
  durationMs?: number
  metadata?: Record<string, unknown> | null
  audit?: AuditMetadata
}

const READ_TOOL_NAMES = new Set(['host.read_file', 'host.read_files', 'host.list_files', 'host.search_files', 'host.read_xlsx', 'host.get_weather'])

function permissionFromEvents(event: AuditEventLike, history: readonly AuditEventLike[]): AuditPermissionDecision {
  if (event.audit?.permission?.decision) return event.audit.permission.decision
  const prior = [...history].reverse().find((candidate) => candidate.audit?.permission?.decision)
  if (prior?.audit?.permission?.decision) return prior.audit.permission.decision
  return event.tool && READ_TOOL_NAMES.has(event.tool) ? 'allow' : 'ask'
}

interface StructuredApprovalProvenance {
  actor: 'user' | 'policy'
  automatic: boolean
}

function structuredApprovalProvenance(event: AuditEventLike): StructuredApprovalProvenance | undefined {
  // Only the server-authenticated approval event may establish provenance.
  // Human-readable reason text is intentionally ignored; a client can submit
  // any such text through /api/approvals/resolve.
  if (event.origin !== 'host' || event.authority !== 'authoritative') return undefined
  if (typeof event.metadata?.approval !== 'object' || event.metadata.approval === null) return undefined
  const raw = (event.metadata.approval as { provenance?: unknown }).provenance
  if (!raw || typeof raw !== 'object') return undefined
  const candidate = raw as { actor?: unknown; automatic?: unknown }
  if ((candidate.actor !== 'user' && candidate.actor !== 'policy') || typeof candidate.automatic !== 'boolean') return undefined
  return { actor: candidate.actor, automatic: candidate.automatic }
}

/** Build the single terminal record for a host tool outcome from its event history. */
export function auditRecordFromOutcome(input: {
  sessionId: string
  runId: string
  event: AuditEventLike
  history?: readonly AuditEventLike[]
}): AuditRecord | null {
  const { event } = input
  if (event.origin && event.origin !== 'host') return null
  if (event.type !== 'tool.succeeded' && event.type !== 'tool.failed' && event.type !== 'tool.denied') return null
  const history = input.history ?? []
  const callEvents = event.callId ? history.filter((candidate) => candidate.callId === event.callId) : []
  const eventAudit = event.audit
  const requested = [...callEvents].reverse().find((candidate) => candidate.type === 'tool.requested')
  const argumentsMeta = eventAudit?.arguments ?? requested?.audit?.arguments ?? makeAuditArguments(event.summary ?? event.tool ?? '', {})
  const permission = permissionFromEvents(event, callEvents)
  const approvalRequested = callEvents.some((candidate) => candidate.type === 'approval.requested')
  const resolvedEvents = callEvents.filter((candidate) => candidate.type === 'approval.resolved' && typeof candidate.approved === 'boolean')
  // The server's authoritative approval API event can be followed by an
  // agent-level duplicate approval.resolved event for the same call. Prefer
  // structured server policy provenance across the complete call history so
  // timeout/cancel/shutdown cannot be relabeled by the later duplicate.
  const policyResolved = [...resolvedEvents].reverse().find((candidate) => {
    const provenance = structuredApprovalProvenance(candidate)
    return provenance?.actor === 'policy' && provenance.automatic === true
  })
  const resolved = policyResolved ?? [...resolvedEvents].reverse()[0]
  const automatic = [...callEvents].reverse().find((candidate) => candidate.type === 'tool.approved' && candidate.metadata?.automatic === true)
  let approval: AuditApproval = eventAudit?.approval ?? {
    required: approvalRequested || Boolean(event.tool && !READ_TOOL_NAMES.has(event.tool)),
    outcome: 'not_required',
    actor: 'policy',
    automatic: false
  }
  if (resolved) {
    const provenance = structuredApprovalProvenance(resolved)
    const policyResolution = provenance?.actor === 'policy' && provenance.automatic === true
    approval = { required: true, outcome: resolved.approved ? 'approved' : 'denied', actor: policyResolution ? 'policy' : 'user', automatic: policyResolution }
  } else if (automatic) {
    approval = { required: true, outcome: 'approved', actor: 'policy', automatic: true }
  } else if (permission === 'deny') {
    approval = { required: false, outcome: 'not_required', actor: 'policy', automatic: true }
  }
  const metadata = event.metadata
  const target = nullAuditTarget({
    ...eventAudit?.target,
    path: eventAudit?.target?.path ?? (typeof metadata?.path === 'string' ? metadata.path : null),
    before_sha256: eventAudit?.target?.before_sha256 ?? (typeof metadata?.beforeHash === 'string' ? metadata.beforeHash : null),
    after_sha256: eventAudit?.target?.after_sha256 ?? (typeof metadata?.afterHash === 'string' ? metadata.afterHash : null)
  })
  const outcome: AuditResultOutcome = event.type === 'tool.succeeded' ? 'success' : event.type === 'tool.failed' ? 'failure' : 'refused'
  return makeAuditRecord({
    event_id: event.eventId ?? `${input.runId}-audit-${event.callId ?? event.type}`,
    timestamp: new Date(event.at ?? Date.now()).toISOString(),
    session_id: input.sessionId,
    run_id: input.runId,
    call_id: event.callId ?? null,
    tool_name: event.tool ?? 'unknown',
    arguments: argumentsMeta,
    permission: { decision: permission },
    approval,
    result: {
      outcome,
      duration_ms: typeof event.durationMs === 'number' ? event.durationMs : null,
      error: outcome === 'success' ? null : (event.error ?? event.output ?? null)
    },
    target
  })
}

function clampLimit(value: number | undefined, fallback = DEFAULT_MAX_RECORDS): number {
  if (!Number.isFinite(value)) return fallback
  return Math.min(MAX_QUERY_RECORDS, Math.max(1, Math.trunc(value as number)))
}

function validRecord(value: unknown): value is AuditRecord {
  if (!value || typeof value !== 'object') return false
  const record = value as Partial<AuditRecord>
  return record.schema_version === 1
    && typeof record.event_id === 'string'
    && typeof record.timestamp === 'string'
    && typeof record.session_id === 'string'
    && typeof record.run_id === 'string'
    && (record.call_id === null || typeof record.call_id === 'string')
    && typeof record.tool_name === 'string'
    && !!record.arguments && typeof record.arguments.summary === 'string' && typeof record.arguments.sha256 === 'string'
    && !!record.permission && (record.permission.decision === 'allow' || record.permission.decision === 'ask' || record.permission.decision === 'deny')
    && !!record.approval && typeof record.approval.required === 'boolean'
    && (record.approval.outcome === 'not_required' || record.approval.outcome === 'approved' || record.approval.outcome === 'denied')
    && (record.approval.actor === 'policy' || record.approval.actor === 'user')
    && typeof record.approval.automatic === 'boolean'
    && !!record.result && (record.result.outcome === 'success' || record.result.outcome === 'failure' || record.result.outcome === 'refused')
    && (record.result.duration_ms === null || typeof record.result.duration_ms === 'number')
    && (record.result.error === null || typeof record.result.error === 'string')
    && !!record.target && (record.target.path === null || typeof record.target.path === 'string')
    && (record.target.before_sha256 === null || typeof record.target.before_sha256 === 'string')
    && (record.target.after_sha256 === null || typeof record.target.after_sha256 === 'string')
}

function csvCell(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  const normalized = text ?? ''
  return /[",\r\n]/u.test(normalized) ? `"${normalized.replaceAll('"', '""')}"` : normalized
}

export const AUDIT_CSV_HEADERS = [
  'schema_version',
  'event_id',
  'timestamp',
  'session_id',
  'run_id',
  'call_id',
  'tool_name',
  'arguments',
  'permission',
  'approval',
  'result',
  'target'
] as const

export function auditRecordsToCsv(records: readonly AuditRecord[]): string {
  const rows: string[] = [AUDIT_CSV_HEADERS.join(',')]
  for (const record of records) {
    rows.push([
      record.schema_version,
      record.event_id,
      record.timestamp,
      record.session_id,
      record.run_id,
      record.call_id,
      record.tool_name,
      record.arguments,
      record.permission,
      record.approval,
      record.result,
      record.target
    ].map(csvCell).join(','))
  }
  return `${rows.join('\r\n')}\r\n`
}

export class AuditLog {
  readonly directory: string
  readonly filePath: string
  private initialized = false
  private appendHandle: number | null = null
  private appendFailure: string | null = null
  private readonly seenOutcomeKeys = new Set<string>()

  constructor(options: AuditLogOptions) {
    this.directory = resolveAuditDirectory(options.workspace, options.directory)
    const fileName = options.fileName?.trim() || DEFAULT_FILE_NAME
    if (path.basename(fileName) !== fileName || fileName.includes('..')) throw new Error('監査ログのファイル名が不正です')
    this.filePath = path.join(this.directory, fileName)
  }

  /** Create/open the destination in append mode and validate its boundaries. */
  initialize(): void {
    if (this.initialized) return
    fs.mkdirSync(this.directory, { recursive: true })
    assertNoReparseComponents(this.directory)
    // Check the final target before resolving its real path; otherwise a
    // symlink could make the boundary check report a misleading outside path.
    assertNoReparseComponents(this.filePath)
    if (isInside(this.directory, this.filePath) === false) throw new Error('監査ログファイルが保存先ディレクトリ外です')
    if (fs.existsSync(this.filePath)) {
      const stat = fs.lstatSync(this.filePath)
      if (stat.isSymbolicLink()) throw new Error(`監査ログファイルはシンボリックリンク／再解析点を使用できません: ${this.filePath}`)
      if (!stat.isFile()) throw new Error(`監査ログが通常ファイルではありません: ${this.filePath}`)
    }
    // Keep one append-only descriptor for the process. This prevents a path
    // replacement after validation from redirecting later writes.
    this.appendHandle = fs.openSync(this.filePath, 'a')
    this.initialized = true
  }

  get ready(): boolean {
    return this.initialized
  }

  get healthy(): boolean {
    return this.initialized && this.appendFailure === null
  }

  get failureReason(): string | null {
    return this.appendFailure
  }

  /** Append one complete JSON object line; existing bytes are never replaced. */
  append(record: AuditRecord, dedupeKey?: string): void {
    if (!this.initialized) throw new Error('監査ログが初期化されていません')
    if (this.appendFailure) throw new Error(`監査ログはunhealthyです: ${this.appendFailure}`)
    if (!validRecord(record)) {
      this.appendFailure = '監査ログレコードがschema_version 1に適合しません'
      throw new Error(`監査ログ追記に失敗しました: ${this.appendFailure}`)
    }
    if (dedupeKey && this.seenOutcomeKeys.has(dedupeKey)) return
    const line = `${JSON.stringify(record)}\n`
    if (this.appendHandle === null) {
      this.appendFailure = '監査ログの追記ハンドルがありません'
      throw new Error(`監査ログ追記に失敗しました: ${this.appendFailure}`)
    }
    try {
      fs.writeSync(this.appendHandle, line, undefined, 'utf8')
    } catch (err) {
      this.appendFailure = (err as Error).message || String(err)
      throw new Error(`監査ログ追記に失敗しました: ${this.appendFailure}`)
    }
    if (dedupeKey) this.seenOutcomeKeys.add(dedupeKey)
  }

  records(limit = DEFAULT_MAX_RECORDS, filters: AuditFilters = {}): AuditRecord[] {
    if (!this.initialized) throw new Error('監査ログが初期化されていません')
    if (!fs.existsSync(this.filePath)) return []
    const text = fs.readFileSync(this.filePath, 'utf8')
    const lines = text.split(/\r?\n/u)
    const found: AuditRecord[] = []
    for (let i = lines.length - 1; i >= 0 && found.length < clampLimit(limit); i--) {
      const line = lines[i]?.trim()
      if (!line) continue
      try {
        const parsed: unknown = JSON.parse(line)
        if (!validRecord(parsed)) continue
        const record = parsed as AuditRecord
        if (filters.tool && record.tool_name !== filters.tool) continue
        if (filters.result && record.result.outcome !== filters.result) continue
        if (filters.permission && record.permission.decision !== filters.permission) continue
        found.push(record)
      } catch {
        // A torn/foreign line is not exposed as a fabricated record. New appends
        // remain valid JSONL; callers can diagnose the underlying file directly.
      }
    }
    return found
  }

  csv(limit = DEFAULT_MAX_RECORDS, filters: AuditFilters = {}): string {
    return auditRecordsToCsv(this.records(limit, filters))
  }
}

export function createAuditLog(options: AuditLogOptions): AuditLog {
  return new AuditLog(options)
}

export interface AuditAvailability {
  available: boolean
  detail: string | null
}

/** Shared health decision used by every server audit/work route. */
export function auditAvailability(log: Pick<AuditLog, 'healthy' | 'failureReason'> | null, initError: string | null): AuditAvailability {
  if (log?.healthy && !initError) return { available: true, detail: null }
  return { available: false, detail: initError ?? log?.failureReason ?? '監査ログが初期化されていません' }
}

export function makeAuditRecord(input: Omit<AuditRecord, 'schema_version'> & { schema_version?: 1 }): AuditRecord {
  return { schema_version: 1, ...input }
}
