#Requires -Version 5.1
<#
.SYNOPSIS
    社内アプリ標準の配布ZIPを生成する（汎用テンプレート）。

.DESCRIPTION
    apps\<AppName> 配下のうち許可リストに一致するファイルだけを
    「<AppName>_v<バージョン>_日時.zip」に梱包する。
    ZIPはエントリ名UTF-8＋汎用目的ビット11付きで作成するため、
    日本語Windowsのエクスプローラーで展開しても文字化けしない。

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\package-release.ps1 -AppName coding-agent -Version 0.2.0 -RuntimeExe runtime\node-v22.14.0-win-x64\node.exe
#>
param(
    [Parameter(Mandatory = $true)][string]$AppName,
    [string]$Version = '0.0.0',
    [string]$SourceDir = '',
    [string]$OutputDirectory = '',
    [string]$RuntimeExe = ''
)
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

$ShareRoot = Split-Path -Parent $PSScriptRoot
if (-not $SourceDir) { $SourceDir = Join-Path $ShareRoot "apps\$AppName" }
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $ShareRoot 'packages' }

$AllowPatterns = @(
    '^start\.cmd$',
    '^manifest\.json$',
    '^dist/[^/]+\.js$',
    ('^' + [regex]::Escape($AppName) + '\.cmd$'),
    '^runtime/node\.exe$'
)

function Test-AllowedPath {
    param([Parameter(Mandatory = $true)][string]$RelativePath)
    $p = $RelativePath.Replace('\', '/').TrimStart('/')
    foreach ($pat in $AllowPatterns) { if ($p -match $pat) { return $true } }
    return $false
}

function Write-Step([string]$Message) { Write-Host ('[package] ' + $Message) -ForegroundColor Cyan }
function Write-Fail([string]$Message) { Write-Host ('[package] ' + $Message) -ForegroundColor Red }

if (-not (Test-Path -LiteralPath $SourceDir -PathType Container)) { throw "アプリフォルダーが見つかりません: $SourceDir" }

$stampedName = '{0}_v{1}_{2}' -f $AppName, $Version, (Get-Date).ToString('yyyyMMdd-HHmm')
$stageRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('pkg-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
$stageApp = Join-Path $stageRoot $AppName
New-Item -ItemType Directory -Path $stageApp -Force | Out-Null

try {
    Write-Step ('ステージング: ' + $stageApp)
    $copied = 0; $skipped = 0
    foreach ($file in @(Get-ChildItem -LiteralPath $SourceDir -Recurse -File)) {
        $relative = $file.FullName.Substring($SourceDir.Length).TrimStart('\', '/')
        if (-not (Test-AllowedPath -RelativePath $relative)) { $skipped++; continue }
        $target = Join-Path $stageApp ($relative.Replace('/', '\'))
        $targetDir = Split-Path -Parent $target
        if (-not (Test-Path -LiteralPath $targetDir)) { New-Item -ItemType Directory -Path $targetDir -Force | Out-Null }
        Copy-Item -LiteralPath $file.FullName -Destination $target -Force
        $copied++
    }
    if ($RuntimeExe) {
        if (-not (Test-Path -LiteralPath $RuntimeExe -PathType Leaf)) { throw "ランタイムが見つかりません: $RuntimeExe" }
        New-Item -ItemType Directory -Path (Join-Path $stageApp 'runtime') -Force | Out-Null
        Copy-Item -LiteralPath $RuntimeExe -Destination (Join-Path $stageApp 'runtime\node.exe') -Force
        $copied++
    }
    Write-Step ('コピー完了: {0} ファイル（除外 {1} 件）' -f $copied, $skipped)

    $required = @('start.cmd', 'manifest.json')
    $missing = @($required | Where-Object { -not (Test-Path -LiteralPath (Join-Path $stageApp $_) -PathType Leaf) })
    if ($missing.Count -gt 0) {
        Write-Fail '必須ファイルが不足しています:'
        $missing | ForEach-Object { Write-Fail ('  - ' + $_) }
        throw 'パッケージングを中止しました。'
    }

    if (-not (Test-Path -LiteralPath $OutputDirectory)) { New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null }
    $zipPath = Join-Path $OutputDirectory ($stampedName + '.zip')
    if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }

    Add-Type -AssemblyName System.IO.Compression | Out-Null
    Add-Type -AssemblyName System.IO.Compression.FileSystem | Out-Null
    Write-Step ('ZIP作成: ' + $zipPath)
    $zip = [System.IO.Compression.ZipFile]::Open($zipPath, [System.IO.Compression.ZipArchiveMode]::Create, [System.Text.Encoding]::UTF8)
    try {
        foreach ($file in @(Get-ChildItem -LiteralPath $stageRoot -Recurse -File | Sort-Object FullName)) {
            $entryName = $file.FullName.Substring($stageRoot.Length).TrimStart('\', '/').Replace('\', '/')
            $null = [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
                $zip, $file.FullName, $entryName, [System.IO.Compression.CompressionLevel]::Optimal)
        }
    } finally { $zip.Dispose() }

    $check = [System.IO.Compression.ZipFile]::Open($zipPath, [System.IO.Compression.ZipArchiveMode]::Read, [System.Text.Encoding]::UTF8)
    try {
        $names = @($check.Entries | ForEach-Object { $_.FullName })
        $unexpected = @($names | Where-Object {
                $rel = $_ -replace ('^' + [regex]::Escape($AppName) + '/'), ''
                -not (Test-AllowedPath -RelativePath $rel)
            })
        if ($unexpected.Count -gt 0) { throw ('許可されていないZIPエントリを検出しました: ' + (@($unexpected) -join ', ')) }
        $startEntry = @($names | Where-Object { $_ -like '*/start.cmd' })
        if ($startEntry.Count -ne 1) { throw 'start.cmd のエントリ名を検証できませんでした（文字化けの可能性）。' }
        Write-Step ('検証OK: {0} エントリ / start.cmd = {1}' -f $names.Count, $startEntry[0])
    } finally { $check.Dispose() }

    $sizeMb = [math]::Round((Get-Item -LiteralPath $zipPath).Length / 1MB, 2)
    Write-Host ''
    Write-Host ('完成: {0}  ({1} MB)' -f $zipPath, $sizeMb) -ForegroundColor Green
    Write-Host '展開後、start.cmd をダブルクリックして起動を確認してください。' -ForegroundColor Green
} finally {
    if (Test-Path -LiteralPath $stageRoot) {
        try { Remove-Item -LiteralPath $stageRoot -Recurse -Force -ErrorAction SilentlyContinue } catch {}
    }
}
