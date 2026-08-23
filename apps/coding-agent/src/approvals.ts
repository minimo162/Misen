export interface ApprovalSnapshot {
  id: string
  question: string
  createdAt: number
}

interface PendingApproval extends ApprovalSnapshot {
  resolve: (approved: boolean) => void
}

const pending = new Map<string, PendingApproval>()
let sequence = 0
const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000

function makeId(): string {
  sequence = (sequence + 1) % 0x100000
  return `approval-${Date.now().toString(36)}-${sequence.toString(36)}`
}

export function requestApproval(question: string): Promise<boolean> {
  const id = makeId()
  const createdAt = Date.now()
  return new Promise((resolve) => {
    const entry: PendingApproval = { id, question, createdAt, resolve }
    pending.set(id, entry)
    setTimeout(() => {
      const current = pending.get(id)
      if (current !== entry) return
      pending.delete(id)
      resolve(false)
    }, APPROVAL_TIMEOUT_MS).unref()
  })
}

export function listApprovals(): ApprovalSnapshot[] {
  return [...pending.values()]
    .sort((a, b) => a.createdAt - b.createdAt)
    .map(({ id, question, createdAt }) => ({ id, question, createdAt }))
}

export function resolveApproval(id: string, approved: boolean): boolean {
  const entry = pending.get(id)
  if (!entry) return false
  pending.delete(id)
  entry.resolve(Boolean(approved))
  return true
}

export function clearApprovals(): void {
  for (const entry of pending.values()) entry.resolve(false)
  pending.clear()
}