# Ollama provider (Issue #41)

The coding agent can run the existing `agentLoop="v2"` against an Ollama
OpenAI-compatible endpoint. The shipped compatibility default is unchanged:
`agentLoop="v1"` and `provider="copilot-edge"`. Ollama is opt-in through
[`config.ollama.json`](./config.ollama.json), which uses the loopback URL
`http://127.0.0.1:11434/v1` and model `ornith-1.5:9b`.

```powershell
Copy-Item config.ollama.json config.json
ollama serve
npm run serve -- --config .\config.json --workspace .
```

`provider="ollama"` requires a model and a loopback `baseURL`; remote URLs and
unknown providers are rejected while loading configuration. No
`COMPANY_LLM_API_KEY` is read or sent on this path. Copilot/OpenAI-compatible
v2 still requires its existing API key.

## Encoding and reasoning

The Ollama transport makes the JSON request content type explicit with
`charset=utf-8`. Non-streaming JSON response bytes are decoded with fatal
UTF-8 semantics, so malformed bytes fail closed instead of becoming replacement
characters. Run `npm run smoke` to exercise Japanese tool arguments and the
malformed-response regression.

`reasoningEffort` is intentionally omitted by default. If needed, set it to
`high`, `medium`, `low`, or `none`; the AI SDK provider option is translated to
the Ollama/OpenAI-compatible HTTP field `reasoning_effort`. Raw reasoning text
is not rewritten by the transport. The opt-in live harness records whether
`U+FFFD` or `<think>` appears in measured event/final output; absence is only
claimed for live runs recorded as passing in `OLLAMA-VALIDATION.md`.

The OpenAI-compatible API does not provide a portable per-request `num_ctx`
setting here; context size is a model/server concern. If an 8K context variant
is needed, create it with a temporary (untracked) Modelfile. For example:

```powershell
$env:OLLAMA_MODEL = 'ornith-1.5:9b-8k'
$modelfile = Join-Path $env:TEMP 'coding-agent-ollama.Modelfile'
@"
FROM ornith-1.5:9b
PARAMETER num_ctx 8192
"@ | Set-Content -LiteralPath $modelfile -Encoding utf8
ollama create $env:OLLAMA_MODEL -f $modelfile
Remove-Item -LiteralPath $modelfile -Force
```

The live measurement is opt-in and never runs as part of the normal gate:

```powershell
npm run flex:measure:ollama
npm run gate -- --live-ollama
```

Use `OLLAMA_LIVE_TASKS=list,read,open,write,search` for the five-task
acceptance run, or `OLLAMA_LIVE_TASKS=long` to isolate the context-length
case. `OLLAMA_REASONING_EFFORT=none` is available for an explicit comparison;
it is not the default.

It creates disposable fixtures, config, audit, and isolated AppData roots under
`apps/coding-agent/.tmp`, starts a no-browser server, and fails nonzero when
Ollama is unavailable or any safety/UTF-8/audit assertion fails. This document
does not report live results; run the command on a machine with the selected
model available.

The Issue #41 preparation-PC measurements and the selected 8K rationale are
recorded in [`OLLAMA-VALIDATION.md`](./OLLAMA-VALIDATION.md).

## Computer Use Vision demo (Issue #53)

The opt-in Computer Use harness launches a dedicated headed Edge profile on a
random loopback CDP port. It captures the synthetic business screen, sends only
the PNG bytes and user text to Ornith, exposes only the run-scoped
`open_company` tool, uses the normal permission/approval/guard/audit path, then
captures the changed page for Vision confirmation. It never attaches to an
existing browser profile or tab and it does not use pixel clicks.

```powershell
npm run computer-use:measure:ollama -- --seed 53028 --budget 512
npm run gate -- --live-computer-use --seed 53028 --budget 512
```

Supported visual-budget tiers are 512, 768, and 1024 estimated Qwen grid
tokens; 512 is the default. The estimate uses the factor-32 grid and is not a
processor-reported token count. `reasoningEffort="none"`, a 4K model context,
and exactly one active tool are intentional for this narrow demo. Screenshots
and temporary Edge profiles are disposable; result logs retain dimensions and
hashes, never image bytes. A run without a screenshot fails before the model or
approval is called.

This command is a bounded synthetic demo, not authorization for general UI
automation or Excel fine-formatting. Actual 16 GB suitability must be measured
on a 16 GB machine; do not infer it from a larger machine's run.
