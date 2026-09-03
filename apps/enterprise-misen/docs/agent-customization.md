# Misen Agent customization primitives

Misen keeps its existing conversation UI and the public Pi Agent runtime. This
module adds only three bounded customization primitives: workspace instructions,
portable Skills, and typed in-process lifecycle hooks. Misen's capability,
resource, mutation, secret/network, and high-impact-side-effect policies remain
the Security Authority. Instructions and Skills are guidance, never authority.

## Workspace instructions

- Canonical path: `<authorized-workspace>/AGENTS.md` only.
- Discovery is root-only and deterministic. Missing is normal; no parent, home,
  global, nested, network, or plugin instruction files are searched.
- The file must be a regular, single-link, valid UTF-8 file no larger than 64 KiB.
  Lexical and real paths must remain inside the selected WorkspaceBoundary.
- The system prompt receives a JSON envelope with separate `source` and `content`
  fields. It is not combined with the user message and is not exposed as reasoning.
- Loading does not read environment variables or credentials and cannot change
  the fixed model-facing Tool roster.

This is the deliberately small subset of the open [AGENTS.md convention](https://agents.md/).
Nested precedence can be added later only if a real workspace need demonstrates it.

## Portable Agent Skills

- Canonical path: `<authorized-workspace>/.agents/skills/<name>/SKILL.md`.
- Only direct child directories are discovered, sorted by name, with a maximum
  of 256 directory entries, 32 Skills, and 64 KiB per `SKILL.md`.
- `name` and `description` YAML frontmatter follow the open
  [Agent Skills specification](https://agentskills.io/specification). The name
  must match its parent directory.
- Initial context contains only name, description, and Workspace-relative path.
  When relevant, the Agent reads the selected body with the existing
  `workspace_read_text` Tool. This follows the standard
  [progressive-disclosure pattern](https://agentskills.io/client-implementation/adding-skills-support)
  without a selector request or dedicated Skill-selection Tool.
- References and scripts are not scanned, loaded, or executed automatically.
  Frontmatter such as `allowed-tools` is descriptive only and cannot grant a
  capability. There is no download, marketplace, dynamic module, eval, process,
  network, or runtime package-install surface.

The synthetic fixture contains one `monthly-report` Skill only to prove the
vertical seam. Its business content and the Decision 441 oracle are not a generic
production Finance validation architecture.

## Typed lifecycle hooks

`StaticLifecycleHooks` accepts only TypeScript objects passed directly by Misen
code. It performs no folder scan, dynamic import, shell command, or plugin load.
The minimal lifecycle is:

1. `prepareSession` after bounded customization discovery and before Agent construction.
2. `beforeTool` through Pi's public `beforeToolCall` seam after schema validation.
3. `afterTool` through Pi's public `afterToolCall` seam after execution.

Hooks run sequentially in registration order with a one-second bound. Exceptions,
timeouts, and malformed hook results fail closed with a generic policy error.
The built-in capability authority is always registered first and validates the
exact eleven-Tool roster. Existing Tool implementation guards remain in place, so
omitting an optional hook cannot remove the underlying Security Authority.

Pi is an in-process Agent loop, not the Security Authority. The implementation
uses only its documented public `Agent` constructor, Tool API, lifecycle callbacks,
and event subscription surface; it does not fork, patch, or import Pi internals.
See the [Pi Agent API](https://github.com/earendil-works/pi/blob/main/packages/agent/README.md).

## Dependency and maintenance surface

The only direct dependency added is `yaml@2.9.0`, already present in the pinned
Pi dependency graph. Declaring it directly makes standards-compliant frontmatter
parsing an explicit Misen dependency without adding a newly resolved package.
No UI, runtime plugin framework, model provider decision, or Tool category selector
is added by this spike.
