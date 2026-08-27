# Ollama + Ornith validation (Issue #41)

Measured on 2026-08-27 with Ollama 0.33.1, `ornith-1.5:9b` Q4_K_M, the
existing v2 loop, and a preparation PC with 31.52 GiB physical RAM. This is
not a 16 GiB company-PC measurement.

## Five-task result at 4K

The canonical model loaded with context 4096 and completed all five fresh-session
tasks. Times are end-to-end and include every model/tool round.

| Task | Result | Time | Model decisions | Tool calls | Approval | Audit records |
| --- | --- | ---: | ---: | --- | ---: | ---: |
| list | PASS | 65.611 s | 2 | `list_files` | 0 | 1 |
| read | PASS | 56.832 s | 2 | `read_file` | 0 | 1 |
| open | PASS | 139.298 s | 4 | `list_files`, `start_process`, `read_process_log` | 1 | 3 |
| write | PASS | 87.606 s | 2 | `write_file` | 1 | 1 |
| search | PASS | 102.048 s | 3 | `search_files` x2 | 0 | 2 |

All five had zero retries, tool failures, or warnings. Japanese paths, search
terms, written content, final replies, and audit correlation contained neither
U+FFFD replacement characters nor `<think>` leakage. The open and write
approvals were resolved only after exact workspace, tool, path/command, and
new-file binding checks.

## Context decision

The 4K model completed the five short tasks, but the Japanese long-tool-result
case stopped after `read_file` (2 model decisions, 1 tool call) without
selecting the required second `search_files` round. The finalized numbered
tool result is 12,805 UTF-8 bytes and 5,195 JavaScript characters.

An Ollama-derived alias with `PARAMETER num_ctx 8192` completed the unchanged
long case in 188.698 s with 3 model decisions and 2 tool calls
(`read_file` then `search_files`). Context 8192 is therefore the selected
configuration. Context 16384 was not run because 8192 met the acceptance case;
increasing it would add memory pressure without evidence of need.

The final live gate repeated the 8K case with a stricter, tool-specific prompt
and passed in 221.112 s with the same 3 decisions and 2-tool sequence. An
intermediate run proposed an unrelated `write_file`; the exact approval worker
rejected it and the gate failed closed. No model retry was hidden or counted as
a pass.

After the fix-first review, the harness repeated the 8K case with exact model
identity matching and passed in 256.769 s with 3 decisions, 2 tool calls, and
zero retries, failures, warnings, approvals, UTF-8 replacement, or `<think>`
leakage.

Before loading the 8K alias, available physical memory was 13.70 GiB. After the
long run it was 6.98 GiB (6.72 GiB decrease). `llama-server` showed 6.861 GiB
working set and 8.095 GiB private bytes; Ollama `/api/ps` reported
6,418,564,381 bytes, CPU execution, and context 8192. A point-in-time
`Memory\\Pages/sec` sample was 0.0. These preparation-PC values must not be
treated as 16 GiB company-PC results.

## Reasoning and safety

Reasoning remains enabled by omission. With default reasoning, the 8K long
case passed. The same case with `reasoning_effort=none` returned no tool call
(1 model decision) and failed, so the product does not suppress thinking by
default. In these measured live runs, raw reasoning was not emitted in
AgentEvent, UI output, or final text; this is not a general sanitization claim.

The live runs used the unchanged safety sequence: argument validation, before
hooks, declarative permission, server-authenticated approval, precondition
recheck, `ToolDef.run`, hard guards, and append-only audit. A separate 8K open
attempt selected an unnecessary second command after the approved open; the
existing command budget stopped it with a warning. This is retained as one
model-variability retry/fail-close observation, not bypassed.

## Deterministic gates

- typecheck: PASS (2396 ms)
- build: PASS (474 ms)
- smoke: PASS (41742 ms), including Ollama no-key/auth, UTF-8, malformed UTF-8
  fail-close, reasoning wire field, and multiple-tool-call zero-execution
- flex-validate: PASS (905 ms)
- live-ollama 8K long case: PASS (221504 ms stage time)
- normal live stages: explicit SKIP unless requested
- `npm audit --omit=dev`: 0 vulnerabilities

The live JSON evidence is generated under `apps/coding-agent/.tmp` and is not
tracked because it contains machine-specific absolute paths.
