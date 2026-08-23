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
$remoteManifestPath = Join-Path $remoteAppDir 'manifest.json'
$containerDir = Join-Path $localRoot "apps\$app"
$versionsDir = Join-Path $containerDir 'versions'
$currentPointerPath = Join-Path $containerDir 'current.json'
$stateDir = Join-Path $localRoot 'state'
$statePath = Join-Path $stateDir "$app.json"

function Write-JsonAtomic([string]$Path, [object]$Value) {
    $dir = Split-Path -Parent $Path
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $tmp = "$Path.tmp-$([guid]::NewGuid().ToString('N'))"
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($tmp, (($Value | ConvertTo-Json -Depth 10) + [Environment]::NewLine), $utf8)
    Move-Item -LiteralPath $tmp -Destination $Path -Force
}

function Read-Json([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    try { return (Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json) } catch { return $null }
}

function Write-DistributionState(
    [string]$Phase,
    [string]$Message,
    [string]$RemoteVersion,
    [string]$LocalVersion,
    [string]$RemotePublishId,
    [string]$LocalPublishId,
    [string]$PreviousVersion = '',
    [string]$PreviousPublishId = '',
    [bool]$Verified = $false,
    [string]$ErrorMessage = ''
) {
    try {
        New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
        $eventName = @{ checking = 'distribution.check_started'; syncing = 'distribution.sync_progress'; integrity_passed = 'distribution.integrity_passed'; activated = 'distribution.activated'; verified = 'distribution.verified'; rolled_back = 'distribution.rolled_back'; failed = 'distribution.failed' }[$Phase]
        if (-not $eventName) { $eventName = 'distribution.state' }
        $state = [ordered]@{
            app = $app
            phase = $Phase
            event = $eventName
            message = $Message
            sharedVersion = $RemoteVersion
            localVersion = $LocalVersion
            sharedPublishId = $RemotePublishId
            localPublishId = $LocalPublishId
            previousVersion = $PreviousVersion
            previousPublishId = $PreviousPublishId
            verified = $Verified
            checkedAt = (Get-Date).ToUniversalTime().ToString('o')
            error = $ErrorMessage
        }
        Write-JsonAtomic $statePath $state
    } catch { Write-Host "[launch] 配布状態の記録に失敗しました: $($_.Exception.Message)" }
}

function Get-PublishId([object]$Manifest) {
    if ($Manifest.publishId) { return [string]$Manifest.publishId }
    return "version-$([string]$Manifest.version)"
}

function Assert-StagedApp([string]$Stage, [object]$RemoteManifest) {
    $manifestPath = Join-Path $Stage 'manifest.json'
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw "ステージングmanifestがありません" }
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    if ("$($manifest.version)" -ne "$($RemoteManifest.version)") { throw "ステージング版数が一致しません" }
    if ("$(Get-PublishId $manifest)" -ne "$(Get-PublishId $RemoteManifest)") { throw "ステージング公開IDが一致しません" }
    foreach ($required in @('dist\server.js', 'public\index.html', 'manifest.json')) {
        if (-not (Test-Path -LiteralPath (Join-Path $Stage $required) -PathType Leaf)) { throw "必須ファイルが不足しています: $required" }
    }
    if ($RemoteManifest.files) {
        foreach ($property in $RemoteManifest.files.PSObject.Properties) {
            $filePath = Join-Path $Stage ([string]$property.Name)
            if (-not (Test-Path -LiteralPath $filePath -PathType Leaf)) { throw "整合性対象ファイルがありません: $($property.Name)" }
            $actual = (Get-FileHash -LiteralPath $filePath -Algorithm SHA256).Hash.ToLowerInvariant()
            if ($actual -ne ([string]$property.Value).ToLowerInvariant()) { throw "SHA-256が一致しません: $($property.Name)" }
        }
    }
    return $manifest
}

if (-not (Test-Path -LiteralPath $remoteManifestPath -PathType Leaf)) {
    throw "アプリが見つかりません: $remoteManifestPath"
}
$remoteManifest = Get-Content -LiteralPath $remoteManifestPath -Raw | ConvertFrom-Json
$remoteVersion = [string]$remoteManifest.version
$remotePublishId = Get-PublishId $remoteManifest
$current = Read-Json $currentPointerPath
$previousVersion = if ($current) { [string]$current.version } else { '' }
$previousPublishId = if ($current) { [string]$current.publishId } else { '' }
$localVersion = $previousVersion
$localPublishId = $previousPublishId
$localAppDir = if ($current -and $current.publishId) { Join-Path $versionsDir ([string]$current.publishId) } else { '' }

Write-DistributionState 'checking' '共有版とこのPCの版を確認しています' $remoteVersion $localVersion $remotePublishId $localPublishId $previousVersion $previousPublishId

$needSync = -not ($current -and $current.publishId -and $localAppDir -and (Test-Path -LiteralPath $localAppDir -PathType Container) -and $localPublishId -eq $remotePublishId)
$stage = $null
try {
    if ($needSync) {
        Write-Host "[launch] 版別ステージングを取得中: $app v$remoteVersion"
        New-Item -ItemType Directory -Force -Path $versionsDir | Out-Null
        $stage = Join-Path $versionsDir ".staging-$([guid]::NewGuid().ToString('N'))"
        New-Item -ItemType Directory -Force -Path $stage | Out-Null
        Write-DistributionState 'syncing' '共有版を版別ステージングへ取得しています' $remoteVersion $localVersion $remotePublishId $localPublishId $previousVersion $previousPublishId
        # The default robocopy retry policy is effectively unbounded. A file held
        # open by another user must fail this activation and roll back instead of
        # leaving the launcher stuck forever in the syncing phase.
        & robocopy $remoteAppDir $stage /MIR /XD node_modules .git /NFL /NDL /NJH /NJS /NP /R:2 /W:1 | Out-Null
        if ($LASTEXITCODE -ge 8) { throw "robocopy失敗 (exit=$LASTEXITCODE)" }
        $stagedManifest = Assert-StagedApp $stage $remoteManifest
        Write-DistributionState 'integrity_passed' 'ステージングの必須ファイルと公開IDを確認しました' $remoteVersion $localVersion $remotePublishId $localPublishId $previousVersion $previousPublishId $true
        $target = Join-Path $versionsDir $remotePublishId
        if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
        Move-Item -LiteralPath $stage -Destination $target -Force
        $stage = $null
        $pointer = [ordered]@{
            app = $app
            version = $remoteVersion
            publishId = $remotePublishId
            activatedAt = (Get-Date).ToUniversalTime().ToString('o')
            previousVersion = $previousVersion
            previousPublishId = $previousPublishId
        }
        Write-JsonAtomic $currentPointerPath $pointer
        $current = $pointer
        $localVersion = $remoteVersion
        $localPublishId = $remotePublishId
        $localAppDir = $target
        Write-DistributionState 'activated' '検証済み版をcurrentへ切り替えました' $remoteVersion $localVersion $remotePublishId $localPublishId $previousVersion $previousPublishId $true
    } else {
        Write-DistributionState 'verified' '同じ公開版を起動します' $remoteVersion $localVersion $remotePublishId $localPublishId $previousVersion $previousPublishId $true
    }

    $type = if ($remoteManifest.type) { "$($remoteManifest.type)" } else { 'cli' }
    if ($remoteManifest.env) {
        foreach ($p in $remoteManifest.env.PSObject.Properties) { Set-Item -Path "Env:$($p.Name)" -Value $p.Value }
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
        if (-not (Test-Path -LiteralPath $remoteNodeExe)) { throw "node.exeが見つかりません: $remoteNodeExe" }
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
        if ($proc.HasExited) { throw "アプリプロセスが起動直後に終了しました (exit=$($proc.ExitCode))" }
        $url = if ($remoteManifest.url) { "$($remoteManifest.url)" } else { 'http://localhost:3000' }
        Start-Process $url
        $proc.WaitForExit()
        exit $proc.ExitCode
    }

    & $localNodeExe @nodeArgs $entryPath @rest
    exit $LASTEXITCODE
} catch {
    $message = $_.Exception.Message
    Write-DistributionState 'failed' $message $remoteVersion $localVersion $remotePublishId $localPublishId $previousVersion $previousPublishId $false $message
    if ($stage -and (Test-Path -LiteralPath $stage)) { Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue }
    if ($previousPublishId -and (Test-Path -LiteralPath (Join-Path $versionsDir $previousPublishId) -PathType Container)) {
        try {
            $rollback = [ordered]@{ app = $app; version = $previousVersion; publishId = $previousPublishId; rolledBackAt = (Get-Date).ToUniversalTime().ToString('o') }
            Write-JsonAtomic $currentPointerPath $rollback
            Write-DistributionState 'rolled_back' '新しい版の起動に失敗したため前回正常版へ戻しました' $remoteVersion $previousVersion $remotePublishId $previousPublishId $previousVersion $previousPublishId $true $message
        } catch {}
    }
    throw
}
