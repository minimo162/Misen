param(
    [string]$ModelFile = 'Qwen3.8-27B-UD-IQ3_XXS.gguf',
    [string]$ModelUrl = 'https://huggingface.co/unsloth/Qwen3.8-27B-GGUF/resolve/main/Qwen3.8-27B-UD-IQ3_XXS.gguf',
    [switch]$SkipBinary,
    [switch]$SkipModel
)
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$shareRoot = Split-Path -Parent $PSScriptRoot
$llamaDir = Join-Path $shareRoot 'runtime\llama-cpp'
$modelDir = Join-Path $shareRoot 'runtime\models'

if (-not $SkipBinary) {
    Write-Host '[llama] 最新リリース情報を取得中...'
    $asset = $null
    $rels = Invoke-RestMethod -Uri 'https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=15'
    foreach ($r in $rels) {
        $asset = @($r.assets | Where-Object { $_.name -match '^llama-.+-bin-win-cpu-x64\.zip$' })[0]
        if ($asset) {
            Write-Host ("[llama] リリース: " + $r.tag_name)
            break
        }
    }
    if (-not $asset) {
        Write-Host '[llama] CPUアセットが見つかりません。候補:'
        ($rels | Select-Object -First 1).assets | ForEach-Object { Write-Host ('  - ' + $_.name) }
        throw 'win-cpu-x64 ビルドが見つかりません'
    }
    Write-Host ("[llama] ダウンロード: " + $asset.name)
    $tmp = Join-Path $env:TEMP ('llamacpp-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
    New-Item -ItemType Directory -Force -Path $tmp | Out-Null
    $zipPath = Join-Path $tmp $asset.name
    & curl.exe -sSL --retry 3 -o $zipPath $asset.browser_download_url
    if ($LASTEXITCODE -ne 0) { throw 'llama.cpp のダウンロードに失敗しました' }
    Write-Host '[llama] 展開中...'
    Expand-Archive -LiteralPath $zipPath -DestinationPath $tmp -Force
    $sub = @(Get-ChildItem -LiteralPath $tmp -Directory)
    if ($sub.Count -gt 0) { $from = Join-Path $sub[0].FullName '*' } else { $from = Join-Path $tmp '*' }
    New-Item -ItemType Directory -Force -Path $llamaDir | Out-Null
    Copy-Item -Path $from -Destination $llamaDir -Recurse -Force
    Remove-Item -LiteralPath $tmp -Recurse -Force
    Write-Host "[llama] 配置完了: $llamaDir"
}

if (-not $SkipModel) {
    New-Item -ItemType Directory -Force -Path $modelDir | Out-Null
    $gguf = Join-Path $modelDir $ModelFile
    Write-Host "[model] ダウンロード開始 (数GB。中断しても再実行でレジュームします):"
    Write-Host ("[model] " + $ModelUrl)
    & curl.exe -L -C - --retry 3 --retry-delay 2 -o $gguf $ModelUrl
    if ($LASTEXITCODE -ne 0) { throw 'モデルのダウンロードに失敗しました' }
    $mb = [math]::Round((Get-Item -LiteralPath $gguf).Length / 1MB)
    Write-Host "[model] 配置完了: $gguf ($mb MB)"
}

Write-Host '[done]'
