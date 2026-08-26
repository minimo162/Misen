# Flex mode (Windows, offline local converter)

From `apps/coding-agent`, first obtain the repository contents, then reconstruct and verify the checked-in runtime. No company-PC download is part of this flow.

```powershell
git pull
powershell.exe -NoProfile -File .\vendor\flex-runtime\Join-FlexRuntime.ps1
powershell.exe -NoProfile -File .\vendor\flex-runtime\Test-FlexRuntime.ps1
powershell.exe -NoProfile -File .\vendor\flex-runtime\Start-FlexConverter.ps1
```

If local policy blocks checked-out scripts, set the user-scoped policy once from PowerShell and rerun the same commands: `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`. The launch scripts do not add `-ExecutionPolicy Bypass`.

In another PowerShell window, start the agent for any existing folder (the folder is the only file-operation boundary):

```powershell
node .\dist\server.js --config .\config.flex.json --workspace "C:\path\to\your\folder"
```

The runtime is the official CPU-specific unified llama.cpp binary; `llama.exe serve` is the single-binary form of `llama-server`. It avoids the separately loaded unsigned `ggml.dll` that Windows Code Integrity rejected on the preparation PC. Qwen3.5-0.8B Q4 was measured first but produced only 2/16 correct conversions. Qwen3.5-4B Q4_0 established the 16/16 baseline, then the trusted Unsloth Q4_K_M build retained 16/16 with zero false positives on eight negative cases, so the checked-in package uses Qwen3.5-4B Q4_K_M. The server binds only to `127.0.0.1` and requires the local token already matched in `config.flex.json`. The web UI opens at `http://127.0.0.1:3948`; if automatic browser opening is blocked, open that URL manually. `config.flex.json` enables the loopback converter. The converter only contacts `127.0.0.1`, `localhost`, or `::1`; any timeout, unavailable server, or malformed response falls back to the existing Copilot parser. Tool arguments are still validated against the current host schemas before execution.

The local heterogeneous corpus passed 16/16 for both host operations and Q4_K_M response conversion: list 3/3, read 4/4 (including text, CSV, xlsx, and missing file), open 3/3, write 3/3, and search 3/3. The eight-case negative gate produced zero false-positive tool calls. Strict JSON responses used the validated fast path in 0–1 ms; malformed/plain positive responses converted on CPU in 2.3–5.2 seconds in the adoption gate. Real Copilot task evidence and the kickoff stability decision are recorded in `FLEX-VALIDATION.md`. These are preparation-PC measurements, not company-PC EDR results.

Operating rules: use one clear request at a time; inspect before editing; approve writes and application opens deliberately; keep requested paths inside the selected workspace; treat missing files as a question rather than a reason to guess. Allowed document-open forms are restricted to an existing, regular, non-link workspace document or media file (`Invoke-Item`, `Start-Process`, or `excel.exe` for `.xlsx`); executable/script/shortcut/URL files and reparse points are denied. Flex configuration sets `safeCommandOnly`, so other shell input and network-backed host tools are removed from the model contract and rejected again at execution. Deletion, network, registry mutation, encoded PowerShell, shell metacharacters, and workspace escape are denied.

The web UI starts in the projection-friendly demo view. It shows the user request, a collapsed Japanese activity line, the final answer, and links for artifacts; internal events, raw logs, run IDs, diffs, and verification evidence remain hidden. Use the `診断ビュー` toggle when developing or troubleshooting. Failed and older sessions are collapsed under `過去の実行` by default.

Company-PC remaining checks: confirm the Copilot account/session, rendered Edge send control, corporate endpoint behavior, antivirus treatment of the vendored single binary, and a real document-open approval. If startup shows error `0xC0E90002`, check Code Integrity events 3033/3077; do not call it file corruption until the complete-file SHA-256 has also failed. Those are manual checks and are not asserted by the local smoke suite.
