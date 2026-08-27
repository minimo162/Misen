#Requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Destination,
    [string]$SourceRoot = '',
    [string]$AppName = 'coding-agent',
    [string]$Version = '',
    [switch]$SkipNpmInstall,
    [switch]$SkipTests,
    [switch]$CleanDestination
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

function Write-Step([string]$Message) { Write-Host ('[prepare] ' + $Message) -ForegroundColor Cyan }
function Write-Ok([string]$Message) { Write-Host ('[prepare] ' + $Message) -ForegroundColor Green }
function Fail([string]$Message) { throw ('[prepare] ' + $Message) }

function Invoke-Checked {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [string[]]$ArgumentList = @(),
        [Parameter(Mandatory = $true)][string]$WorkingDirectory
    )
    Push-Location -LiteralPath $WorkingDirectory
    try {
        & $FilePath @ArgumentList
        $code = $LASTEXITCODE
    } finally {
        Pop-Location
    }
    if ($code -ne 0) { Fail "$FilePath が失敗しました (exit=$code)" }
}

if (-not $SourceRoot) { $SourceRoot = Split-Path -Parent $PSScriptRoot }
try { $source = (Resolve-Path -LiteralPath $SourceRoot -ErrorAction Stop).Path.TrimEnd('\', '/') } catch { Fail "ソースルートが見つかりません: $SourceRoot" }

$appDir = Join-Path $source "apps\$AppName"
$manifestPath = Join-Path $appDir 'manifest.json'
$packagePath = Join-Path $appDir 'package.json'
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { Fail "manifest.json が見つかりません: $manifestPath" }
if (-not (Test-Path -LiteralPath $packagePath -PathType Leaf)) { Fail "package.json が見つかりません: $packagePath" }

try { $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json } catch { Fail "manifest.json を読み込めません: $manifestPath" }
if (-not $Version) { $Version = [string]$manifest.version }
if ([string]::IsNullOrWhiteSpace($Version)) { Fail '公開版の version が空です。-Version を指定してください。' }
$runtimeName = if ($manifest.runtime) { [string]$manifest.runtime } else { 'node-v22-win-x64' }
$nodeVersionMatch = [regex]::Match($runtimeName, '^node-v(?<version>\d+\.\d+\.\d+)-win-x64$')
if (-not $nodeVersionMatch.Success) { Fail "runtime 名からNode.js版数を解決できません: $runtimeName" }
$nodeVersion = $nodeVersionMatch.Groups['version'].Value
$runtimeExe = Join-Path $source "runtime\$runtimeName\node.exe"

try { $gitRoot = (& git -C $source rev-parse --show-toplevel 2>$null | Select-Object -First 1) } catch { $gitRoot = '' }
if (-not $gitRoot) { Fail 'SourceRoot は git clone 済みのリポジトリで指定してください。' }
Write-Step "clone済みリポジトリ: $gitRoot"

$npm = (Get-Command npm.cmd -ErrorAction SilentlyContinue).Source
if (-not $npm) { $npm = (Get-Command npm -ErrorAction SilentlyContinue).Source }
if (-not $npm) { Fail 'npm が見つかりません。Node.js開発環境を先にインストールしてください。' }

if (-not $SkipNpmInstall) {
    Write-Step '依存関係を構築中: npm ci'
    Invoke-Checked -FilePath $npm -ArgumentList @('ci') -WorkingDirectory $appDir
}

if (-not $SkipTests) {
    Write-Step '型チェック中: npm run typecheck'
    Invoke-Checked -FilePath $npm -ArgumentList @('run', 'typecheck') -WorkingDirectory $appDir
    Write-Step 'ビルドとスモークテスト中: npm run smoke'
    Invoke-Checked -FilePath $npm -ArgumentList @('run', 'smoke') -WorkingDirectory $appDir
}

if (-not (Test-Path -LiteralPath $runtimeExe -PathType Leaf)) {
    $getNode = Join-Path $source 'scripts\get-node.ps1'
    if (-not (Test-Path -LiteralPath $getNode -PathType Leaf)) { Fail "Node.js取得スクリプトが見つかりません: $getNode" }
    Write-Step "Node.jsランタイムを取得中: v$nodeVersion"
    Invoke-Checked -FilePath (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $getNode, '-Version', $nodeVersion) -WorkingDirectory $source
}
if (-not (Test-Path -LiteralPath $runtimeExe -PathType Leaf)) { Fail "Node.jsランタイムを用意できません: $runtimeExe" }

$publish = Join-Path $source 'scripts\New-Misen.ps1'
if (-not (Test-Path -LiteralPath $publish -PathType Leaf)) { Fail "公開スクリプトが見つかりません: $publish" }
$publishArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $publish, '-Destination', $Destination, '-SourceRoot', $source, '-AppName', $AppName, '-Version', $Version)
if ($CleanDestination) { $publishArgs += '-CleanDestination' }
Write-Step "共有フォルダーへ公開中: $Destination"
Invoke-Checked -FilePath (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') -ArgumentList $publishArgs -WorkingDirectory $source
Write-Ok "準備完了: $AppName v$Version"
Write-Ok '利用者は共有フォルダーの start-coding-agent.cmd だけを実行します。'
