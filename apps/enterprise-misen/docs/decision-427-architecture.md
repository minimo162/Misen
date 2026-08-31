# Decision 427 implementation map

## Before / after

The historical Home PoC ran the full DSH Web/CLI profile as the product
boundary. This package does not inherit that architecture. Misen is the product;
DSH/Cordis are modular OSS components inside its execution plane.

The minimal DSH graph is:

```text
@deepseek-ai/cordis 4.0.2
  + dsh-llm
  + dsh-session
  + dsh-session-projection
  + dsh-system-prompt
  + dsh-tools (native mode)
  + dsh-agent
  + dsh-agent-loop
```

Every DSH package is pinned to `0.1.2-alpha.2`. Provider/model routing remains
an injected `LlmAdapter`; Misen owns no Model Gateway and no custom Agent Loop.
The optional live Brain route uses DSH's public
`@deepseek-ai/dsh-llm-pi-ai@0.1.2-alpha.2` adapter, configured for the explicitly
declared `openai` route and model `gpt-5.6-luna`. It does not mount the retry
plugin: the first failed live business result stops month progression. The
public `@deepseek-ai/dsh-llm-retry@0.1.2-alpha.2` seam is retained only for the
deterministic transient-provider recovery test. The profile stores only the
credential reference `OPENAI_API_KEY`; the value is resolved at request time
inside the provider boundary and is never passed through a model-facing Tool,
logged, persisted, or copied into the repository.

## Rejected runtime boundaries

| Candidate | Decision |
| --- | --- |
| Full `@deepseek-ai/dsh` CLI | Rejected: broad shell/jobs/skills/Web/UI/plugin-loader/runtime-install surface |
| `@deepseek-ai/dsh-agent-spine-demo` | Reference only: mounts jobs and defaults to model-facing bash/skills/jobs |
| `dsh-fs-local` / `dsh-fs-sandbox` | Rejected: Koffi/Win32 native artifacts conflict with the initial no-native gate |
| `dsh-tool-fs-search` | Rejected: launches bundled ripgrep subprocess |
| `dsh-attachment-local` | Not required; rejected from this slice because Sharp/libvips adds native artifacts |
| Misen-owned xlsx engine | Rejected: commodity engine passed the mandatory spike |

The resulting Workspace boundary is narrow Misen-owned security glue using
Node standard `fs`: lexical containment, real-path containment, symlink escape
denial, bounded model-visible reads, and output-only `.xlsx` writes.

## Spreadsheet engine

`@office-kit/xlsx@0.9.0` passed the synthetic preservation spike for values,
formula text/cached values, Font, Fill, Border, Alignment, NumberFormat,
dimensions, save/reopen, untouched cells, and input hashes. Excel dates remain
the commodity library's serial plus NumberFormat representation on disk and are
converted through its public date helpers at the tool seam.

Before any source or existing output workbook can be serialized as a
deliverable, every populated formula cell is checked against the same bounded
local-formula policy used for model-authored formulas. Unsafe network, file,
external-workbook, cross-sheet, DDE, or unapproved function/name references
fail closed without publishing or mutating the output. The public Office Kit
relationship/passthrough surface is also inspected: explicit URI/host-file
targets on generic preserved relationships, external URL/file
hyperlinks, external workbook references, external-link/query-table/connection
parts, and corresponding relationship extras are rejected rather than copied
into a deliverable. Location-only links inside the workbook remain valid.

Output replacement writes and syncs a private sibling temporary file and then
uses one same-directory `rename` replacement. The old destination is never
unlinked first, so an ordinary commit/rename error leaves the last-known-good
file intact and the temporary is cleaned. This is failure-safe namespace
replacement, not a power-loss-durable transaction: Node/libuv does not fsync
the directory entry here, and open handles, ACL interference, and filesystem
failure remain residual risks.

The selection gate also opens, edits, saves, and reopens the tracked
`demo/renketsu-demo/workspace/集計台帳.xlsx` fixture. That workbook was generated
independently by the existing ImportExcel/EPPlus build at commit `b39307d`;
the test checks its sheet structure, styles, dimensions, untouched content, and
input hash. This prevents an Office Kit self-roundtrip from being the sole
preservation evidence.

Known library boundary: no formula recalculation engine; rich-text formatting
may flatten; modeled OOXML can be semantically rebuilt rather than byte-identical.

## Vertical slice

The fixture-only handoff describes purpose, workbook roles, business rules,
template meaning, and completion criteria without prescribing Tool order. A
test-only scripted Brain replay drives the real DSH Agent Loop and the five
production capabilities for both July and August. Production source contains no
month/company fixture literals or Finance-specific Tool names. This proves the
mechanical two-dataset integration and independent grading path; it does not
prove autonomous planning/generalization by GPT-5.6 Luna.

Live Luna and DSH UI remain explicit follow-up gates, not inferred PASS results.
The first configured live attempt used the exact minimal Japanese request
`7月の3社実績を取りまとめて、月次管理レポートを完成させて`; independent
validation found the produced report month was incorrect (`MONTH`), so July is
recorded as FAIL and no August live request was started. A later rerun is
credential-gated and must use the same prompt for both synthetic months; the
deterministic replay remains evidence of mechanical integration only.

Two earlier live diagnostics exposed a transport issue rather than a provider
contract issue: localized month labels in the session id reached an HTTP header
and produced `PI_AI_ERROR`. The live harness now derives an ASCII-only,
deterministic SHA-256 correlation id (`enterprise-live-<hex>`) while retaining
the localized month solely in the prompt. No API key, raw provider payload,
session log, or generated live artifact is stored in version control.

## Public UI seam inspection

After the backend spike passed, current `deepseek-harness` public package paths
were inspected for `packages/client/ui-conversation`, `ui-session`,
`ui-workspace`, `ui-approval`, and `ui-deliverables`, alongside the client
renderer/layout/Web composition. They cover the candidate Conversation,
Session, Workspace, Approval, Tool activity/deliverable, and connection shell
needed by a later Misen UI composition. This backend PR does not add those
packages, run the full DSH Web product, or create a parallel Misen Chat UI.
Branding/rendered-browser acceptance remains a separate live UI gate.
