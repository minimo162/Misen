# Flex mode validation (2026-08-27)

Scope: preparation PC, local workspace fixtures, real M365 Copilot Edge session, and the checked-in local converter. This does not claim company-PC EDR or tenant validation.

## Final status

| Task | Deterministic host corpus | Local converter corpus | Real Copilot evidence | Status for kickoff |
|---|---:|---:|---|---|
| List | 3/3 | 3/3 | final layer-1-only fresh session 19.677 s | Stable |
| Read | 4/4 | 4/4 | final layer-1-only txt read 17.358 s | Stable |
| Open | 3/3 | 3/3 | final layer-1-only CSV default-app launch 15.551 s | Stable |
| Write | 3/3 | 3/3 | final layer-1-only new file 14.929 s; content read back exactly | Stable |
| Search | 3/3 | 3/3 | final layer-1-only cross-file search 16.411 s | Stable |

The deterministic corpus varied workspace root, `reports`, `rates`, `tools`, an empty directory, and a mixed Japanese-name directory containing txt, CSV, xlsx, and Markdown. Layer 1 used strict JSON, flattened JSON, labeled text, and malformed JSON forms and passed 16/16. Its expanded fifteen-case negative gate, including explanatory mentions of tool names, an unknown tool, example-only JSON, an unescaped Windows-path example, Japanese/English negated JSON, unavailable-operation sentences, and a tool-description sentence, produced zero false-positive tool calls. Thirty jsonrepair-inspired categories passed 30/30 while schema-invalid values remained rejected. The optional Q4_K_M converter separately retained its prior 16/16 positive and 0/8 false-positive adoption gate. Its measured maxima varied from 3.710/12.539 seconds to 11.808/21.920 seconds under load, which is one reason it is insurance rather than the kickoff default.

The first-choice Qwen3.5-0.8B Q4 model scored 2/16 after removing a harness false negative. It invented commands and paths, so it was rejected. Qwen3.5-4B Q4_0 then established a 16/16 baseline. Per the final packaging decision, the trusted Unsloth Q4_K_M file was hash-verified and rerun against the same 16 positives plus eight negative cases; it retained 16/16 and zero false positives, so Q4_K_M replaced Q4_0 in the package.

## Defects found by the real path and fixed

- Edge Lexical inserted U+200B/U+200C caret markers at text chunk boundaries. DOM comparison now removes only those implementation markers and logs the first real mismatch with nearby code points.
- Windows PowerShell 5.1 xlsx output used a non-UTF-8 console encoding. The wrapper now forces UTF-8, and smoke asserts the Japanese sheet names `連結台帳` and `確認事項`.
- Copilot used `start` and `open` for document launch. The command gate accepts these only as a single existing workspace file and rewrites them to `Invoke-Item -LiteralPath`; metacharacters and workspace escape remain rejected.
- The final safety review found that safe mode still advertised the network-backed weather tool and accepted executable/link targets for `Invoke-Item`. Safe mode now removes weather from the prompt, converter schema, and OpenAI tool contract and rejects it again at execution; document opens require an allowlisted regular non-link file and reject scripts, executables, shortcuts, URL files, directories, and reparse points.
- A successful GUI launch produced no stdout, which caused a retry loop. A zero-exit `Invoke-Item` now returns an explicit application-launch success result.
- “ここ直下” was initially answered from the recursive bootstrap list. `list_files` now supports `recursive:false`, while the existing bootstrap remains recursive.
- Whole-prompt `Input.insertText` is now attempted once and verified against the Edge editor. A cold failure gets one direct retry; only then does the established chunk path run. The final five-task run had one cold retry and no truncated input.
- Synthetic send click is no longer assumed successful. The client observes generation, changed response, cleared input, or a disabled/disappeared send control and falls back to a native CDP mouse click at the verified send-button rectangle before failing closed.
- OpenCode exposed an unescaped `\.\日本語名` inside Copilot's JSON command. `jsonrepair` correctly made the JSON parseable but removed that invalid escape, producing a nonexistent `.日本語名`. Layer 1 now preserves invalid JSON backslashes before repair, and the bridge's generic Windows-open guidance uses `Start-Process -FilePath './相対パス'` instead of the nonexistent `-LiteralPath` parameter. The same Japanese file then opened on the first command and produced a new Notepad PID.

## Segment timing and YakuLingo comparison

`npm run flex:measure:copilot` creates a disposable mixed fixture and runs five fresh-session requests (list, read, search, new-file write, and document open). Every `model.decision` records connection, UI session creation, input readiness, model selection, prompt write, send, generation wait, completion retrieval, and local converter time; host events already record tool execution time. API session creation and whole-task elapsed time are measured by the driver.

| Build / single change | Real Copilot pass | End-to-end range | Relevant result |
|---|---:|---:|---|
| Instrumented baseline | 5/5 | 31.298–35.775 s | Converter 65.207 s and generation wait 56.574 s were dominant across the set; clipboard response retrieval cost 14.570 s. |
| YakuLingo-style stable DOM response retrieval | 5/5 | 19.952–36.299 s | Retrieval fell from 14.570 s to 0.001 s across the set; adopted. Strict completion still requires no Stop control, enabled Copy, and unchanged text for at least one second. |
| Initial whole `Input.insertText` experiment | 0/2, then 0/1 after focus repair | not adopted at that point | Edge showed text while React send state remained disabled or opened the blank-message confirmation. This result motivated explicit editor verification and send-establishment checks. |
| Deterministic post-tool answer shortcut | 5/5 | 26.999–38.034 s | Did not match the real response forms and did not improve time; reverted rather than widening language heuristics by guesswork. |
| Verified whole-input insertion, one direct retry, staged send, layer 1 default | 5/5 | 15.283–24.752 s | Adopted. Nine model decisions were layer 1, layer 2 was unused, and failed decisions were zero. |
| Fresh-surface verification and native-send regression fixes | 5/5 | 14.929–19.677 s | Final rerun. Nine decisions were layer 1; layer 2 and failed decisions remained zero. |

The final accepted layer-1-only run's phase totals were: Copilot generation wait 63.012 s, prompt write 9.824 s, UI session creation 4.360 s, connection 1.739 s, send 0.538 s, input ready 0.060 s, completion retrieval 0 s, layer 1 interpretation 0.001 s, and converter 0 s. The cold first prompt used one verified retry and took 7.150 s; the remaining eight prompt writes took 0.323–0.347 s. Service generation is now the limiting interval. YakuLingo's single `Input.insertText` approach became transferable only after adding editor-content verification, one retry, and explicit send establishment; its direct DOM response retrieval remains adopted behind this agent's stronger completion gate. YakuLingo's request-scoped domain marker was not copied because generic replies do not have an equivalent reliable marker.

## Layer activity and OpenCode bridge

The final built-in Flex run made nine model decisions: layer 1 resolved 9, optional layer 2 was needed 0, and both-layer failure was 0. This is the evidence for keeping `localResponseConverter.enabled=false` as the kickoff default. The 4B runtime remains an opt-in insurance path and its 16/16 positive, zero-false-positive corpus gate remains preserved.

The separate OpenAI-compatible bridge reused the same Copilot client and deterministic interpreter. After the Windows relative-path repair, OpenCode 1.18.21 completed a fresh changed-wording set 5/5: list 19.350 s (2 turns), CSV read and absent-field answer 25.941 s (3), search 27.344 s (2), new-file write 19.979 s (2), and CSV default-app open 20.038 s (2). The written content was read back exactly. A targeted Japanese text-file open immediately before this set also succeeded on the first command and produced new Notepad PID 38768. Across the final five tasks, six tool calls and five normal answers were resolved without layer 2, raw-content fallback, or schema rejection. Full setup and the fixed binary SHA-256 are in `README-OPENAI-BRIDGE.md`.

## Operating boundary

Accept only one- or two-step list, read, open, new-file write, and cross-file search requests during the kickoff. Keep deletion, overwrite of an existing file, network access, registry changes, and multi-stage business workflows out of scope. Product `config.flex.json` keeps write and application launch approval enabled; the automated evidence used a temporary fixture-only configuration.

## Demo view QA

`FLEX-UI-QA.png` is a 1440 x 900 rendered-browser capture using representative list/read/write events. The visible-text gate found none of `run-demo`, `checkpoint`, `0x`, `tool.succeeded`, `host.`, or `[error]`. The DOM order was user request, collapsed Japanese activity line, then final answer. The artifact link and collapsed past-run group were visible. Switching to the diagnostic view restored change diff, verification evidence, and diagnostic JSON controls.
