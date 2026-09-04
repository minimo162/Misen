import type { StoredPlan, StoredPlanStep } from './sessions.js'

export const PLAN_TOOLS = [
  'workspace_list_files', 'workspace_read_text', 'spreadsheet_read', 'document_read', 'presentation_read',
  'office_get', 'office_query', 'office_inspect', 'office_create_output', 'office_set', 'office_add',
  'office_remove', 'office_move', 'office_swap', 'office_batch', 'office_import',
] as const

const WRITING_TOOLS = new Set(['office_create_output', 'office_set', 'office_add', 'office_remove', 'office_move', 'office_swap', 'office_batch', 'office_import'])
const PLAN_TOOL_SET = new Set<string>(PLAN_TOOLS)
const SAFE_TARGET = /^(?!\/|[A-Za-z]:)(?!.*(?:^|\/)\.\.(?:\/|$))[^\r\n]{1,512}$/u

export type PlanProposalStep = { title: string; tool: string; target: string }
export type PlanProposal = { steps: PlanProposalStep[] }
export type PlanProvider = (root: string, prompt: string, importedPaths: readonly string[]) => Promise<PlanProposal | undefined>

const boundedTitle = (value: unknown): value is string => typeof value === 'string' && value.trim() === value && !/[\r\n]/u.test(value) && Array.from(value).length >= 1 && Array.from(value).length <= 30

/** Validate the model's submit_plan arguments before they become local UI state. */
export function parsePlanProposal(value: unknown): PlanProposal | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const steps = (value as { steps?: unknown }).steps
  if (!Array.isArray(steps) || steps.length < 1 || steps.length > 8) return undefined
  const parsed = steps.map(step => {
    if (!step || typeof step !== 'object' || Array.isArray(step)) return undefined
    const { title, tool, target } = step as Record<string, unknown>
    const normalizedTarget = typeof target === 'string' ? target.replace(/\\/gu, '/') : ''
    if (!boundedTitle(title) || typeof tool !== 'string' || !PLAN_TOOL_SET.has(tool) || !SAFE_TARGET.test(normalizedTarget)) return undefined
    return { title, tool, target: normalizedTarget }
  })
  return parsed.some(step => !step) ? undefined : { steps: parsed as PlanProposalStep[] }
}

export function createStoredPlan(clientId: string, proposal?: PlanProposal): StoredPlan {
  if (!proposal) {
    return {
      id: `plan-${clientId}`,
      title: '実行計画',
      visible: true,
      completed: false,
      fallback: true,
      steps: [
        { id: 'review', title: '依頼内容と入力を確認', tool: '', target: '', status: 'running' },
        { id: 'work', title: '必要な作業を実行', tool: '', target: '', status: 'pending' },
        { id: 'verify', title: '成果物を確認して完了', tool: '', target: '', status: 'pending' },
      ],
    }
  }
  return {
    id: `plan-${clientId}`,
    title: 'この依頼で行うこと',
    visible: planShouldBeVisible(proposal.steps),
    completed: false,
    steps: proposal.steps.map((step, index) => ({ id: `step-${index + 1}`, ...step, status: 'pending' })),
  }
}

export function planShouldBeVisible(steps: readonly Pick<StoredPlanStep, 'tool'>[]): boolean {
  return steps.length >= 2 || steps.some(step => WRITING_TOOLS.has(step.tool))
}

const normalizedTarget = (value: string | undefined): string => (value ?? '').replace(/\\/gu, '/').replace(/^\.\//u, '').toLocaleLowerCase('ja-JP')

export function matchingPendingStep(plan: StoredPlan, tool: string, target?: string): StoredPlanStep | undefined {
  const actual = normalizedTarget(target)
  return plan.steps.find(step => !step.unplanned && step.status === 'pending' && step.tool === tool && normalizedTarget(step.target) === actual)
}

export function additionalOperationStep(plan: StoredPlan, tool: string, target?: string): StoredPlanStep {
  const count = plan.steps.filter(step => step.unplanned).length + 1
  return { id: `additional-${count}`, title: '追加の操作', tool, target: (target ?? '').replace(/\\/gu, '/').replace(/^\.\//u, '') || '対象なし', status: 'running', unplanned: true }
}
