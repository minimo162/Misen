#Requires -Version 5.1
<#
  管理者用: prepare-runtime が生成した Enterprise Misen の自己完結ランタイムを、共有フォルダーの配布レイアウトへ公開する。

  共有フォルダーのレイアウト:
    Misen起動.cmd     利用者がダブルクリックする唯一のファイル
    manifest.json     版数・公開ID・各ファイルの SHA-256（misen-distribution/1）
    app\              Enterprise Misen（dist, node_modules, package.json, dependency-lock.json）
    runtime\          同梱 Node.js と OfficeCLI
    workspace\        作業フォルダーの雛形（初回起動時にローカルへコピー）
    launcher\         launch.ps1 と prepared-runtime の監査用 manifest / SHA256SUMS.txt

  APIキーなどの秘密情報は一切含めない（利用者ごとの %LOCALAPPDATA%\Misen\config\settings.json に置く）。
#>
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
    [Parameter(Mandatory = $true)][string]$Destination,
    [Parameter(Mandatory = $true)][string]$PreparedRuntime,
    [string]$SourceRoot = '',
    [string]$Version = '',
    [string]$Url = 'http://127.0.0.1:8787/',
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
try { $prepared = (Resolve-Path -LiteralPath $PreparedRuntime -ErrorAction Stop).Path.TrimEnd('\', '/') } catch { Fail "prepared runtime が見つかりません: $PreparedRuntime" }

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
    Copy-Item -LiteralPath $entrySource -Destination (Join-Path $stageRoot 'Misen起動.cmd') -Force
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
            $files[$relative] = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        }
    }
    $files['Misen起動.cmd'] = (Get-FileHash -LiteralPath (Join-Path $stageRoot 'Misen起動.cmd') -Algorithm SHA256).Hash.ToLowerInvariant()
    if (-not $files.Contains($entry) -or -not $files.Contains($nodeExe) -or -not $files.Contains($officeCliExe)) { Fail 'ステージングに必須ファイルがありません' }

    $manifest = [ordered]@{
        schema = 'misen-distribution/1'
        name = 'enterprise-misen'
        version = $Version
        publishId = [guid]::NewGuid().ToString('N')
        publishedAt = (Get-Date).ToUniversalTime().ToString('o')
        entry = $entry
        node = $nodeExe
        officeCli = $officeCliExe
        url = $Url
        workspaceSeed = 'workspace'
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
    Write-Utf8NoBom (Join-Path $stageRoot 'manifest.json') (($manifest | ConvertTo-Json -Depth 10) + [Environment]::NewLine)
    Write-Step "版: v$Version / 公開ID: $($manifest.publishId) / ファイル数: $($files.Count)"

    $WhatIfPreference = $stageWhatIfPreference
    if (-not $WhatIfPreference) {
        if (-not (Test-Path -LiteralPath $destinationFull)) { New-Item -ItemType Directory -Force -Path $destinationFull | Out-Null }
        if ($CleanDestination) {
            foreach ($relative in @('app', 'runtime', 'workspace', 'launcher', 'Misen起動.cmd', 'manifest.json')) {
                $target = Join-Path $destinationFull $relative
                if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
            }
        }
        # manifest.json は最後に置く。コピー途中の共有フォルダーを利用者が開いても、古い manifest か新しい manifest のどちらかに整合する。
        & robocopy $stageRoot $destinationFull /E /R:2 /W:1 /NFL /NDL /NJH /NJS /NP /XF manifest.json | Out-Null
        if ($LASTEXITCODE -ge 8) { Fail "配布先へのコピーに失敗しました (robocopy exit=$LASTEXITCODE)" }
        Copy-Item -LiteralPath (Join-Path $stageRoot 'manifest.json') -Destination (Join-Path $destinationFull 'manifest.json') -Force
        $global:LASTEXITCODE = 0
        Write-Ok "配布完了: $destinationFull"
        Write-Ok "Enterprise Misen v$Version（Node $($manifest.preparedRuntime.nodeVersion) / OfficeCLI $($manifest.preparedRuntime.officeCliVersion)）"
        Write-Host '利用者は共有フォルダーの Misen起動.cmd だけをダブルクリックしてください。' -ForegroundColor Green
    } else {
        Write-Host "[publish] WhatIf: 配布先へは書き込みません -> $destinationFull" -ForegroundColor Yellow
    }
} finally {
    if (Test-Path -LiteralPath $stageRoot) {
        try { Remove-Item -LiteralPath $stageRoot -Recurse -Force -WhatIf:$false -ErrorAction SilentlyContinue } catch {}
    }
}
