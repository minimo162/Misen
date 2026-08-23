#Requires -Version 5.1
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
    [Parameter(Mandatory = $true)][string]$Destination,
    [string]$SourceRoot = '',
    [string]$AppName = 'coding-agent',
    [string]$Version = '',
    [string]$RuntimeExe = '',
    [switch]$CleanDestination
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

function Write-Step([string]$Message) { Write-Host ('[publish] ' + $Message) -ForegroundColor Cyan }
function Write-Ok([string]$Message) { Write-Host ('[publish] ' + $Message) -ForegroundColor Green }
function Fail([string]$Message) { throw ('[publish] ' + $Message) }
function Write-Utf8NoBom([string]$Path, [string]$Content) {
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $Content, $utf8)
}

if (-not $SourceRoot) { $SourceRoot = Split-Path -Parent $PSScriptRoot }
try { $source = (Resolve-Path -LiteralPath $SourceRoot -ErrorAction Stop).Path.TrimEnd('\', '/') } catch { Fail "ソースルートが見つかりません: $SourceRoot" }

$appSource = Join-Path $source "apps\$AppName"
$manifestSource = Join-Path $appSource 'manifest.json'
if (-not (Test-Path -LiteralPath $appSource -PathType Container)) { Fail "アプリフォルダーが見つかりません: $appSource" }
if (-not (Test-Path -LiteralPath $manifestSource -PathType Leaf)) { Fail "manifest.json が見つかりません: $manifestSource" }
foreach ($required in @('launcher\launch.ps1', 'launcher\launch.cmd', 'start-coding-agent.cmd')) {
    if (-not (Test-Path -LiteralPath (Join-Path $source $required) -PathType Leaf)) { Fail "配布用ファイルが不足しています: $required" }
}

try { $manifest = Get-Content -LiteralPath $manifestSource -Raw | ConvertFrom-Json } catch { Fail "manifest.json を読み込めません: $manifestSource" }
if (-not $Version) { $Version = [string]$manifest.version }
if ([string]::IsNullOrWhiteSpace($Version) -or $Version -notmatch '^[0-9A-Za-z][0-9A-Za-z._-]*$') { Fail "不正なバージョンです: $Version" }
$runtimeName = if ($manifest.runtime) { [string]$manifest.runtime } else { 'node-v22-win-x64' }
if (-not $RuntimeExe) { $RuntimeExe = Join-Path $source "runtime\$runtimeName\node.exe" }
if (-not (Test-Path -LiteralPath $RuntimeExe -PathType Leaf)) { Fail "Node.jsランタイムが見つかりません: $RuntimeExe" }

try { $destinationFull = [System.IO.Path]::GetFullPath($Destination).TrimEnd('\', '/') } catch { Fail "配布先を解決できません: $Destination" }
$sourceComparable = $source.TrimEnd('\', '/') + '\'
$destinationComparable = $destinationFull.TrimEnd('\', '/') + '\'
if ($destinationComparable.StartsWith($sourceComparable, [System.StringComparison]::OrdinalIgnoreCase)) {
    Fail '配布先をソースルートの中に置くことはできません。'
}

$stageRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('company-apps-share-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
$stageApp = Join-Path $stageRoot "apps\$AppName"
New-Item -ItemType Directory -Force -Path $stageApp | Out-Null

try {
    Write-Step "ステージング: $stageRoot"
    New-Item -ItemType Directory -Force -Path (Join-Path $stageRoot 'launcher') | Out-Null
    New-Item -ItemType Directory -Force -Path (Join-Path $stageRoot "runtime\$runtimeName") | Out-Null
    Copy-Item -LiteralPath (Join-Path $source 'launcher\launch.ps1') -Destination (Join-Path $stageRoot 'launcher\launch.ps1') -Force
    Copy-Item -LiteralPath (Join-Path $source 'launcher\launch.cmd') -Destination (Join-Path $stageRoot 'launcher\launch.cmd') -Force
    Copy-Item -LiteralPath (Join-Path $source 'start-coding-agent.cmd') -Destination (Join-Path $stageRoot 'start-coding-agent.cmd') -Force

    foreach ($fileName in @('start.cmd', "$AppName.cmd")) {
        $sourceFile = Join-Path $appSource $fileName
        if (Test-Path -LiteralPath $sourceFile -PathType Leaf) { Copy-Item -LiteralPath $sourceFile -Destination (Join-Path $stageApp $fileName) -Force }
    }
    $distSource = Join-Path $appSource 'dist'
    $distStage = Join-Path $stageApp 'dist'
    if (-not (Test-Path -LiteralPath $distSource -PathType Container)) { Fail "dist フォルダーが見つかりません: $distSource" }
    New-Item -ItemType Directory -Force -Path $distStage | Out-Null
    Get-ChildItem -LiteralPath $distSource -Filter '*.js' -File | Copy-Item -Destination $distStage -Force
    $publicSource = Join-Path $appSource 'public\index.html'
    if (-not (Test-Path -LiteralPath $publicSource -PathType Leaf)) { Fail "public\index.html が見つかりません: $publicSource" }
    New-Item -ItemType Directory -Force -Path (Join-Path $stageApp 'public') | Out-Null
    Copy-Item -LiteralPath $publicSource -Destination (Join-Path $stageApp 'public\index.html') -Force

    $manifest.version = $Version
    Write-Utf8NoBom (Join-Path $stageApp 'manifest.json') (($manifest | ConvertTo-Json -Depth 10) + [Environment]::NewLine)
    Copy-Item -LiteralPath $RuntimeExe -Destination (Join-Path $stageRoot "runtime\$runtimeName\node.exe") -Force

    $requiredStage = @(
        'launcher\launch.ps1', 'launcher\launch.cmd', ('apps\' + $AppName + '\manifest.json'),
        ('apps\' + $AppName + '\dist\server.js'), ('apps\' + $AppName + '\public\index.html'),
        ('runtime\' + $runtimeName + '\node.exe'), 'start-coding-agent.cmd'
    )
    foreach ($relative in $requiredStage) {
        if (-not (Test-Path -LiteralPath (Join-Path $stageRoot $relative) -PathType Leaf)) { Fail "ステージング必須ファイルが不足しています: $relative" }
    }

    if (-not $WhatIfPreference) {
        if (-not (Test-Path -LiteralPath $destinationFull)) { New-Item -ItemType Directory -Force -Path $destinationFull | Out-Null }
        if ($CleanDestination) {
            foreach ($relative in @('launcher', ('apps\' + $AppName), ('runtime\' + $runtimeName), 'start-coding-agent.cmd', 'install-coding-agent.cmd', 'scripts\Install-CompanyApp.ps1')) {
                $target = Join-Path $destinationFull $relative
                if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
            }
        }
        $roboArgs = @($stageRoot, $destinationFull, '/E', '/R:2', '/W:1', '/NFL', '/NDL', '/NJH', '/NJS', '/NP')
        & robocopy @roboArgs | Out-Null
        if ($LASTEXITCODE -ge 8) { Fail "配布先へのコピーに失敗しました (robocopy exit=$LASTEXITCODE)" }
        $global:LASTEXITCODE = 0
        Write-Ok "配布完了: $destinationFull"
        Write-Ok "アプリ: $AppName v$Version / ランタイム: $runtimeName"
        Write-Host '利用者は共有フォルダーの start-coding-agent.cmd だけを実行してください。' -ForegroundColor Green
    } else {
        Write-Host "[publish] WhatIf: 配布先へは書き込みません -> $destinationFull" -ForegroundColor Yellow
    }
} finally {
    if (Test-Path -LiteralPath $stageRoot) {
        try { Remove-Item -LiteralPath $stageRoot -Recurse -Force -ErrorAction SilentlyContinue } catch {}
    }
}
