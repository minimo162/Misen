param(
    [Parameter(Mandatory = $true)][string]$App,
    [string]$ShortcutPath,
    [string]$LauncherPs1
)
$ErrorActionPreference = 'Stop'
if (-not $LauncherPs1) { $LauncherPs1 = Join-Path $PSScriptRoot 'launch.ps1' }
if (-not $ShortcutPath) {
    $desktop = [Environment]::GetFolderPath('Desktop')
    $ShortcutPath = Join-Path $desktop "$App.lnk"
}
$ws = New-Object -ComObject WScript.Shell
$lnk = $ws.CreateShortcut($ShortcutPath)
$lnk.TargetPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$lnk.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$LauncherPs1`" $App"
$lnk.WorkingDirectory = $env:USERPROFILE
$lnk.IconLocation = "$(Join-Path $env:SystemRoot 'System32\SHELL32.dll'),25"
$lnk.Save()
Write-Host "ショートカット作成: $ShortcutPath -> $App"
