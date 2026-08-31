# Misen

広島・宮島の弥山（みせん）に由来する、社内向けAIエージェントプロジェクトです。

## Enterprise Misen initial PoC (Decision 427)

The capability-constrained DSH + Spreadsheet research baseline lives in
[`apps/enterprise-misen`](apps/enterprise-misen/README.md). It is isolated from
the historical Home PoC and legacy coding-agent runtime. It proves a modular
DSH Agent Loop and dummy two-month Excel vertical slice; it does not claim live
GPT-5.6 Luna, corporate-device approval, or Enterprise production readiness.

## coding-agent の起動

リポジトリの `コーディングエージェント起動.cmd` をダブルクリックすると、既定の workspace として `%USERPROFILE%\Documents\エージェント作業場` を作成・使用します。作成できない場合は日本語のエラーを表示して停止します。

別の既存フォルダーを workspace にする場合は、そのフォルダーを `コーディングエージェント起動.cmd` へドラッグ＆ドロップします。先頭のフォルダーを workspace として使い、2 個目以降のコマンドライン引数は coding-agent に透過します。指定先が存在するフォルダーでない場合は起動しません。

起動時は `launcher\launch.cmd` が共有 `apps\coding-agent` の版を確認します。初回または更新時にはローカルの版別領域へ取得し、manifest に記載された各ファイルの SHA-256 を検証してから current 版を有効化します。その後、検証済み版のサーバーを起動してブラウザーを開きます。
