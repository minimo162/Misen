# Misen

広島・宮島の弥山（みせん）に由来する、社内向けAIエージェントプロジェクトです。

| アプリ | 役割 | 利用者の入口 |
| --- | --- | --- |
| Enterprise Misen（`apps/enterprise-misen`） | Excel / Word / PowerPoint を扱う社内向けエージェント。同梱 Node.js と OfficeCLI で動く自己完結ランタイム | 共有フォルダーの **`Misen起動.cmd`** |
| coding-agent（`apps/coding-agent`） | Copilot / Ollama を使うコーディングエージェント | 共有フォルダーの `start-coding-agent.cmd` |

## リポジトリ構成

```text
launcher\                利用者用（共有フォルダーへそのまま公開されるファイル）
  Misen起動.cmd            Enterprise Misen の唯一の起動入口
  launch.ps1               起動スクリプト本体（manifest 比較・SHA-256 検証・ローカル版の起動）
  test\launch.test.mjs     初回起動・2回目起動・版更新後の起動・改ざん検出の自動テスト
  start-coding-agent.cmd / コーディングエージェント起動.cmd / launch-coding-agent.*   coding-agent 用
scripts\                 管理者用
  prepare-misen.cmd / Prepare-Misen.ps1 / New-Misen.ps1        Enterprise Misen の構築と共有フォルダーへの公開
  prepare-coding-agent.cmd / Prepare-CodingAgent.ps1 / New-CodingAgent.ps1   coding-agent 用
  get-node.ps1 / get-llama.ps1 / start-llama.cmd / package-release.ps1       開発用
apps\enterprise-misen\   Enterprise Misen 本体
apps\coding-agent\       coding-agent 本体
```

## Enterprise Misen の起動（利用者）

共有フォルダーの `Misen起動.cmd` をダブルクリックするだけです。共有フォルダーから直接は実行せず、次の順で動きます。

1. 共有側 `manifest.json` の版数・公開IDを `%LOCALAPPDATA%\Misen\current.json` と比較する
2. 初回、または版数か公開IDが違うときだけ `app\` `runtime\` `workspace\` を `%LOCALAPPDATA%\Misen\versions\<version>\` へコピーし、manifest に記載された全ファイルの SHA-256 を検証してから `current` を切り替える（検証に失敗すると前回正常版に戻して停止）
3. 検証済みローカル版の同梱 Node.js でサーバーを起動し、ブラウザーで `http://127.0.0.1:8787/` を開く

作業フォルダーの既定は `%LOCALAPPDATA%\Misen\workspace` で、初回に共有側の雛形 `workspace\` からコピーされます。別のフォルダーを使う場合は、そのフォルダーを `Misen起動.cmd` へドラッグ＆ドロップしてください。書き込みは `%LOCALAPPDATA%\Misen` 配下と作業フォルダーだけで、共有フォルダーは読み取り専用のままです。

失敗時は日本語のメッセージを表示して停止します。直近の配布状態は `%LOCALAPPDATA%\Misen\state\launch.json` に記録されます（秘密情報は含みません）。

## coding-agent の起動

`launcher\コーディングエージェント起動.cmd` をダブルクリックすると、既定の workspace として `%USERPROFILE%\Documents\エージェント作業場` を作成・使用します。別の既存フォルダーを workspace にする場合は、そのフォルダーをドラッグ＆ドロップします。起動時は `launcher\launch-coding-agent.cmd` が共有 `apps\coding-agent` の版を確認し、初回または更新時にローカルの版別領域へ取得して SHA-256 を検証してから起動します。

## テスト

回帰テストは 3 層に分かれています（Issue #93）。既定の `npm test` は unit 層だけを実行し、両アプリとも 30 秒以内に終わります。

| 層 | coding-agent | enterprise-misen | 必要なもの |
| --- | --- | --- | --- |
| unit | `npm test`（`node test/gate.mjs --tier unit`） | `npm test`（`node scripts/test.mjs unit`） | なし（ネットワーク・OfficeCLI・ブラウザーを使わない） |
| integration | `npm run test:integration`（プロセス起動・実ループバックサーバーを伴う smoke） | `npm run test:integration`（`*.integration.test.ts`、OfficeCLI 実行） | enterprise-misen は `MISEN_OFFICECLI_PATH` |
| live | `npm run test:live -- --live-copilot` など | `npm run test:live` | 実プロバイダーの資格情報。手動実行のみ |

ビルドは変更検知付きです。ソースが前回ビルドから変わっていなければ typecheck とビルドを飛ばします（coding-agent は `.tmp/build-stamp.json`、enterprise-misen は `dist/.build-stamp.json`）。強制ビルドは `--force-build`（coding-agent）または `npm run build:force`（enterprise-misen）です。

起動入口のテストはリポジトリ直下で次を実行します（Windows のみ。一時フォルダーを共有フォルダーに見立て、初回起動・2回目起動・版更新後の起動・改ざん検出を確認します）。

```bash
node --test launcher/test/launch.test.mjs
```
