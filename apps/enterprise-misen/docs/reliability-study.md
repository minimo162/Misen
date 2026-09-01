# Issue 73 frozen reliability observer

This observer is test/evidence infrastructure. It does not change the production Agent, prompt, handoff, fixtures, five Tool contracts, validator, model, retry, fallback, dependency versions, or UI.

The formal sample is fixed at production baseline `06804c5eb0c8f9e42322d66b11c2f5ae0153da69`, 20 valid runs in July/August alternating order, no more than 24 paid attempts, and a USD 10 provider spend cap. Create the checkpoint only after the observer commit has passed deterministic gates and independent review:

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

Captured public surfaces are Pi `message_end` AssistantMessage
provider/model/usage/stopReason plus Tool execution start/end/isError. Target
strings are one-way hashed and values are reduced to shape counts. Error bodies
are classified but never persisted. Successful Tool result bodies, Assistant
text, raw reasoning, provider payloads, and credentials are never stored. A run
cannot pass without a complete balanced event stream and the frozen observed
provider/model. The Agent/turn lifecycle, at least one Tool call, and the actual
Agent model, thinking level, and exact five-Tool state are also checked.

`credentialExposure` and `unexpectedNetwork` remain `null` unless a separate safe observer supplies evidence. Pi derives its public cost field from catalog pricing, so the record labels it a catalog estimate rather than provider billing. The checkpoint therefore requires confirmation of a provider-account USD 10 hard cap; the local estimate ledger is an additional stop control and never substitutes an absent billing control or guessed cost.
