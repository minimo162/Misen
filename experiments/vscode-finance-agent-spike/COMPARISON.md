# Maintenance and security comparison

Status: prepared comparison; actual Custom Endpoint Agent runs are still
required before an architecture verdict.

## Reference decomposition

The Misen-owned reference supplied for this spike is:

```text
Misen UI
  -> Pi Agent Runtime
  -> AGENTS.md-compatible instructions
     Agent Skills
     typed lifecycle hooks
     minimum necessary Tools
  -> Approved Brain
       - company-approved external API
       - centrally managed internal GPU endpoint
```

The spike asks which layers VS Code can own without weakening the Finance
boundary. It does not assume that either host is preferable.

## Ownership comparison

| Concern | Misen-owned host | VS Code Local Agent route |
| --- | --- | --- |
| Conversation UI, streaming, stop/cancel | Misen / assistant-ui code | VS Code standard Agent host |
| Agent loop | Pi dependency and Misen wiring | VS Code standard Agent harness |
| Instructions | Misen prompt/handoff or future AGENTS-compatible layer | Scoped `AGENTS.md` |
| Business knowledge | Misen-owned prompt/runtime assets | Official project Agent Skill |
| Lifecycle hooks | Misen observer/runtime code or typed hooks | Official VS Code hooks (Preview); none needed by this functional spike |
| Excel automation | Five Misen capabilities plus boundary/engine | One deterministic XLSX helper using the same commodity library |
| Tool UI and approvals | Misen-owned UI/runtime behavior | VS Code tool UI and approvals |
| Model adapter/config | Pi provider/model wiring | Official Custom Endpoint model configuration |
| Brain choice | External API or internal endpoint through Misen adapter | External API or internal endpoint by changing official endpoint configuration |
| Packaging/startup/browser | Misen-owned distribution and loopback web app | Existing managed VS Code installation plus workspace files |
| Artifact lifecycle | Misen server/runtime boundary | Workspace/output rules plus helper enforcement; external oracle for this spike |
| Observer/evidence | PR #75 adds a dedicated observer surface | VS Code transcript/tool UI plus a small external acceptance harness; audit adequacy unverified |

## Rough current code surface

Measured on `origin/main@06804c5` and this spike. These figures are directional,
not a quality score and not perfectly like-for-like.

### Enterprise Misen main

- Agent runtime wiring: 2 files / 37 lines
- custom web UI and loopback host: 4 files / 636 lines
- Finance tools, spreadsheet seam, and workspace boundary: 4 files / 549 lines
- acceptance/oracle runners: 5 files / 369 lines
- packaging/build scripts in the app: 3 files / 63 lines
- direct production dependencies: 7, including Pi, assistant-ui, React, and XLSX
- PR #75 observer preparation: 12 changed files and roughly 1.3k added lines;
  formal paid 20-run sampling has not started
- PR #76 prepared-runtime packaging: 6 changed files and roughly 650 added
  lines; corporate-device and live-provider validation have not run

### VS Code spike

- `AGENTS.md`: 16 lines
- Finance Skill: 52 lines
- deterministic XLSX helper: about 180 lines
- direct production dependency: 1 (`@office-kit/xlsx`), 12 transitive packages
- custom extension/Tool API/runtime/UI/model adapter/proxy: 0
- operator-only fixture/oracle harness and regression: about 190 lines

The strongest maintenance difference is ownership, not raw LOC: VS Code would
own the generic Agent host, conversation UI, tool presentation, cancellation,
and model-selection experience. Finance would retain business instructions,
the binary Excel adapter, domain checks, and any genuinely sensitive Tool
boundary.

## Security delegation and gaps

### Potentially delegated to VS Code

- Agent host, conversation, streaming, and stop/cancel
- workspace file/search tools
- model selection and official endpoint configuration
- tool approval UI, terminal allow/deny rules, URL approvals, sensitive-file
  protection, Workspace Trust, and managed settings

### Finance-owned or likely to remain custom

- business instructions and Skills
- Excel and future SAP automation
- domain-specific acceptance checks
- narrow Tools for operations that cannot safely use a general terminal
- audit evidence required by Finance policy

### Unresolved after the home-PC spike

- native Windows has no documented Agent terminal sandbox
- terminal auto-approval is best-effort, not a containment boundary
- filesystem containment when terminal commands are allowed
- arbitrary network and endpoint allowlisting
- enterprise policy for Custom Endpoint and BYOK
- prompt/response retention, logging, and audit requirements
- corporate EDR/application-control behavior
- corporate-device and live-provider validation

Neither `AGENTS.md` nor a Skill is a security guarantee. VS Code availability is
also not a security certification. A production route may need WSL2/container
isolation, managed policy, or one narrow Finance Tool/Extension boundary even if
the generic host remains VS Code.

## Verdict gate

No GO / HYBRID / KEEP verdict is valid until the official Custom Endpoint model
is visible in Local Agent mode, tool calling works, and the one-shot July and
August runs are independently graded. Failure of the official endpoint path is
itself a finding; a proxy or replacement chat UI is out of scope.
