[CmdletBinding()]
param(
    [string]$OutputPath
)

$ErrorActionPreference = 'Stop'
$appRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
if ([string]::IsNullOrWhiteSpace($OutputPath)) {
    $OutputPath = Join-Path $appRoot 'evidence\process-network-observation.json'
}
$outputFullPath = [System.IO.Path]::GetFullPath($OutputPath)
$evidenceRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('misen-d427-observation-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $evidenceRoot | Out-Null
$stdoutPath = Join-Path $evidenceRoot 'stdout.txt'
$stderrPath = Join-Path $evidenceRoot 'stderr.txt'
$holdMilliseconds = 12000
$sampleIntervalMilliseconds = 250
$nodeCode = "await import('./dist/test/phase-d/vertical-slice.test.js'); await new Promise(resolve => setTimeout(resolve, $holdMilliseconds));"
$quotedCode = '"' + $nodeCode + '"'

try {
    $startedAt = Get-Date
    $process = Start-Process `
        -FilePath (Get-Command node).Source `
        -ArgumentList @('--input-type=module', '--eval', $quotedCode) `
        -WorkingDirectory $appRoot `
        -RedirectStandardOutput $stdoutPath `
        -RedirectStandardError $stderrPath `
        -WindowStyle Hidden `
        -PassThru

    $rootPid = $process.Id
    $samples = 0
    $children = @()
    $connections = @()
    do {
        $samples++
        $knownPids = @($rootPid)
        $index = 0
        while ($index -lt $knownPids.Count) {
            $parentPid = $knownPids[$index]
            foreach ($child in @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$parentPid" -ErrorAction SilentlyContinue)) {
                if (-not ($knownPids -contains [int]$child.ProcessId)) {
                    $knownPids += [int]$child.ProcessId
                    $children += [pscustomobject]@{
                        Timestamp = (Get-Date).ToString('o')
                        PID = [int]$child.ProcessId
                        ParentPID = [int]$child.ParentProcessId
                        Name = $child.Name
                    }
                }
            }
            $index++
        }
        foreach ($pidValue in $knownPids) {
            foreach ($connection in @(Get-NetTCPConnection -OwningProcess $pidValue -ErrorAction SilentlyContinue)) {
                $connections += [pscustomobject]@{
                    Timestamp = (Get-Date).ToString('o')
                    PID = $pidValue
                    State = [string]$connection.State
                    LocalAddress = $connection.LocalAddress
                    LocalPort = $connection.LocalPort
                    RemoteAddress = $connection.RemoteAddress
                    RemotePort = $connection.RemotePort
                }
            }
        }
        Start-Sleep -Milliseconds $sampleIntervalMilliseconds
        $process.Refresh()
    } while (-not $process.HasExited)
    $process.WaitForExit()

    $result = [ordered]@{
        Schema = 'misen.decision-427.process-network-observation.v1'
        StartedAt = $startedAt.ToString('o')
        FinishedAt = (Get-Date).ToString('o')
        NodeVersion = (& node --version)
        Command = "node --input-type=module --eval <import Phase D; hold ${holdMilliseconds}ms>"
        HoldMilliseconds = $holdMilliseconds
        SampleIntervalMilliseconds = $sampleIntervalMilliseconds
        RootPID = $rootPid
        ExitCode = $process.ExitCode
        Samples = $samples
        ChildProcesses = @($children | Sort-Object PID -Unique)
        TcpConnections = @($connections | Sort-Object PID, RemoteAddress, RemotePort -Unique)
        Stdout = Get-Content -Raw -LiteralPath $stdoutPath
        Stderr = Get-Content -Raw -LiteralPath $stderrPath
    }
    $outputDirectory = Split-Path -Parent $outputFullPath
    New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
    $result | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $outputFullPath -Encoding utf8
    $result | ConvertTo-Json -Depth 8
    if ($process.ExitCode -ne 0) { exit $process.ExitCode }
} finally {
    Remove-Item -LiteralPath $evidenceRoot -Recurse -Force -ErrorAction SilentlyContinue
}

