[CmdletBinding()]
param(
  [string]$ReleaseBase = 'https://github.com/minimo162/company-apps-share/releases/download/flex-runtime-v1',
  [string]$Repository = 'minimo162/company-apps-share',
  [string]$ReleaseTag = 'flex-runtime-v1',
  [string]$Kind = '',
  [switch]$ForceDownload,
  [switch]$DownloadOnly
)
$ErrorActionPreference = 'Stop'

function Get-Sha256([string]$LiteralPath) {
  $stream = [IO.File]::OpenRead($LiteralPath)
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
  finally { $sha.Dispose(); $stream.Dispose() }
}

function Receive-VerifiedAsset(
  [string]$AssetName,
  [string]$Destination,
  [int64]$ExpectedBytes,
  [string]$ExpectedSha256
) {
  if (-not $ForceDownload -and (Test-Path -LiteralPath $Destination -PathType Leaf)) {
    $existing = Get-Item -LiteralPath $Destination
    if ($existing.Length -eq $ExpectedBytes -and (Get-Sha256 $Destination) -eq $ExpectedSha256) {
      Write-Host "OK existing $AssetName"
      return
    }
  }

  $parent = Split-Path -Parent $Destination
  if (-not (Test-Path -LiteralPath $parent -PathType Container)) {
    New-Item -ItemType Directory -Path $parent | Out-Null
  }
  $temporary = $Destination + '.download'
  if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
  $url = $ReleaseBase.TrimEnd('/') + '/' + $AssetName
  Write-Host "GET $url"
  try {
    Invoke-WebRequest -UseBasicParsing -Headers @{ 'User-Agent' = 'company-apps-flex-runtime-v1' } -Uri $url -OutFile $temporary
  } catch {
    $downloaded = $false
    $gh = Get-Command 'gh.exe' -ErrorAction SilentlyContinue
    if ($gh) {
      Write-Host 'INFO direct download failed; retrying through authenticated gh.exe'
      & $gh.Source 'release' 'download' $ReleaseTag '--repo' $Repository '--pattern' $AssetName '--output' $temporary
      $downloaded = $LASTEXITCODE -eq 0
    }
    if (-not $downloaded) {
      if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
      $curl = Get-Command 'curl.exe' -ErrorAction SilentlyContinue
      if (-not $curl) { throw }
      Write-Host 'INFO authenticated gh.exe unavailable; retrying direct URL with Windows curl.exe'
      & $curl.Source '--fail' '--location' '--retry' '3' '--retry-delay' '2' '--output' $temporary $url
      if ($LASTEXITCODE -ne 0) { throw "Release download failed ($LASTEXITCODE): $AssetName. For this private repository, run gh auth login first." }
    }
  }
  $downloaded = Get-Item -LiteralPath $temporary
  if ($downloaded.Length -ne $ExpectedBytes) {
    Remove-Item -LiteralPath $temporary -Force
    throw "Downloaded size mismatch: $AssetName"
  }
  $actual = Get-Sha256 $temporary
  if ($actual -ne $ExpectedSha256) {
    Remove-Item -LiteralPath $temporary -Force
    throw "Downloaded hash mismatch: $AssetName"
  }
  Move-Item -LiteralPath $temporary -Destination $Destination -Force
  Write-Host "OK downloaded $AssetName $actual"
}

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$manifest = Get-Content -Raw -LiteralPath (Join-Path $here 'manifest.json') | ConvertFrom-Json

$artifacts = @($manifest.artifacts | Where-Object { -not $Kind -or $_.kind -eq $Kind })
if ($artifacts.Count -eq 0) { throw 'No matching runtime artifact in manifest.' }
foreach ($artifact in $artifacts) {
  $target = Join-Path $here $artifact.file
  if (Test-Path -LiteralPath $target -PathType Leaf) {
    $targetInfo = Get-Item -LiteralPath $target
    if ($targetInfo.Length -eq [int64]$artifact.bytes -and (Get-Sha256 $target) -eq $artifact.sha256) {
      Write-Host "OK complete $($artifact.file)"
      continue
    }
  }

  if ($artifact.kind -eq 'llama_cpp_windows_cpu') {
    Receive-VerifiedAsset -AssetName $artifact.file -Destination $target -ExpectedBytes ([int64]$artifact.bytes) -ExpectedSha256 $artifact.sha256
    continue
  }

  foreach ($part in @($artifact.parts)) {
    $assetName = Split-Path -Leaf $part.file
    $partPath = Join-Path $here $part.file
    Receive-VerifiedAsset -AssetName $assetName -Destination $partPath -ExpectedBytes ([int64]$part.bytes) -ExpectedSha256 $part.sha256
  }
}

if (-not $DownloadOnly) {
  & (Join-Path $here 'Join-FlexRuntime.ps1')
  & (Join-Path $here 'Test-FlexRuntime.ps1')
}

