# Misen v3 initial PoC — Windows Acceptance record

This is the version-controlled record for the mandatory real-machine gate. Static verification, reviewer approval, and this gate are separate. Do not mark the PR Ready or merge it until every mandatory row below is `PASS` with real Windows + Ollama + Ornith evidence.

## Frozen baseline

| Item | Acceptance requirement / tested candidate |
| --- | --- |
| OS | Windows x64 |
| Node.js | pinned DSH supported range `^22.19.0 || >=24.0.0`; current tested candidate `24.18.1`; record the actual version |
| npm | record the actual version; clean `npm ci` must pass |
| DSH package | `@deepseek-ai/dsh@0.1.2-alpha.2` |
| DSH tag / commit | `dsh-v0.1.2-alpha.2` / `0a53fb55bea101816fa226bb964ae2bed71c343b` |
| Ollama | current tested candidate `0.33.2`; record the actual version |
| model | stock `ornith-1.5:9b` Q4_K_M |
| endpoint | `http://127.0.0.1:11434/v1` |
| Ollama and DSH context | `4096` |
| thinking | OFF |
| DSH Web | standard `127.0.0.1:3080` |

Node and npm are not exact-version equality gates beyond the pinned DSH compatibility contract and the required clean install. Passing this Acceptance on Ollama `0.33.2` establishes `0.33.2` as the tested baseline for this initial PoC; it does not guarantee compatibility with arbitrary future Ollama versions.

Record the date, tester, PC/Windows build, and exact command output. Store raw logs outside Git when they contain session data; commit only redacted conclusions and small synthetic evidence.

## 1. Clean checkout and dedicated state

Run in a new PowerShell terminal from a clean checkout of the Draft PR commit:

```powershell
git status --short
git rev-parse HEAD
node --version
npm --version
ollama --version
ollama list
npm ci
npm ls @deepseek-ai/dsh --depth=0

$env:DSH_HOME = Join-Path $env:USERPROFILE '.dsh-misen-acceptance'
$env:DSH_TELEMETRY_DISABLED = '1'
$env:MISEN_LLM_API_KEY = 'ollama'
New-Item -ItemType Directory -Force $env:DSH_HOME | Out-Null
Copy-Item -Recurse -Force .\profile\misen (Join-Path $env:DSH_HOME 'profiles\misen')
Copy-Item -Recurse -Force .\agent-presets\misen-file (Join-Path $env:DSH_HOME 'misen-agent-presets\misen-file')
npx --no-install dsh --profile misen --dump-config
```

Confirm the package is exactly `0.1.2-alpha.2`; the effective configuration selects `misen-ollama` / `ornith-1.5:9b`, context `4096`, reasoning `off`, telemetry disabled, and the `misen-file` preset. Do not reuse a normal DSH home.

Create a synthetic project outside the repository:

```powershell
$caseRoot = Join-Path $env:TEMP 'misen-v3-acceptance'
New-Item -ItemType Directory -Force (Join-Path $caseRoot 'reports') | Out-Null
Set-Content -Encoding utf8 (Join-Path $caseRoot 'overview.txt') "Project: Misen synthetic acceptance`nStatus: draft`nOwner: Test User"
Set-Content -Encoding utf8 (Join-Path $caseRoot 'reports\alpha.txt') "alpha total: 12`nstatus: open"
Set-Content -Encoding utf8 (Join-Path $caseRoot 'reports\beta.txt') "beta total: 30`nstatus: closed"
Add-Type -AssemblyName System.Drawing
foreach ($spec in @(@('red.png',640,480,'RED 17'), @('blue.png',640,480,'BLUE 29'), @('large.png',3840,2160,'LARGE 43'))) {
  $bmp = [System.Drawing.Bitmap]::new([int]$spec[1],[int]$spec[2])
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.Clear([System.Drawing.Color]::White)
  $brush = if ($spec[0] -eq 'red.png') {[System.Drawing.Brushes]::Red} else {[System.Drawing.Brushes]::Blue}
  $g.FillRectangle($brush,40,40,$bmp.Width-80,$bmp.Height-80)
  $font = [System.Drawing.Font]::new('Arial',48)
  $g.DrawString([string]$spec[3],$font,[System.Drawing.Brushes]::Black,70,70)
  $bmp.Save((Join-Path $caseRoot $spec[0]),[System.Drawing.Imaging.ImageFormat]::Png)
  $font.Dispose(); $g.Dispose(); $bmp.Dispose()
}
Set-Location $caseRoot
npm --prefix <PATH-TO-MISEN-CHECKOUT> start
```

Replace `<PATH-TO-MISEN-CHECKOUT>` with the absolute Draft PR checkout path. Keep this launch terminal visible for standard DSH output.

## 2. Mandatory interactive checks

Use the opened DSH Web surface and its standard Trajectory. For each case, record `PASS` or `FAIL`, exact prompt/action, observed result, and evidence reference.

### A01 — Boot, Web, auth, and project picker

Confirm Web opens only on `127.0.0.1:3080`, no Misen login/auth layer appears, the standard project picker works, and `$caseRoot` is selected. Confirm a new session can be created.

### A02 — Text read, glob, grep, and representative multi-tool completion

Ask: ``Find every txt file. You must use `glob` to enumerate the txt files, `grep` to locate the `status` and `total` lines, and `read` to read the files and verify the values. Report each status and the sum of all totals. Do not modify files.`` Confirm real `glob`, `grep`, and `read` calls are visible, `alpha` is `open`, `beta` is `closed`, the sum is `42`, no file is mutated, and no Think/reasoning content is displayed.

### A03 — Chat attachment image understanding

Attach `red.png` in Chat and ask for its color and printed number. Require `red` and `17`; filename-only inference is not a pass.

### A04 — Workspace read_image understanding

Without attaching it, ask the agent to inspect workspace file `blue.png` and report its color and number. Confirm a real `read_image` call and answer `blue`, `29`.

### A05 — Multiple images under 4K pressure

Attach or inspect `red.png`, `blue.png`, and `large.png` in one turn. Ask for all three numbers and colors. Require `17`, `29`, `43` and correct colors; record any normalization, spill, pruning, or failure visible in standard evidence.

### A06 — Read-only mutation denial

In the initial read-only sandbox, ask to change `overview.txt`. Confirm the mutation cannot execute. Record the standard denial/approval UI; do not weaken the Profile.

### A07 — workspace-write Allow once

Through the standard permission UI, choose the narrowest `workspace-write` grant for the selected synthetic project and `Allow once`. Ask to create `allowed-once.txt` containing `approved once`. Confirm it succeeds only after human approval and is inside `$caseRoot`.

### A08 — Reject does not mutate

Before the request, run in another PowerShell:

```powershell
$before = Get-ChildItem -Recurse -File $caseRoot | Get-FileHash -Algorithm SHA256
```

Ask to overwrite `reports\alpha.txt`, then choose `Reject`. Re-run the hash command and confirm no existing file changed and no requested output was created.

### A09 — Filesystem observation policy

With `workspace-write` approved when prompted:

1. Ask to overwrite an existing file without reading it; require denial or a read-before-edit requirement.
2. Ask the agent to read `overview.txt`, then edit `Status: draft` to `Status: reviewed`; require success after approval.
3. After the agent reads it again, externally change the file with `Add-Content -Encoding utf8 (Join-Path $caseRoot 'overview.txt') 'external change'`, then ask it to edit based on stale state; require stale-version failure and reread before retry.

### A10 — Resume requires reread

Read `overview.txt`, stop the DSH process, restart with the same environment and project, resume the session, and request an edit. Confirm observed filesystem state was not persisted: the first guarded mutation requires a fresh read.

### A11 — Restart, resume, Rename, Archive, and Fork

Using only standard DSH UI, verify restart retains discoverable session state, resume works, Rename changes the session name, Archive removes it from the active list without deleting the project, and Fork creates an independent conversation. Record each result separately.

### A12 — Export and attachment-history redisplay

Run `/export` in the image-bearing session. Confirm export completes and does not expose secrets. Reload/resume the session and confirm prior attachment thumbnails/content redisplay correctly. Keep any raw export outside Git.

### A13 — `/compact`, pruning, spill, and overflow recovery

Use the standard Web command entry point to confirm `/compact` is available, then run `/compact` explicitly in the active session. Before compacting, create a long synthetic conversation by repeatedly asking for exact summaries of the synthetic files and images until the 4096-token context experiences standard pressure. Confirm in the standard Web/Trajectory evidence that the command executes an actual session-context reduction (record the before/after context or compaction markers), not merely a help response. Confirm standard compaction/pruning/spill/overflow recovery occurs without a Misen adapter, the session remains usable for a new prompt, and the effective agent-local compaction includes `compaction-basic` with `maxTokens: 512`.

After `/compact`, run a representative file-agent turn and confirm all six model-facing tools still work normally: `read`, `read_image`, `write`, `edit`, `glob`, and `grep`. Record the command availability, context-reduction evidence, post-compaction continuation, and six-tool Trajectory evidence and counts.

### A14 — Stop/Cancel loop-prone work

Ask for a deliberately repetitive multi-step inspection of the synthetic files, then use Stop/Cancel while tools are still running. Confirm execution stops, no further mutation occurs, and the session remains usable for a new prompt.

### A15 — Ollama stopped, model missing, cold load, and retry exhaustion

Test these separately and restore the baseline between them:

1. Stop the Ollama server, submit a harmless read prompt, and confirm a bounded visible failure. Restore Ollama.
2. Temporarily rename the configured model in a copy of the Profile under the dedicated acceptance `DSH_HOME`, launch that copy, and confirm model-missing failure. Restore the exact Profile before continuing.
3. Run `ollama stop ornith-1.5:9b`, submit the representative read prompt, and measure cold-load TTFA and total time.
4. With Ollama unavailable, allow standard DSH retries to exhaust; confirm the standard normal/5 policy terminates and does not loop forever. Do not add retry or timeout overrides.

### A16 — Exact model-facing surface and absent selectors

From effective config plus real Web/Trajectory, confirm exactly these six native model-facing tools: `read`, `read_image`, `write`, `edit`, `glob`, `grep`. Confirm there is no shell, Research/Web, MCP, subagent, skills, goals, plan, todo, ask-user tool, model selector, preset selector, or permission selector exposed to the model. Standard human permission UI is expected and is not a model tool.

### A17 — Route, telemetry, project root, and no custom runtime

Confirm with `--dump-config`, Ollama info/log, Trajectory, and filesystem observation:

- provider/model are `misen-ollama` / stock Q4_K_M `ornith-1.5:9b`;
- Ollama runtime and DSH model context are both `4096`;
- real Ollama evidence shows thinking OFF (`reasoning_tokens=0` or equivalent);
- `DSH_TELEMETRY_DISABLED=1` is effective;
- selected Project is the mutation workspace root and mutation outside it is denied;
- the checkout contains no Misen runtime code, launcher, adapter, compatibility mode, fallback, or active v2 implementation.

### A18 — Continuous, DSH-PID-scoped non-loopback connection observation

Use two PowerShell terminals. Close other DSH/Misen sessions first. Start one fresh DSH Web session from the checkout (the launch terminal remains visible), then run the following in the second terminal **before starting A02**. These are inline Windows-standard inspection commands only; do not add a Misen monitor, verifier, firewall rule, or proxy.

First identify and record the DSH root process. The candidate filter must match the command line of the newly started DSH process; if more than one unrelated candidate remains, stop and resolve the ambiguity rather than combining process trees:

```powershell
$dshCandidates = @(Get-CimInstance Win32_Process |
  Where-Object { $_.CommandLine -match '(?i)(^|[\\/ ])dsh([\\/ ]|$)|@deepseek-ai[\\/]dsh' } |
  Select-Object ProcessId,ParentProcessId,Name,CommandLine)
$dshCandidates | Format-List
$root = @($dshCandidates | Where-Object {
  -not (@($dshCandidates.ProcessId) -contains $_.ParentProcessId)
})
if ($root.Count -ne 1) { throw "Expected exactly one fresh DSH root candidate; found $($root.Count). Close unrelated sessions and repeat." }
$rootPid = [int]$root[0].ProcessId
$root | Export-Csv -NoTypeInformation -Encoding utf8 (Join-Path $env:TEMP 'misen-v3-dsh-root.csv')
$phaseFile = Join-Path $env:TEMP 'misen-v3-dsh-network-phase.txt'
$logFile = Join-Path $env:TEMP 'misen-v3-dsh-network.csv'
$statusFile = Join-Path $env:TEMP 'misen-v3-dsh-network-status.txt'
Set-Content -Encoding utf8 $phaseFile 'BEFORE_FLOW'
Set-Content -Encoding utf8 $statusFile 'RUNNING'
'RecordType,Timestamp,Phase,RootPid,ProcessTreePids,OwningProcess,ProcessName,LocalAddress,LocalPort,RemoteAddress,RemotePort,State,IsNonLoopback' | Set-Content -Encoding utf8 $logFile
```

Start this continuous monitor **before A02**. It rebuilds the DSH descendant set on every sample, so short-lived tool/runtime children are included. Keep this terminal running while the other terminal completes A02, A03, A04, and A05. The phase marker is a temporary file outside Git; change it exactly at the boundaries shown below:

```powershell
$flowEndAt = $null
while ($true) {
  $sampleTime = Get-Date
  $phase = (Get-Content -Raw $phaseFile).Trim()
  $all = @(Get-CimInstance Win32_Process)
  $rootPresent = @($all | Where-Object { [int]$_.ProcessId -eq $rootPid }).Count -eq 1
  if (-not $rootPresent) {
    [pscustomobject]@{
      RecordType='Failure'; Timestamp=$sampleTime.ToString('o'); Phase=$phase; RootPid=$rootPid
      ProcessTreePids=[string]$rootPid; OwningProcess=''; ProcessName='dsh-root-disappeared'
      LocalAddress=''; LocalPort=''; RemoteAddress=''; RemotePort=''; State='NOT RUN'; IsNonLoopback=''
    } | ConvertTo-Csv -NoTypeInformation | Select-Object -Skip 1 | Add-Content -Encoding utf8 $logFile
    Set-Content -Encoding utf8 $statusFile 'NOT RUN: DSH root PID disappeared during monitoring'
    break
  }
  $tree = @($rootPid)
  $changed = $true
  while ($changed) {
    $changed = $false
    foreach ($child in @($all | Where-Object { $tree -contains [int]$_.ParentProcessId })) {
      if (-not ($tree -contains [int]$child.ProcessId)) { $tree += [int]$child.ProcessId; $changed = $true }
    }
  }
  $treeIds = ($tree | Sort-Object -Unique) -join ';'
  $names = @{}
  foreach ($p in @($all | Where-Object { $tree -contains [int]$_.ProcessId })) { $names[[int]$p.ProcessId] = $p.Name }
  # A Sample row is written on every iteration, including when there are zero
  # established connections. This proves continuous phase coverage separately
  # from Connection rows, whose IsNonLoopback value is the classification field.
  [pscustomobject]@{
    RecordType='Sample'; Timestamp=$sampleTime.ToString('o'); Phase=$phase; RootPid=$rootPid
    ProcessTreePids=$treeIds; OwningProcess=''; ProcessName=''; LocalAddress=''; LocalPort=''
    RemoteAddress=''; RemotePort=''; State=''; IsNonLoopback=''
  } | ConvertTo-Csv -NoTypeInformation | Select-Object -Skip 1 | Add-Content -Encoding utf8 $logFile
  $connections = @(Get-NetTCPConnection -State Established -ErrorAction SilentlyContinue |
    Where-Object { $tree -contains [int]$_.OwningProcess })
  foreach ($c in $connections) {
    $remote = [string]$c.RemoteAddress
    $loopback = $remote -in @('127.0.0.1','::1','0.0.0.0','::')
    [pscustomobject]@{
      RecordType='Connection'; Timestamp=$sampleTime.ToString('o'); Phase=$phase; RootPid=$rootPid
      ProcessTreePids=$treeIds; OwningProcess=[int]$c.OwningProcess
      ProcessName=[string]$names[[int]$c.OwningProcess]; LocalAddress=$c.LocalAddress; LocalPort=$c.LocalPort
      RemoteAddress=$remote; RemotePort=$c.RemotePort; State=$c.State; IsNonLoopback=(-not $loopback)
    } | ConvertTo-Csv -NoTypeInformation | Select-Object -Skip 1 | Add-Content -Encoding utf8 $logFile
  }
  if ($phase -eq 'FLOW_END' -and $null -eq $flowEndAt) { $flowEndAt = $sampleTime }
  if ($null -ne $flowEndAt -and (($sampleTime - $flowEndAt).TotalSeconds -ge 3)) {
    Set-Content -Encoding utf8 $statusFile 'COMPLETED: FLOW_END sampled through 3-second grace period'
    break
  }
  Start-Sleep -Seconds 1
}
```

In the flow terminal, immediately before A02 set `FLOW_ACTIVE`, then perform A02–A05 without pausing the monitor. Immediately after A05's final response and tool call, set `FLOW_END`. The monitor continues writing one `Sample` row per second and connection rows, including zero-connection samples, for at least three seconds after it first observes `FLOW_END`, then writes `COMPLETED` to the status file and exits. If the DSH root PID disappears, it writes a `Failure` row with `State=NOT RUN` and writes a `NOT RUN` status instead of passing silently:

```powershell
Set-Content -Encoding utf8 $phaseFile 'FLOW_ACTIVE'
# Perform A02, A03, A04, and A05 in the DSH Web terminal now.
Set-Content -Encoding utf8 $phaseFile 'FLOW_END'
```

Review the complete temporary log, retaining the raw file outside Git and recording a redacted conclusion in this table. Include the DSH root/descendant process IDs, timestamps covering `BEFORE_FLOW`, `FLOW_ACTIVE`, and `FLOW_END`, owning process name/PID, and every remote endpoint observed:

```powershell
Get-Content -LiteralPath $statusFile
Import-Csv $logFile | Format-Table -AutoSize
Import-Csv $logFile | Where-Object { $_.RecordType -eq 'Connection' -and $_.IsNonLoopback -eq 'True' } |
  Select-Object Timestamp,Phase,OwningProcess,ProcessName,RemoteAddress,RemotePort
```

For this application-runtime claim, the only expected paths are Browser ↔ `127.0.0.1:3080` and DSH ↔ Ollama `127.0.0.1:11434`. Browser traffic may be outside the DSH process tree; do not classify it from this PID-scoped log. Evaluate only `RecordType=Connection` rows: a connection is `FAIL` only when its owning PID is in the DSH/Misen root-plus-descendant set and its remote address is non-loopback. `Sample` rows have blank connection fields and prove that the monitor sampled every phase even when no connection was established. Record the concrete timestamp, owning PID/process, and remote endpoint for every non-loopback connection row and investigate it before Ready. Unrelated browser tabs, Ollama's own process, Windows services, EDR, Zscaler, VPN, or other PC traffic outside the DSH/Misen process tree is explicitly out of scope and is not a Misen failure. A `NOT RUN` status, missing/ambiguous root, interrupted sampling, absent phase coverage, or any `Failure` row is `NOT RUN`, not an inferred pass.

## 3. Performance observations (measured, not initial SLA)

For A02, A03, A05, A13, and A15 cold load, record TTFA, total turn time, peak process-tree RAM, model-call count, tool-call count, compaction count, retry count, and test conditions. Do not convert these observations into an unstated pass threshold.

```powershell
Get-Process node,ollama -ErrorAction SilentlyContinue |
  Select-Object Id,ProcessName,WorkingSet64,PrivateMemorySize64,CPU
```

## 4. Result record

### Historical Decision 422 run

The earlier Decision 422 configuration run remains part of the record. Its A02 result was `FAIL`: the trajectory completed the text inspection without a `grep` call, and visible Think/reasoning content appeared. Acceptance stopped before A03–A05; A18 was recorded as `NOT RUN` for that incomplete flow. This historical result is not the current Decision 424 authority.

### Current Decision 424 rerun

Candidate commit: `e1e836db804922de33576ad014ff88914f1d9a57`.

| ID | Current Decision 424 result | Evidence / notes |
| --- | --- | --- |
| A01 | PASS (carried forward) | The prior A01 PASS remains valid; this reasoning/prompt repair did not alter boot, auth, project-picker, or session creation behavior. |
| A02 | PASS | Exact authoritative prompt used: ``Find every txt file. You must use `glob` to enumerate the txt files, `grep` to locate the `status` and `total` lines, and `read` to read the files and verify the values. Report each status and the sum of all totals. Do not modify files.`` Real `glob` ran once, `grep` once, and `read` three times. The response reported `alpha=open`, `beta=closed`, and total `42`; pre/post TXT SHA256 hashes were unchanged. No Think/reasoning block or text was displayed. Standard automatic compaction occurred. Observed turn: 3 steps / 5 tool calls. Session metrics after A02: LLM 7m50s, tool 2.2s, TTFT average 44.2s, 6.6 tok/s; these are observations only and imply no SLA. |
| A03 | FAIL | Human attached `red.png` in Chat and used `Inspect the attached image itself. Report its color and the printed number.` DSH displayed a real Think block with reasoning beginning `Let me confirm the details: The image is 640x480px, image/png. It's a`; after stop it remained `Thought for a while`. The partial visible inspection recognized `RED 17`, but the turn was stopped immediately for the thinking-OFF violation; this is not an image-understanding PASS. |
| A04 | NOT RUN | Stopped at the first current-run failure (A03). |
| A05 | NOT RUN | Stopped at the first current-run failure (A03). |
| A18 | NOT RUN | Monitor mechanics completed, but the representative A02–A05 flow was incomplete because execution stopped at A03. Root PID `20176`; continuous observation from `2026-08-31T12:21:52.5186711+09:00` through `2026-08-31T13:14:37.6351926+09:00`; phase samples: `BEFORE_FLOW` 320, `FLOW_ACTIVE` 1837, `FLOW_END` 4; failure rows 0; DSH-tree non-loopback connections 0; three-second grace completed. This remains `NOT RUN`, not a pass, because the required representative flow did not complete. Raw logs remain outside Git. |

The table below is the consolidated current status. The earlier Decision 422 A02 failure is preserved above for audit history; the Decision 424 rows are the current authority.

| ID | Mandatory result | Evidence / notes |
| --- | --- | --- |
| A01 | PASS | DSH Web listened on `127.0.0.1:3080`; the standard DeepSeek Harness UI opened without an additional Misen auth layer, selected `misen-v3-acceptance` through the Project picker, and created a new session with an enabled Chat input. |
| A02 | PASS | Current Decision 424 rerun: see the detailed row above for the exact prompt, real `glob`/`grep`/`read` evidence, values, unchanged hashes, no Think/reasoning content, and measured observations. |
| A03 | FAIL | Current Decision 424 rerun failed the thinking-OFF requirement when inspecting the attached `red.png`; see the detailed row above. |
| A04 | NOT RUN | Stopped at the first current-run failure (A03). |
| A05 | NOT RUN | Stopped at the first current-run failure (A03). |
| A06 | NOT RUN | |
| A07 | NOT RUN | |
| A08 | NOT RUN | |
| A09 | NOT RUN | |
| A10 | NOT RUN | |
| A11 | NOT RUN | |
| A12 | NOT RUN | |
| A13 | NOT RUN | |
| A14 | NOT RUN | |
| A15 | NOT RUN | |
| A16 | NOT RUN | |
| A17 | NOT RUN | |
| A18 | NOT RUN | Current Decision 424 monitor run completed mechanically, but the mandatory representative A02–A05 flow was incomplete because execution stopped at A03; see the detailed row above. Raw CSV remains outside Git. |

Tester: `Codex coordinator with human Web UI operator`
Date/time and timezone: `2026-08-31, Asia/Tokyo`
Windows build / CPU / RAM: `Windows 11 Pro 10.0.26200 (x64) / Intel Core Ultra 5 228V / 33,847,832,576 bytes`
Node / npm / Ollama / model digest: `Node 24.18.1 / npm 11.16.0 / Ollama 0.33.2 / ornith-1.5:9b e5df7dcdd8a2 (Q4_K_M)`
Draft PR commit: `e1e836db804922de33576ad014ff88914f1d9a57` (current Acceptance candidate)

Overall status: `BLOCKED_AFTER_A03_DECISION_424`. Mechanical implementation, deterministic verification, independent reviews, and Draft PR creation are complete, but current Windows Acceptance has A03 `FAIL` and A04/A05/A18 `NOT RUN`. Do not mark the PR Ready, merge it, or close the issue until the authorized repair loop resolves the failure and every A01–A18 row is `PASS`.
