[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$InputPath,
  [Parameter(Mandatory = $true)][string]$Kind,
  [int]$PartBytes = 90000000,
  [string]$ReplacesKind = '',
  [string]$SourceUrl = '',
  [string]$License = '',
  [string]$LicenseFile = ''
)
$ErrorActionPreference = 'Stop'
function Get-Sha256([string]$LiteralPath) {
  $stream = [IO.File]::OpenRead($LiteralPath)
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
  finally { $sha.Dispose(); $stream.Dispose() }
}
if ($PartBytes -lt 1 -or $PartBytes -ge 95000000) { throw 'PartBytes must be below 95000000.' }
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$source = [IO.Path]::GetFullPath($InputPath)
if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Missing input: $source" }
$targetDir = Join-Path $here 'parts'
New-Item -ItemType Directory -Force -Path $targetDir | Out-Null
$buffer = New-Object byte[] 1048576
$input = [IO.File]::OpenRead($source)
$parts = New-Object 'System.Collections.Generic.List[object]'
try {
  $partNo = 0
  while ($input.Position -lt $input.Length) {
    $partNo++
    $name = ('{0}.part{1:d3}' -f ([IO.Path]::GetFileName($source)), $partNo)
    $outPath = Join-Path $targetDir $name
    $out = [IO.File]::Create($outPath)
    try {
      $remaining = [int64]$PartBytes
      while ($remaining -gt 0 -and $input.Position -lt $input.Length) {
        $want = [Math]::Min([int64]$buffer.Length, $remaining)
        $read = $input.Read($buffer, 0, [int]$want)
        if ($read -le 0) { break }
        $out.Write($buffer, 0, $read); $remaining -= $read
      }
    } finally { $out.Dispose() }
    $item = Get-Item -LiteralPath $outPath
    $parts.Add([ordered]@{ file = "parts/$name"; bytes = [int64]$item.Length; sha256 = (Get-Sha256 $outPath) })
  }
} finally { $input.Dispose() }
$manifestPath = Join-Path $here 'manifest.json'
$manifest = if (Test-Path -LiteralPath $manifestPath) { Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json } else { [pscustomobject]@{ artifacts = @() } }
$artifacts = @($manifest.artifacts | Where-Object { $_.kind -ne $Kind -and (-not $ReplacesKind -or $_.kind -ne $ReplacesKind) })
$item = Get-Item -LiteralPath $source
$artifact = [ordered]@{ kind = $Kind; file = [IO.Path]::GetFileName($source); bytes = [int64]$item.Length; sha256 = (Get-Sha256 $source) }
if ($SourceUrl) { $artifact.source = [ordered]@{ url = $SourceUrl } }
$artifact.parts = $parts.ToArray()
$artifacts += [pscustomobject]$artifact
$notices = @($manifest.notices | Where-Object { $_ -and $_.artifact -ne $Kind -and (-not $ReplacesKind -or $_.artifact -ne $ReplacesKind) })
if ($License -and $LicenseFile) { $notices += [pscustomobject]@{ artifact = $Kind; license = $License; file = $LicenseFile } }
[ordered]@{ format = 1; partLimitBytes = 95000000; notices = $notices; artifacts = $artifacts } | ConvertTo-Json -Depth 7 | Set-Content -LiteralPath $manifestPath -Encoding UTF8
Write-Host "Split $Kind into $($parts.Count) parts."
