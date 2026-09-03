#Requires -Version 5.1
<#
  管理者用: clone 済みリポジトリから Enterprise Misen を構築し、共有フォルダーへ公開する。

  流れ: npm ci → npm test（unit 層）→ Node.js / OfficeCLI ランタイム取得（検証付き）→ prepare-runtime → New-Misen.ps1
  作業領域は既定で %LOCALAPPDATA%\Misen\staging（共有フォルダーには書き込まない）。
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Destination,
    [string]$SourceRoot = '',
    [string]$Version = '',
    [string]$NodeRuntime = '',
    [string]$OfficeCliRuntime = '',
    [string]$Staging = '',
    [string]$Url = 'http://127.0.0.1:8787/',
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
$appDir = Join-Path $source 'apps\enterprise-misen'
if (-not (Test-Path -LiteralPath (Join-Path $appDir 'package.json') -PathType Leaf)) { Fail "apps\enterprise-misen\package.json が見つかりません: $appDir" }
if (-not $Staging) { $Staging = Join-Path (Join-Path $env:LOCALAPPDATA 'Misen') 'staging' }
New-Item -ItemType Directory -Force -Path $Staging | Out-Null

try { $gitRoot = (& git -C $source rev-parse --show-toplevel 2>$null | Select-Object -First 1) } catch { $gitRoot = '' }
if (-not $gitRoot) { Fail 'SourceRoot は git clone 済みのリポジトリで指定してください。' }
Write-Step "clone済みリポジトリ: $gitRoot"

$npm = (Get-Command npm.cmd -ErrorAction SilentlyContinue).Source
if (-not $npm) { $npm = (Get-Command npm -ErrorAction SilentlyContinue).Source }
if (-not $npm) { Fail 'npm が見つかりません。Node.js開発環境を先にインストールしてください。' }
$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'

if (-not $SkipNpmInstall) {
    Write-Step '依存関係を構築中: npm ci --ignore-scripts'
    Invoke-Checked -FilePath $npm -ArgumentList @('ci', '--ignore-scripts', '--no-audit', '--no-fund') -WorkingDirectory $appDir
}
if (-not $SkipTests) {
    Write-Step 'unit 層テスト中: npm test'
    Invoke-Checked -FilePath $npm -ArgumentList @('test') -WorkingDirectory $appDir
}

if ($NodeRuntime) { try { $NodeRuntime = (Resolve-Path -LiteralPath $NodeRuntime -ErrorAction Stop).Path } catch { Fail "Node.js ランタイム入力が見つかりません: $NodeRuntime" } }
if ($OfficeCliRuntime) { try { $OfficeCliRuntime = (Resolve-Path -LiteralPath $OfficeCliRuntime -ErrorAction Stop).Path } catch { Fail "OfficeCLI ランタイム入力が見つかりません: $OfficeCliRuntime" } }
if (-not $NodeRuntime) {
    $NodeRuntime = Join-Path $Staging 'node-runtime'
    if (-not (Test-Path -LiteralPath (Join-Path $NodeRuntime 'node.exe') -PathType Leaf)) {
        Write-Step "Node.js ランタイムを取得中（公式配布物の SHA-256 を検証）: $NodeRuntime"
        if (Test-Path -LiteralPath $NodeRuntime) { Remove-Item -LiteralPath $NodeRuntime -Recurse -Force }
        Invoke-Checked -FilePath $npm -ArgumentList @('run', 'acquire:node-runtime', '--', '--output', $NodeRuntime) -WorkingDirectory $appDir
    }
}
if (-not $OfficeCliRuntime) {
    $OfficeCliRuntime = Join-Path $Staging 'officecli-runtime'
    if (-not (Test-Path -LiteralPath (Join-Path $OfficeCliRuntime 'officecli.exe') -PathType Leaf)) {
        Write-Step "OfficeCLI ランタイムを取得中（公式リリースの SHA-256 を検証）: $OfficeCliRuntime"
        if (Test-Path -LiteralPath $OfficeCliRuntime) { Remove-Item -LiteralPath $OfficeCliRuntime -Recurse -Force }
        Invoke-Checked -FilePath $npm -ArgumentList @('run', 'acquire:officecli-runtime', '--', '--output', $OfficeCliRuntime) -WorkingDirectory $appDir
    }
}
foreach ($required in @((Join-Path $NodeRuntime 'node.exe'), (Join-Path $OfficeCliRuntime 'officecli.exe'))) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { Fail "ランタイムを用意できません: $required" }
}

$prepared = Join-Path $Staging ('prepared-' + (Get-Date).ToString('yyyyMMdd-HHmmss'))
Write-Step "自己完結ランタイムを生成中: $prepared"
Invoke-Checked -FilePath $npm -ArgumentList @('run', 'prepare-runtime', '--', '--output', $prepared, '--node-runtime', $NodeRuntime, '--officecli-runtime', $OfficeCliRuntime) -WorkingDirectory $appDir
Write-Step '生成物を検証中: npm run verify:prepared-runtime'
Invoke-Checked -FilePath $npm -ArgumentList @('run', 'verify:prepared-runtime', '--', '--runtime', $prepared) -WorkingDirectory $appDir

$publish = Join-Path $source 'scripts\New-Misen.ps1'
if (-not (Test-Path -LiteralPath $publish -PathType Leaf)) { Fail "公開スクリプトが見つかりません: $publish" }
$publishArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $publish, '-Destination', $Destination, '-PreparedRuntime', $prepared, '-SourceRoot', $source, '-Url', $Url)
if ($Version) { $publishArgs += @('-Version', $Version) }
if ($CleanDestination) { $publishArgs += '-CleanDestination' }
Write-Step "共有フォルダーへ公開中: $Destination"
Invoke-Checked -FilePath $powershell -ArgumentList $publishArgs -WorkingDirectory $source
Write-Ok '準備完了。利用者は共有フォルダーの Misen起動.cmd だけをダブルクリックします。'
Write-Ok "prepared runtime は $prepared に残しています（監査用。不要なら削除してください）。"
