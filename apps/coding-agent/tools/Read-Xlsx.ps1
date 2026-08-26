[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string[]]$Path
)
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8
$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$appRoot = Split-Path -Parent $scriptRoot
$appsRoot = Split-Path -Parent $appRoot
$repoRoot = Split-Path -Parent $appsRoot
$reader = Join-Path $repoRoot 'demo\renketsu-demo\workspace\tools\Read-Xlsx.ps1'
$module = Join-Path $repoRoot 'demo\renketsu-demo\workspace\vendor\ImportExcel\7.8.10'
if (-not (Test-Path -LiteralPath $reader -PathType Leaf)) { throw "Bundled xlsx reader was not found: $reader" }
if (-not (Test-Path -LiteralPath $module -PathType Container)) { throw "Bundled ImportExcel module was not found: $module" }
& $reader -Path $Path -ImportExcelPath $module
