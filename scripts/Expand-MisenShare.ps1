#Requires -Version 5.1
<#
  社内 PC 用: GitHub Release からダウンロードした共有フォルダー配布物（misen-share-*.zip）を
  検証して共有フォルダーへ展開する。管理者権限は不要。git も Node.js も不要。

  1. zip の SHA-256 を同名の .sha256.txt と突き合わせる
  2. 共有フォルダーの最上位に Misen起動.cmd と _misen\ だけを展開する（既存の _misen\versions は残す）
  3. 展開したファイルの「インターネットから取得」マーク（Zone.Identifier）を外す
  4. _misen に隠し属性を付ける
  5. _misen\publish-log.txt の最終行（生成時の再検証結果）を表示する

  使い方:
    powershell -NoProfile -ExecutionPolicy Bypass -File .\Expand-MisenShare.ps1 -Zip .\misen-share-0.2.0-abc1234.zip -Destination "\\fileserver\財務\Misen"
#>
param(
    [Parameter(Mandatory = $true)][string]$Zip,
    [Parameter(Mandatory = $true)][string]$Destination,
    [switch]$SkipHashCheck
)
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
function Step([string]$m) { Write-Host "[expand] $m" -ForegroundColor Cyan }
function Ok([string]$m) { Write-Host "[expand] $m" -ForegroundColor Green }
function Fail([string]$m) { Write-Host "[expand] $m" -ForegroundColor Red; exit 1 }

try { $zipPath = (Resolve-Path -LiteralPath $Zip -ErrorAction Stop).Path } catch { Fail "zip が見つかりません: $Zip" }
if (-not $SkipHashCheck) {
    $sumPath = "$zipPath.sha256.txt"
    if (-not (Test-Path -LiteralPath $sumPath -PathType Leaf)) { Fail "SHA-256 ファイルが見つかりません: $sumPath（Release から同じフォルダーへダウンロードしてください。検証を省く場合は -SkipHashCheck）" }
    $expected = ((Get-Content -LiteralPath $sumPath -Raw) -split '\s+')[0].ToLowerInvariant()
    $actual = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($expected -ne $actual) { Fail "zip の SHA-256 が一致しません。ダウンロードし直してください。`n  期待: $expected`n  実際: $actual" }
    Ok "zip の SHA-256 を確認しました"
}

$dest = $Destination.TrimEnd('\', '/')
if (-not (Test-Path -LiteralPath $dest)) { New-Item -ItemType Directory -Force -Path $dest | Out-Null }
$dest = (Resolve-Path -LiteralPath $dest).Path.TrimEnd('\', '/')

Step "一時フォルダーへ展開しています"
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ('misen-share-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::ExtractToDirectory($zipPath, $tmp)
try {
    $entry = Join-Path $tmp 'Misen起動.cmd'
    $misen = Join-Path $tmp '_misen'
    if (-not (Test-Path -LiteralPath $entry -PathType Leaf) -or -not (Test-Path -LiteralPath (Join-Path $misen 'manifest.json') -PathType Leaf)) {
        Fail 'zip の中身が配布物の形（Misen起動.cmd と _misen\manifest.json）ではありません'
    }
    $manifest = Get-Content -LiteralPath (Join-Path $misen 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    Step "版 $($manifest.current) を共有フォルダーへ配置しています: $dest"

    # 版フォルダー → 起動ファイル → manifest の順。途中で利用者が開いても前の版か新しい版のどちらかに整合する。
    $destMisen = Join-Path $dest '_misen'
    New-Item -ItemType Directory -Force -Path (Join-Path $destMisen 'versions') | Out-Null
    $srcVersion = Join-Path (Join-Path $misen 'versions') $manifest.current
    $dstVersion = Join-Path (Join-Path $destMisen 'versions') $manifest.current
    if (Test-Path -LiteralPath $dstVersion) { Remove-Item -LiteralPath $dstVersion -Recurse -Force }
    & robocopy $srcVersion $dstVersion /E /R:2 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { Fail "コピーに失敗しました (robocopy exit=$LASTEXITCODE)" }
    $global:LASTEXITCODE = 0
    Copy-Item -LiteralPath $entry -Destination (Join-Path $dest 'Misen起動.cmd') -Force
    if (Test-Path -LiteralPath (Join-Path $misen 'publish-log.txt')) {
        Get-Content -LiteralPath (Join-Path $misen 'publish-log.txt') -Encoding UTF8 | Add-Content -LiteralPath (Join-Path $destMisen 'publish-log.txt') -Encoding UTF8
    }
    $tmpManifest = Join-Path $destMisen ('manifest.json.tmp-' + [guid]::NewGuid().ToString('N'))
    Copy-Item -LiteralPath (Join-Path $misen 'manifest.json') -Destination $tmpManifest -Force
    Move-Item -LiteralPath $tmpManifest -Destination (Join-Path $destMisen 'manifest.json') -Force

    Step 'インターネットから取得したマークを外しています'
    Get-ChildItem -LiteralPath $dest -Recurse -File -Force | Unblock-File -ErrorAction SilentlyContinue
    Get-Item -LiteralPath (Join-Path $dest 'Misen起動.cmd') | Unblock-File -ErrorAction SilentlyContinue

    $item = Get-Item -LiteralPath $destMisen -Force
    if (-not ($item.Attributes -band [System.IO.FileAttributes]::Hidden)) { $item.Attributes = $item.Attributes -bor [System.IO.FileAttributes]::Hidden }

    Ok "配置完了: $dest"
    Ok "有効な版: $($manifest.current) / 公開ID: $($manifest.publishId)"
    $log = Join-Path $destMisen 'publish-log.txt'
    if (Test-Path -LiteralPath $log) { Write-Host ('[expand] 生成時の再検証: ' + (Get-Content -LiteralPath $log -Encoding UTF8 | Select-Object -Last 1)) }
    Write-Host '利用者は共有フォルダーの Misen起動.cmd だけをダブルクリックしてください。' -ForegroundColor Green
} finally {
    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
