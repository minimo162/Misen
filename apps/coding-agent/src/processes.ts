import { spawn, spawnSync, type ChildProcess } from 'node:child_process'

export type ManagedProcessStatus = 'running' | 'exited' | 'failed' | 'stopped'

type StreamName = 'stdout' | 'stderr'

interface InternalRecord {
  id: string
  command: string
  cwd: string
  label: string
  url?: string
  child: ChildProcess
  status: ManagedProcessStatus
  startedAt: number
  finishedAt: number | null
  exitCode: number | null
  signal: string | null
  output: string[]
  baseOffset: number
  pending: Record<StreamName, string>
  requestedStop: boolean
}

export interface ProcessSnapshot {
  id: string
  command: string
  cwd: string
  label: string
  url?: string
  status: ManagedProcessStatus
  startedAt: number
  finishedAt: number | null
  exitCode: number | null
  signal: string | null
  tail: string[]
  nextOffset: number
}

export interface ProcessLogResult {
  process: ProcessSnapshot
  lines: string[]
  nextOffset: number
  truncated: boolean
}

const MAX_RECORDS = 24
const MAX_OUTPUT_LINES = 400
const records = new Map<string, InternalRecord>()
let sequence = 0

function makeId(): string {
  sequence = (sequence + 1) % 0x100000
  return `proc-${Date.now().toString(36)}-${sequence.toString(36)}`
}

function appendLine(record: InternalRecord, line: string, stream: StreamName): void {
  const text = line.trimEnd()
  if (!text) return
  record.output.push(`[${stream}] ${text}`)
  while (record.output.length > MAX_OUTPUT_LINES) {
    record.output.shift()
    record.baseOffset += 1
  }
}

function appendChunk(record: InternalRecord, stream: StreamName, chunk: string): void {
  const combined = record.pending[stream] + chunk
  const parts = combined.split(/\r?\n/)
  record.pending[stream] = parts.pop() ?? ''
  for (const line of parts) appendLine(record, line, stream)
}

function flushPending(record: InternalRecord): void {
  for (const stream of ['stdout', 'stderr'] as const) {
    if (record.pending[stream]) {
      appendLine(record, record.pending[stream], stream)
      record.pending[stream] = ''
    }
  }
}

function snapshot(record: InternalRecord): ProcessSnapshot {
  return {
    id: record.id,
    command: record.command,
    cwd: record.cwd,
    label: record.label,
    ...(record.url ? { url: record.url } : {}),
    status: record.status,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    exitCode: record.exitCode,
    signal: record.signal,
    tail: record.output.slice(-8),
    nextOffset: record.baseOffset + record.output.length
  }
}

function validateUrl(url: string | undefined): string | undefined {
  if (!url) return undefined
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`urlが不正です: ${url}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('urlはhttpまたはhttpsだけ指定できます')
  }
  return parsed.toString()
}

function pruneRecords(): void {
  if (records.size <= MAX_RECORDS) return
  const removable = [...records.values()]
    .filter((record) => record.status !== 'running')
    .sort((a, b) => a.startedAt - b.startedAt)
  while (records.size > MAX_RECORDS && removable.length > 0) {
    const record = removable.shift()
    if (record) records.delete(record.id)
  }
}

export function startManagedProcess(command: string, cwd: string, label?: string, url?: string): ProcessSnapshot {
  const trimmed = command.trim()
  if (!trimmed) throw new Error('commandが空です')
  const cleanUrl = validateUrl(url)
  const child = spawn(trimmed, {
    cwd,
    shell: true,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const record: InternalRecord = {
    id: makeId(),
    command: trimmed,
    cwd,
    label: label?.trim() || trimmed.slice(0, 80),
    ...(cleanUrl ? { url: cleanUrl } : {}),
    child,
    status: 'running',
    startedAt: Date.now(),
    finishedAt: null,
    exitCode: null,
    signal: null,
    output: [],
    baseOffset: 0,
    pending: { stdout: '', stderr: '' },
    requestedStop: false
  }
  records.set(record.id, record)
  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string | Buffer) => appendChunk(record, 'stdout', String(chunk)))
  child.stderr?.on('data', (chunk: string | Buffer) => appendChunk(record, 'stderr', String(chunk)))
  child.once('error', (error) => {
    appendLine(record, error.message, 'stderr')
    if (record.status === 'running') {
      record.status = 'failed'
      record.finishedAt = Date.now()
    }
  })
  child.once('close', (code, signal) => {
    flushPending(record)
    if (record.status === 'running') {
      record.status = record.requestedStop ? 'stopped' : code === 0 ? 'exited' : 'failed'
      record.finishedAt = Date.now()
      record.exitCode = code
      record.signal = signal
    }
    pruneRecords()
  })
  pruneRecords()
  return snapshot(record)
}

export function listManagedProcesses(): ProcessSnapshot[] {
  return [...records.values()]
    .sort((a, b) => b.startedAt - a.startedAt)
    .map(snapshot)
}

function waitForClose(record: InternalRecord, timeoutMs: number): Promise<void> {
  if (record.status !== 'running') return Promise.resolve()
  return new Promise((resolve) => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(finish, timeoutMs)
    record.child.once('close', finish)
    record.child.once('error', finish)
  })
}

export async function stopManagedProcess(id: string): Promise<ProcessSnapshot> {
  const record = records.get(id)
  if (!record) throw new Error(`processが見つかりません: ${id}`)
  if (record.status !== 'running') return snapshot(record)
  record.requestedStop = true
  if (process.platform === 'win32' && record.child.pid) {
    await new Promise<void>((resolve) => {
      const killer = spawn('taskkill', ['/PID', String(record.child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      killer.once('close', (code) => {
        if (code !== 0) {
          try { record.child.kill() } catch {}
        }
        resolve()
      })
      killer.once('error', () => {
        try { record.child.kill() } catch {}
        resolve()
      })
    })
  } else {
    try { record.child.kill('SIGTERM') } catch {}
  }
  await waitForClose(record, 3000)
  if (record.status === 'running') {
    record.status = 'stopped'
    record.finishedAt = Date.now()
    record.signal = 'SIGTERM'
  }
  return snapshot(record)
}

export function readManagedProcessLog(id: string, offset = 0): ProcessLogResult {
  const record = records.get(id)
  if (!record) throw new Error(`processが見つかりません: ${id}`)
  const safeOffset = Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0
  const start = Math.max(0, safeOffset - record.baseOffset)
  return {
    process: snapshot(record),
    lines: record.output.slice(start),
    nextOffset: record.baseOffset + record.output.length,
    truncated: safeOffset < record.baseOffset
  }
}

export function killAllManagedProcesses(): void {
  for (const record of records.values()) {
    if (record.status !== 'running') continue
    record.requestedStop = true
    if (process.platform === 'win32' && record.child.pid) {
      try { spawnSync('taskkill', ['/PID', String(record.child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }) } catch {}
    } else {
      try { record.child.kill() } catch {}
    }
  }
}