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

The preparation-PC binary was `opencode 1.18.21`, 179,463,208 bytes, SHA-256 `EA4F4D4BEC95CD41BAF0FC53ADC4E34B31E1C8676DC5B2507C8797AB1884AF18`. The morning company-PC gate is: download and hash, run `--version`, then run the five tasks below. Company-PC EDR and proxy behavior remain unverified.

## Measured five-task gate

On 2026-08-27, OpenCode through the bridge completed 5/5 on a disposable mixed workspace:

| Task | Result | Turns | End-to-end |
| --- | --- | ---: | ---: |
| List current folder | PASS | 2 | 28.45 s |
| Read CSV and answer | PASS | 3 | 28.67 s |
| Cross-file search | PASS | 2 | 18.67 s |
| Create a new file | PASS | 2 | 20.50 s |
| Open a text file | PASS | 3 | 31.08 s |

The open task first emitted an invalid PowerShell parameter and then corrected itself to `Start-Process "概要.txt"`; a new Notepad PID was observed. Across the 12 Copilot responses, seven tool calls were recovered by layer 1, four normal answers used the plain-answer path, and one post-tool answer was returned unchanged through the raw-content fallback. Layer 2 was invoked zero times; schema rejection and failed responses were both zero. Average phase time per Copilot response was 7.073 seconds generation, 0.755 seconds fresh UI session creation, 0.608 seconds prompt write (0.336–0.368 seconds after the cold retry), 0.121 seconds connection, 0.062 seconds send, and 0 seconds DOM completion retrieval. Service generation was the dominant interval.

## Kickoff fallback chain

Run the same five-task check on the company PC and show only a level that passes there:

1. OpenCode through this bridge.
2. Built-in Flex UI with layer 1 only; no llama executable or model is needed.
3. Fixed consolidation demo.
4. Verified prerecorded video.

If the OpenCode Release asset is blocked, use built-in Flex. If Copilot/Edge or the corporate tenant path fails, do not claim a live pass; fall back to the fixed demo or video. The optional 4B converter remains insurance and is not required by either the bridge or the default Flex mode.
