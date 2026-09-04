#Requires -Version 5.1
<#
  管理者用（開発 PC）: 共有フォルダー配布物を生成し、zip にして GitHub Release に添付する。
  GitHub Actions の分数を使わない配布経路。社内 PC では Release から zip を落とし、
  Expand-MisenShare.ps1 で共有フォルダーへ展開する（DEPLOY.md「GitHub 経由の配布」）。

  手順:
    1. Prepare-Misen.ps1 で一時フォルダーへ共有フォルダー形式に公開（npm ci → unit テスト → ランタイム取得と検証 → 生成 → 検証 → 公開）
    2. UTF-8 名の zip と .sha256.txt を作る
    3. gh release create でタグ share-v<version>-<sha7> の Release を作り、zip / .sha256.txt / Expand-MisenShare.ps1 を添付

  例:
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\Publish-Release.ps1 -NodeRuntime <検証済み Node 入力> -OfficeCliRuntime <検証済み OfficeCLI 入力>
#>
param(
    [string]$Version = '',
    [string]$NodeRuntime = '',
    [string]$OfficeCliRuntime = '',
    [switch]$SkipTests,
    [switch]$SkipNpmInstall,
    [switch]$Prerelease,
    [int]$KeepReleases = 2,
    [string]$OutputDirectory = ''
)
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
function Step([string]$m) { Write-Host "[release] $m" -ForegroundColor Cyan }
function Ok([string]$m) { Write-Host "[release] $m" -ForegroundColor Green }
function Fail([string]$m) { throw "[release] $m" }

$root = Split-Path -Parent $PSScriptRoot
if (-not (Get-Command gh -ErrorAction SilentlyContinue)) { Fail 'gh（GitHub CLI）が見つかりません。' }
& gh auth status 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) { Fail 'gh にサインインしていません。gh auth login を実行してください。' }
$global:LASTEXITCODE = 0

if (-not $Version) { $Version = (Get-Content (Join-Path $root 'apps\enterprise-misen\package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version }
$sha = (& git -C $root rev-parse --short=7 HEAD).Trim()
$dirty = (& git -C $root status --porcelain).Length -gt 0
if ($dirty) { Fail '作業ツリーに未コミットの変更があります。コミットするか退避してから実行してください（Release は特定のコミットに紐づけます）。' }
$tag = "share-v$Version-$sha"
$name = "misen-share-$Version-$sha"
if (-not $OutputDirectory) { $OutputDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ('misen-release-' + [guid]::NewGuid().ToString('N').Substring(0, 8)) }
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$share = Join-Path $OutputDirectory 'share'
$zip = Join-Path $OutputDirectory "$name.zip"

Step "配布物を生成しています（版 $Version / $sha）"
$args = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $root 'scripts\Prepare-Misen.ps1'), '-Destination', $share, '-Version', $Version, '-CleanDestination')
if ($NodeRuntime) { $args += @('-NodeRuntime', $NodeRuntime) }
if ($OfficeCliRuntime) { $args += @('-OfficeCliRuntime', $OfficeCliRuntime) }
if ($SkipTests) { $args += '-SkipTests' }
if ($SkipNpmInstall) { $args += '-SkipNpmInstall' }
& (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') @args
if ($LASTEXITCODE -ne 0) { Fail "Prepare-Misen.ps1 が失敗しました (exit=$LASTEXITCODE)" }
$global:LASTEXITCODE = 0
$publishLine = Get-Content (Join-Path $share '_misen\publish-log.txt') -Encoding UTF8 | Select-Object -Last 1
if ($publishLine -notmatch 'verify=OK') { Fail "公開直後の再検証が OK ではありません: $publishLine" }

Step 'zip を作成しています（UTF-8 名）'
Add-Type -AssemblyName System.IO.Compression.FileSystem
if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }
[System.IO.Compression.ZipFile]::CreateFromDirectory($share, $zip, [System.IO.Compression.CompressionLevel]::Optimal, $false, [System.Text.Encoding]::UTF8)
$hash = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
[System.IO.File]::WriteAllText("$zip.sha256.txt", "$hash  $name.zip`n", (New-Object System.Text.ASCIIEncoding))
$files = (Get-ChildItem $share -Recurse -File -Force).Count
$size = (Get-Item $zip).Length
Ok "zip: $zip ($size bytes, $files files) SHA-256 $hash"

$manifest = Get-Content (Join-Path $share '_misen\manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$notes = @(
    "# Enterprise Misen 共有フォルダー配布物 v$Version",
    '',
    "開発 PC で ``scripts\Publish-Release.ps1`` により、コミット ``$((& git -C $root rev-parse HEAD).Trim())`` から生成。",
    '',
    "- 配布物: ``$name.zip``（$size bytes、$files files）",
    "- zip SHA-256: ``$hash``",
    "- 公開ID: ``$($manifest.publishId)``",
    "- 同梱: Node.js $($manifest.preparedRuntime.nodeVersion) / OfficeCLI $($manifest.preparedRuntime.officeCliVersion)（公式配布物を契約ファイルの SHA-256 で検証済み）",
    "- 公開直後の再検証: ``$publishLine``",
    '',
    '## 社内 PC での展開',
    '',
    '1. この Release から zip、`.sha256.txt`、`Expand-MisenShare.ps1` の 3 つを同じフォルダーへダウンロードする',
    '2. PowerShell で次を実行する（共有フォルダーのパスは置き換える）',
    '',
    '```',
    "powershell -NoProfile -ExecutionPolicy Bypass -File .\Expand-MisenShare.ps1 -Zip .\$name.zip -Destination `"\\fileserver\財務\Misen`"",
    '```',
    '',
    '3. 利用者は共有フォルダーの `Misen起動.cmd` をダブルクリックする',
    '',
    '詳細は DEPLOY.md の「GitHub 経由の配布」を参照。'
) -join "`n"
$notesPath = Join-Path $OutputDirectory 'notes.md'
[System.IO.File]::WriteAllText($notesPath, $notes, (New-Object System.Text.UTF8Encoding($false)))

Step "GitHub Release を作成しています: $tag"
$ghArgs = @('release', 'create', $tag, $zip, "$zip.sha256.txt", (Join-Path $root 'scripts\Expand-MisenShare.ps1'), '--title', "共有フォルダー配布物 v$Version ($sha)", '--notes-file', $notesPath, '--target', (& git -C $root rev-parse HEAD).Trim())
if ($Prerelease) { $ghArgs += '--prerelease' } else { $ghArgs += '--latest' }
& gh @ghArgs
if ($LASTEXITCODE -ne 0) { Fail "gh release create が失敗しました (exit=$LASTEXITCODE)" }
$global:LASTEXITCODE = 0
Ok "Release を作成しました: $tag"

# 古い share-v* の Release を KeepReleases 個だけ残して削除する（タグも消す）。共有フォルダーには最新だけ展開するので、Release 一覧が増え続けないようにする。
if ($KeepReleases -ge 1) {
    $existing = (& gh release list --limit 100 --json tagName,createdAt | ConvertFrom-Json) | Where-Object { $_.tagName -like 'share-v*' } | Sort-Object createdAt -Descending
    $global:LASTEXITCODE = 0
    $stale = @($existing | Select-Object -Skip $KeepReleases)
    foreach ($old in $stale) {
        & gh release delete $old.tagName --cleanup-tag --yes 2>$null
        if ($LASTEXITCODE -eq 0) { Step "古い Release を削除しました: $($old.tagName)" } else { Write-Host "[release] 古い Release の削除に失敗しました（次回再試行）: $($old.tagName)" -ForegroundColor Yellow }
        $global:LASTEXITCODE = 0
    }
}
Ok "生成物は $OutputDirectory に残しています（不要なら削除してください）。"
