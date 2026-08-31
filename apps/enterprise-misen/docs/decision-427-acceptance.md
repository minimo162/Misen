# Decision 427 acceptance record

This record is for the Enterprise Misen Home Technical PoC. It uses synthetic
workbooks only and does not claim enterprise adoption, security approval, or a
production Brain decision.

Acceptance candidate provenance:

- Starting PR #71 code commit: `d014308cb440166fb7ccff59e6e72af7ee87fb7b`.
- Final tested implementation commit: recorded in the PR #71 and Issue #70
  checkpoint after the verified tree is committed; the record-only commit that
  may follow is not recursively embedded here.
- Branch at final rerun: `issue-70-enterprise-poc`.
- Windows candidate runtime: Node.js `24.18.1`, npm `11.16.0`; exact observed
  versions are recorded rather than used as an unrelated compatibility claim.
- Live model/provider boundary: DSH public `dsh-llm-pi-ai@0.1.2-alpha.2` on the
  `openai` route, hand-declared model `gpt-5.6-luna`; only the environment
  reference `OPENAI_API_KEY` is configured. The key value is request-scoped and
  is not logged, persisted, committed, or exposed to a Tool.

## Phase results

| Phase | Result | Evidence |
| --- | --- | --- |
| A — minimal DSH composition | PASS | Public Cordis/DSH services start; Session and standard Agent Loop complete Tool call → result → next request → final response; provider/model adapter is replaceable; forbidden services are absent. |
| B — commodity Spreadsheet engine | PASS | `@office-kit/xlsx@0.9.0` opens, reads, batch-writes, saves, and reopens both synthetic templates and an independently generated EPPlus workbook while preserving checked values/styles/dimensions and input hashes. |
| C — File + Spreadsheet capability integration | PASS | Exact five-tool roster; non-recursive listing; workspace-relative reads; symlink/traversal/absolute/hardlink denial; safe local formula subset applied to model-authored and carried formulas; output-only `.xlsx` writes. |
| D — two-month mechanical vertical slice | PASS (mechanical only) | A scripted test adapter drives the real DSH Agent Loop and production Tools to create independently checked July and August deliverables without production month/company hard-coding or input mutation. Live-model July ran separately and failed independent `MONTH` validation; August was not run. |
| E — independent deterministic acceptance | PASS (deterministic); live FAIL | Decision 430 pre-live regression: 46 tests: 45 PASS, 0 FAIL, 1 host-permission SKIP. Decision 429's bounded July run remains historical `FAIL — ROWS`; the one Decision 430 diagnosis rerun passed current `ROWS`, so the result is classified as run-to-run variance rather than remediation. August was not run. |

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

The starting-candidate gate output is historical evidence only. The post-repair
commands below were rerun on the final implementation tree:

```text
npm ci --ignore-scripts                     PASS (133 packages installed)
npm ls --all                                PASS (only declared optional peers absent)
npm run test                                PASS (41 pass, 0 fail, 1 skip / 42)
npm run acceptance                          PASS (1 pass, 0 fail)
npm run sbom                                PASS (131 unique production versions / 132 locations)
npm audit --omit=dev --package-lock-only    PASS (0 vulnerabilities)
git diff --check                            PASS
```

Final-head metrics:

| Dataset | Total elapsed | Spreadsheet local time | LLM requests | Tool calls | Model-visible input | Tool results | RSS sample | Output size |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| July | 129.935 ms | 76 ms | 10 | 9 | 49,027 B | 22,296 B | 120,410,112 B | 3,216 B |
| August | 74.738 ms | 50 ms | 10 | 9 | 49,036 B | 22,301 B | 140,144,640 B | 3,211 B |

These are local deterministic replay measurements, not SLA claims. Token counts
and cost are recorded only when the provider exposes them; byte counts are not
used as token or cost estimates. The previous starting-candidate measurements
remain historical and are not final-head evidence.

## Live Brain status

The first configured GPT-5.6 Luna attempt is independent live evidence, not a
replay result. July produced one output workbook, but independent validation
classified it `FAIL — MONTH` because the report month did not match the July
dataset. No August live request was started after that first failure, so August
is `NOT RUN`. This failure does not claim an upstream DSH/Ollama defect, and no
live retry or fallback Brain is authorized by this record.

The exact minimal prompt is preserved for any future credential-gated rerun:
`7月の3社実績を取りまとめて、月次管理レポートを完成させて` (with only the
month label changed for August). The two earlier July `PI_AI_ERROR` diagnostics
were caused by localized session ids reaching the provider's HTTP header. The
harness now uses an ASCII-only deterministic correlation id and retains the
localized label only in the user prompt.

### Decision 428 diagnosis-only rerun

One July rerun was performed with the same standard DSH OpenAI Responses route,
exact `gpt-5.6-luna` model, `off` reasoning setting, persona, handoff, exact
prompt, five Tool contracts, fixtures, template, and independent Acceptance.
It again returned `FAIL — MONTH`; no retry, fallback, prompt hint, remediation,
or August request followed.

The generated workbook contained `Report!A2 = "Month"` and
`Report!B2 = "2024年7月"`, while Acceptance requires the synthetic literal
`"7月"`. The Tool sequence contained 20 calls. At sequence 16 the Brain called
`spreadsheet_update` for workbook `output/7月_月次管理レポート.xlsx`, sheet
`Report`, range `B2:B2`, with values `[["2024年7月"]]`. The call succeeded: all
20 calls had results, no Tool error was recorded, and the independently reopened
workbook contained that exact value. The first observer rendering labeled the
result `missing-result` because it looked for the DSH call id on the message
rather than on `message.source.callId`; this observer-only correlation defect
was corrected and covered by a deterministic DSH event-shape test without a
second live run.

Read-only output diagnosis was:

```text
SHEET             PASS
MONTH             FAIL
ROWS              PASS
PROFIT_FORMULAS   PASS
STATUS            PASS
TOTAL             PASS
FOOTER            PASS
FORMAT            PASS
```

Inputs were unchanged, the forbidden Tool roster was empty, no reasoning block
was recorded, no LLM retry occurred, and the turn completed normally. The
evidence-supported root cause is **CLASS B — representation mismatch**: the
Brain targeted the correct month cell and wrote a value that denotes July, but
used `2024年7月` rather than the exact Acceptance representation `7月`.
Production behavior was not changed; diagnostic code reads only synthetic Tool
events and the completed workbook. The API key and raw reasoning/provider
payload were neither collected nor retained.

### Decision 429 semantic-period correction and bounded continuation

Decision 429 corrected only the independent `MONTH` checker. The previous two
July runs remain historical `FAIL — MONTH` results under the old exact-string
Acceptance; they are not retroactively reclassified. The defect was that the
business specification required the reporting period's meaning but did not
require the hidden literal representation `7月`.

The current checker derives one concrete `{ year, month }` from all three source
workbooks' `Actuals!B4` as-of dates. Missing, invalid, or inconsistent source
periods fail the Acceptance-fixture stage. Output accepts only `M月` and
`YYYY年M月`; the latter must match both year and month. Wrong month/year, empty,
unparseable, English, ISO, slash, and numeric-only forms fail. No substring
matching is used.

After clean deterministic gates and fresh review passed, one July live run was
performed with the unchanged exact GPT-5.6 Luna route, prompt, persona, handoff,
fixtures, Tool contracts, and capability behavior. It produced one workbook
with `Report!B2 = "7月"`, so semantic `MONTH` passed. Independent validation then
stopped at **`FAIL — ROW`**. Read-only output diagnosis was:

```text
SHEET             PASS
MONTH             PASS
ROWS              FAIL
PROFIT_FORMULAS   PASS
STATUS            PASS
TOTAL             PASS
FOOTER            PASS
FORMAT            PASS
```

The July turn completed with 16 LLM requests, 20 Tool calls, 20 Tool results,
39,620.379 ms elapsed, 2,886 input tokens, 2,402 output tokens, 7,804 cache-write
tokens, 69,706 cache-read tokens, 82,798 provider total tokens, 105,357,312 B RSS,
and a 3,217-byte output. The provider did not expose a reasoning-token value;
no reasoning content block was recorded. API cost was not calculated because no
authoritative per-model price was established in this gate. Inputs were
unchanged, the exact five-Tool request roster was retained, no forbidden Tool
appeared, no retry occurred, and no fallback or prompt hint was used.

Per the first-failure rule, August is `NOT RUN` and the current
**Live Brain Gate is FAIL**. No additional live run or business failure repair
was performed.

### Decision 430 ROWS diagnosis-only rerun

The Decision 429 record above remains historical evidence: that July run failed
the unchanged fixed-order `ROWS` validator, and its actual row range was not
retained. Existing safe evidence was therefore insufficient to distinguish a
company/value error from a row-order-only mismatch. Decision 430 added only an
Acceptance observer and tests. Production behavior, the fixed-order `ROWS`
validator, model/provider/reasoning, persona, prompt, handoff, fixtures, and the
five Tool contracts were unchanged.

One authorized July diagnosis rerun used the exact prompt
`7月の3社実績を取りまとめて、月次管理レポートを完成させて`. The independently reopened
output contained:

```text
Report!A5:C7 actual:
Alpha / 1200 / 700
Beta  / 950  / 500
Gamma / 1100 / 650

Source-workbook triples:
Alpha / 1200 / 700
Beta  / 950  / 500
Gamma / 1100 / 650
```

The strict set comparison passed, and the current fixed-order `ROWS` validation
also passed. The overlapping update sequence was: sequence 19 attempted
`Report!A5:E8` with the correct three company/value associations but formula
objects and received a Tool validation error; sequence 20 repeated the same
range and values with formula strings and succeeded. This was an Agent Tool
correction inside the single turn, not another live run or provider retry.

Read-only output diagnosis was:

```text
SHEET             PASS
MONTH             PASS
ROWS              PASS
PROFIT_FORMULAS   PASS
STATUS            PASS
TOTAL             PASS
FOOTER            PASS
FORMAT            PASS
```

The single turn completed with 13 LLM requests, 22 Tool calls and 22 Tool
results in 33,960.775 ms. Provider usage reported 3,100 input tokens, 2,120
output tokens, 6,204 cache-write tokens, 37,100 cache-read tokens, and 48,524
total tokens. RSS was 106,536,960 B and the output was 3,227 B. Inputs were
unchanged, no forbidden Tool or reasoning block appeared, and provider retry
count was zero. API cost was not calculated.

Because the previous failing run's `A5:C7` values cannot be reconstructed and
this diagnosis rerun passed the unchanged criterion, the Decision 430 result is
**run-to-run variance / nondeterministic live behavior**. It does not resolve or
retroactively reclassify the earlier failure. No second rerun, Acceptance
change, prompt hint, fallback, August run, or remediation followed. The API key
and raw reasoning/provider payload were not collected or retained.

## Process and network observation

An external PowerShell acceptance launched the compiled Phase D test directly
in one Node process, scoped observation to that root PID and descendants, and
kept the process alive for observation after the real flow completed. It
recorded root PID `23984`, exit code `0`, 11 samples, and zero TCP connections.
The only observed descendant was the Windows console host (`conhost.exe`, PID
`26400`) created by the external `Start-Process` hidden-window test launcher;
the Agent path created no child process. The exact external harness and captured rows are
retained in
[`acceptance/observe-process-network.ps1`](../acceptance/observe-process-network.ps1)
and [`evidence/process-network-observation.json`](../evidence/process-network-observation.json).
This measured run is evidence, not an automatically executed repository gate.
Production source imports no child-process/network
executor API, and no model-facing Tool invokes a process. In the attempted
live July run the expected OpenAI destination was observed as
`172.66.0.243:443`; this is endpoint evidence only, not a fixed-IP guarantee.
The provider observation must remain PID-scoped to the Misen/DSH process tree;
unrelated browser, EDR, Zscaler, or Ollama traffic is not attributed to Misen.

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
- Standard live provider seam: `@deepseek-ai/dsh-llm-pi-ai@0.1.2-alpha.2`;
  its resolved pi-ai package is `@earendil-works/pi-ai@0.84.4`. Live composition
  does not mount retry. `@deepseek-ai/dsh-llm-retry@0.1.2-alpha.2` is exercised
  only by the deterministic transient-provider recovery test.
- Spreadsheet engine: `@office-kit/xlsx@0.9.0`.
- Clean development install uses `npm ci --ignore-scripts`. The exact installed
  graph has 133 package locations and 131 unique production package versions.
  It has two declared but disabled install hooks: `@google/genai@1.52.0` preinstall
  `echo 'preinstall: no-op'` and `protobufjs@7.6.6` postinstall
  `node scripts/postinstall`. No package declares gyp/native metadata, and the
  installed graph contains no `.node`, `.dll`, or `.exe` files.
- Installed development graph measurement: 11,936 files / 97,242,705 bytes.
- Lockfile SHA-256: `ef961cc8d790f1ce9425c5128c8632099ee9e7781b8477fe7d3afcc34c779208`.
- CycloneDX SBOM SHA-256: `5510490db476cf21a8948c706c7d45cb08aeacc015943ad23c4c6016b654c288`
  (the generator derives the production component set from the exact lockfile).
- Retained deterministic Phase D PID/network observation SHA-256:
  `e9a444fe2a132ace1f5166aaa11ea7ff4c480d9b795d6ab1639149d8c9fc500e`.
  Live July PID/TCP evidence was held outside the repository: the root had only
  launcher-created `conhost.exe` as a descendant, and the only observed TCP
  destination was the expected OpenAI HTTPS endpoint `172.66.0.243:443`; no raw
  live log is committed.

The Office Kit guard rejects external URL/file hyperlinks, external workbook
references, external-link/query-table/connection passthrough parts, and their
relationship extras before publishing or mutating an output; location-only
links inside the workbook remain accepted. Overwrite uses a private sibling
temporary plus direct same-directory replacement, so ordinary rename failure
preserves the last-known-good destination and cleans the temporary. This is not
a power-loss-durable transaction: directory fsync, open-handle/ACL races, and
filesystem failure remain residual risks.

TypeScript keeps source checking strict. `tsconfig.json` sets
`skipLibCheck: true` only to avoid unrelated declaration-resolution failures in
upstream transitive `@anthropic-ai`/`@google` SDK packages; no SDK shim or
source-level type relaxation is added.

## Not run / known limitations

- Live GPT-5.6 Luna execution: Decision 429 July remains **FAIL — ROWS** after
  semantic `MONTH` passed. The one Decision 430 diagnosis rerun passed the
  unchanged `ROWS` criterion and is classified as run-to-run variance, not a
  repair or reliability PASS. August is **NOT RUN**. The two earlier July
  `FAIL — MONTH` runs remain historical old-Acceptance evidence. No API key,
  raw live log, or generated live artifact is committed or retained.
- DSH public UI composition implementation and rendered-browser validation:
  **NOT RUN**. Public UI package seams were inspected only.
- Corporate EDR/proxy/device deployment: **NOT RUN**.
- Windows Node exposes no `O_NOFOLLOW`. Model-facing reads therefore use a
  validated handle plus post-read file-identity check, and writes use a private
  temporary file plus atomic rename. A malicious separate local process with
  the same OS identity that deliberately races those checks remains outside
  this model-capability PoC threat boundary and requires corporate-device
  validation; the model has no Tool that can create links or processes.
- The replacement regression validated the hardlink path, but Windows denied
  creation of the symlink fixture with `EPERM`; that symlink subcase is the one
  deterministic test SKIP and remains device-policy acceptance work rather
  than a claimed PASS.
- Formula recalculation, `.xlsm`, VBA, Pivot refresh, chart repair, Excel COM,
  LibreOffice, and visual spreadsheet inspection are outside this initial slice.
