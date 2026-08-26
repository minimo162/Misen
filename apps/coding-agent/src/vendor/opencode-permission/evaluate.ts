// Source: https://github.com/anomalyco/opencode/blob/c2eacd72afc4a4984564c393e15ab30011057269/packages/opencode/src/permission/index.ts
// Upstream repository: https://github.com/sst/opencode (canonical: https://github.com/anomalyco/opencode)
// Original path: packages/opencode/src/permission/index.ts
// Commit: c2eacd72afc4a4984564c393e15ab30011057269
// License: MIT (Copyright (c) 2025 opencode)
// Adaptation: extracted evaluate() only; local Rule/Ruleset types and an ES2022 findLast type cast replace PermissionV1 types.

import { match } from './wildcard'

export type PermissionAction = 'allow' | 'ask' | 'deny'

export interface PermissionRule {
  permission: string
  pattern: string
  action: PermissionAction
}

export type PermissionRuleset = readonly PermissionRule[]

export function evaluate(permission: string, pattern: string, ...rulesets: PermissionRuleset[]): PermissionRule {
  return (
    (rulesets.flat() as PermissionRule[] & { findLast(predicate: (rule: PermissionRule) => boolean): PermissionRule | undefined })
      .findLast((rule) => match(permission, rule.permission) && match(pattern, rule.pattern)) ?? {
      action: "ask",
      permission,
      pattern: "*",
    }
  )
}
