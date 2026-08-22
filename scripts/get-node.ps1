param([string]$Version = '22.14.0')
$ErrorActionPreference = 'Stop'
$runtimeRoot = Join-Path (Split-Path -Parent $PSScriptRoot) 'runtime'
$destDir = Join-Path $runtimeRoot "node-v$Version-win-x64"
New-Item -ItemType Directory -Force -Path $destDir | Out-Null
$workDir = Join-Path $env:TEMP 'company-node-download'
$zipPath = Join-Path $workDir "node-v$Version-win-x64.zip"
$url = "https://nodejs.org/dist/v$Version/node-v$Version-win-x64.zip"
Write-Host "ダウンロード中: $url"
New-Item -ItemType Directory -Force -Path $workDir | Out-Null
Invoke-WebRequest -Uri $url -OutFile $zipPath
Expand-Archive -LiteralPath $zipPath -DestinationPath $workDir -Force
Copy-Item -LiteralPath (Join-Path $workDir "node-v$Version-win-x64\node.exe") (Join-Path $destDir 'node.exe') -Force
Remove-Item -LiteralPath $workDir -Recurse -Force
& (Join-Path $destDir 'node.exe') -v
Write-Host "配置完了: $(Join-Path $destDir 'node.exe')"
