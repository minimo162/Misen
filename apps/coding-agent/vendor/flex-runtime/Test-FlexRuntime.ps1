[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
function Get-Sha256([string]$LiteralPath) {
  $stream = [IO.File]::OpenRead($LiteralPath)
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
  finally { $sha.Dispose(); $stream.Dispose() }
}
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$manifest = Get-Content -Raw -LiteralPath (Join-Path $here 'manifest.json') | ConvertFrom-Json
foreach ($artifact in @($manifest.artifacts)) {
  foreach ($part in @($artifact.parts)) {
    $partPath = Join-Path $here $part.file
    $info = Get-Item -LiteralPath $partPath
    if ($info.Length -ge [int64]$manifest.partLimitBytes) { throw "Part limit failed: $($part.file)" }
    if ((Get-Sha256 $partPath) -ne $part.sha256) { throw "Part hash mismatch: $($part.file)" }
  }
  $target = Join-Path $here $artifact.file
  if (Test-Path -LiteralPath $target) {
    if ((Get-Sha256 $target) -ne $artifact.sha256) { throw "Artifact hash mismatch: $($artifact.file)" }
  }
}
Write-Host 'OK all split parts are below the limit and hashes match.'
