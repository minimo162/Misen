# Misen v3 初期 PoC セットアップ

## 前提

- Node.js 22.19.0
- npm
- Ollama 0.33.1
- Ollama model `ornith-1.5:9b`
- `@deepseek-ai/dsh@0.1.2-alpha.2`（tag `dsh-v0.1.2-alpha.2`、provenance SHA `0a53fb55bea101816fa226bb964ae2bed71c343b`）

## インストール

リポジトリ直下で依存関係を固定します。

```powershell
npm ci
npm ls @deepseek-ai/dsh --depth=0
```

profile と preset は専用の DSH home の下に置きます。

```powershell
$env:DSH_HOME = Join-Path $env:USERPROFILE '.dsh-misen'
New-Item -ItemType Directory -Force (Join-Path $env:DSH_HOME 'profiles\misen') | Out-Null
Copy-Item .\profile\misen\package.json (Join-Path $env:DSH_HOME 'profiles\misen\package.json') -Force
Copy-Item .\profile\misen\cordis.patch.yml (Join-Path $env:DSH_HOME 'profiles\misen\cordis.patch.yml') -Force
New-Item -ItemType Directory -Force (Join-Path $env:DSH_HOME 'misen-agent-presets\misen-file') | Out-Null
Copy-Item .\agent-presets\misen-file\agent.cordis.yml (Join-Path $env:DSH_HOME 'misen-agent-presets\misen-file\agent.cordis.yml') -Force
```

The Misen profile disables DSH's shipped preset roots and points its roster at `$DSH_HOME/misen-agent-presets`. Keep the file named `agent.cordis.yml` beneath a preset root named `misen-file`.

## Ollama

```powershell
ollama serve
ollama pull ornith-1.5:9b
ollama list
```

The profile uses `http://127.0.0.1:11434/v1` and names `MISEN_LLM_API_KEY`. Set that variable to the dummy Ollama compatibility sentinel `ollama` below; no real secret is needed for local Ollama.

## 起動と config 確認

Set the launch environment explicitly before starting or dumping config:

```powershell
$env:DSH_TELEMETRY_DISABLED = '1'
$env:MISEN_LLM_API_KEY = 'ollama'
```

`ollama` is a dummy Ollama compatibility sentinel, not a secret.

```powershell
npm start
```

Before the first interactive request, inspect the effective profile with DSH's standard dump facility:

```powershell
npx dsh --profile misen --dump-config
```

The dump must show the alpha.2 profile, provider `misen-ollama`, model `ornith-1.5:9b`, context window 4096, reasoning disabled, read-only sandbox, and ask approval. The model-facing preset tools must be exactly `read`, `read_image`, `write`, `edit`, `glob`, and `grep`.
