# 社内PCへの配布

## 管理者側

1. 管理者PCの任意の作業フォルダーでリポジトリをcloneします。保存先は固定ではありません。

```cmd
cd C:\任意の作業フォルダー
git clone https://github.com/minimo162/company-apps-share.git
cd company-apps-share
```

2. 共有フォルダーへ公開します。clone先の `scripts\prepare-company-apps.cmd` を実行してください。依存関係の構築、型チェック、ビルド、スモークテスト、Node.jsランタイム準備、公開をまとめて行います。`-Version` を省略すると `apps\coding-agent\manifest.json` の版数を使います。

コマンドプロンプトから実行する場合:

```cmd
scripts\prepare-company-apps.cmd "\\fileserver\CompanyApps\company-apps-share" -CleanDestination
```

エクスプローラーから `scripts\prepare-company-apps.cmd` をダブルクリックすることもできます。共有フォルダーのUNCパスを入力してEnterを押してください。ダブルクリック時は `-CleanDestination` が自動で付くため、古い配布物を削除してから公開します。

版数を明示する場合は、コマンドプロンプトから次のように指定できます。

```cmd
scripts\prepare-company-apps.cmd "\\fileserver\CompanyApps\company-apps-share" -Version 0.10.1 -CleanDestination
```

共有先には、`launcher`、`apps\coding-agent`、`runtime\node-v...\node.exe`、`start-coding-agent.cmd` だけが配置されます。利用者には共有フォルダーの読み取り権限だけを付与してください。

## バージョン更新時（管理者側）

clone済みの同じフォルダーで、次の操作を行います。

```cmd
cd C:\任意の作業フォルダー\company-apps-share
git pull
```

その後、`scripts\prepare-company-apps.cmd` をダブルクリックし、同じ共有フォルダーのUNCパスを入力します。コマンドプロンプトからなら次の1行です。

```cmd
scripts\prepare-company-apps.cmd "\\fileserver\CompanyApps\company-apps-share" -CleanDestination
```

`manifest.json` の版数が共有先へ反映されるため、利用者は初回と同じ `start-coding-agent.cmd` をダブルクリックするだけで更新を取得します。

## 利用者側

利用者が使うファイルは、初回も更新後も同じ `start-coding-agent.cmd` です。

```text
\\fileserver\CompanyApps\company-apps-share\start-coding-agent.cmd
```

このファイルをダブルクリックすると、毎回次の処理を行います。

1. 共有側の `manifest.json` とローカル版数を比較
2. 初回または版数が違う場合、アプリ本体を `%LOCALAPPDATA%\CompanyApps` へ同期
3. Node.jsランタイムが無ければ同じ場所へ同期
4. ローカルに同期したWebサーバーを起動し、ブラウザーを開く

作業フォルダーを変える場合は、次のように引数を渡します。省略時は `Documents` を使います。

```text
start-coding-agent.cmd --workspace "C:\Users\me\Documents\my-project"
```

## 更新

管理者が新しい版を公開するときは、`manifest.json` の版数を上げてから、管理者側の `scripts\prepare-company-apps.cmd` をもう一度実行してください。同じ版数のままだと利用者は更新を取得しません。利用者は同じ `start-coding-agent.cmd` を使い続けます。

## 前提

- 管理者PC: Git、Node.js/npm、Windows PowerShell 5.1
- 利用者PC: Windows、Microsoft Edge とM365 Copilotへのサインイン
- 利用者PC: 共有フォルダーへの読み取り権限
- 利用者側の管理者権限は不要（ローカル同期先は `%LOCALAPPDATA%`）