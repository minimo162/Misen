# Third-party inventory for 連結デモ

この一覧は、`demo/renketsu-demo` の読み取り・抽出補助と `apps/coding-agent` の JSON 補助に同梱するもの、および任意導入のFlex runtimeを固定するための記録です。デモ本体の実行時にパッケージ取得や外部URL照会は行いません。任意のFlex runtimeだけは明示的な準備工程でGitHub Releaseから取得し、manifestのSHA-256照合後に使います。バージョンとlicenseは同梱ファイル、manifest、lockfileを先に確認し、実機EDR結果は別の監査記録へ保存します。

## 収録物

| コンポーネント | 固定バージョン | License | 同梱場所 | 用途 |
| --- | --- | --- | --- | --- |
| ImportExcel | 7.8.10 | Apache-2.0 | `demo/renketsu-demo/workspace/vendor/ImportExcel/7.8.10/` | `tools/Read-Xlsx.ps1` から xlsx を読むための PowerShell モジュール |
| EPPlus.dll | Assembly/File 4.5.3.2 | LGPL-3.0-or-later | `demo/renketsu-demo/workspace/vendor/ImportExcel/7.8.10/EPPlus.dll` | ImportExcel が xlsx を解析する CLR アセンブリ。legacy/unsupported parser のため、信頼した入力だけで使う |
| iconv-lite | 0.6.3 | MIT | `apps/coding-agent/vendor/npm/node_modules/iconv-lite/` | CP932 等のテキスト decode 補助 |
| jsonrepair | 3.15.0 | ISC | `apps/coding-agent/vendor/npm/node_modules/jsonrepair/` | 層1で厳密parseに失敗したJSON候補を純JSで修復し、再parse・host tool schema検証へ渡す補助。追加exeなし |
| safer-buffer | 2.1.2 | MIT | `apps/coding-agent/vendor/npm/node_modules/safer-buffer/` | iconv-lite の依存 buffer 実装 |
| OpenCode | 1.18.21 Windows x64 | MIT | GitHub Release `flex-runtime-v1`; manifest/script/license only in `apps/coding-agent/vendor/opencode/` | OpenAI互換bridgeへ接続する任意OSSハーネス。exeはGit履歴に入れず、取得時にサイズ・SHA-256・単独起動を検査 |
| OpenCode permission evaluator | c2eacd72afc4a4984564c393e15ab30011057269 | MIT | `apps/coding-agent/src/vendor/opencode-permission/{evaluate,wildcard,arity}.ts` と `LICENSE` | `sst/opencode`（canonical: `anomalyco/opencode`）の `evaluate()`、wildcard `match()`、command-prefix `prefix()` の純粋部分を固定vendor。上流URLと元パスは各ファイル先頭に記録 |
| Vercel AI SDK (`ai`) | 6.0.268 | Apache-2.0 | `apps/coding-agent/package-lock.json` / npm install | 実験的なagent loop v2のモデル・tool loop API |
| AI SDK OpenAI-Compatible Provider (`@ai-sdk/openai-compatible`) | 2.0.72 | Apache-2.0 | `apps/coding-agent/package-lock.json` / npm install | copilot-openai-bridgeの `/v1/chat/completions` へ接続するprovider |
| shell-quote | 1.10.0 | MIT | `apps/coding-agent/package-lock.json`; install時の `apps/coding-agent/node_modules/shell-quote/` | v2 permission hookでのshell token/operator解析。追加の `@types/shell-quote` は導入しない |
| assistant-ui React (`@assistant-ui/react`) | 0.15.16 | MIT | `apps/coding-agent/package-lock.json` / npm install | 既存サーバー状態を表示するスレッド、コンポーザー、ExternalStoreRuntimeのUIプリミティブ。ツール実行・承認は委譲しない |
| React | 19.2.8 | MIT | `apps/coding-agent/package-lock.json` / npm install | assistant-ui ベースのブラウザ画面の描画 |
| React DOM | 19.2.8 | MIT | `apps/coding-agent/package-lock.json` / npm install | ブラウザの `#app` への React マウント |

`apps/coding-agent/vendor/npm/package-lock.json` の resolved/integrity と `package.json` の exact dependency も、上記 npm パッケージの固定根拠です。ImportExcel の `ImportExcel.psd1` は ModuleVersion 7.8.10 と `EPPlus.dll` の required assembly を示します。

自作の `Build-DemoData.ps1` と `workspace/tools/` 配下4本は UTF-8 BOM付き・CRLFで固定し、Windows PowerShell 5.1 parserで検査します。一方、`vendor/` 内の第三者配布 `.ps1` は取得物の同一性を優先して上流の改行・encodingを変更しません。

## License 本文の場所

- ImportExcel (Apache-2.0): `demo/renketsu-demo/workspace/vendor/ImportExcel/7.8.10/LICENSE.txt`。`ImportExcel.psd1` の LicenseUri は <https://github.com/dfinke/ImportExcel/blob/master/LICENSE.txt> です。
- EPPlus 4.5.3.2 (LGPL-3.0-or-later): `demo/renketsu-demo/workspace/vendor/ImportExcel/7.8.10/EPPlus-LICENSE.txt`。取得元・NuGet package hash・DLL hash・版は同ディレクトリの `EPPlus-NOTICE.txt` に記録しています。ImportExcel の Apache 本文を EPPlus の license 本文として扱いません。
- iconv-lite (MIT): `apps/coding-agent/vendor/npm/node_modules/iconv-lite/LICENSE`。
- jsonrepair 3.15.0 (ISC): `apps/coding-agent/vendor/npm/node_modules/jsonrepair/LICENSE.md`。同梱実物の本文は Copyright (c) 2020-2026 Jos de Jong、package.json の license も ISC と確認しています。
- safer-buffer (MIT): `apps/coding-agent/vendor/npm/node_modules/safer-buffer/LICENSE`。
- OpenCode 1.18.21 (MIT): `apps/coding-agent/vendor/opencode/LICENSE-OpenCode.txt`。同梱実物の本文は Copyright (c) 2025 opencode、npm package の license も MIT と確認しています。Release asset `opencode-1.18.21-windows-x64.exe` は 179,463,208 bytes、SHA-256 `EA4F4D4BEC95CD41BAF0FC53ADC4E34B31E1C8676DC5B2507C8797AB1884AF18` です。上流は `anomalyco/opencode` tag `v1.18.21` の公式 `opencode-windows-x64.zip`（60,622,013 bytes、SHA-256 `F8CC5477F478FA129ECE99B550D508363CEFF612F99D859042E526B13B951542`）。ZIPを照合後に `Expand-Archive` し、唯一の `opencode.exe` を無変更でコピーしたところ内部assetとSHA-256が一致しました。
- OpenCode permission evaluator (MIT): `apps/coding-agent/src/vendor/opencode-permission/LICENSE`。`evaluate.ts` は `packages/opencode/src/permission/index.ts` の `evaluate()`、`wildcard.ts` は `packages/core/src/util/wildcard.ts` の `match()`、`arity.ts` は `packages/opencode/src/permission/arity.ts` の `prefix()` と辞書を、commit `c2eacd72afc4a4984564c393e15ab30011057269` から抽出しています。各vendorファイルに canonical URL・元パス・固定SHA・MIT・適応内容を記載しています。
- Vercel AI SDK 6.0.268 (Apache-2.0): `apps/coding-agent/node_modules/ai/LICENSE`（install時）およびpackage metadata。固定解決版は `apps/coding-agent/package-lock.json` に記録します。
- AI SDK OpenAI-Compatible Provider 2.0.72 (Apache-2.0): `apps/coding-agent/node_modules/@ai-sdk/openai-compatible/LICENSE`（install時）およびpackage metadata。固定解決版は `apps/coding-agent/package-lock.json` に記録します。
- shell-quote 1.10.0 (MIT): `apps/coding-agent/node_modules/shell-quote/LICENSE`（install時）。固定解決版、resolved URL、integrity、license は `apps/coding-agent/package-lock.json` に記録します。`@types/shell-quote` は追加していません。
- assistant-ui React 0.15.16 (MIT): `apps/coding-agent/node_modules/@assistant-ui/react/LICENSE`（install時）および package metadata。固定解決版、resolved URL、integrity、license は `apps/coding-agent/package-lock.json` に記録します。ExternalStoreRuntime のpresentation-only利用であり、client-side tool executionは有効化しません。
- React 19.2.8 / React DOM 19.2.8 (MIT): `apps/coding-agent/node_modules/react/LICENSE`、`apps/coding-agent/node_modules/react-dom/LICENSE`（install時）および package metadata。固定解決版、resolved URL、integrity、license は `apps/coding-agent/package-lock.json` に記録します。

## 取得と実行の境界

1. 取得は build/準備工程だけで行い、必ず上表の exact version を指定します。npm 依存は次のように `--ignore-scripts` と `--save-exact` を併用し、lockfile をレビューします（デモ中には実行しません）。

   ```powershell
   npm install --ignore-scripts --save-exact iconv-lite@0.6.3 jsonrepair@3.15.0
   ```

2. ImportExcel は PowerShell Gallery の 7.8.10 パッケージを準備工程で保存し、`vendor/ImportExcel/7.8.10/` に展開します。`Install-Module` やダウンロードを `Read-Xlsx.ps1`／`Update-Ledger.ps1` の実行時に呼び出しません。
3. 実行時のネットワーク取得、パッケージ install、外部 script の評価を禁止します。任意のFlex runtime取得はデモ開始前の準備工程に限定します。共有フォルダー上のまま実行せず、承認済みlocal-copyとSHA-256確認済みRelease資産だけを使います。
4. 同梱 DLL／script は EDR canary の後に使い、Excel や入力 xlsx はデモ用に信頼したものだけを対象にします。EPPlus 4.5.3.2 は legacy/unsupported parser であり、「安全」とは表現しません。悪意ある xlsx に対する残余リスクがあります。
5. OpenCode は `Get-OpenCode.ps1` で Release から取得し、manifest のサイズ・SHA-256照合後に `--version` を単独実行します。会社PCのEDR/プロキシ結果はこの準備PCの成功から推定せず、朝のゲートで確認します。

## 受入れレビュー（毎回の手順）

準備工程で次を実行し、結果・実行日・担当者を監査ログへ残します。ここでは pass を自動宣言せず、欠落した証跡は未確認と記録します。

```powershell
$root = (Resolve-Path .).Path
$vendor = Join-Path $root 'demo\renketsu-demo\workspace\vendor'
$npmVendor = Join-Path $root 'apps\coding-agent\vendor\npm'
Get-ChildItem $vendor -Recurse -File | Where-Object Extension -ieq '.exe'
Get-ChildItem $npmVendor -Recurse -File | Where-Object Extension -ieq '.exe'
rg -n -i "Invoke-WebRequest|Invoke-RestMethod|WebClient|Start-BitsTransfer|Install-Module|npm (install|update)|http://|https://" $vendor $npmVendor
Get-FileHash (Join-Path $vendor 'ImportExcel\7.8.10\EPPlus.dll') -Algorithm SHA256
Get-FileHash (Join-Path $vendor 'ImportExcel\7.8.10\ImportExcel.psd1') -Algorithm SHA256
```

- `.exe` の出力は空であることを人が確認します。出力があれば配布を止め、理由と除外根拠を記録します。
- `rg` は runtime download、外部 script 呼出し、不要な egress の候補を探す静的レビューです。文字列が説明やテストにある場合は、実行経路を目視で切り分けます。
- 実測 SHA256 は、EPPlus.dll `C32CEFBD1EA051ED3AF06E7FB9DD558598A612F042164140CD8BE722A351BC63`、ImportExcel.psd1 `DCC25C276A757E7364B4AFF5A7D51AA7E1F666F4BCD90D19D82DF7E0F869F151`、EPPlus-LICENSE.txt `E3A994D82E644B03A792A930F574002658412F62407F5FEE083F2555C5F23118` です。版を更新したら再計測します。
- 既知 CVE は、各 exact version を GitHub Advisory、OSV、NVD 等の一次／公式検索で照合し、URL・検索日・結果をログに残します。2026-08-25 の公式 ImportExcel/EPPlus advisory ページでは matching GitHub advisory が見つからなかった、という限定的な結果だけを記録し、完全な CVE 不在や「安全」を宣言しません。同日の `npm audit --omit=dev --package-lock-only` は npm 依存について `found 0 vulnerabilities` でしたが、これも将来の安全保証ではありません。
- license 本文、notice、依存関係の差分をレビューし、版が変わったら受入れをやり直します。

## 更新手順

1. 更新理由（CVE、互換性、版の EOL）と対象コンポーネントを記録し、demo 実行中の更新はしません。
2. 承認済みの準備環境で exact version を取得し、npm は `--ignore-scripts --save-exact`、ImportExcel は exact module version として保存します。runtime network は残しません。
3. `package-lock.json`／manifest、license 本文、依存差分、`.exe` の有無、source の egress 文字列、SHA256、公式 advisory 結果、EDR canary を再レビューします。
4. `Read-Xlsx`、`Update-Ledger`、壊れた JSON／CP932／xlsx のローカルテストと、同じ入力での ledger 比較を実施します。実機 Excel/Copilot/Edge/EDR は別の朝チェックで確認します。
5. 受入れ済みの版・場所・hash・license パスをこの文書と監査ログへ反映し、旧版を削除する場合は参照が無いことを確認してから行います。

## 現時点の未確定事項

- Windows 実機の EDR canary、Excel Desktop、Copilot Edge、共有フォルダー local-copy は、明朝のチェックリストが pass するまで未確認です。
# Flex runtime (optional Release assets)

- **llama.cpp** — official `ggml-org` unified Windows CPU binary `b10612` for detected CPU feature code `qrkkk`; complete executable SHA-256 `9bef3d41385f98a5b8eb0ffd621310a377670725bf6c4bbff23335f45c223157`; MIT License. The pinned official source is `https://huggingface.co/buckets/ggml-org/install.sh/resolve/b10612/x86_64/windows/cpu/qrkkk/llama-app.exe.zst` (compressed SHA-256 `70a611b512a2155abf8580f15b506f53bae8ca48f16eddd3f56018e6735e5746`), decompressed with the same official bucket's `unzstd.exe` (SHA-256 `d845a5b17c7b5f7e8421f32d8e981b0092c4b262e9dba7f370f38bb24470a6f3`). `llama.exe serve` is the single-binary `llama-server` entry point. The executable is an optional `flex-runtime-v1` GitHub Release asset and is not stored in Git history. The preparation PC rejected the nightly ZIP's separate unsigned `ggml.dll` with Code Integrity events 3033/3077 and status `0xC0E90002`; the pinned unified binary passed `llama.exe version` without loading that DLL.
- **Qwen3.5-4B-GGUF** — `unsloth/Qwen3.5-4B-GGUF`, file `Qwen3.5-4B-Q4_K_M.gguf` (2,740,937,888 bytes); locally verified SHA-256 `00fe7986ff5f6b463e62455821146049db6f9313603938a70800d1fb69ef11a4`; Apache-2.0. Qwen3.5-0.8B Q4 was rejected after a 2/16 conversion result. Qwen3.5-4B Q4_0 established a 16/16 baseline, and Q4_K_M retained 16/16 plus zero false positives on the eight-case negative gate. The canonical Apache-2.0 notice is retained as `apps/coding-agent/vendor/flex-runtime/LICENSE-Qwen3.5-Apache-2.0.txt`. Source: https://huggingface.co/unsloth/Qwen3.5-4B-GGUF/blob/main/Qwen3.5-4B-Q4_K_M.gguf. The 31 split files are optional `flex-runtime-v1` GitHub Release assets, not Git history; the checked-in manifest records the locally verified complete-file SHA-256 and every asset SHA-256.


## Enterprise Misen Pi demo

Enterprise Misen pins `@earendil-works/pi-agent-core@0.84.4` and `@earendil-works/pi-ai@0.84.4`. Pi source is [earendil-works/pi](https://github.com/earendil-works/pi), tag `v0.84.4`, commit `b79e4cc834970cca69daebffab7df1da7d1e52c4`; package metadata lists MIT licensing. Pi Agent Core transitively includes `@earendil-works/pi-telemetry`; this demo registers no telemetry exporter and grants no telemetry network authority. The `@agegr/pi-web@0.8.11` prior-art application was rejected because its full Next/CLI/pi-coding-agent surface includes models/keys, cwd browse, git, bash, plugins/skills, subagents, worktrees, updates, push, and raw thinking; it has no restricted reusable component seam.

The Office document engine is [iOfficeAI/OfficeCLI](https://github.com/iOfficeAI/OfficeCLI) v1.0.147, source commit `b94f3906fd52d450c64f8e40370e376b9e15079e`, under Apache-2.0. The prepared Windows x64 runtime bundles the official self-contained release asset `officecli-win-x64.exe` with SHA-256 `724056e5ff079c3585df79c8afc386f08ef7d5f956cf4e2723534e129aab6e80`, plus the pinned source `LICENSE` and `NOTICE`. Misen disables updater and resident-process behavior and invokes the binary only through typed spreadsheet capabilities. Full provenance and capability evidence are recorded in `apps/enterprise-misen/docs/officecli-migration.md` and the CycloneDX SBOM.

Independent bounded OpenXML Acceptance uses exact-pinned `fflate@0.8.3` and `fast-xml-parser@5.9.3`, both MIT. They inspect ZIP/XML relationships, formulas, and preservation metadata; they are not a second workbook mutation engine.

The browser presentation pins `@assistant-ui/react@0.15.17` (MIT; tag commit `b6e7ab88b5e6e60866695d31a08adc3a80f449ff`), `react@19.2.8`, and `react-dom@19.2.8`. Misen uses only assistant-ui's public External Store Runtime and Thread/Message/Composer primitives. The transitive `assistant-cloud@0.1.42` package is not imported, instantiated, or configured by Misen; no Assistant Cloud endpoint or telemetry authority is enabled. `esbuild@0.25.11` is an exact-pinned development-only browser bundler: its platform package contains a native build executable and its install script prepares that executable during dependency installation, but neither esbuild nor a child process is present in the normal Agent runtime. Production dependency installation remains `npm ci --ignore-scripts`; browser assets are built in the preparation environment.

SBOM generation uses the development-only official `@cyclonedx/cyclonedx-library@10.2.0` (Apache-2.0) JSON validator with exact `ajv@8.20.0`, `ajv-formats@3.0.1`, and `ajv-formats-draft2019@1.6.1` peers. These packages are not imported by the Agent runtime; they validate the generated CycloneDX 1.6 artifact and a deliberately invalid negative control during the release evidence step.
