import { appendFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export type AuditEvent =
  | { event: 'file.imported'; filename: string; size: number; sha256: string }
  | { event: 'project.switched'; folder: string }
  | { event: 'approval.changed'; mode: 'confirm' | 'session-auto' }
  | { event: 'checkpoint.requested'; id: string; verb: string; target: string; risk: '低' | '中' | '高'; reason: string }
  | { event: 'checkpoint.responded'; id: string; verb: string; decision: 'approved' | 'rejected'; approveSimilar: boolean; automatic?: boolean }

export function defaultAuditPath(env: NodeJS.ProcessEnv = process.env): string {
  const localAppData = env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')
  return join(localAppData, 'Misen', 'state', 'audit.jsonl')
}

/** One append call per metadata-only event; audit records never contain file contents or credentials. */
export async function appendAudit(path: string, event: AuditEvent, now: () => Date = () => new Date()): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await appendFile(path, JSON.stringify({ schema: 'misen-audit/1', timestamp: now().toISOString(), ...event }) + '\n', 'utf8')
}
