import path from 'node:path'
import { parse as shellParse, type ParseEntry } from 'shell-quote'
import type { PermissionRule } from './config'
import type { ToolExecuteBeforeHook } from './hooks'
import { bareToolName, type ToolContext } from './tools'
import { evaluate } from './vendor/opencode-permission/evaluate'
import { prefix } from './vendor/opencode-permission/arity'

export type PermissionDecision = PermissionRule['action']

export interface PermissionTarget {
  pattern: string
  /** Complex shell input is evaluated normally but cannot receive allow. */
  allowEligible: boolean
}

export interface CommandPermissionTarget {
  target: string
  allowEligible: boolean
}

function normalizeWorkspacePattern(value: string, ctx: ToolContext): string {
  const source = value.trim().replaceAll('\\', '/')
  if (!source) return ''
  // This is deliberately lexical. The host tools retain the realpath/symlink
  // checks that enforce the actual workspace boundary at execution time.
  const workspace = path.resolve(ctx.workspace)
  const absolute = path.resolve(workspace, source)
  return path.relative(workspace, absolute).replaceAll('\\', '/') || '.'
}

function joinPathAndGlob(pathValue: string, globValue: string): string {
  const base = pathValue.trim()
  const glob = globValue.trim()
  if (!base || base === '.') return glob
  if (!glob) return base
  if (path.isAbsolute(glob) || /^[A-Za-z]:[\\/]/u.test(glob)) return glob
  return `${base.replace(/[\\/]+$/u, '')}/${glob.replace(/^[\\/]+/u, '')}`
}

/**
 * Extract the command prefix used by OpenCode's permission matcher.
 * Operators, globs, comments, malformed input, and multiple-command text are
 * intentionally not eligible for an allow rule; their complete text is still
 * returned so deny/ask rules can match conservatively.
 */
export function commandPermissionTarget(command: string): CommandPermissionTarget {
  const target = command.trim()
  if (!target || /[\r\n]/u.test(target)) return { target, allowEligible: false }
  let parsed: ParseEntry[]
  try {
    parsed = shellParse(target)
  } catch {
    return { target, allowEligible: false }
  }
  if (parsed.length === 0 || parsed.some((entry) => typeof entry !== 'string')) {
    return { target, allowEligible: false }
  }
  const commandPrefix = prefix(parsed as string[]).join(' ')
  return commandPrefix ? { target: commandPrefix, allowEligible: true } : { target, allowEligible: false }
}

interface StringCollection {
  values: string[]
  invalid: boolean
}

function collectStrings(value: unknown): StringCollection {
  if (typeof value === 'string') return { values: value.trim() ? [value] : [], invalid: value.trim().length === 0 }
  if (!Array.isArray(value)) return { values: [], invalid: value !== undefined }
  const values: string[] = []
  let invalid = false
  for (const item of value) {
    if (typeof item === 'string' && item.trim()) values.push(item)
    else invalid = true
  }
  return { values, invalid }
}

function pathTarget(value: string, ctx: ToolContext): PermissionTarget {
  return { pattern: normalizeWorkspacePattern(value, ctx), allowEligible: true }
}

/** Return one or more workspace-relative permission targets for a host call. */
export function permissionTargets(tool: string, args: Record<string, unknown>, ctx: ToolContext): PermissionTarget[] {
  const bare = bareToolName(tool)
  if (bare === 'run_command' || bare === 'start_process') {
    if (typeof args.command === 'string') {
      const command = commandPermissionTarget(args.command)
      return [{ pattern: command.target, allowEligible: command.allowEligible }]
    }
    return [{ pattern: '*', allowEligible: false }]
  }

  const targets: PermissionTarget[] = []
  let invalid = false

  // Directory listing and content search have a base path plus a glob. Match
  // the combined workspace-relative pattern instead of requiring two rules.
  if (bare === 'list_files' || bare === 'search_files') {
    const baseValues = collectStrings(args.path)
    const listValues = collectStrings(args.paths)
    const bases = [...baseValues.values, ...listValues.values]
    const globKey = bare === 'list_files' ? 'glob' : 'include'
    const globValues = collectStrings(args[globKey])
    invalid ||= baseValues.invalid || listValues.invalid || globValues.invalid
    if (bases.length > 0 && globValues.values.length > 0) {
      for (const base of bases) for (const glob of globValues.values) targets.push(pathTarget(joinPathAndGlob(base, glob), ctx))
    } else {
      for (const base of bases) targets.push(pathTarget(base, ctx))
      for (const glob of globValues.values) targets.push(pathTarget(glob, ctx))
    }
  }

  const pathValues = collectStrings(args.path)
  const pathsValues = collectStrings(args.paths)
  invalid ||= pathValues.invalid || pathsValues.invalid
  if (bare !== 'list_files' && bare !== 'search_files') {
    for (const value of pathValues.values) targets.push(pathTarget(value, ctx))
    for (const value of pathsValues.values) targets.push(pathTarget(value, ctx))
  }

  const patternValues = collectStrings(args.pattern)
  const patternsValues = collectStrings(args.patterns)
  invalid ||= patternValues.invalid || patternsValues.invalid
  for (const value of patternValues.values) targets.push(pathTarget(value, ctx))
  for (const value of patternsValues.values) targets.push(pathTarget(value, ctx))

  // A malformed path-like argument must never turn an allow rule into an
  // execution approval. Valid calls with no target retain the usual `*` key.
  if (targets.length === 0) return [{ pattern: '*', allowEligible: !invalid }]
  return targets
}

interface EvaluatedTarget {
  target: PermissionTarget
  action: PermissionDecision
}

function evaluatedTargets(tool: string, args: Record<string, unknown>, ctx: ToolContext, rules: readonly PermissionRule[]): EvaluatedTarget[] {
  const permission = bareToolName(tool)
  return permissionTargets(permission, args, ctx).map((target) => ({
    target,
    action: evaluate(permission, target.pattern, rules).action
  }))
}

function combineDecisions(items: readonly EvaluatedTarget[]): PermissionDecision {
  let needsAsk = false
  for (const item of items) {
    if (item.action === 'deny') return 'deny'
    if (item.action === 'ask' || (item.action === 'allow' && !item.target.allowEligible)) needsAsk = true
  }
  return needsAsk ? 'ask' : 'allow'
}

export function evaluateToolPermission(
  tool: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
  rules: readonly PermissionRule[]
): PermissionDecision {
  return combineDecisions(evaluatedTargets(tool, args, ctx, rules))
}

export function createPermissionHook(rules: readonly PermissionRule[]): {
  hook: ToolExecuteBeforeHook
  takeDecision(args: Record<string, unknown>): PermissionDecision | undefined
} {
  const ruleset = [...rules]
  const decisions = new WeakMap<Record<string, unknown>, PermissionDecision>()
  const hook: ToolExecuteBeforeHook = ({ tool, args, ctx }) => {
    const evaluated = evaluatedTargets(tool, args, ctx, ruleset)
    const decision = combineDecisions(evaluated)
    if (decision === 'deny') {
      const denied = evaluated.filter((item) => item.action === 'deny').map((item) => item.target.pattern)
      throw new Error(`permission denied: ${bareToolName(tool)} (${denied.join(', ') || '*'})`)
    }
    decisions.set(args, decision)
  }
  return {
    hook,
    takeDecision(args) {
      return decisions.get(args)
    }
  }
}
