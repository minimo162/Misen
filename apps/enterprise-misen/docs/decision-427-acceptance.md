# Decision 427 acceptance record

Tested on Windows x64 with Node.js `24.18.1` and npm `11.16.0`. All results
below use synthetic workbooks and a deterministic test-only Brain adapter over
DSH's public `LlmAdapter` seam. They do not claim a live GPT-5.6 Luna run or
corporate deployment approval.

## Phase results

| Phase | Result | Evidence |
| --- | --- | --- |
| A — minimal DSH composition | PASS | Public Cordis/DSH services start; Session and standard Agent Loop complete Tool call → result → next request → final response; provider/model adapter is replaceable; forbidden services are absent. |
| B — commodity Spreadsheet engine | PASS | `@office-kit/xlsx@0.9.0` opens, reads, batch-writes, saves, and reopens both synthetic templates and an independently generated EPPlus workbook while preserving checked values/styles/dimensions and input hashes. |
| C — File + Spreadsheet capability integration | PASS | Exact five-tool roster; non-recursive listing; workspace-relative reads; symlink/traversal/absolute/hardlink denial; safe local formula subset applied to model-authored and carried formulas; output-only `.xlsx` writes. |
| D — two-month mechanical vertical slice | PASS (mechanical only) | A scripted test adapter drives the real DSH Agent Loop and production Tools to create independently checked July and August deliverables without production month/company hard-coding or input mutation. Live-model planning/generalization is **NOT RUN**. |
| E — independent deterministic acceptance | PASS (local scope) | 15/15 tests pass; hashes, formulas, values, styles, roster, dependency graph, source boundary, and workspace boundary are checked outside model-facing Tools. One external PID/TCP observation is recorded separately below. |

## Capability roster

- `workspace_list_files`
- `workspace_read_text`
- `spreadsheet_read`
- `spreadsheet_create_output`
- `spreadsheet_update`

No bash, shell, PowerShell, Python, Web, MCP, generic subagent, background job,
runtime Skill discovery, generic plugin discovery, or arbitrary host filesystem
capability is mounted model-facing.

## Deterministic gates

```text
npm ci                                      PASS
npm ls --all                                PASS
npm run test                                PASS (15/15, 0 skipped)
npm run acceptance                          PASS (2 months)
npm audit --omit=dev --package-lock-only    PASS (0 vulnerabilities)
git diff --check                            PASS
```

The successful acceptance run recorded:

| Dataset | Total elapsed | Spreadsheet local time | LLM requests | Tool calls | Model-visible input | Tool results | RSS sample | Output size |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| July | 138.28 ms | 87 ms | 10 | 9 | 49,027 bytes | 22,296 bytes | 103,628,800 bytes | 3,216 bytes |
| August | 96.89 ms | 66 ms | 10 | 9 | 49,036 bytes | 22,301 bytes | 97,406,976 bytes | 3,211 bytes |

These are local deterministic replay measurements, not SLA claims. Token counts
were not available and are not inferred from byte counts.

## Process and network observation

An external PowerShell acceptance launched the compiled Phase D test directly
in one Node process, scoped observation to that root PID and descendants, and
kept the process alive for observation after the real flow completed. It
recorded root PID `23984`, exit code `0`, 11 samples, and zero TCP connections.
The only observed descendant was the Windows console host (`conhost.exe`, PID
`26400`) created by the external hidden-window test launcher; the Agent path
created no child process. The exact external harness and captured rows are
retained in
[`acceptance/observe-process-network.ps1`](../acceptance/observe-process-network.ps1)
and [`evidence/process-network-observation.json`](../evidence/process-network-observation.json).
This measured run is evidence, not an automatically executed repository gate.
Production source imports no child-process/network
executor API, and no model-facing Tool invokes a process. A future configured
LLM endpoint remains the expected runtime network destination.

The observation can be repeated without adding runtime code: use
`node --input-type=module --eval` to import the compiled Phase D test and retain
that same process briefly after completion; launch it with PowerShell
`Start-Process -WindowStyle Hidden -PassThru`; repeatedly collect descendants
from `Get-CimInstance Win32_Process` and sockets from
`Get-NetTCPConnection -OwningProcess`; then record exit code, samples, child
processes, and endpoints. This inspection is external Acceptance, not an Agent
capability or launcher dependency.

## Supply chain

- Exact DSH line: every resolved `@deepseek-ai/dsh-*` package is
  `0.1.2-alpha.2`; Cordis is `4.0.2`.
- Spreadsheet engine: `@office-kit/xlsx@0.9.0`.
- Clean development install: 39 package manifests; no dependency install hooks, gyp/native
  declaration, `.node`, `.dll`, or `.exe` files.
- Installed development graph measurement: 1,844 files / 41,221,651 bytes.
- Lockfile SHA-256:
  `C046EE6649D376B4BD8458AF7CAD52864C1165A3B117B1698D86D4078B3EC95D`.
- CycloneDX SBOM SHA-256:
  `42FDD9A9E884C6DE852A413B9B82B6C8A565BBA9BBFE1D6BF051E5662FB01271`
  (35 production libraries; exact match to all non-dev lock packages).
- Process/network observation SHA-256:
  `E9A444FE2A132ACE1F5166AAA11EA7FF4C480D9B795D6AB1639149D8C9FC500E`.

## Not run / known limitations

- Live GPT-5.6 Luna credential execution: **NOT RUN**.
- DSH public UI composition implementation and rendered-browser validation:
  **NOT RUN**. Public UI package seams were inspected only.
- Corporate EDR/proxy/device deployment: **NOT RUN**.
- Windows Node exposes no `O_NOFOLLOW`. Model-facing reads therefore use a
  validated handle plus post-read file-identity check, and writes use a private
  temporary file plus atomic rename. A malicious separate local process with
  the same OS identity that deliberately races those checks remains outside
  this model-capability PoC threat boundary and requires corporate-device
  validation; the model has no Tool that can create links or processes.
- Formula recalculation, `.xlsm`, VBA, Pivot refresh, chart repair, Excel COM,
  LibreOffice, and visual spreadsheet inspection are outside this initial slice.
