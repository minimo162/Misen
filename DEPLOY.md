# 社内PCへの配布

Enterprise Misen を共有フォルダーへ公開し、利用者が `Misen起動.cmd` だけで使えるようにする手順です。coding-agent の配布は末尾の「coding-agent の配布」を参照してください。

## 共有フォルダーのレイアウト

```text
\\fileserver\CompanyApps\Misen\
  Misen起動.cmd          ← 利用者が触るのはこれだけ
  _misen\                ← 隠し属性。先頭アンダースコアで並び順の末尾
    manifest.json        ← current（有効な版）・版数・公開ID・各ファイルの SHA-256（misen-distribution/2）
    publish-log.txt      ← 公開直後の再検証結果（公開のたびに 1 行追記）
    versions\<version>\  ← 版別。前の版を 1 つ残し、それより古い版は公開時に削除
      app\               ← Enterprise Misen（dist, node_modules, package.json, dependency-lock.json）
      runtime\           ← 同梱 Node.js（runtime\node）と OfficeCLI（runtime\officecli）
      workspace\         ← 作業フォルダーの雛形（初回起動時に利用者のローカルへコピー）
      launcher\          ← launch.ps1 と、監査用の prepared-runtime\manifest.json / SHA256SUMS.txt
```

共有フォルダーには APIキーなどの秘密情報を置きません。共有フォルダーは読める人が全員書き込める前提なので、最上位に見えるのは `Misen起動.cmd` だけにし、それ以外は隠し属性の `_misen` 配下の版別フォルダーに置きます。誤って上書きしても前の版が残ります。

## 管理者側

1. 管理者PCの任意の作業フォルダーでリポジトリを clone します。

```cmd
cd C:\任意の作業フォルダー
git clone https://github.com/minimo162/Misen.git
cd Misen
```

2. `scripts\prepare-misen.cmd` を実行します。`npm ci` → unit 層テスト → Node.js / OfficeCLI ランタイムの取得と SHA-256 検証 → 自己完結ランタイムの生成と検証 → 共有フォルダーへの公開、をまとめて行います。作業領域は `%LOCALAPPDATA%\Misen\staging` です。

コマンドプロンプトから:

```cmd
scripts\prepare-misen.cmd "\\fileserver\CompanyApps\Misen" -CleanDestination
```

エクスプローラーから `scripts\prepare-misen.cmd` をダブルクリックし、共有フォルダーの UNC パスを入力して Enter を押しても同じです。ダブルクリック時は `-CleanDestination` が自動で付き、古い配布物を削除してから公開します。

主なオプション（`Prepare-Misen.ps1` に渡されます）:

| オプション | 意味 |
| --- | --- |
| `-Version 0.3.0` | 公開版数を明示する。省略時は `apps\enterprise-misen\package.json` の version |
| `-NodeRuntime <dir>` / `-OfficeCliRuntime <dir>` | 取得済み（検証済み）のランタイム入力フォルダーを使う。省略時は staging へ取得 |
| `-SkipNpmInstall` / `-SkipTests` | 依存関係の構築、unit テストを省略 |
| `-Url http://127.0.0.1:8787/` | 利用者側で開くループバック URL |

公開のたびに新しい公開ID（GUID）が発行され、`_misen\manifest.json` に全ファイルの SHA-256 が記録されます。公開スクリプトは `_misen\versions\<version>\` を作り、共有側のハッシュを再検証して結果を `_misen\publish-log.txt` に追記してから、最後に `manifest.json` の `current` を差し替えます。コピー途中の共有フォルダーを利用者が開いても前の版か新しい版のどちらかに整合します。前の版は 1 つ残し（`-KeepPreviousVersions`）、それより古い版は削除します。`-CleanDestination` は他の全版と旧レイアウトの残骸を削除します。

## バージョン更新時（管理者側）

```cmd
cd C:\任意の作業フォルダー\Misen
git pull
scripts\prepare-misen.cmd "\\fileserver\CompanyApps\Misen" -CleanDestination
```

版数を変えなくても公開IDが変わるため、利用者は次回のダブルクリックで自動的に更新を取得します。

## 利用者側

利用者が使うファイルは、初回も更新後も同じ `Misen起動.cmd` です。

```text
\\fileserver\CompanyApps\Misen\Misen起動.cmd
```

ダブルクリックすると毎回次の処理を行います。

1. 共有側 `_misen\manifest.json` の `current`（有効な版）・公開IDと `%LOCALAPPDATA%\Misen\current.json` を比較
2. 初回、または版数か公開IDが違う場合だけ `_misen\versions\<version>\` の `app\` `runtime\` `workspace\` を `%LOCALAPPDATA%\Misen\versions\<version>\` へコピーし、全ファイルの SHA-256 を検証してから `current` を切り替え（失敗時は前回正常版へ戻して停止）
3. 検証済みローカル版の `runtime\node\node.exe` でサーバーを起動し、ブラウザーで `http://127.0.0.1:8787/` を開く。既に起動中ならブラウザーだけを開く

作業フォルダーの既定は `%LOCALAPPDATA%\Misen\workspace`（初回に共有側 `workspace\` の雛形をコピー）です。別のフォルダーを使う場合は、そのフォルダーを `Misen起動.cmd` へドラッグ＆ドロップします。

利用者側の書き込み先は `%LOCALAPPDATA%\Misen` 配下と作業フォルダーだけです。

| パス | 内容 |
| --- | --- |
| `%LOCALAPPDATA%\Misen\versions\<version>\` | 検証済みの app / runtime / workspace 雛形（前回版を 1 つだけ残す） |
| `%LOCALAPPDATA%\Misen\current.json` | 有効な版と公開ID |
| `%LOCALAPPDATA%\Misen\state\launch.json` | 直近の配布状態（checking / syncing / integrity_passed / activated / verified / rolled_back / failed） |
| `%LOCALAPPDATA%\Misen\workspace\` | 既定の作業フォルダー |

## LLM 接続設定（利用者側）

初回のダブルクリックで、次のファイルが無ければテンプレートを作成してメモ帳で開き、起動を止めます。

```text
%LOCALAPPDATA%Misenconfigsettings.json
```

| 項目 | 意味 |
| --- | --- |
| `brain.provider` | `"openai"`（OpenAI 公式）/ `"anthropic"`（Anthropic 公式）/ `"openai-compatible"`（社内 LLM や llama.cpp などの OpenAI 互換 API） |
| `brain.model` | モデル名。公式プロバイダーは Pi の公式カタログにある ID だけ |
| `brain.apiKey` | 文字列で直接書くか、`{ "env": "OPENAI_API_KEY" }` で IT 部門が配布した環境変数を参照する。認証不要な openai-compatible では省略 |
| `brain.baseUrl` | openai-compatible のときだけ必須（http/https）。公式プロバイダーでは指定不可 |
| `brain.thinkingLevel` | 省略可（既定 medium） |

記入して保存したあと、もう一度 `Misen起動.cmd` をダブルクリックします。設定に誤りがあると日本語のメッセージで停止します（API キーは表示しません）。管理者が事前に確認する場合は、ローカル版の `appdistsrcuntimesettings-cli.js check --settings <path>` を同梱 Node.js で実行してください。

API キーは共有フォルダー・manifest・ログ・画面・セッション履歴に出ません。共有フォルダーには利用者の設定を置かないでください。

## 起動入口の自動テスト

一時フォルダーを共有フォルダーに見立て、初回起動・2回目起動・版更新後の起動・改ざんされた共有の拒否・ドラッグ＆ドロップ・`-SyncOnly` を確認します。

```bash
node --test launcher/test/launch.test.mjs
```

実機の共有フォルダーで事前確認する場合は、`Misen起動.cmd -SyncOnly` を実行すると取得と検証だけを行って終了します。

## テスト（管理者側）

公開前に各アプリで `npm test`（unit 層、30 秒以内）を実行してください。OfficeCLI を使う enterprise-misen の integration 層は `MISEN_OFFICECLI_PATH` を設定してから `npm run test:integration` で実行します。APIキーが必要な live 層は手動実行のみです。層の詳細は `README.md` の「テスト」を参照してください。

## 前提

- 管理者PC: Git、Node.js/npm、Windows PowerShell 5.1、ランタイム取得のためのインターネット接続（取得済み入力フォルダーを渡す場合は不要）
- 利用者PC: Windows、共有フォルダーへの読み取り権限。Node.js や Office のインストールは不要
- 利用者側の管理者権限は不要（ローカル同期先は `%LOCALAPPDATA%\Misen`）

## coding-agent の配布

coding-agent は従来どおり `scripts\prepare-coding-agent.cmd`（`Prepare-CodingAgent.ps1` / `New-CodingAgent.ps1`）で公開します。共有先には `launcher\launch-coding-agent.*`、`apps\coding-agent`、`runtime\node-v...\node.exe`、`start-coding-agent.cmd` が配置され、利用者は `start-coding-agent.cmd` を実行します。ローカル同期先は `%LOCALAPPDATA%\CompanyApps` です。

```cmd
scripts\prepare-coding-agent.cmd "\\fileserver\CompanyApps\CodingAgent" -CleanDestination
```

### Edge接続の分離

coding-agentは通常、空きポートと専用Edgeプロファイルを自動で割り当てます。既に動作中の別アプリのEdgeや固定CDPポートへは接続しません。`copilot.reuseExistingEdge` を `true` にした場合だけ、指定した `copilot.cdpPort` の既存Edgeへ明示的に接続します。

### 天気取得

天気・気温の質問は、地域を設定した `weather.defaultLocation`（例: `広島市`）を使ってOpen-Meteoから取得します。既定地域を使わない場合は質問に市区町村名を含めてください。
