[CmdletBinding()]
param(
  [string]$ReleaseBase = 'https://github.com/minimo162/Misen/releases/download/flex-runtime-v1',
  [string]$Repository = 'minimo162/Misen',
  [string]$ReleaseTag = 'flex-runtime-v1',
  [switch]$ForceDownload,
  [switch]$SkipLaunchTest
)
$ErrorActionPreference = 'Stop'

function Get-Sha256([string]$LiteralPath) {
  $stream = [IO.File]::OpenRead($LiteralPath)
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
  finally { $sha.Dispose(); $stream.Dispose() }
}

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$manifest = Get-Content -Raw -LiteralPath (Join-Path $here 'manifest.json') | ConvertFrom-Json
$artifact = $manifest.artifact
$target = Join-Path $here 'opencode.exe'
$validExisting = $false
if (-not $ForceDownload -and (Test-Path -LiteralPath $target -PathType Leaf)) {
  $existing = Get-Item -LiteralPath $target
  $validExisting = $existing.Length -eq [int64]$artifact.bytes -and (Get-Sha256 $target) -eq $artifact.sha256
}

if (-not $validExisting) {
  $temporary = $target + '.download'
  if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
  $url = $ReleaseBase.TrimEnd('/') + '/' + $artifact.name
  Write-Host "GET $url"
  try {
    Invoke-WebRequest -UseBasicParsing -Headers @{ 'User-Agent' = 'company-apps-opencode-1.18.21' } -Uri $url -OutFile $temporary
  } catch {
    if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
    $gh = Get-Command 'gh.exe' -ErrorAction SilentlyContinue
    if (-not $gh) {
      throw "Release download failed. This is a private repository; install GitHub CLI and run gh auth login first. URL: $url"
    }
    Write-Host 'INFO direct download failed; retrying through authenticated gh.exe'
    & $gh.Source 'release' 'download' $ReleaseTag '--repo' $Repository '--pattern' $artifact.name '--output' $temporary
    if ($LASTEXITCODE -ne 0) { throw "gh release download failed ($LASTEXITCODE): $($artifact.name)" }
  }

  $downloaded = Get-Item -LiteralPath $temporary
  if ($downloaded.Length -ne [int64]$artifact.bytes) {
    Remove-Item -LiteralPath $temporary -Force
    throw "Downloaded size mismatch: $($artifact.name)"
  }
  $actual = Get-Sha256 $temporary
  if ($actual -ne $artifact.sha256) {
    Remove-Item -LiteralPath $temporary -Force
    throw "Downloaded hash mismatch: $($artifact.name)"
  }
  Move-Item -LiteralPath $temporary -Destination $target -Force
}

$actualHash = Get-Sha256 $target
if ($actualHash -ne $artifact.sha256) { throw 'OpenCode SHA-256 verification failed.' }
Write-Host "OK SHA256 $actualHash"

if (-not $SkipLaunchTest) {
  $versionOutput = (& $target '--version' 2>&1 | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or $versionOutput -notmatch [regex]::Escape([string]$artifact.version)) {
    throw "OpenCode standalone launch test failed: $versionOutput"
  }
  Write-Host "OK launch $versionOutput"
}

Write-Output $target
