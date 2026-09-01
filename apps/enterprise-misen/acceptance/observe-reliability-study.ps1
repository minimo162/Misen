[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$appRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$expectedHost = 'api.openai.com'
$expectedAddresses = @(
    @(Resolve-DnsName -Name $expectedHost -Type A -ErrorAction Stop).IPAddress
    @(Resolve-DnsName -Name $expectedHost -Type AAAA -ErrorAction SilentlyContinue).IPAddress
) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Sort-Object -Unique
if ($expectedAddresses.Count -eq 0) {
    throw "No address resolved for configured provider host $expectedHost"
}

$startedAt = Get-Date
$sampleIntervalMilliseconds = 250
$children = @()
$connections = @()
$violation = $null
$process = Start-Process `
    -FilePath (Get-Command node).Source `
    -ArgumentList @('dist/acceptance/reliability-study.js') `
    -WorkingDirectory $appRoot `
    -NoNewWindow `
    -PassThru

$rootPid = $process.Id
Write-Output "DECISION_432_MONITOR_ACTIVE rootPid=$rootPid"
$samples = 0

do {
    $samples++
    $knownPids = @($rootPid)
    $index = 0
    while ($index -lt $knownPids.Count) {
        $parentPid = $knownPids[$index]
        foreach ($child in @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$parentPid" -ErrorAction SilentlyContinue)) {
            $childPid = [int]$child.ProcessId
            if (-not ($knownPids -contains $childPid)) {
                $knownPids += $childPid
                $childRecord = [pscustomobject]@{
                    Timestamp = (Get-Date).ToString('o')
                    PID = $childPid
                    ParentPID = [int]$child.ParentProcessId
                    Name = [string]$child.Name
                }
                $children += $childRecord
                if ([string]$child.Name -ne 'conhost.exe' -and $null -eq $violation) {
                    $violation = "unexpected child process $($child.Name) PID $childPid"
                }
            }
        }
        $index++
    }

    foreach ($pidValue in $knownPids) {
        foreach ($connection in @(Get-NetTCPConnection -OwningProcess $pidValue -ErrorAction SilentlyContinue)) {
            if ([int]$connection.RemotePort -le 0 -or [string]$connection.State -in @('Listen', 'Bound')) { continue }
            $remoteAddress = [string]$connection.RemoteAddress
            $normalizedRemote = $remoteAddress -replace '^::ffff:', ''
            $connectionRecord = [pscustomobject]@{
                Timestamp = (Get-Date).ToString('o')
                PID = $pidValue
                State = [string]$connection.State
                RemoteAddress = $remoteAddress
                RemotePort = [int]$connection.RemotePort
            }
            $connections += $connectionRecord
            $loopback = $normalizedRemote -eq '127.0.0.1' -or $normalizedRemote -eq '::1'
            $expectedProvider = [int]$connection.RemotePort -eq 443 -and $expectedAddresses -contains $normalizedRemote
            if (-not $loopback -and -not $expectedProvider -and $null -eq $violation) {
                $violation = "unexpected TCP destination $remoteAddress`:$($connection.RemotePort) owned by PID $pidValue"
            }
        }
    }

    if ($null -ne $violation) {
        # Stop deepest discovered descendants first so a violating child cannot
        # survive root termination. The PID tree and violation were already
        # captured above; cleanup does not erase the evidence.
        $stopPids = @($knownPids | Select-Object -Unique)
        [array]::Reverse($stopPids)
        foreach ($stopPid in $stopPids) {
            Stop-Process -Id $stopPid -Force -ErrorAction SilentlyContinue
        }
        break
    }
    Start-Sleep -Milliseconds $sampleIntervalMilliseconds
    $process.Refresh()
} while (-not $process.HasExited)

$process.WaitForExit()
$observation = [ordered]@{
    Schema = 'misen.decision-432.medium-reliability-observation.v1'
    StartedAt = $startedAt.ToString('o')
    FinishedAt = (Get-Date).ToString('o')
    RootPID = $rootPid
    ExitCode = $process.ExitCode
    SampleIntervalMilliseconds = $sampleIntervalMilliseconds
    Samples = $samples
    ExpectedHost = $expectedHost
    ExpectedAddresses = @($expectedAddresses)
    ChildProcesses = @($children | Sort-Object PID -Unique)
    TcpConnections = @($connections | Sort-Object PID, RemoteAddress, RemotePort -Unique)
    SecurityIntegrityViolation = $violation
}
Write-Output ("DECISION_432_PROCESS_NETWORK " + ($observation | ConvertTo-Json -Depth 8 -Compress))

if ($null -ne $violation) { exit 3 }
if ($process.ExitCode -ne 0) { exit $process.ExitCode }
