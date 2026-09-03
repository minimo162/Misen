# OfficeCLI migration decision

Decision: `REMOVE_OFFICE_KIT`, `ADOPT_OFFICECLI`.

Enterprise Misen uses [iOfficeAI/OfficeCLI](https://github.com/iOfficeAI/OfficeCLI)
as its single Office document engine. The similarly named `officecli/officecli`
repository is an LLM-backed generation product whose network/provider contract
does not fit Misen's deterministic local workbook boundary.

## Frozen identity

| Field | Value |
|---|---|
| Repository | `https://github.com/iOfficeAI/OfficeCLI` |
| Version/tag | `1.0.147` / `v1.0.147` |
| Source commit | `b94f3906fd52d450c64f8e40370e376b9e15079e` |
| License | Apache-2.0 |
| Windows artifact | `officecli-win-x64.exe` |
| Artifact SHA-256 | `724056e5ff079c3585df79c8afc386f08ef7d5f956cf4e2723534e129aab6e80` |
| Distribution | self-contained single file; no external language runtime or Office install |
| Runtime network | not required; updater and auto-resident behavior disabled by Misen |

The prepared-runtime manifest and CycloneDX SBOM repeat this identity. Runtime
acquisition is preparation-host-only; targets never select or download a newer
version.

At the 2026-09-03 investigation checkpoint, v1.0.147 was the current maintained
release. Its release page publishes self-contained Windows x64/arm64, macOS
x64/arm64, Linux x64/arm64, and Alpine-compatible artifacts. Source builds target
.NET 10 and self-contained single-file publication, but the selected Windows x64
release requires no separately installed .NET, Node.js, Python, package manager,
or Microsoft Office. The executable runs directly without installation.

OfficeCLI has optional install, updater, and resident-server facilities. Misen
uses none of them: the fixed executable is bundled, `OFFICECLI_SKIP_UPDATE=1`
and `OFFICECLI_NO_AUTO_RESIDENT=1` are set on every invocation, and document
operations need no network access. Independent invocations and separate private
temp directories allow concurrent Misen requests without shared workbook state.

## Verified command and capability surface

The selected release exposes `create`, `get`, `query`, `set`, `add`, `remove`,
`move`, `swap`, `batch`, `dump`, `import`, `merge`, `validate`, `view`, and `raw`.
Commands return JSON envelopes on stdout and diagnostics on stderr; nonzero exit
codes are failures. Successful warnings remain bounded diagnostics. Large batch
results spill to a JSON file; Misen redirects that spill into its private temp
directory, checks its name and declared/actual size, parses it once, and deletes
it with the workbook. Actual negative controls returned `corrupt_file` for a
malformed workbook, `invalid_value` for an invalid range, and
`atomicRolledBack: true` for a failed atomic batch.

Excel supports workbook and sheet creation/removal, bounded ranges, typed scalar
values, dates and number formats, formulas with cached/computed values, styles,
row heights, column widths, merged cells, and existing-workbook mutation.
Formula CLI writes omit the leading `=`; Misen preserves the model-facing
`{ formula: "=..." }` contract. An explicit string beginning with `=` remains a
literal. External workbook relationships, URLs, and formulas outside Misen's
allowlist remain rejected.

OfficeCLI also supports Word and PowerPoint operations, validation, HTML/PNG
rendering, MCP, and skills. The follow-up Word/PowerPoint vertical slice uses
the same pinned executable through six typed Tools; MCP, raw shell, and generic
DOM mutation remain unexposed.

Actual files confirmed Japanese sheet/file names, paths containing spaces,
formula read/write and cached values, style preservation, row height, column
width, merged cells, sheet add/remove, new-workbook creation, existing-workbook
mutation, and reopen/validation. ZIP/OpenXML and Excel Desktop provide separate
compatibility checks. The CLI uses exit 0 plus `success:true` for success and a
nonzero exit plus structured error codes for failure; malformed stdout, missing
data, unexpected summary counts, excessive output, timeout, cancellation, and a
missing executable are distinct Misen errors.

## Misen boundary

```text
Finance Skill -> Pi Agent -> typed spreadsheet Tool -> OfficeCLI process -> Excel
```

The five Excel-era Agent-facing Tool names and schemas remain stable. Six typed
Word/PowerPoint Tools are added, for eleven total. No raw shell Tool is added.
The adapter uses direct argument arrays, UTF-8, separate bounded
stdout/stderr, timeout, cancellation, forced termination, strict JSON envelopes,
one batch per multi-cell update, private temporary paths, and cleanup. Create
and update operate on a private copy, validate it, recheck the OpenXML boundary,
then use the existing atomic publish primitive. Source files and pre-existing
outputs remain unchanged on failure.

Production mutation and readback use OfficeCLI. Acceptance independently opens
the bounded ZIP/OpenXML package and inspects workbook/sheet relationships,
formulas, style IDs, row/column metadata, merges, and external relationships.
This preserves Decision 441's eight axes and supplies negative controls for
same-engine blind spots without building a second spreadsheet engine. July and
August fixture bytes and all business inputs are unchanged.

Japanese and space-containing paths are passed as direct process arguments.
Each request uses private temporary files. Concurrent requests use separate
processes because resident behavior is disabled. Large output is bounded and
rejected rather than truncated; updates never spawn one process per cell.

## Measured migration cost

On the implementation Windows host, the former in-process engine baseline was
read 4.91 ms (n=10), create 10.62 ms (n=5), and update 8.94 ms (n=10). The final
OfficeCLI adapter measured read 738.62 ms, create 706.50 ms, and update 744.51 ms
with the same sample counts. Each production Tool now uses one OfficeCLI process;
the initial multi-process adapter measured roughly 1.35-1.43 seconds and was not
retained. July and August mechanical flows took 13.456 and 13.205 seconds,
respectively; the combined build-and-flow command took 33.084 seconds versus the
6.610-second pre-migration baseline. No resident daemon or cache was added: live
Brain latency remains larger, and the simpler isolated process contract was kept.
