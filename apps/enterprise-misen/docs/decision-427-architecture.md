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
fail closed without publishing or mutating the output.

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

## Public UI seam inspection

After the backend spike passed, current `deepseek-harness` public package paths
were inspected for `packages/client/ui-conversation`, `ui-session`,
`ui-workspace`, `ui-approval`, and `ui-deliverables`, alongside the client
renderer/layout/Web composition. They cover the candidate Conversation,
Session, Workspace, Approval, Tool activity/deliverable, and connection shell
needed by a later Misen UI composition. This backend PR does not add those
packages, run the full DSH Web product, or create a parallel Misen Chat UI.
Branding/rendered-browser acceptance remains a separate live UI gate.
