# Flex mode (Windows, deterministic by default)

## 回帰ゲート

`apps/coding-agent` で次の1コマンドを実行すると、通常の回帰ゲートを順番に実行します。各段の出力はリアルタイムに表示され、最後に PASS / FAIL / SKIP と所要時間の表が出ます。途中の段が失敗しても可能な後続段を続け、1段でも失敗した場合は終了コード1になります。

```powershell
npm run gate
```

| 段 | 実行内容 | 通常実行 |
|---|---|---|
| typecheck | `npx tsc --noEmit` | PASS / FAIL |
| build | `node esbuild.config.mjs` | PASS / FAIL |
| smoke | `node dist/smoke.js`（直前のbuild成果物を使用） | PASS / FAIL |
| flex-validate | `node dist/flex-harness.js` | PASS / FAIL |
| live-converter | `node dist/flex-harness.js --live` | フラグなしはSKIP |
| live-copilot | `node test/measure-flex-copilot.mjs` | フラグなしはSKIP |
| live-copilot-v2 | `node test/measure-flex-copilot-v2.mjs` | フラグなしはSKIP |

4B変換係まで実行する場合は、llama.cppサーバーを `127.0.0.1:8080` で起動してから `npm run gate -- --live-converter` を使います。

実Copilot 5種の計測まで実行する場合は、`dist/server.js` のサーバーとEdge Copilotセッションを準備してから `npm run gate -- --live-copilot` を使います。既存計測スクリプトのbaseURL、workspace、結果パスはフラグの後へ同じ順番で渡せます。

```powershell
npm run gate -- --live-copilot http://127.0.0.1:3951 .tmp/flex-copilot-performance .tmp/flex-performance/result.json
```

機械可読な全段の結果は、実行のたびに `.tmp/gate-result.json` へUTF-8のJSONとして保存されます。

## 日本語アシスタント UI

既定の `http://127.0.0.1:3948/` は、assistant-ui のスレッド／コンポーザー部品を使った日本語画面です。既存の `/api/sessions`、`/api/session`、`/api/turn`、実行状態、AgentEvent の進捗、承認 API を表示用に接続し、一覧・読み取り・検索・新規作成・ファイルを開くという5つの依頼例をそのまま選べます。進捗は利用者向けの短い日本語に変換され、内部namespace、プロンプト、JSON、raw logは表示しません。

この画面は presentation-only です。assistant-ui の `ExternalStoreRuntime` は会話の表示と入力送信だけに使い、クライアント側のツール実行・承認コールバックは登録しません。実行時の検証、before hook、権限、既存の承認 API と再確認、`ToolDef.run` のワークスペース／safeCommandOnly ガードは従来どおりサーバーだけが担当します。許可カードの「許可」「拒否」は既存 `/api/approvals/resolve` へ送られます。

変更前の画面は `/classic` から引き続き利用できます。サイドバーとヘッダーの「従来画面」リンク、JavaScript無効時の案内から移動できます。`classic.html` は旧 `index.html` の完全なコピーとして保持し、旧UIの実行確認を smoke テストで行います。

## ループv2（実験的）

Vercel AI SDKを使うループv2は並行実装です。既定の `agentLoop` は引き続き `"v1"` で、v1/v2の全ゲートが同等以上になったことを確認してから切替を別途判断します。v2でも既存ホストツールの引数検証、実行前フック、承認、コマンド／ファイルガードを順番に通り、各実行上限とno-progress停止を適用します。

v2を試すローカル設定では、Copilot OpenAI互換bridgeの `/v1` を `baseURL` に指定し、bridgeと同じトークンを `apiKey` または `apiKeyEnv` で渡します。

```json
{
  "agentLoop": "v2",
  "provider": "copilot-edge",
  "baseURL": "http://127.0.0.1:3952/v1",
  "apiKeyEnv": "COPILOT_BRIDGE_TOKEN",
  "model": "copilot-edge"
}
```

通常の `npm run gate` にはモックOpenAI互換応答を使うv2決定論テストが含まれ、実サービスには接続しません。実Copilotの5種計測は、Edge Copilotセッションを使うbridgeと、上記v2設定で起動した `dist/server.js` を準備してから、次のopt-inフラグで実行します。baseURL、workspace、結果パスの追加引数はv1計測と同じです。

```powershell
npm run gate -- --live-copilot-v2 http://127.0.0.1:3951 .tmp/flex-copilot-v2-performance .tmp/flex-copilot-v2-result.json
```

llama.cppサーバーは `--live-converter` のときだけ必要です。フラグを付けないlive段はSKIPとなり、全段の結果は `.tmp/gate-result.json` に保存されます。

## 宣言的権限層（v2専用）

`agentLoop: "v2"` のときだけ、設定の `permissions` 配列を実行前フックとして適用できます。各規則は `permission`（bareなツール名）、`pattern`、`action`（`allow` / `ask` / `deny`）で指定します。規則は配列順に評価され、最後に一致した規則が優先されます。`*` と `?` のワイルドカードが使え、ファイル対象はワークスペース相対の `/` 区切りへ正規化されます。

`allow` は既存の承認プロンプトだけを省略し、`ToolDef.run` と既存のワークスペース・危険コマンド・`allowArbitraryCommands`・`safeCommandOnly` ガードは必ず通ります。`ask` は読み取りツールを含めて既存の承認を必ず表示し、`deny` は実行前に停止します。複数の対象がある場合は、1件でも `deny` なら拒否、次に `ask` があれば確認、全件 `allow` のときだけ許可です。

`write_file` の権限は他の実行前フックが適用された後の最終 `args.path` で判定します。その時点でファイルが存在すれば bare 名に `.overwrite` を付けた `write_file.overwrite`、存在しなければ `write_file` を評価します。対象パターンは従来どおりワークスペース相対です。`write_file.overwrite: ask` は既存の承認バインディング（存在状態と変更前ハッシュ）を捕捉し、承認後に再確認します。`allow` はこの既存承認だけを自動化し、承認後の再確認を追加せず、`ToolDef.run` とホスト側ガードは必ず実行します。

`run_command` と `start_process` は、shell-quoteで安全に1コマンド1トークン列と判定できたときだけ `git status` や `npm run dev` などのコマンド接頭辞へ一致させます。`;`、`&&`、`|`、リダイレクト、glob、複数行、parse失敗を含む複雑な入力は全文を対象に `ask` へ保守的に降格され、`allow` でガードを回避できません。

最小確認プロファイル（`config.example.json` と `config.flex.json` に収録）は、一覧・読み取り・検索・xlsx読み取り・新規書き込み・明示的なファイルオープンを `allow`、既存ファイルの上書きを `write_file.overwrite: ask`、任意の `run_command` を `ask` とします。`start_process: allow *` は `safeCommandOnly: true` を前提とし、既存のワークスペース内通常ファイル1件を開く操作だけに制限されます。permissions がこのハードガードを広げることはありません。`config.flex.json` は `agentLoop: "v1"` を既定のまま保持するため、これらの `permissions` は将来 v2 を選択したときだけ有効です。

```json
{
  "permissions": [
    { "permission": "list_files", "pattern": "*", "action": "allow" },
    { "permission": "read_file", "pattern": "*", "action": "allow" },
    { "permission": "read_files", "pattern": "*", "action": "allow" },
    { "permission": "read_xlsx", "pattern": "*", "action": "allow" },
    { "permission": "search_files", "pattern": "*", "action": "allow" },
    { "permission": "write_file", "pattern": "*", "action": "allow" },
    { "permission": "write_file.overwrite", "pattern": "*", "action": "ask" },
    { "permission": "start_process", "pattern": "*", "action": "allow" },
    { "permission": "run_command", "pattern": "*", "action": "ask" }
  ]
}
```

`allow` は宣言的権限だけの許可であり、ワークスペース境界、シンボリックリンク／再解析点、引数スキーマ、`safeCommandOnly`、危険なコマンド操作などの既存ハードガードを迂回できません。削除・破壊的操作はハードガードの段階で拒否され、permissions で承認可能な経路がないため、専用の権限規則は不要です。

```json
{
  "agentLoop": "v2",
  "permissions": [
    { "permission": "write_file", "pattern": "*", "action": "ask" },
    { "permission": "write_file", "pattern": "generated/**", "action": "allow" },
    { "permission": "write_file", "pattern": "generated/secrets/**", "action": "deny" },
    { "permission": "run_command", "pattern": "*", "action": "ask" },
    { "permission": "run_command", "pattern": "git status", "action": "allow" }
  ]
}
```

未指定または空配列の `permissions` は従来どおりです。設定例のように広い `ask` を先に置き、後ろへ狭い `allow` / `deny` を置いてください。

## 実行監査ログ（issue #37）

hostツールの完了結果は、既存の`AgentEvent`を`callId`で相関して、専用の`audit.jsonl`へ1結果1行で追記します。既定保存先はワークスペース外のWindows `LOCALAPPDATA\\CompanyAppsShare\\audit\\audit.jsonl`（環境変数がない場合は決定的なユーザー状態／一時領域フォールバック）です。`auditLogDir`で保存ディレクトリを上書きできますが、ワークスペース内を指定すると起動時に拒否されます。ログはUTC日付で分割せず、1つの安定したファイルをappendモードだけで使います。

各行は`schema_version: 1`のJSONオブジェクトで、`event_id`、`timestamp`、`session_id`、`run_id`、`call_id`、`tool_name`、`arguments`（要約と最終引数のSHA-256のみ）、`permission`、`approval`、`result`、`target`（利用可能な変更前／変更後ハッシュを含む）を持ちます。読み取り・CSV出力は次の読み取り専用APIから行えます。`limit`は最大500件で、`tool`、`result`（`success` / `failure` / `refused`）、`permission`（`allow` / `ask` / `deny`）で絞り込めます。クライアントからファイルパスは受け取りません。

```text
GET /api/audit?limit=100&result=refused
GET /api/audit.csv?tool=host.write_file
```

書き込み・切り詰め・削除APIはありません。セッション履歴の削除・選択は監査ログから独立しています。監査ログは追記整合性を目的とし、ハッシュチェーンや改ざん防止は対象外です。承認の事実はUI状態やクライアント理由文字列ではなく、サーバーが既存の承認API／`approval.requested` / `approval.resolved`イベントへ付与する構造化`provenance`（`actor`、`automatic`）から記録します。UI解決は常に`actor=user`、期限切れ・キャンセル・終了による解決は`actor=policy`です。追記障害を検知したサーバーはunhealthyをラッチし、後続のwork／resume／retryを503で停止します。

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

The local heterogeneous corpus passed 16/16 for host operations and 16/16 for deterministic layer-1 interpretation: list 3/3, read 4/4 (including text, CSV, xlsx, and missing file), open 3/3, write 3/3, and search 3/3. The expanded fifteen-case negative gate, including an unescaped Windows-path example, Japanese/English negated tool JSON, unavailable-operation sentences, and a tool-description sentence, produced zero false-positive tool calls. Thirty jsonrepair-inspired malformed-JSON categories passed 30/30 with schema-invalid values still rejected. The optional Q4_K_M converter separately retained its prior 16/16 positive and zero-false-positive eight-case adoption gate. Real Copilot task evidence and the kickoff stability decision are recorded in `FLEX-VALIDATION.md`. These are preparation-PC measurements, not company-PC EDR results.

For repeatable preparation-PC performance evidence, start the agent on port 3951 with a disposable workspace and run `npm run flex:measure:copilot -- http://127.0.0.1:3951 .tmp/flex-copilot-performance .tmp/flex-performance/result.json`. The driver exercises list, read, search, new-file write, and open with fresh sessions, auto-approves only its disposable write/open fixture, and records per-phase timings. The final layer-1-only run was 5/5 at 14.929–19.677 seconds. All nine model decisions were resolved by layer 1; layer 2 and failed decisions were both zero. Copilot generation, not local conversion or response retrieval, was the dominant interval. See `FLEX-VALIDATION.md` for the one-change-at-a-time comparison and rejected experiments.

For the optional OpenAI-compatible wrapper and tested OpenCode setup, see `README-OPENAI-BRIDGE.md`. The OpenCode executable is a hash-pinned GitHub Release asset and is not in Git history. After the final relative-path repair, the preparation-PC OpenCode gate completed list, read, search, new-file write, and actual application open 5/5 in 19.350–27.344 seconds. Company-PC execution remains a morning gate.

Operating rules: use one clear request at a time; inspect before editing; approve writes and application opens deliberately; keep requested paths inside the selected workspace; treat missing files as a question rather than a reason to guess. Allowed document-open forms are restricted to an existing, regular, non-link workspace document or media file (`Invoke-Item`, `Start-Process`, or `excel.exe` for `.xlsx`); executable/script/shortcut/URL files and reparse points are denied. Flex configuration sets `safeCommandOnly`, so other shell input and network-backed host tools are removed from the model contract and rejected again at execution. Deletion, network, registry mutation, encoded PowerShell, shell metacharacters, and workspace escape are denied.

The default web UI starts in the Japanese assistant view described above. The unchanged projection-friendly classic view is available at `/classic`; it shows the user request, a collapsed Japanese activity line, the final answer, and links for artifacts. Internal events, raw logs, run IDs, diffs, and verification evidence remain hidden from the classic demo view unless its existing `診断ビュー` toggle is used. Failed and older sessions are collapsed under `過去の実行` by default.

Company-PC remaining checks: first run layer 1 alone; confirm the Copilot account/session, rendered Edge send control, corporate endpoint behavior, and a real document-open approval. Only when enabling the optional insurance layer, check Release access and antivirus treatment of the downloaded single binary. If startup shows error `0xC0E90002`, check Code Integrity events 3033/3077; do not call it file corruption until the complete-file SHA-256 has also failed. Those are manual checks and are not asserted by the local smoke suite.
