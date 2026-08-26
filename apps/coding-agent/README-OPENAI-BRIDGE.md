# Copilot OpenAI bridge

This optional local process exposes the existing Copilot Edge client and deterministic layer 1 through an OpenAI-compatible endpoint. It does not duplicate browser automation. The bridge binds only to `127.0.0.1`, requires a fixed bearer token of at least 16 characters, validates tool arguments against each caller-provided JSON schema, and never invents a tool call when repair or validation fails.

## Start

From `apps/coding-agent`:

```powershell
npm run build
$env:COPILOT_BRIDGE_TOKEN = 'replace-with-a-local-token-at-least-16-chars'
node .\dist\openai-bridge.js --config .\config.flex.json --port 3952
```

Each request uses a fresh Copilot UI session. The complete OSS `messages` transcript is folded into one prompt for every request. This costs about 0.5 seconds per warm request in the preparation-PC run, but prevents stale Copilot session history and makes retries independent. `stream:true` is implemented as a compatibility stream: the completed answer is emitted as one SSE chunk followed by `[DONE]`; it is not token streaming.

Requests are serialized because they share one visible Copilot Edge surface. Up to eight active or queued requests are accepted; additional requests fail with HTTP 429. If the caller disconnects, queued work is skipped and active Copilot work is aborted. `tool_choice` supports `auto`, `none`, `required`, and a named function. A required or named choice that cannot be recovered and schema-validated fails with HTTP 422 instead of inventing a call.

## Curl checks

Normal chat:

```powershell
curl.exe --fail --silent --show-error http://127.0.0.1:3952/v1/chat/completions `
  -H "Authorization: Bearer $env:COPILOT_BRIDGE_TOKEN" `
  -H "Content-Type: application/json" `
  -d '{"model":"copilot-edge-layer1","messages":[{"role":"user","content":"3文字で挨拶して"}]}'
```

Tool call:

```powershell
curl.exe --fail --silent --show-error http://127.0.0.1:3952/v1/chat/completions `
  -H "Authorization: Bearer $env:COPILOT_BRIDGE_TOKEN" `
  -H "Content-Type: application/json" `
  -d '{"model":"copilot-edge-layer1","messages":[{"role":"user","content":"memo.txtへ確認と書いて"}],"tools":[{"type":"function","function":{"name":"write_file","description":"新規ファイルを書く","parameters":{"type":"object","additionalProperties":false,"required":["path","content"],"properties":{"path":{"type":"string"},"content":{"type":"string"}}}}}]}'
```

## OpenCode on Windows

OpenCode 1.18.21 is an optional GitHub Release asset, not Git history. The checked-in script tries the direct Release URL, falls back to authenticated `gh release download` for this private repository, verifies byte size and SHA-256, and runs a standalone version gate:

```powershell
gh auth status
powershell.exe -NoProfile -File .\vendor\opencode\Get-OpenCode.ps1
Copy-Item .\opencode.bridge.example.json C:\path\to\workspace\opencode.json
$env:COPILOT_BRIDGE_TOKEN = 'the-same-local-token'
Set-Location C:\path\to\workspace
C:\path\to\repo\apps\coding-agent\vendor\opencode\opencode.exe run 'ここ直下、何ある？'
```

Do not commit the copied `opencode.json` when it contains local policy changes. The example asks before write, edit, or shell execution. For an automated disposable-fixture test only, those permissions were temporarily set to `allow`.

The preparation-PC binary was `opencode 1.18.21`, 179,463,208 bytes, SHA-256 `EA4F4D4BEC95CD41BAF0FC53ADC4E34B31E1C8676DC5B2507C8797AB1884AF18`. It is the byte-for-byte executable extracted from the official `anomalyco/opencode` v1.18.21 `opencode-windows-x64.zip`; the checked-in manifest records the upstream URL, ZIP size/SHA-256, extraction recipe, and final executable SHA-256. The morning company-PC gate is: download and hash, run `--version`, then run the five tasks below. Company-PC EDR and proxy behavior remain unverified.

## Measured five-task gate

On 2026-08-27, OpenCode through the bridge completed 5/5 on a disposable mixed workspace:

| Task | Result | Turns | End-to-end |
| --- | --- | ---: | ---: |
| List current folder | PASS | 2 | 19.350 s |
| Read CSV and answer an absent field honestly | PASS | 3 | 25.941 s |
| Cross-file search | PASS | 2 | 27.344 s |
| Create a new file | PASS | 2 | 19.979 s |
| Open a CSV in its default application | PASS | 2 | 20.038 s |

This is the full rerun after repairing an observed unescaped `\.\日本語名` in Copilot's JSON command and teaching the generic bridge prompt to use `Start-Process -FilePath './相対パス'`. Immediately before the set, that same Japanese text file opened on the first command and produced a new Notepad PID. The final set's new-file content was read back exactly; its open command completed without an error. Across its 11 Copilot responses, six tool calls and five normal answers were resolved by layer 1. Layer 2, raw-content fallback, schema rejection, and failed responses were all zero. Service generation remained the dominant interval.

## Kickoff fallback chain

Run the same five-task check on the company PC and show only a level that passes there:

1. OpenCode through this bridge.
2. Built-in Flex UI with layer 1 only; no llama executable or model is needed.
3. Fixed consolidation demo.
4. Verified prerecorded video.

If the OpenCode Release asset is blocked, use built-in Flex. If Copilot/Edge or the corporate tenant path fails, do not claim a live pass; fall back to the fixed demo or video. The optional 4B converter remains insurance and is not required by either the bridge or the default Flex mode.
