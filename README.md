# Misen

Misen は DeepSeek Harness (DSH) の profile / preset だけを管理する社内向け AI エージェント構成です。Misen 固有の実行ループは持たず、固定した DSH 構成を起動します。

## 起動

```powershell
npm ci
npm start
```

初回は [セットアップ手順](docs/setup.md) に従って profile と preset を DSH home に配置してください。実行には Windows の Ollama、`ornith-1.5:9b`、DSH の `@deepseek-ai/dsh@0.1.2-alpha.2` が必要です。

Misen profile は `misen-ollama` / `ornith-1.5:9b`、context window 4096、reasoning 無効、read-only sandbox、approval ask を固定します。agent preset の model-facing tools は `read`、`read_image`、`write`、`edit`、`glob`、`grep` のみです。

## 検証

Windows 実機での Ollama / Ornith acceptance は [v3 initial PoC acceptance](docs/acceptance/v3-initial-poc.md) の手順と結果を記録します。
