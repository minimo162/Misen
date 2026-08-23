$ErrorActionPreference = 'Stop'

if ($args.Count -lt 1 -or $args[0] -match '^-') {
    Write-Host "Usage: launch.ps1 <app-name> [args...]"
    exit 1
}
$app = $args[0]
$rest = @()
if ($args.Count -gt 1) { $rest = @($args[1..($args.Count - 1)]) }

$shareRoot = Split-Path -Parent $PSScriptRoot
$localRoot = Join-Path $env:LOCALAPPDATA 'CompanyApps'
$remoteAppDir = Join-Path $shareRoot "apps\$app"
$localAppDir = Join-Path $localRoot "apps\$app"
$remoteManifestPath = Join-Path $remoteAppDir 'manifest.json'
$localManifestPath = Join-Path $localAppDir 'manifest.json'
$stateDir = Join-Path $localRoot 'state'
$statePath = Join-Path $stateDir "$app.json"

function Write-DistributionState([string]$Phase, [string]$Message, [string]$RemoteVersion, [string]$LocalVersion, [bool]$Verified = $false) {
    try {
        New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
        $state = [ordered]@{
            app = $app
            phase = $Phase
            message = $Message
            sharedVersion = $RemoteVersion
            localVersion = $LocalVersion
            verified = $Verified
            checkedAt = (Get-Date).ToUniversalTime().ToString('o')
        }
        [System.IO.File]::WriteAllText($statePath, ($state | ConvertTo-Json -Depth 5) + [Environment]::NewLine, (New-Object System.Text.UTF8Encoding($false)))
    } catch { Write-Host "[launch] 配布状態の記録に失敗しました: $($_.Exception.Message)" }
}

if (-not (Test-Path -LiteralPath $remoteManifestPath)) {
    throw "アプリが見つかりません: $remoteManifestPath"
}
$remoteManifest = Get-Content -LiteralPath $remoteManifestPath -Raw | ConvertFrom-Json
$localVersion = ''
Write-DistributionState 'checking' 'checking shared and local versions' ([string]$remoteManifest.version) $localVersion

$needSync = $true
if (Test-Path -LiteralPath $localManifestPath) {
    try {
        $localManifest = Get-Content -LiteralPath $localManifestPath -Raw | ConvertFrom-Json
        $localVersion = [string]$localManifest.version
        if ("$($localManifest.version)" -eq "$($remoteManifest.version)") { $needSync = $false }
    } catch { $needSync = $true }
}
if ($needSync) {
    Write-Host "[launch] 更新を取得中: $app v$($remoteManifest.version)"
    Write-DistributionState 'syncing' 'syncing the shared version to this PC' ([string]$remoteManifest.version) $localVersion
    New-Item -ItemType Directory -Force -Path $localAppDir | Out-Null
    & robocopy $remoteAppDir $localAppDir /MIR /XD node_modules .git /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "robocopy 失敗 (exit=$LASTEXITCODE)" }
    $localVersion = [string]$remoteManifest.version
    Write-DistributionState 'verified' 'sync completed and versions match' ([string]$remoteManifest.version) $localVersion $true
} else {
    Write-DistributionState 'verified' 'starting the same version' ([string]$remoteManifest.version) $localVersion $true
}

$type = if ($remoteManifest.type) { "$($remoteManifest.type)" } else { 'cli' }
if ($remoteManifest.env) {
    foreach ($p in $remoteManifest.env.PSObject.Properties) {
        Set-Item -Path "Env:$($p.Name)" -Value $p.Value
    }
}

if ($type -eq 'powershell') {
    $entry = Join-Path $localAppDir $remoteManifest.entry
    & powershell -NoProfile -ExecutionPolicy Bypass -File $entry @rest
    exit $LASTEXITCODE
}

$runtimeName = if ($remoteManifest.runtime) { "$($remoteManifest.runtime)" } else { 'node-v22-win-x64' }
$localNodeExe = Join-Path $localRoot "runtime\$runtimeName\node.exe"
if (-not (Test-Path -LiteralPath $localNodeExe)) {
    $remoteNodeExe = Join-Path $shareRoot "runtime\$runtimeName\node.exe"
    if (-not (Test-Path -LiteralPath $remoteNodeExe)) {
        throw "node.exe が見つかりません。共有フォルダで scripts\get-node.ps1 を実行してください: $remoteNodeExe"
    }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $localNodeExe) | Out-Null
    Copy-Item -LiteralPath $remoteNodeExe -Destination $localNodeExe
    Write-Host '[launch] ランタイムを初回コピーしました'
}

$entryPath = Join-Path $localAppDir $remoteManifest.entry
if (-not (Test-Path -LiteralPath $entryPath)) { throw "エントリが見つかりません: $entryPath" }

$nodeArgs = @()
if ($remoteManifest.nodeArgs) { $nodeArgs = @($remoteManifest.nodeArgs) }

if ($type -eq 'web') {
    $argList = @($nodeArgs + @($entryPath) + @($rest) | ForEach-Object { "`"$_`"" })
    $proc = Start-Process -FilePath $localNodeExe -ArgumentList $argList -PassThru -NoNewWindow
    Start-Sleep -Seconds 1
    $url = if ($remoteManifest.url) { "$($remoteManifest.url)" } else { 'http://localhost:3000' }
    Start-Process $url
    $proc.WaitForExit()
    exit $proc.ExitCode
}

& $localNodeExe @nodeArgs $entryPath @rest
exit $LASTEXITCODE