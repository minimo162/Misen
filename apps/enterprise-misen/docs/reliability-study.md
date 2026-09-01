# Issue 73 Thin Misen reliability observer

This observer is test/evidence infrastructure. It does not change the Thin Misen production Agent, prompt, handoff, fixtures, five Tool contracts, lifecycle hooks, validator, model, retry, fallback, dependency versions, or UI.

The original observer was prepared against historical baseline `06804c5eb0c8f9e42322d66b11c2f5ae0153da69`. No formal paid sample was started on that baseline. After PR #78, schema version 2 supersedes that unused setup and freezes production baseline `f3b772f7765206f75f7296e436d89c6a771b690a`. Historical evidence, if any is found, must not be mixed with this baseline.

The future formal sample remains 20 valid runs in July/August alternating order, no more than 24 paid attempts, and a USD 10 provider spend cap. This port performed deterministic validation only: do not create the checkpoint or run `study:live` until Issue #73 records a separate explicit authorization after the observer commit has passed all gates and review. At that later point, the commands are:

```text
npm run study:checkpoint -- --evidence-dir C:\absolute\study-evidence --observer-sha <40-hex-observer-commit> --provider-hard-cap-confirmed true
```

Run exactly one scheduled attempt at a time:

```text
npm run study:live -- --evidence-dir C:\absolute\study-evidence --observer-sha <same-commit> --run 1 --attempt 1
```

Immediately before each paid request, the observer writes an immutable reservation
file. A crash can therefore consume an attempt but cannot silently reuse it; an
unresolved reservation stops all later requests for audit. The observer then
writes one immutable per-attempt JSON file and refreshes `aggregate.json`.
Checkpoint, reservation, and run JSON are validated at runtime and mixed
baseline/configuration/observer evidence is rejected. Evidence is rejected when
its directory is inside the Agent Workspace. A changed observer SHA invalidates
the checkpoint and requires the formal sample to restart at run 1.

Checkpoint creation and every live attempt also bind those declarations to the
actual Git checkout: current `HEAD` must equal the observer SHA, observer paths
must be clean, and the protected production `src`, Acceptance, fixtures, and
lockfile trees must be byte-identical to the frozen production commit.

Before reserving an attempt or sending a provider request, the live runner also
reconstructs and verifies the Thin Misen context binding. It covers the user
prompts, complete fixture manifest, system prompt, root `AGENTS.md`, approved
Skill catalog and selected monthly-report `SKILL.md`, exact Tool contracts, and
static lifecycle-hook names/timeout. OOXML package timestamps are normalized for
this baseline fingerprint; per-run input integrity still uses raw before/after
file hashes. The protected source tree and frozen fixture blob keep the generator
and acceptance oracle bound to the production commit.

Captured public surfaces are Pi `message_end` AssistantMessage
provider/model/usage/stopReason plus Tool execution start/end/isError. Target
strings are one-way hashed and values are reduced to shape counts. Error bodies
are classified but never persisted. Successful Tool result bodies, Assistant
text, raw reasoning, provider payloads, and credentials are never stored. A run
cannot pass without a complete balanced event stream and the frozen observed
provider/model. The Agent/turn lifecycle, at least one Tool call, and the actual
Agent model, thinking level, and exact five-Tool state are also checked.

INVALID attempts persist only one allowlisted reason code: `OBSERVER_CAPTURE_FAILURE`,
`INFRASTRUCTURE_FAILURE`, `CONFIGURATION_DRIFT`, or `INCOMPLETE_EVENT_STREAM`.
Raw exception text may be consumed transiently for control flow but is never stored
as the INVALID reason. Runtime validation rejects arbitrary or mismatched reason
strings so the aggregate can distinguish why an attempt was excluded without
retaining sensitive diagnostic text.

The progressive monthly-report Skill read is recorded as a derived boolean from
the already-hashed `workspace_read_text` target. It does not add a model-facing
Tool, expose Skill contents, modify the static hook chain, or by itself determine
PASS/FAIL. The production roster remains exactly five Tools; call count is a
separate observed behavior metric.

`credentialExposure` and `unexpectedNetwork` remain `null` unless a separate safe observer supplies evidence. Pi derives its public cost field from catalog pricing, so the record labels it a catalog estimate rather than provider billing. If any AssistantMessage request lacks a finite Pi catalog total, the run-level `catalogEstimatedCostUsd` is `null`; a partial subtotal is never presented as a complete estimate. If any persisted run has a `null` catalog estimate, the study aggregate total is also `null`, and `study:live` stops before reserving or sending the next paid attempt so the discrepancy can be audited. The checkpoint therefore requires confirmation of a provider-account USD 10 hard cap; the local estimate ledger is an additional stop control and never substitutes an absent billing control or guessed cost.
