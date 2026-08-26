# Flex mode (Windows, deterministic by default)

Layer 1 is the default and needs neither llama.cpp nor a local model. From `apps/coding-agent`, start the agent for any existing folder; that folder is the only file-operation boundary:

```powershell
git pull
node .\dist\server.js --config .\config.flex.json --workspace "C:\path\to\your\folder"
```

The optional 4B insurance layer is distributed as GitHub Release assets, not Git history. To install it after `git pull`, download, reconstruct, and verify the pinned assets, then set `localResponseConverter.enabled` to `true` in a local config copy and start it:

```powershell
powershell.exe -NoProfile -File .\vendor\flex-runtime\Get-FlexRuntime.ps1
powershell.exe -NoProfile -File .\vendor\flex-runtime\Start-FlexConverter.ps1
```

Because this repository is private, run `gh auth status` first on a new PC. `Get-FlexRuntime.ps1` tries direct `https://github.com/minimo162/company-apps-share/releases/download/flex-runtime-v1/...` URLs, then uses authenticated `gh release download` for private-asset access without writing a token to disk. It checks every downloaded byte count and SHA-256 from `manifest.json`, joins the model, and verifies the complete artifacts. If Release downloads are blocked, do not enable the converter; layer 1 remains the supported default. If local policy blocks checked-out scripts, set the user-scoped policy once from PowerShell and rerun the same commands: `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`. The scripts do not add `-ExecutionPolicy Bypass`.

The optional runtime is the official CPU-specific unified llama.cpp binary; `llama.exe serve` is the single-binary form of `llama-server`. It avoids the separately loaded unsigned `ggml.dll` that Windows Code Integrity rejected on the preparation PC. Qwen3.5-0.8B Q4 was measured first but produced only 2/16 correct conversions. Qwen3.5-4B Q4_0 established the 16/16 baseline, then the trusted Unsloth Q4_K_M build retained 16/16 with zero false positives on eight negative cases. The optional server binds only to `127.0.0.1` and requires the local token matched in the opt-in config. The web UI opens at `http://127.0.0.1:3948`; if automatic browser opening is blocked, open that URL manually. `config.flex.json` keeps the converter disabled. The converter only contacts `127.0.0.1`, `localhost`, or `::1`; any timeout, unavailable server, or malformed response remains fail-closed. Tool arguments are always validated against the current host schemas before execution.

The local heterogeneous corpus passed 16/16 for host operations and 16/16 for deterministic layer-1 interpretation: list 3/3, read 4/4 (including text, CSV, xlsx, and missing file), open 3/3, write 3/3, and search 3/3. The expanded ten-case negative gate, including an unescaped Windows-path example, produced zero false-positive tool calls, and 30 jsonrepair-inspired malformed-JSON categories passed 30/30 with schema-invalid values still rejected. The optional Q4_K_M converter separately retained its prior 16/16 positive and zero-false-positive eight-case adoption gate. Real Copilot task evidence and the kickoff stability decision are recorded in `FLEX-VALIDATION.md`. These are preparation-PC measurements, not company-PC EDR results.

For repeatable preparation-PC performance evidence, start the agent on port 3951 with a disposable workspace and run `npm run flex:measure:copilot -- http://127.0.0.1:3951 .tmp/flex-copilot-performance .tmp/flex-performance/result.json`. The driver exercises list, read, search, new-file write, and open with fresh sessions, auto-approves only its disposable write/open fixture, and records per-phase timings. The final layer-1-only run was 5/5 at 15.283–24.752 seconds. All nine model decisions were resolved by layer 1; layer 2 and failed decisions were both zero. Copilot generation, not local conversion or response retrieval, was the dominant interval. See `FLEX-VALIDATION.md` for the one-change-at-a-time comparison and rejected experiments.

For the optional OpenAI-compatible wrapper and tested OpenCode setup, see `README-OPENAI-BRIDGE.md`. The OpenCode executable is a hash-pinned GitHub Release asset and is not in Git history. The preparation-PC OpenCode gate completed list, read, search, new-file write, and actual application open 5/5 in 18.67–31.08 seconds. Company-PC execution remains a morning gate.

Operating rules: use one clear request at a time; inspect before editing; approve writes and application opens deliberately; keep requested paths inside the selected workspace; treat missing files as a question rather than a reason to guess. Allowed document-open forms are restricted to an existing, regular, non-link workspace document or media file (`Invoke-Item`, `Start-Process`, or `excel.exe` for `.xlsx`); executable/script/shortcut/URL files and reparse points are denied. Flex configuration sets `safeCommandOnly`, so other shell input and network-backed host tools are removed from the model contract and rejected again at execution. Deletion, network, registry mutation, encoded PowerShell, shell metacharacters, and workspace escape are denied.

The web UI starts in the projection-friendly demo view. It shows the user request, a collapsed Japanese activity line, the final answer, and links for artifacts; internal events, raw logs, run IDs, diffs, and verification evidence remain hidden. Use the `診断ビュー` toggle when developing or troubleshooting. Failed and older sessions are collapsed under `過去の実行` by default.

Company-PC remaining checks: first run layer 1 alone; confirm the Copilot account/session, rendered Edge send control, corporate endpoint behavior, and a real document-open approval. Only when enabling the optional insurance layer, check Release access and antivirus treatment of the downloaded single binary. If startup shows error `0xC0E90002`, check Code Integrity events 3033/3077; do not call it file corruption until the complete-file SHA-256 has also failed. Those are manual checks and are not asserted by the local smoke suite.
