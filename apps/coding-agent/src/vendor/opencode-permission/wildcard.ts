// Source: https://github.com/anomalyco/opencode/blob/c2eacd72afc4a4984564c393e15ab30011057269/packages/core/src/util/wildcard.ts
// Upstream repository: https://github.com/sst/opencode (canonical: https://github.com/anomalyco/opencode)
// Original path: packages/core/src/util/wildcard.ts
// Commit: c2eacd72afc4a4984564c393e15ab30011057269
// License: MIT (Copyright (c) 2025 opencode)
// Adaptation: extracted match() only; removed the namespace re-export.

export function match(input: string, pattern: string): boolean {
  const normalized = input.replaceAll("\\", "/")
  let escaped = pattern
    .replaceAll("\\", "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".")

  if (escaped.endsWith(" .*")) escaped = escaped.slice(0, -3) + "( .*)?"

  return new RegExp("^" + escaped + "$", process.platform === "win32" ? "si" : "s").test(normalized)
}
