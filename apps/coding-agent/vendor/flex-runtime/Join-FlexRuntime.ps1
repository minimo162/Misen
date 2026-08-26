[CmdletBinding()]
param([string]$Kind = '')
$ErrorActionPreference = 'Stop'
function Get-Sha256([string]$LiteralPath) {
  $stream = [IO.File]::OpenRead($LiteralPath)
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
  finally { $sha.Dispose(); $stream.Dispose() }
}
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$manifest = Get-Content -Raw -LiteralPath (Join-Path $here 'manifest.json') | ConvertFrom-Json
$items = @($manifest.artifacts | Where-Object { -not $Kind -or $_.kind -eq $Kind })
if ($items.Count -eq 0) { throw 'No matching runtime artifact in manifest.' }
foreach ($artifact in $items) {
  $target = Join-Path $here $artifact.file
  if (Test-Path -LiteralPath $target -PathType Leaf) {
    $existingHash = Get-Sha256 $target
    if ($existingHash -eq $artifact.sha256) {
      Write-Host "OK $($artifact.file) $existingHash (existing)"
      continue
    }
  }
  $stream = [IO.File]::Create($target)
  try {
    foreach ($part in @($artifact.parts)) {
      $partPath = Join-Path $here $part.file
      if (-not (Test-Path -LiteralPath $partPath -PathType Leaf)) { throw "Missing part: $($part.file)" }
      $actual = Get-Sha256 $partPath
      if ($actual -ne $part.sha256) { throw "Part hash mismatch: $($part.file)" }
      $input = [IO.File]::OpenRead($partPath)
      try { $input.CopyTo($stream) } finally { $input.Dispose() }
    }
  } finally { $stream.Dispose() }
  $actual = Get-Sha256 $target
  if ($actual -ne $artifact.sha256) { Remove-Item -LiteralPath $target -Force; throw "Reassembled hash mismatch: $($artifact.file)" }
  Write-Host "OK $($artifact.file) $actual"
}
