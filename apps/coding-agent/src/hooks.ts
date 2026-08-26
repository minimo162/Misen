import type { ToolContext } from './tools'

export type ToolExecuteBeforeHook = (input: {
  tool: string
  args: Record<string, unknown>
  ctx: ToolContext
}) => void | Promise<void>

const registeredBeforeHooks: ToolExecuteBeforeHook[] = []

export function registerToolExecuteBeforeHook(hook: ToolExecuteBeforeHook): () => void {
  registeredBeforeHooks.push(hook)
  return () => {
    const index = registeredBeforeHooks.indexOf(hook)
    if (index >= 0) registeredBeforeHooks.splice(index, 1)
  }
}

export function clearToolExecuteBeforeHooks(): void {
  registeredBeforeHooks.length = 0
}

export async function runToolExecuteBeforeHooks(
  input: Parameters<ToolExecuteBeforeHook>[0],
  perRunHooks: readonly ToolExecuteBeforeHook[] = []
): Promise<void> {
  // Phase 2's declarative permission layer plugs in here. Keep this ordered
  // between schema validation and the existing approval/host-guard path.
  for (const hook of [...registeredBeforeHooks, ...perRunHooks]) await hook(input)
}
