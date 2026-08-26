# Flex mode validation (2026-08-26)

Scope: preparation PC, local workspace fixtures, real M365 Copilot Edge session, and the checked-in local converter. This does not claim company-PC EDR or tenant validation.

## Final status

| Task | Deterministic host corpus | Local converter corpus | Real Copilot evidence | Status for kickoff |
|---|---:|---:|---|---|
| List | 3/3 | 3/3 | folder list 26.6 s; root-direct list 40.5 s | Stable |
| Read | 4/4 | 4/4 | txt 32.5 s; CSV 30.6 s; xlsx 43.4 s; missing file 18.5 s | Stable |
| Open | 3/3 | 3/3 | CSV default-app launch 43.6 s | Stable |
| Write | 3/3 | 3/3 | one-line file 35.5 s; two-line file 33.0 s; both read back exactly | Stable |
| Search | 3/3 | 3/3 | two different terms, 30.6 s and 31.4 s | Stable |

The deterministic corpus varied workspace root, `reports`, `rates`, `tools`, an empty directory, and a mixed Japanese-name directory containing txt, CSV, xlsx, and Markdown. The converter corpus used different strict JSON, flattened JSON, labeled text, and plain Japanese forms. The final post-review Q4_K_M run passed 16/16; strict JSON used the schema-validated fast path in 0–1 ms. A separate eight-case negative gate, including explanatory mentions of tool names and an unknown tool, produced zero false-positive tool calls. The adoption run measured at most 3.710 s for a positive and 12.539 s for a negative. The final rerun under a more heavily loaded CPU still passed 16/16 and 0/8 false positives, but the maxima rose to 11.808 s and 21.920 s respectively; converter latency is therefore workload-sensitive.

The first-choice Qwen3.5-0.8B Q4 model scored 2/16 after removing a harness false negative. It invented commands and paths, so it was rejected. Qwen3.5-4B Q4_0 then established a 16/16 baseline. Per the final packaging decision, the trusted Unsloth Q4_K_M file was hash-verified and rerun against the same 16 positives plus eight negative cases; it retained 16/16 and zero false positives, so Q4_K_M replaced Q4_0 in the package.

## Defects found by the real path and fixed

- Edge Lexical inserted U+200B/U+200C caret markers at text chunk boundaries. DOM comparison now removes only those implementation markers and logs the first real mismatch with nearby code points.
- Windows PowerShell 5.1 xlsx output used a non-UTF-8 console encoding. The wrapper now forces UTF-8, and smoke asserts the Japanese sheet names `連結台帳` and `確認事項`.
- Copilot used `start` and `open` for document launch. The command gate accepts these only as a single existing workspace file and rewrites them to `Invoke-Item -LiteralPath`; metacharacters and workspace escape remain rejected.
- The final safety review found that safe mode still advertised the network-backed weather tool and accepted executable/link targets for `Invoke-Item`. Safe mode now removes weather from the prompt, converter schema, and OpenAI tool contract and rejects it again at execution; document opens require an allowlisted regular non-link file and reject scripts, executables, shortcuts, URL files, directories, and reparse points.
- A successful GUI launch produced no stdout, which caused a retry loop. A zero-exit `Invoke-Item` now returns an explicit application-launch success result.
- “ここ直下” was initially answered from the recursive bootstrap list. `list_files` now supports `recursive:false`, while the existing bootstrap remains recursive.

## Segment timing and YakuLingo comparison

`npm run flex:measure:copilot` creates a disposable mixed fixture and runs five fresh-session requests (list, read, search, new-file write, and document open). Every `model.decision` records connection, UI session creation, input readiness, model selection, prompt write, send, generation wait, completion retrieval, and local converter time; host events already record tool execution time. API session creation and whole-task elapsed time are measured by the driver.

| Build / single change | Real Copilot pass | End-to-end range | Relevant result |
|---|---:|---:|---|
| Instrumented baseline | 5/5 | 31.298–35.775 s | Converter 65.207 s and generation wait 56.574 s were dominant across the set; clipboard response retrieval cost 14.570 s. |
| YakuLingo-style stable DOM response retrieval | 5/5 | 19.952–36.299 s | Retrieval fell from 14.570 s to 0.001 s across the set; adopted. Strict completion still requires no Stop control, enabled Copy, and unchanged text for at least one second. |
| Whole `Input.insertText` prompt write | 0/2, then 0/1 after focus repair | not adopted | Edge showed the text in the DOM but the React send state remained disabled or opened the blank-message confirmation. The existing verified clipboard path with chunk fallback remains. |
| Deterministic post-tool answer shortcut | 5/5 | 26.999–38.034 s | Did not match the real response forms and did not improve time; reverted rather than widening language heuristics by guesswork. |

The accepted run's phase totals were: converter 64.273 s, Copilot generation wait 62.246 s, prompt write 14.950 s, UI session creation 7.856 s, connection 1.179 s, send 0.563 s, input ready 0.095 s, and completion retrieval 0.001 s. Converter and service generation remain the limiting intervals. YakuLingo's full-input insertion is not transferable to this Edge surface without losing completion, while its direct DOM response retrieval is transferable after this agent's stronger completion gate. YakuLingo's request-scoped domain marker was not copied because generic replies do not have an equivalent reliable marker.

## Operating boundary

Accept only one- or two-step list, read, open, new-file write, and cross-file search requests during the kickoff. Keep deletion, overwrite of an existing file, network access, registry changes, and multi-stage business workflows out of scope. Product `config.flex.json` keeps write and application launch approval enabled; the automated evidence used a temporary fixture-only configuration.

## Demo view QA

`FLEX-UI-QA.png` is a 1440 x 900 rendered-browser capture using representative list/read/write events. The visible-text gate found none of `run-demo`, `checkpoint`, `0x`, `tool.succeeded`, `host.`, or `[error]`. The DOM order was user request, collapsed Japanese activity line, then final answer. The artifact link and collapsed past-run group were visible. Switching to the diagnostic view restored change diff, verification evidence, and diagnostic JSON controls.
