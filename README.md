# Misen

広島・宮島の弥山（みせん）に由来する、社内向けAIエージェントプロジェクトです。

## coding-agent の起動

リポジトリの `コーディングエージェント起動.cmd` をダブルクリックすると、既定の workspace として `%USERPROFILE%\Documents\エージェント作業場` を作成・使用します。作成できない場合は日本語のエラーを表示して停止します。

別の既存フォルダーを workspace にする場合は、そのフォルダーを `コーディングエージェント起動.cmd` へドラッグ＆ドロップします。先頭のフォルダーを workspace として使い、2 個目以降のコマンドライン引数は coding-agent に透過します。指定先が存在するフォルダーでない場合は起動しません。

起動時は `launcher\launch.cmd` が共有 `apps\coding-agent` の版を確認します。初回または更新時にはローカルの版別領域へ取得し、manifest に記載された各ファイルの SHA-256 を検証してから current 版を有効化します。その後、検証済み版のサーバーを起動してブラウザーを開きます。

## テスト

回帰テストは 3 層に分かれています（Issue #93）。既定の `npm test` は unit 層だけを実行し、両アプリとも 30 秒以内に終わります。

| 層 | coding-agent | enterprise-misen | 必要なもの |
| --- | --- | --- | --- |
| unit | `npm test`（`node test/gate.mjs --tier unit`） | `npm test`（`node scripts/test.mjs unit`） | なし（ネットワーク・OfficeCLI・ブラウザーを使わない） |
| integration | `npm run test:integration`（プロセス起動・実ループバックサーバーを伴う smoke） | `npm run test:integration`（`*.integration.test.ts`、OfficeCLI 実行） | enterprise-misen は `MISEN_OFFICECLI_PATH` |
| live | `npm run test:live -- --live-copilot` など | `npm run test:live` | 実プロバイダーの資格情報。手動実行のみ |

ビルドは変更検知付きです。ソースが前回ビルドから変わっていなければ typecheck とビルドを飛ばします（coding-agent は `.tmp/build-stamp.json`、enterprise-misen は `dist/.build-stamp.json`）。強制ビルドは `--force-build`（coding-agent）または `npm run build:force`（enterprise-misen）です。
