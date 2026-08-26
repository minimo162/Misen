[CmdletBinding()]
param(
  [int]$Port = 8080,
  [string]$ApiKey = 'company-apps-flex-local'
)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
& (Join-Path $here 'Join-FlexRuntime.ps1')
& (Join-Path $here 'Test-FlexRuntime.ps1')
$model = Join-Path $here 'Qwen3.5-4B-Q4_K_M.gguf'
$server = Join-Path $here 'llama-b10612-windows-x64-cpu-qrkkk.exe'
if (-not (Test-Path -LiteralPath $server -PathType Leaf)) { throw 'The official unified llama.cpp binary was not reconstructed.' }
$startInfo = New-Object System.Diagnostics.ProcessStartInfo
$startInfo.FileName = $server
$startInfo.Arguments = 'version'
$startInfo.UseShellExecute = $false
$startInfo.CreateNoWindow = $true
$startInfo.RedirectStandardOutput = $true
$startInfo.RedirectStandardError = $true
$check = [Diagnostics.Process]::Start($startInfo)
$stdout = $check.StandardOutput.ReadToEnd()
$stderr = $check.StandardError.ReadToEnd()
$check.WaitForExit()
$version = ($stdout + "`n" + $stderr).Trim()
if ($check.ExitCode -ne 0) { throw "The official unified llama.cpp binary failed its startup check: $version" }
Write-Host $version
& $server serve -m $model --host 127.0.0.1 --port $Port -c 4096 -ngl 0 --jinja --reasoning off --api-key $ApiKey
