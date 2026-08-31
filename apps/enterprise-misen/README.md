# Enterprise Misen initial PoC

This package implements the Decision 427 technical baseline: a general-purpose,
capability-constrained Agent runtime with a replaceable Brain and local File +
Spreadsheet execution. It is not a Finance-specific runtime and is not an
Enterprise adoption or security approval.

## Architecture

```text
replaceable Brain adapter
        |
DSH public Agent Loop / Session / Tool lifecycle
        |
explicit five-tool capability roster
        |
Node workspace guard + @office-kit/xlsx
```

The production composition imports public DSH packages directly. It does not
run the full `dsh` CLI or `agent-spine-demo`, discover plugins, expose a shell,
or mount jobs, skills, goals, Web, MCP, subagents, or process executors.

Model-facing tools:

- `workspace_list_files`
- `workspace_read_text`
- `spreadsheet_read`
- `spreadsheet_create_output`
- `spreadsheet_update`

All paths are relative to a user-selected workspace. General file operations
are read-only. Spreadsheet writes are limited to `.xlsx` files below
`workspace/output`.

## Deterministic verification

```powershell
Set-Location apps\enterprise-misen
npm ci
npm test
npm run acceptance
```

`npm test` covers the modular DSH composition, a real Tool call/result/follow-up
loop, Spreadsheet round-trip and preservation, Workspace containment, and the
two-month Excel vertical slice. The test-only replay adapter uses DSH's public
`LlmAdapter` seam; it is not a production Brain or a replacement Agent Loop.
Its scripted calls prove mechanical integration and independent output grading,
not autonomous Agent planning or live-model generalization.

## Current boundary

- Dummy data only.
- Live GPT-5.6 Luna credential execution: **NOT RUN**.
- DSH public UI composition: source seam inspected; UI implementation/live test
  **NOT RUN** in this backend vertical slice.
- Model-authored formulas write validated local formula text and reject
  model-supplied cached values; Misen does not implement an Excel calculation
  engine.
- Existing formulas carried from a source or output workbook are revalidated
  before every deliverable write; unsafe formulas fail closed.
- `.xlsx` only. VBA, `.xlsm`, Pivot refresh, Excel COM, and LibreOffice are out
  of scope.
- Corporate EDR/proxy/device approval is not inferred from these local tests.

See [Decision 427 architecture](docs/decision-427-architecture.md), the
[Decision 427 acceptance record](docs/decision-427-acceptance.md), the
[CycloneDX SBOM](evidence/sbom.cdx.json), and
[third-party notices](THIRD_PARTY_NOTICES.md).
