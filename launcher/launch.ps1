#Requires -Version 5.1
<#
  Enterprise Misen 利用者用ランチャー本体（Misen起動.cmd から呼ばれる）。

  共有フォルダー（読み取り専用、Issue #108 のレイアウト）:
    Misen起動.cmd
    _misen\manifest.json                  current（有効な版）・公開ID・SHA-256 一覧
    _misen\versions\<version>\           app\ runtime\ workspace\ launcher\（このスクリプトはここに置かれる）
  ローカル（書き込みはここだけ）:
    %LOCALAPPDATA%\Misen\versions\<version>\   検証済みの app・runtime・workspace 雛形
    %LOCALAPPDATA%\Misen\current.json          有効な版と公開ID
    %LOCALAPPDATA%\Misen\state\launch.json     直近の配布状態（監査用。秘密情報は含まない）
    %LOCALAPPDATA%\Misen\workspace\            既定の作業フォルダー（初回に雛形からコピー）

  manifest 比較・SHA-256 検証・ロールバックの流れは、2026 年 8 月の coding-agent 用ランチャー（タグ archive/coding-agent-be614a6）から引き継いだ設計です。
#>
[CmdletBinding()]
param(
    [string]$Workspace = '',
    [string]$ShareRoot = '',
    [string]$LocalRoot = '',
    [switch]$SyncOnly,
    [switch]$NoBrowser,
    [int]$StartupTimeoutSeconds = 60
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

# 既定の配置: <share>\_misen\versions\<version>\launcher\launch.ps1 → 4 階層上が共有ルート
if (-not $ShareRoot) { $ShareRoot = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))) }
if (-not $LocalRoot) { $LocalRoot = Join-Path $env:LOCALAPPDATA 'Misen' }
$shareRoot = $ShareRoot.TrimEnd('\', '/')
$localRoot = $LocalRoot.TrimEnd('\', '/')
$remoteMisenDir = Join-Path $shareRoot '_misen'
$remoteManifestPath = Join-Path $remoteMisenDir 'manifest.json'
$versionsDir = Join-Path $localRoot 'versions'
$currentPointerPath = Join-Path $localRoot 'current.json'
$stateDir = Join-Path $localRoot 'state'
$statePath = Join-Path $stateDir 'launch.json'
$projectsStatePath = Join-Path $stateDir 'projects.json'
$syncDirectories = @('app', 'runtime', 'workspace')

function Write-Info([string]$Message) { Write-Host ('[Misen] ' + $Message) }

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
    try { return (Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json) } catch { return $null }
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
            app = 'enterprise-misen'
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
    } catch { Write-Info "配布状態の記録に失敗しました: $($_.Exception.Message)" }
}

function Get-PublishId([object]$Manifest) {
    if ($Manifest.publishId) { return [string]$Manifest.publishId }
    return "version-$([string]$Manifest.version)"
}

function Assert-ManifestShape([object]$Manifest) {
    if ("$($Manifest.schema)" -ne 'misen-distribution/2') { throw "manifest.json の形式が未対応です: $($Manifest.schema)（管理者に再公開を依頼してください）" }
    if ([string]::IsNullOrWhiteSpace([string]$Manifest.current)) { throw 'manifest.json に current（有効な版）がありません' }
    if ([string]$Manifest.current -notmatch '^[0-9A-Za-z][0-9A-Za-z._-]*$') { throw "manifest.json の current が不正です: $($Manifest.current)（管理者に再公開を依頼してください）" }
    if ([string]::IsNullOrWhiteSpace([string]$Manifest.version)) { throw 'manifest.json に version がありません' }
    if ([string]$Manifest.version -notmatch '^[0-9A-Za-z][0-9A-Za-z._-]*$') { throw "manifest.json の version が不正です: $($Manifest.version)" }
    foreach ($key in @('entry', 'node', 'officeCli', 'url')) {
        if ([string]::IsNullOrWhiteSpace([string]$Manifest.$key)) { throw "manifest.json に $key がありません" }
    }
    if (-not $Manifest.files) { throw 'manifest.json に files（SHA-256 一覧）がありません' }
}

function Assert-StagedVersion([string]$Stage, [object]$RemoteManifest) {
    # 公開側 manifest に列挙された全ファイルが存在し、SHA-256 が一致することを確認する。
    foreach ($required in @([string]$RemoteManifest.entry, [string]$RemoteManifest.node, [string]$RemoteManifest.officeCli)) {
        $relative = $required.Replace('/', '\')
        if (-not (Test-Path -LiteralPath (Join-Path $Stage $relative) -PathType Leaf)) { throw "必須ファイルが不足しています: $required" }
    }
    $count = 0
    foreach ($property in $RemoteManifest.files.PSObject.Properties) {
        $relativeName = [string]$property.Name
        $top = ($relativeName -split '/')[0]
        if ($syncDirectories -notcontains $top) { continue }
        $filePath = Join-Path $Stage ($relativeName.Replace('/', '\'))
        if (-not (Test-Path -LiteralPath $filePath -PathType Leaf)) { throw "整合性対象ファイルがありません: $relativeName" }
        $actual = (Get-FileHash -LiteralPath $filePath -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($actual -ne ([string]$property.Value).ToLowerInvariant()) { throw "SHA-256 が一致しません: $relativeName" }
        $count++
    }
    if ($count -eq 0) { throw 'manifest.json の files に app/runtime の項目がありません' }
    return $count
}

function Test-PortListening([int]$Port) {
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $async = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
        if (-not $async.AsyncWaitHandle.WaitOne(500, $false)) { return $false }
        $client.EndConnect($async)
        return $true
    } catch { return $false } finally { $client.Close() }
}

if (-not (Test-Path -LiteralPath $remoteManifestPath -PathType Leaf)) {
    throw "共有フォルダーに _misen\manifest.json が見つかりません: $remoteManifestPath"
}
$remoteManifest = Get-Content -LiteralPath $remoteManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
Assert-ManifestShape $remoteManifest
$remoteVersion = [string]$remoteManifest.current
$remoteVersionDir = Join-Path (Join-Path $remoteMisenDir ([string]$remoteManifest.versionsRoot)) $remoteVersion
if (-not (Test-Path -LiteralPath $remoteVersionDir -PathType Container)) { throw "共有フォルダーに有効な版がありません: $remoteVersionDir" }
$remotePublishId = Get-PublishId $remoteManifest
$current = Read-Json $currentPointerPath
$previousVersion = if ($current) { [string]$current.version } else { '' }
$previousPublishId = if ($current) { [string]$current.publishId } else { '' }
$localVersion = $previousVersion
$localPublishId = $previousPublishId
$localVersionDir = if ($previousVersion) { Join-Path $versionsDir $previousVersion } else { '' }

Write-DistributionState 'checking' '共有版とこのPCの版を確認しています' $remoteVersion $localVersion $remotePublishId $localPublishId $previousVersion $previousPublishId
Write-Info "共有版: v$remoteVersion ($remotePublishId)"
if ($localVersion) { Write-Info "ローカル版: v$localVersion ($localPublishId)" } else { Write-Info 'ローカル版: なし（初回起動）' }

$needSync = -not ($current -and $localVersionDir -and (Test-Path -LiteralPath $localVersionDir -PathType Container) -and $localVersion -eq $remoteVersion -and $localPublishId -eq $remotePublishId)
$stage = $null
try {
    if ($needSync) {
        Write-Info "ローカルへ取得しています: v$remoteVersion（初回または版更新）"
        New-Item -ItemType Directory -Force -Path $versionsDir | Out-Null
        $stage = Join-Path $versionsDir ".staging-$([guid]::NewGuid().ToString('N'))"
        New-Item -ItemType Directory -Force -Path $stage | Out-Null
        Write-DistributionState 'syncing' '共有版を版別ステージングへ取得しています' $remoteVersion $localVersion $remotePublishId $localPublishId $previousVersion $previousPublishId
        foreach ($directory in $syncDirectories) {
            $sourceDir = Join-Path $remoteVersionDir $directory
            if (-not (Test-Path -LiteralPath $sourceDir -PathType Container)) {
                if ($directory -eq 'workspace') { continue }
                throw "共有フォルダーに $directory がありません: $sourceDir"
            }
            # robocopy の既定の再試行は事実上無限。共有側でロックされたファイルは失敗としてロールバックする。
            & robocopy $sourceDir (Join-Path $stage $directory) /E /NFL /NDL /NJH /NJS /NP /R:2 /W:1 | Out-Null
            if ($LASTEXITCODE -ge 8) { throw "共有フォルダーからのコピーに失敗しました ($directory, robocopy exit=$LASTEXITCODE)" }
        }
        $verifiedCount = Assert-StagedVersion $stage $remoteManifest
        Write-DistributionState 'integrity_passed' "全 $verifiedCount ファイルの SHA-256 を確認しました" $remoteVersion $localVersion $remotePublishId $localPublishId $previousVersion $previousPublishId $true
        Write-Info "SHA-256 を確認しました: $verifiedCount ファイル"
        $target = Join-Path $versionsDir $remoteVersion
        if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
        Move-Item -LiteralPath $stage -Destination $target -Force
        $stage = $null
        $pointer = [ordered]@{
            app = 'enterprise-misen'
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
        $localVersionDir = $target
        Write-DistributionState 'activated' '検証済み版をcurrentへ切り替えました' $remoteVersion $localVersion $remotePublishId $localPublishId $previousVersion $previousPublishId $true
        Write-Info "v$remoteVersion を有効化しました"
        # 前回版は 1 つだけ残す（ロールバック用）。それより古い版は削除する。
        Get-ChildItem -LiteralPath $versionsDir -Directory | Where-Object { $_.Name -ne $remoteVersion -and $_.Name -ne $previousVersion -and -not $_.Name.StartsWith('.staging-') } | ForEach-Object {
            try { Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction Stop } catch { Write-Info "古い版の削除に失敗しました（次回再試行）: $($_.Exception.Message)" }
        }
    } else {
        Write-DistributionState 'verified' '同じ公開版を起動します' $remoteVersion $localVersion $remotePublishId $localPublishId $previousVersion $previousPublishId $true
        Write-Info '共有版と同じ版がローカルにあります'
    }

    $phase = if ($needSync) { 'activated' } else { 'verified' }
    Write-Output "SYNC_RESULT phase=$phase version=$localVersion publishId=$localPublishId dir=$localVersionDir"
    if ($SyncOnly) { exit 0 }

    $nodeExe = Join-Path $localVersionDir ([string]$remoteManifest.node).Replace('/', '\')
    $officeCliExe = Join-Path $localVersionDir ([string]$remoteManifest.officeCli).Replace('/', '\')
    $entryPath = Join-Path $localVersionDir ([string]$remoteManifest.entry).Replace('/', '\')
    foreach ($required in @($nodeExe, $officeCliExe, $entryPath)) {
        if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "ローカル版に必須ファイルがありません: $required" }
    }

    $rememberedProjects = Read-Json $projectsStatePath
    if (-not $Workspace) {
        $remembered = if ($rememberedProjects -and $rememberedProjects.schema -eq 'misen-projects/1') { [string]$rememberedProjects.last } else { '' }
        if ($remembered -and $remembered -notmatch '^[\\/]{2}' -and (Test-Path -LiteralPath $remembered -PathType Container)) {
            $Workspace = $remembered
        } else {
            $Workspace = Join-Path $localRoot 'workspace'
        }
        if (-not (Test-Path -LiteralPath $Workspace -PathType Container)) {
            $seed = Join-Path $localVersionDir 'workspace'
            New-Item -ItemType Directory -Force -Path $Workspace | Out-Null
            if (Test-Path -LiteralPath $seed -PathType Container) {
                & robocopy $seed $Workspace /E /NFL /NDL /NJH /NJS /NP /R:2 /W:1 | Out-Null
                if ($LASTEXITCODE -ge 8) { throw "作業フォルダーの初期化に失敗しました (robocopy exit=$LASTEXITCODE)" }
                Write-Info "作業フォルダーを雛形から作成しました: $Workspace"
            }
        }
    }
    if ($Workspace -match '^[\\/]{2}') { throw '共有フォルダーは直接使えません。手元にコピーしてください' }
    if (-not (Test-Path -LiteralPath $Workspace -PathType Container)) { throw "作業フォルダーが見つかりません: $Workspace" }
    $workspaceFull = (Resolve-Path -LiteralPath $Workspace).Path
    New-Item -ItemType Directory -Force -Path (Join-Path $workspaceFull 'output') | Out-Null
    $recentProjects = New-Object System.Collections.Generic.List[string]
    $recentProjects.Add($workspaceFull)
    if ($rememberedProjects -and $rememberedProjects.recent) {
        foreach ($candidate in @($rememberedProjects.recent)) {
            $value = [string]$candidate
            if (-not $value -or $value -match '^[\\/]{2}') { continue }
            if (-not ($recentProjects | Where-Object { $_ -ieq $value })) { $recentProjects.Add($value) }
            if ($recentProjects.Count -ge 5) { break }
        }
    }
    Write-JsonAtomic $projectsStatePath ([ordered]@{ schema = 'misen-projects/1'; recent = @($recentProjects); last = $workspaceFull })

    # 利用者ごとの LLM 接続設定（Issue #93 B）。共有フォルダーには置かず、%LOCALAPPDATA%\Misen\config だけに存在する。
    $settingsPath = Join-Path $localRoot 'config\settings.json'
    $env:MISEN_SETTINGS_PATH = $settingsPath
    $settingsCli = Join-Path $localVersionDir 'app\dist\src\runtime\settings-cli.js'
    if (Test-Path -LiteralPath $settingsCli -PathType Leaf) {
        & $nodeExe $settingsCli ensure --settings $settingsPath
        $settingsExit = $LASTEXITCODE
        if ($settingsExit -eq 3) {
            Write-Host ''
            Write-Host "LLM 接続設定のテンプレートを作成しました: $settingsPath" -ForegroundColor Yellow
            Write-Host 'プロバイダー種別・モデル名・API キーを記入して保存し、もう一度 Misen起動.cmd をダブルクリックしてください。' -ForegroundColor Yellow
            if (-not $NoBrowser) { Start-Process notepad.exe "`"$settingsPath`"" }
            exit 2
        }
        if ($settingsExit -ne 0) { throw "LLM 接続設定に問題があります: $settingsPath（上のメッセージを確認してください）" }
    }

    $url = [string]$remoteManifest.url
    $port = ([uri]$url).Port
    if (Test-PortListening $port) {
        Write-Info "Misen は既に起動しています（$url）。ブラウザーを開きます。"
        if (-not $NoBrowser) { Start-Process $url }
        exit 0
    }

    $env:MISEN_OFFICECLI_PATH = $officeCliExe
    $env:OFFICECLI_NO_AUTO_RESIDENT = '1'
    $env:OFFICECLI_SKIP_UPDATE = '1'
    Write-Info "起動しています: $url"
    Write-Info "作業フォルダー: $workspaceFull"
    $proc = Start-Process -FilePath $nodeExe -ArgumentList @("`"$entryPath`"", "`"$workspaceFull`"") -WorkingDirectory $localVersionDir -PassThru -NoNewWindow
    $null = $proc.Handle  # PowerShell 5.1: ExitCode は Handle を参照しておかないと取得できない
    $deadline = (Get-Date).AddSeconds($StartupTimeoutSeconds)
    $ready = $false
    while ((Get-Date) -lt $deadline) {
        if ($proc.HasExited) { break }
        if (Test-PortListening $port) { $ready = $true; break }
        Start-Sleep -Milliseconds 250
    }
    if (-not $ready) {
        if ($proc.HasExited) { throw "Misen のサーバーが起動直後に終了しました (exit=$($proc.ExitCode))" }
        try { $proc.Kill() } catch {}
        throw "Misen のサーバーが $StartupTimeoutSeconds 秒以内に応答しませんでした"
    }
    if (-not $NoBrowser) { Start-Process $url }
    Write-Info 'このウィンドウを閉じると Misen は終了します。'
    $proc.WaitForExit()
    exit $proc.ExitCode
} catch {
    $message = $_.Exception.Message
    Write-DistributionState 'failed' $message $remoteVersion $localVersion $remotePublishId $localPublishId $previousVersion $previousPublishId $false $message
    if ($stage -and (Test-Path -LiteralPath $stage)) { Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue }
    if ($needSync -and $previousVersion -and (Test-Path -LiteralPath (Join-Path $versionsDir $previousVersion) -PathType Container)) {
        try {
            $rollback = [ordered]@{ app = 'enterprise-misen'; version = $previousVersion; publishId = $previousPublishId; rolledBackAt = (Get-Date).ToUniversalTime().ToString('o') }
            Write-JsonAtomic $currentPointerPath $rollback
            Write-DistributionState 'rolled_back' '新しい版の取得に失敗したため前回正常版へ戻しました' $remoteVersion $previousVersion $remotePublishId $previousPublishId $previousVersion $previousPublishId $true $message
            Write-Info "前回正常版 v$previousVersion に戻しました"
        } catch {}
    }
    Write-Host ''
    Write-Host "起動に失敗しました: $message" -ForegroundColor Red
    exit 1
}
