# Third-party inventory for 連結デモ

この一覧は、`demo/renketsu-demo` の読み取り・抽出補助と `apps/coding-agent` の JSON 補助に同梱するものを固定するための記録です。実行時にパッケージを取得したり、外部 URL へ問い合わせたりしません。バージョンと license は同梱ファイル、manifest、lockfile を先に確認し、ハッシュと実機 EDR 結果は別の監査記録へ保存します。

## 収録物

| コンポーネント | 固定バージョン | License | 同梱場所 | 用途 |
| --- | --- | --- | --- | --- |
| ImportExcel | 7.8.10 | Apache-2.0 | `demo/renketsu-demo/workspace/vendor/ImportExcel/7.8.10/` | `tools/Read-Xlsx.ps1` から xlsx を読むための PowerShell モジュール |
| EPPlus.dll | Assembly/File 4.5.3.2 | LGPL-3.0-or-later | `demo/renketsu-demo/workspace/vendor/ImportExcel/7.8.10/EPPlus.dll` | ImportExcel が xlsx を解析する CLR アセンブリ。legacy/unsupported parser のため、信頼した入力だけで使う |
| iconv-lite | 0.6.3 | MIT | `apps/coding-agent/vendor/npm/node_modules/iconv-lite/` | CP932 等のテキスト decode 補助 |
| jsonrepair | 3.15.0 | ISC | `apps/coding-agent/vendor/npm/node_modules/jsonrepair/` | 層1で厳密parseに失敗したJSON候補を純JSで修復し、再parse・host tool schema検証へ渡す補助。追加exeなし |
| safer-buffer | 2.1.2 | MIT | `apps/coding-agent/vendor/npm/node_modules/safer-buffer/` | iconv-lite の依存 buffer 実装 |

`apps/coding-agent/vendor/npm/package-lock.json` の resolved/integrity と `package.json` の exact dependency も、上記 npm 3 パッケージの固定根拠です。ImportExcel の `ImportExcel.psd1` は ModuleVersion 7.8.10 と `EPPlus.dll` の required assembly を示します。

自作の `Build-DemoData.ps1` と `workspace/tools/` 配下4本は UTF-8 BOM付き・CRLFで固定し、Windows PowerShell 5.1 parserで検査します。一方、`vendor/` 内の第三者配布 `.ps1` は取得物の同一性を優先して上流の改行・encodingを変更しません。

## License 本文の場所

- ImportExcel (Apache-2.0): `demo/renketsu-demo/workspace/vendor/ImportExcel/7.8.10/LICENSE.txt`。`ImportExcel.psd1` の LicenseUri は <https://github.com/dfinke/ImportExcel/blob/master/LICENSE.txt> です。
- EPPlus 4.5.3.2 (LGPL-3.0-or-later): `demo/renketsu-demo/workspace/vendor/ImportExcel/7.8.10/EPPlus-LICENSE.txt`。取得元・NuGet package hash・DLL hash・版は同ディレクトリの `EPPlus-NOTICE.txt` に記録しています。ImportExcel の Apache 本文を EPPlus の license 本文として扱いません。
- iconv-lite (MIT): `apps/coding-agent/vendor/npm/node_modules/iconv-lite/LICENSE`。
- jsonrepair 3.15.0 (ISC): `apps/coding-agent/vendor/npm/node_modules/jsonrepair/LICENSE.md`。同梱実物の本文は Copyright (c) 2020-2026 Jos de Jong、package.json の license も ISC と確認しています。
- safer-buffer (MIT): `apps/coding-agent/vendor/npm/node_modules/safer-buffer/LICENSE`。

## 取得と実行の境界

1. 取得は build/準備工程だけで行い、必ず上表の exact version を指定します。npm 依存は次のように `--ignore-scripts` と `--save-exact` を併用し、lockfile をレビューします（デモ中には実行しません）。

   ```powershell
   npm install --ignore-scripts --save-exact iconv-lite@0.6.3 jsonrepair@3.15.0
   ```

2. ImportExcel は PowerShell Gallery の 7.8.10 パッケージを準備工程で保存し、`vendor/ImportExcel/7.8.10/` に展開します。`Install-Module` やダウンロードを `Read-Xlsx.ps1`／`Update-Ledger.ps1` の実行時に呼び出しません。
3. 実行時のネットワーク取得、パッケージ install、外部 script の評価を禁止します。共有フォルダー上のまま実行せず、承認済み local-copy の同梱ファイルだけを使います。
4. 同梱 DLL／script は EDR canary の後に使い、Excel や入力 xlsx はデモ用に信頼したものだけを対象にします。EPPlus 4.5.3.2 は legacy/unsupported parser であり、「安全」とは表現しません。悪意ある xlsx に対する残余リスクがあります。

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
# Flex runtime

- **llama.cpp** — official `ggml-org` unified Windows CPU binary `b10612` for detected CPU feature code `qrkkk`; complete executable SHA-256 `9bef3d41385f98a5b8eb0ffd621310a377670725bf6c4bbff23335f45c223157`; MIT License. The pinned official source is `https://huggingface.co/buckets/ggml-org/install.sh/resolve/b10612/x86_64/windows/cpu/qrkkk/llama-app.exe.zst` (compressed SHA-256 `70a611b512a2155abf8580f15b506f53bae8ca48f16eddd3f56018e6735e5746`), decompressed with the same official bucket's `unzstd.exe` (SHA-256 `d845a5b17c7b5f7e8421f32d8e981b0092c4b262e9dba7f370f38bb24470a6f3`). `llama.exe serve` is the single-binary `llama-server` entry point. Its split complete executable is retained under `apps/coding-agent/vendor/flex-runtime/parts`. The preparation PC rejected the nightly ZIP's separate unsigned `ggml.dll` with Code Integrity events 3033/3077 and status `0xC0E90002`; the pinned unified binary passed `llama.exe version` without loading that DLL.
- **Qwen3.5-4B-GGUF** — `unsloth/Qwen3.5-4B-GGUF`, file `Qwen3.5-4B-Q4_K_M.gguf` (2,740,937,888 bytes); locally verified SHA-256 `00fe7986ff5f6b463e62455821146049db6f9313603938a70800d1fb69ef11a4`; Apache-2.0. Qwen3.5-0.8B Q4 was rejected after a 2/16 conversion result. Qwen3.5-4B Q4_0 established a 16/16 baseline, and Q4_K_M retained 16/16 plus zero false positives on the eight-case negative gate, so Q4_K_M was adopted. The canonical Apache-2.0 notice is retained as `apps/coding-agent/vendor/flex-runtime/LICENSE-Qwen3.5-Apache-2.0.txt`. Source: https://huggingface.co/unsloth/Qwen3.5-4B-GGUF/blob/main/Qwen3.5-4B-Q4_K_M.gguf. The checked-in manifest records the locally verified complete-file SHA-256 and every split part SHA-256.
