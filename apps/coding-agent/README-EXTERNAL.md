# 外部 OpenAI 互換プロバイダー（合成データ専用）

`external-openai` は、明示的に `agentLoop: "v2"` と
`externalProvider.enabled: true` を指定したときだけ使える、汎用の
OpenAI 互換 Chat Completions プロバイダーです。通常の `openai`、
`copilot-edge`、`ollama` の動作は変わりません。

## 設定と秘密情報

`config.external.example.json` をコピーして、`baseURL` と `model` を
利用する互換サーバーに合わせます。秘密情報は `apiKeyEnv` で指定した
環境変数から実行時だけ読み取ります。設定ファイルの `apiKey` は拒否され、
キーの値は保存・ログ・監査記録・API 応答・画面表示に出ません。

HTTPS は利用できます。HTTP は決定的なローカルテスト用の loopback URL
（`127.0.0.1`、`localhost`、`::1`）だけが許可され、URL のユーザー名・
パスワードは使えません。

## 合成ワークスペース境界

外部モデルへのリクエスト前に、現在のワークスペースの realpath が
`externalProvider.syntheticWorkspace`（設定ファイルの場所からの相対パス）
と完全一致することを確認します。さらに、ルート直下に通常ファイルの
`.company-apps-synthetic.json` が必要です。シンボリックリンク、欠落、JSONの
余分なキーや値違いはすべて fail-closed で停止します。

マーカーの契約は次の固定値です。

```json
{
  "schema": "company-apps.synthetic-workspace/v1",
  "classification": "synthetic",
  "purpose": "external-provider-validation"
}
```

同梱の `demo/external-provider-synthetic/workspace` には架空の会社名と状態
だけを置いています。実在企業の資料、認証情報、個人情報は配置しないでください。

外部プロバイダーは v2 の既存のツール引数検証、フック、権限、承認、
precondition 再確認、hard guard、監査の順序を共有します。境界確認に失敗した
場合はネットワーク要求を送らず、turn・再試行・再開・REPL のいずれも停止します。

P2（画像入力）は現行の `ChatMessage` / OpenAI bridge 契約が画像を受け付けない
ため、このプロバイダーでは実装していません。
