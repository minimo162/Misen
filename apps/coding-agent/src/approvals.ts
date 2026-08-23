export type ApprovalRisk = 'low' | 'medium' | 'high'

export interface ApprovalRequest {
  question: string
  runId?: string
  stepId?: string
  toolName?: string
  risk?: ApprovalRisk
  scope?: string
  expiresAt?: number
}

export interface ApprovalSnapshot extends ApprovalRequest {
  id: string
  createdAt: number
  expiresAt: number
}

export interface ApprovalResolution {
  id: string
  approved: boolean
  reason: string
  resolvedAt: number
}

interface PendingApproval extends ApprovalSnapshot {
  resolve: (approved: boolean) => void
}

const pending = new Map<string, PendingApproval>()
const resolutions = new Map<string, ApprovalResolution>()
let sequence = 0
const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000

function makeId(): string {
  sequence = (sequence + 1) % 0x100000
  return `approval-${Date.now().toString(36)}-${sequence.toString(36)}`
}

export function requestApproval(request: string | ApprovalRequest): Promise<boolean> {
  const normalized: ApprovalRequest = typeof request === 'string' ? { question: request } : request
  const id = makeId()
  const createdAt = Date.now()
  const expiresAt = normalized.expiresAt ?? createdAt + APPROVAL_TIMEOUT_MS
  return new Promise((resolve) => {
    const entry: PendingApproval = { ...normalized, id, createdAt, expiresAt, resolve }
    pending.set(id, entry)
    const timeout = Math.max(1, expiresAt - createdAt)
    setTimeout(() => {
      const current = pending.get(id)
      if (current !== entry) return
      pending.delete(id)
      const result: ApprovalResolution = { id, approved: false, reason: '承認期限切れ', resolvedAt: Date.now() }
      resolutions.set(id, result)
      while (resolutions.size > 100) resolutions.delete(resolutions.keys().next().value as string)
      resolve(false)
    }, timeout).unref()
  })
}

export function listApprovals(): ApprovalSnapshot[] {
  return [...pending.values()]
    .sort((a, b) => a.createdAt - b.createdAt)
    .map(({ resolve: _resolve, ...snapshot }) => snapshot)
}

export function resolveApproval(id: string, approved: boolean, reason = approved ? '利用者が許可しました' : '利用者が拒否しました'): boolean {
  const entry = pending.get(id)
  if (!entry) return false
  pending.delete(id)
  const result: ApprovalResolution = { id, approved: Boolean(approved), reason, resolvedAt: Date.now() }
  resolutions.set(id, result)
  while (resolutions.size > 100) resolutions.delete(resolutions.keys().next().value as string)
  entry.resolve(Boolean(approved))
  return true
}

export function getApprovalResolution(id: string): ApprovalResolution | undefined {
  return resolutions.get(id)
}

export function clearApprovals(): void {
  for (const entry of pending.values()) {
    const result: ApprovalResolution = { id: entry.id, approved: false, reason: 'サーバー終了により解除されました', resolvedAt: Date.now() }
    resolutions.set(entry.id, result)
    entry.resolve(false)
  }
  pending.clear()
}
