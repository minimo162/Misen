import { randomBytes } from 'node:crypto'
import { mkdir, open, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const SESSION_SCHEMA_VERSION = 2
export const DEFAULT_SESSION_TITLE = '新しいチャット'
export const MAX_SESSION_TITLE_LENGTH = 36
export const MAX_SESSION_FILE_BYTES = 1024 * 1024
export const SESSION_ID_RE = /^[A-Za-z0-9_-]{24}$/u

export type SessionStatus = 'NEW' | 'RUNNING' | 'COMPLETED' | 'FAIL' | 'CANCELLED'

export type StoredMessage = {
  id: string
  role: 'user' | 'assistant'
  text: string
  timestamp: string
}

export type StoredToolEvent = {
  id: string
  runId: string
  name: string
  detail?: string
  status: 'success' | 'error'
}

export type StoredArtifact = {
  runId: string
  path: string
  filename: string
  sha256: string
}

export type StoredPlanStep = { id: string; title: string; status: 'pending' | 'running' | 'completed' }
export type StoredPlan = { id: string; title: string; steps: StoredPlanStep[] }
export type StoredCheckpoint = { id: string; verb: string; target: string; risk: '低' | '中' | '高'; reason: string; status: 'pending' | 'approved' | 'rejected'; approveSimilar?: boolean }
export type StoredRunUi = { runId: string; plan?: StoredPlan; checkpoints: StoredCheckpoint[] }

export type StoredSession = {
  schemaVersion: typeof SESSION_SCHEMA_VERSION
  id: string
  title: string
  createdAt: string
  updatedAt: string
  status: SessionStatus
  messages: StoredMessage[]
  tools: StoredToolEvent[]
  artifacts: StoredArtifact[]
  runUi: StoredRunUi[]
}

export type SessionSummary = Pick<StoredSession, 'id' | 'title' | 'createdAt' | 'updatedAt' | 'status'>

const ordinal = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value))
const isIsoDate = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value))
const isStatus = (value: unknown): value is SessionStatus => ['NEW', 'RUNNING', 'COMPLETED', 'FAIL', 'CANCELLED'].includes(String(value))
const isSafeText = (value: unknown, maximum: number): value is string => typeof value === 'string' && value.length <= maximum

export function localSessionDirectory(environment: NodeJS.ProcessEnv = process.env): string {
  const localAppData = environment.LOCALAPPDATA
  return join(localAppData && localAppData.trim() ? localAppData : join(homedir(), 'AppData', 'Local'), 'Misen', 'data', 'sessions')
}

export function titleFromFirstUserMessage(text: string): string {
  const normalized = text.replace(/\s+/gu, ' ').trim()
  if (!normalized) return DEFAULT_SESSION_TITLE
  const characters = Array.from(normalized)
  return characters.length <= MAX_SESSION_TITLE_LENGTH
    ? normalized
    : `${characters.slice(0, MAX_SESSION_TITLE_LENGTH - 1).join('')}…`
}

function parseMessage(value: unknown): StoredMessage | undefined {
  if (!isRecord(value) || !isSafeText(value.id, 80) || (value.role !== 'user' && value.role !== 'assistant') || !isSafeText(value.text, 256 * 1024) || !isIsoDate(value.timestamp)) return undefined
  return { id: value.id, role: value.role, text: value.text, timestamp: value.timestamp }
}

function parseTool(value: unknown): StoredToolEvent | undefined {
  if (!isRecord(value) || !isSafeText(value.id, 160) || !isSafeText(value.runId, 80) || !isSafeText(value.name, 80) || (value.status !== 'success' && value.status !== 'error')) return undefined
  if (value.detail !== undefined && !isSafeText(value.detail, 260)) return undefined
  return { id: value.id, runId: value.runId, name: value.name, status: value.status, ...(value.detail === undefined ? {} : { detail: value.detail }) }
}

function parseArtifact(value: unknown): StoredArtifact | undefined {
  if (!isRecord(value) || !isSafeText(value.runId, 80) || !isSafeText(value.path, 512) || !isSafeText(value.filename, 260) || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(value.sha256)) return undefined
  return { runId: value.runId, path: value.path, filename: value.filename, sha256: value.sha256 }
}

function parseRunUi(value: unknown): StoredRunUi | undefined {
  if (!isRecord(value) || !isSafeText(value.runId, 80) || !Array.isArray(value.checkpoints)) return undefined
  let plan: StoredPlan | undefined
  if (value.plan !== undefined) {
    if (!isRecord(value.plan) || !isSafeText(value.plan.id, 80) || !isSafeText(value.plan.title, 200) || !Array.isArray(value.plan.steps)) return undefined
    const steps = value.plan.steps.map(step => isRecord(step) && isSafeText(step.id, 80) && isSafeText(step.title, 200) && ['pending', 'running', 'completed'].includes(String(step.status)) ? { id: step.id, title: step.title, status: step.status as StoredPlanStep['status'] } : undefined)
    if (steps.some(step => !step)) return undefined
    plan = { id: value.plan.id, title: value.plan.title, steps: steps as StoredPlanStep[] }
  }
  const checkpoints = value.checkpoints.map(item => {
    if (!isRecord(item) || !isSafeText(item.id, 80) || !isSafeText(item.verb, 80) || !isSafeText(item.target, 260) || !['低', '中', '高'].includes(String(item.risk)) || !isSafeText(item.reason, 400) || !['pending', 'approved', 'rejected'].includes(String(item.status))) return undefined
    return { id: item.id, verb: item.verb, target: item.target, risk: item.risk as StoredCheckpoint['risk'], reason: item.reason, status: item.status as StoredCheckpoint['status'], ...(item.approveSimilar === true ? { approveSimilar: true } : {}) }
  })
  if (checkpoints.some(item => !item)) return undefined
  return { runId: value.runId, ...(plan ? { plan } : {}), checkpoints: checkpoints as StoredCheckpoint[] }
}

export function parseStoredSession(value: unknown): StoredSession | undefined {
  if (!isRecord(value) || (value.schemaVersion !== 1 && value.schemaVersion !== SESSION_SCHEMA_VERSION) || typeof value.id !== 'string' || !SESSION_ID_RE.test(value.id) || !isSafeText(value.title, 80) || !isIsoDate(value.createdAt) || !isIsoDate(value.updatedAt) || !isStatus(value.status)) return undefined
  if (!Array.isArray(value.messages) || !Array.isArray(value.tools) || !Array.isArray(value.artifacts)) return undefined
  const messages = value.messages.map(parseMessage)
  const tools = value.tools.map(parseTool)
  const artifacts = value.artifacts.map(parseArtifact)
  const runUi = value.runUi === undefined && value.schemaVersion === 1 ? [] : Array.isArray(value.runUi) ? value.runUi.map(parseRunUi) : [undefined]
  if (messages.some(item => !item) || tools.some(item => !item) || artifacts.some(item => !item) || runUi.some(item => !item)) return undefined
  return {
    schemaVersion: SESSION_SCHEMA_VERSION,
    id: value.id,
    title: value.title,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    status: value.status,
    messages: messages as StoredMessage[],
    tools: tools as StoredToolEvent[],
    artifacts: artifacts as StoredArtifact[],
    runUi: runUi as StoredRunUi[],
  }
}

export class LocalSessionStore {
  constructor(
    readonly directory = localSessionDirectory(),
    private readonly now: () => Date = () => new Date(),
  ) {}

  private path(id: string): string {
    if (!SESSION_ID_RE.test(id)) throw new Error('session id')
    return join(this.directory, `${id}.json`)
  }

  async create(): Promise<StoredSession> {
    const timestamp = this.now().toISOString()
    let id = randomBytes(18).toString('base64url')
    while (await this.get(id)) id = randomBytes(18).toString('base64url')
    const session: StoredSession = {
      schemaVersion: SESSION_SCHEMA_VERSION,
      id,
      title: DEFAULT_SESSION_TITLE,
      createdAt: timestamp,
      updatedAt: timestamp,
      status: 'NEW',
      messages: [],
      tools: [],
      artifacts: [],
      runUi: [],
    }
    await this.save(session)
    return session
  }

  async get(id: string): Promise<StoredSession | undefined> {
    if (!SESSION_ID_RE.test(id)) return undefined
    try {
      const handle = await open(this.path(id), 'r')
      try {
        const bytes = Buffer.allocUnsafe(MAX_SESSION_FILE_BYTES + 1)
        let offset = 0
        while (offset < bytes.byteLength) {
          const { bytesRead } = await handle.read(bytes, offset, bytes.byteLength - offset, null)
          if (bytesRead === 0) break
          offset += bytesRead
        }
        if (offset > MAX_SESSION_FILE_BYTES) return undefined
        return parseStoredSession(JSON.parse(bytes.subarray(0, offset).toString('utf8')))
      } finally {
        await handle.close()
      }
    } catch {
      return undefined
    }
  }

  async list(): Promise<SessionSummary[]> {
    let names: string[]
    try {
      names = await readdir(this.directory)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const sessions = (await Promise.all(names
      .filter(name => /^[A-Za-z0-9_-]{24}\.json$/u.test(name))
      .map(name => this.get(name.slice(0, -'.json'.length)))))
      .filter((session): session is StoredSession => Boolean(session))
    return sessions
      .sort((left, right) => ordinal(right.updatedAt, left.updatedAt) || ordinal(right.id, left.id))
      .map(({ id, title, createdAt, updatedAt, status }) => ({ id, title, createdAt, updatedAt, status }))
  }

  async save(session: StoredSession): Promise<void> {
    const validated = parseStoredSession(session)
    if (!validated) throw new Error('session schema')
    await mkdir(this.directory, { recursive: true })
    const target = this.path(validated.id)
    const temporary = join(this.directory, `.${validated.id}.${randomBytes(8).toString('hex')}.tmp`)
    await writeFile(temporary, `${JSON.stringify(validated, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, target)
  }

  async delete(id: string): Promise<boolean> {
    if (!SESSION_ID_RE.test(id)) return false
    try {
      await unlink(this.path(id))
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
  }

  timestamp(): string { return this.now().toISOString() }
}
