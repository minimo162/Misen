#Requires -Version 5.1
<#
  管理者用: prepare-runtime が生成した Enterprise Misen の自己完結ランタイムを、共有フォルダーの配布レイアウトへ公開する。

  共有フォルダーのレイアウト（Issue #108）:
    Misen起動.cmd                 利用者が触る唯一のファイル
    _misen\                       隠し属性。先頭アンダースコアで並び順の末尾
      manifest.json               current（有効な版）・版数・公開ID・各ファイルの SHA-256（misen-distribution/2）
      publish-log.txt             公開直後の再検証結果（追記）
      versions\<version>\         版別。前の版を 1 つ残し、それより古い版は公開時に削除
        app\ runtime\ workspace\ launcher\

  公開の順序: 版フォルダーを作り、ハッシュを再検証してから、最後に manifest.json を書き換える。
  APIキーなどの秘密情報は一切含めない（利用者ごとの %LOCALAPPDATA%\Misen\config\settings.json に置く）。
#>
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
    [Parameter(Mandatory = $true)][string]$Destination,
    [Parameter(Mandatory = $true)][string]$PreparedRuntime,
    [string]$SourceRoot = '',
    [string]$Version = '',
    [string]$Url = 'http://127.0.0.1:8787/',
    [int]$KeepPreviousVersions = 1,
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
function Write-Utf8NoBomAtomic([string]$Path, [string]$Content) {
    $tmp = "$Path.tmp-$([guid]::NewGuid().ToString('N'))"
    Write-Utf8NoBom $tmp $Content
    Move-Item -LiteralPath $tmp -Destination $Path -Force
}
function Get-Sha256([string]$Path) { return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }

if (-not $SourceRoot) { $SourceRoot = Split-Path -Parent $PSScriptRoot }
try { $source = (Resolve-Path -LiteralPath $SourceRoot -ErrorAction Stop).Path.TrimEnd('\', '/') } catch { Fail "ソースルートが見つかりません: $SourceRoot" }
try { $prepared = (Resolve-Path -LiteralPath $PreparedRuntime -ErrorAction Stop).Path.TrimEnd('\', '/') } catch { Fail "prepared runtime が見つかりません: $PreparedRuntime" }
if ($KeepPreviousVersions -lt 0) { Fail 'KeepPreviousVersions は 0 以上を指定してください' }

$launcherSource = Join-Path $source 'launcher\launch.ps1'
$entrySource = Join-Path $source 'launcher\Misen起動.cmd'
foreach ($required in @($launcherSource, $entrySource)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { Fail "配布用ファイルが不足しています: $required" }
}

$preparedManifestPath = Join-Path $prepared 'manifest.json'
if (-not (Test-Path -LiteralPath $preparedManifestPath -PathType Leaf)) { Fail "prepared runtime の manifest.json が見つかりません: $preparedManifestPath" }
try { $preparedManifest = Get-Content -LiteralPath $preparedManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json } catch { Fail "prepared runtime の manifest.json を読み込めません: $preparedManifestPath" }
$entry = 'app/dist/src/web/server.js'
$nodeExe = 'runtime/node/node.exe'
$officeCliExe = 'runtime/officecli/officecli.exe'
foreach ($relative in @($entry, $nodeExe, $officeCliExe, 'app/package.json', 'SHA256SUMS.txt')) {
    if (-not (Test-Path -LiteralPath (Join-Path $prepared $relative.Replace('/', '\')) -PathType Leaf)) { Fail "prepared runtime に必須ファイルがありません: $relative" }
}
if (-not (Test-Path -LiteralPath (Join-Path $prepared 'app\node_modules') -PathType Container)) { Fail 'prepared runtime に app\node_modules がありません' }

if (-not $Version) {
    try { $Version = [string]((Get-Content -LiteralPath (Join-Path $prepared 'app\package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version) } catch { $Version = '' }
}
if ([string]::IsNullOrWhiteSpace($Version) -or $Version -notmatch '^[0-9A-Za-z][0-9A-Za-z._-]*$') { Fail "不正なバージョンです: $Version" }
try { $null = [uri]$Url; if (([uri]$Url).Host -notin @('127.0.0.1', 'localhost')) { Fail "URL はループバックだけを許可します: $Url" } } catch { Fail "URL が不正です: $Url" }

try { $destinationFull = [System.IO.Path]::GetFullPath($Destination).TrimEnd('\', '/') } catch { Fail "配布先を解決できません: $Destination" }
$sourceComparable = $source + '\'
$destinationComparable = $destinationFull + '\'
if ($destinationComparable.StartsWith($sourceComparable, [System.StringComparison]::OrdinalIgnoreCase)) { Fail '配布先をソースルートの中に置くことはできません。' }
if ($destinationComparable.StartsWith(($prepared + '\'), [System.StringComparison]::OrdinalIgnoreCase)) { Fail '配布先を prepared runtime の中に置くことはできません。' }

$misenDir = Join-Path $destinationFull '_misen'
$versionsDir = Join-Path $misenDir 'versions'
$manifestPath = Join-Path $misenDir 'manifest.json'
$publishLogPath = Join-Path $misenDir 'publish-log.txt'
$targetVersionDir = Join-Path $versionsDir $Version

$stageRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('misen-publish-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
$stageWhatIfPreference = $WhatIfPreference
try {
    # 一時ステージングは WhatIf でも生成して整合性を検証し、共有先へのコピーだけを抑止する。
    $WhatIfPreference = $false
    Write-Step "ステージング: $stageRoot"
    New-Item -ItemType Directory -Force -Path $stageRoot | Out-Null
    foreach ($directory in @('app', 'runtime', 'workspace')) {
        $from = Join-Path $prepared $directory
        if (-not (Test-Path -LiteralPath $from -PathType Container)) {
            if ($directory -eq 'workspace') { continue }
            Fail "prepared runtime に $directory がありません: $from"
        }
        & robocopy $from (Join-Path $stageRoot $directory) /E /R:2 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
        if ($LASTEXITCODE -ge 8) { Fail "ステージングへのコピーに失敗しました ($directory, robocopy exit=$LASTEXITCODE)" }
    }
    $global:LASTEXITCODE = 0
    New-Item -ItemType Directory -Force -Path (Join-Path $stageRoot 'launcher\prepared-runtime') | Out-Null
    Copy-Item -LiteralPath $launcherSource -Destination (Join-Path $stageRoot 'launcher\launch.ps1') -Force
    Copy-Item -LiteralPath $preparedManifestPath -Destination (Join-Path $stageRoot 'launcher\prepared-runtime\manifest.json') -Force
    Copy-Item -LiteralPath (Join-Path $prepared 'SHA256SUMS.txt') -Destination (Join-Path $stageRoot 'launcher\prepared-runtime\SHA256SUMS.txt') -Force

    Write-Step 'SHA-256 を計算しています'
    $files = [ordered]@{}
    $stagePrefix = $stageRoot + '\'
    foreach ($directory in @('app', 'runtime', 'workspace', 'launcher')) {
        $dir = Join-Path $stageRoot $directory
        if (-not (Test-Path -LiteralPath $dir -PathType Container)) { continue }
        Get-ChildItem -LiteralPath $dir -File -Recurse | Sort-Object FullName | ForEach-Object {
            $relative = $_.FullName.Substring($stagePrefix.Length).Replace('\', '/')
            $files[$relative] = Get-Sha256 $_.FullName
        }
    }
    if (-not $files.Contains($entry) -or -not $files.Contains($nodeExe) -or -not $files.Contains($officeCliExe)) { Fail 'ステージングに必須ファイルがありません' }

    $previousManifest = $null
    if (Test-Path -LiteralPath $manifestPath -PathType Leaf) {
        try { $previousManifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json } catch { $previousManifest = $null }
    }
    $previousCurrent = if ($previousManifest -and $previousManifest.current) { [string]$previousManifest.current } else { '' }
    # 同じ版数の再公開は禁止する。current が指す版フォルダーを書き直すと、公開中の利用者が起動に失敗し、再検証に失敗すると全利用者が起動できなくなるため。
    if ($previousCurrent -eq $Version) { Fail "版 v$Version は既に共有フォルダーで有効な版です。版数を上げてから公開してください（同じ版数の再公開はできません）。" }

    $manifest = [ordered]@{
        schema = 'misen-distribution/2'
        name = 'enterprise-misen'
        current = $Version
        version = $Version
        publishId = [guid]::NewGuid().ToString('N')
        publishedAt = (Get-Date).ToUniversalTime().ToString('o')
        previousVersion = $previousCurrent
        versionsRoot = 'versions'
        entry = $entry
        node = $nodeExe
        officeCli = $officeCliExe
        launcher = 'launcher/launch.ps1'
        url = $Url
        workspaceSeed = 'workspace'
        entryCmdSha256 = Get-Sha256 $entrySource
        preparedRuntime = [ordered]@{
            schemaVersion = $preparedManifest.schemaVersion
            applicationVersion = $preparedManifest.applicationVersion
            buildGitSha = $preparedManifest.buildGitSha
            nodeVersion = $preparedManifest.node.version
            officeCliVersion = $preparedManifest.officeCli.version
        }
        fileCount = $files.Count
        files = $files
    }
    $manifestJson = ($manifest | ConvertTo-Json -Depth 10) + [Environment]::NewLine
    Write-Step "版: v$Version / 公開ID: $($manifest.publishId) / ファイル数: $($files.Count)"

    $WhatIfPreference = $stageWhatIfPreference
    if ($WhatIfPreference) {
        Write-Host "[publish] WhatIf: 配布先へは書き込みません -> $targetVersionDir" -ForegroundColor Yellow
        return
    }

    New-Item -ItemType Directory -Force -Path $versionsDir | Out-Null
    if ($CleanDestination) {
        # 旧レイアウト（最上位の app/runtime/workspace/launcher/manifest.json）と、他の全版を削除する。
        foreach ($relative in @('app', 'runtime', 'workspace', 'launcher', 'manifest.json')) {
            $legacy = Join-Path $destinationFull $relative
            if (Test-Path -LiteralPath $legacy) { Remove-Item -LiteralPath $legacy -Recurse -Force }
        }
        Get-ChildItem -LiteralPath $versionsDir -Directory | Where-Object { $_.Name -ne $Version } | ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force }
        $previousCurrent = ''
    }

    # 1. 版フォルダーを作る（manifest はまだ前の版を指している。current と同じ版数は上で拒否済み）。
    Write-Step "版フォルダーを書き込んでいます: $targetVersionDir"
    if (Test-Path -LiteralPath $targetVersionDir) { Remove-Item -LiteralPath $targetVersionDir -Recurse -Force }
    & robocopy $stageRoot $targetVersionDir /E /R:2 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { Fail "配布先へのコピーに失敗しました (robocopy exit=$LASTEXITCODE)" }
    $global:LASTEXITCODE = 0

    # 2. 公開直後の再検証: 共有側の版フォルダーを manifest の SHA-256 と突き合わせる。
    Write-Step '共有側のハッシュを再検証しています'
    $verifyErrors = New-Object System.Collections.Generic.List[string]
    foreach ($property in $manifest.files.GetEnumerator()) {
        $path = Join-Path $targetVersionDir ([string]$property.Key).Replace('/', '\')
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { $verifyErrors.Add("missing $($property.Key)"); continue }
        if ((Get-Sha256 $path) -ne [string]$property.Value) { $verifyErrors.Add("sha256 mismatch $($property.Key)") }
    }
    $verifyResult = if ($verifyErrors.Count -eq 0) { 'OK' } else { 'FAIL(' + (($verifyErrors | Select-Object -First 5) -join '; ') + ')' }
    $logLine = "{0}`tversion={1}`tpublishId={2}`tfiles={3}`tverify={4}`tby={5}@{6}" -f (Get-Date).ToUniversalTime().ToString('o'), $Version, $manifest.publishId, $files.Count, $verifyResult, $env:USERNAME, $env:COMPUTERNAME
    Add-Content -LiteralPath $publishLogPath -Value $logLine -Encoding UTF8
    if ($verifyErrors.Count -gt 0) {
        Remove-Item -LiteralPath $targetVersionDir -Recurse -Force -ErrorAction SilentlyContinue
        Fail "公開直後の再検証に失敗しました（$($verifyErrors.Count) 件）。manifest は前の版のままです。publish-log.txt を確認してください。"
    }

    # 3. 最上位の Misen起動.cmd を更新し、_misen に隠し属性を付ける。
    Copy-Item -LiteralPath $entrySource -Destination (Join-Path $destinationFull 'Misen起動.cmd') -Force
    $misenItem = Get-Item -LiteralPath $misenDir -Force
    if (-not ($misenItem.Attributes -band [System.IO.FileAttributes]::Hidden)) { $misenItem.Attributes = $misenItem.Attributes -bor [System.IO.FileAttributes]::Hidden }

    # 4. 最後に manifest.json を差し替える（アトミック）。コピー途中の共有フォルダーを利用者が開いても前の版か新しい版のどちらかに整合する。
    Write-Utf8NoBomAtomic $manifestPath $manifestJson

    # 5. 前の版を KeepPreviousVersions 個だけ残し、それより古い版を削除する。
    $keep = New-Object System.Collections.Generic.List[string]
    $keep.Add($Version)
    if ($previousCurrent -and $previousCurrent -ne $Version -and $KeepPreviousVersions -gt 0) { $keep.Add($previousCurrent) }
    $others = Get-ChildItem -LiteralPath $versionsDir -Directory | Where-Object { $keep -notcontains $_.Name } | Sort-Object LastWriteTimeUtc -Descending
    $extraKeep = [Math]::Max(0, $KeepPreviousVersions - ($keep.Count - 1))
    $others | Select-Object -Skip $extraKeep | ForEach-Object {
        Write-Step "古い版を削除しています: $($_.Name)"
        try { Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction Stop } catch { Write-Host "[publish] 古い版の削除に失敗しました（次回再試行）: $($_.Exception.Message)" -ForegroundColor Yellow }
    }

    Write-Ok "配布完了: $destinationFull"
    Write-Ok "Enterprise Misen v$Version（Node $($manifest.preparedRuntime.nodeVersion) / OfficeCLI $($manifest.preparedRuntime.officeCliVersion)）再検証: $verifyResult"
    if ($previousCurrent -and $previousCurrent -ne $Version) { Write-Ok "前の版 v$previousCurrent は _misen\versions に残しています" }
    Write-Host '利用者は共有フォルダーの Misen起動.cmd だけをダブルクリックしてください。' -ForegroundColor Green
} finally {
    if (Test-Path -LiteralPath $stageRoot) {
        try { Remove-Item -LiteralPath $stageRoot -Recurse -Force -WhatIf:$false -ErrorAction SilentlyContinue } catch {}
    }
}
