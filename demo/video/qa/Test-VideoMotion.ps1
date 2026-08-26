[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$RawPath,

    [string]$RawMetadataPath,

    [string]$FinalPath,

    [Parameter(Mandatory = $true)]
    [string]$FfmpegPath,

    [double]$RawStartSec = 0,

    [double]$RawDurationSec = 0,

    [double]$FinalStartSec = 17,

    [double]$FinalDurationSec = 24,

    [double]$SampleIntervalSec = 2,

    [double]$DifferenceThreshold = 0.15,

    [double]$MinimumMovingRatio = 0.10,

    [int]$MinimumMovingPairs = 3,

    [double]$MaximumStaticSec = 30
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$invariant = [System.Globalization.CultureInfo]::InvariantCulture

function ConvertTo-InvariantString {
    param([Parameter(Mandatory = $true)][double]$Value)
    return $Value.ToString('0.###', $invariant)
}

function Quote-NativeArgument {
    param([Parameter(Mandatory = $true)][string]$Value)
    if ($Value.Contains('"')) {
        throw 'A native argument contains a quote character.'
    }
    if ($Value -match '\s') {
        return '"' + $Value + '"'
    }
    return $Value
}

function Invoke-MotionSample {
    param(
        [Parameter(Mandatory = $true)][string]$InputPath,
        [Parameter(Mandatory = $true)][double]$StartSec,
        [Parameter(Mandatory = $true)][double]$DurationSec,
        [string]$CropFilter,
        [Parameter(Mandatory = $true)][string]$Label
    )

    if ($DurationSec -le ($SampleIntervalSec * 2)) {
        throw "$Label duration is too short for motion analysis."
    }
    $fps = 1.0 / $SampleIntervalSec
    $filters = New-Object System.Collections.Generic.List[string]
    if (-not [string]::IsNullOrWhiteSpace($CropFilter)) {
        $filters.Add($CropFilter)
    }
    $filters.Add(('fps={0}' -f (ConvertTo-InvariantString $fps)))
    $filters.Add('scale=190:354:flags=area')
    $filters.Add('format=gray')
    $filters.Add('tblend=all_mode=difference')
    $filters.Add('signalstats')
    $filters.Add('metadata=print')

    $arguments = @(
        '-hide_banner',
        '-loglevel', 'info',
        '-ss', (ConvertTo-InvariantString $StartSec),
        '-t', (ConvertTo-InvariantString $DurationSec),
        '-i', $InputPath,
        '-vf', (($filters.ToArray()) -join ','),
        '-an',
        '-f', 'null',
        'NUL'
    )
    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = $FfmpegPath
    $startInfo.Arguments = (($arguments | ForEach-Object { Quote-NativeArgument ([string]$_) }) -join ' ')
    $startInfo.UseShellExecute = $false
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.CreateNoWindow = $true
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $startInfo
    if (-not $process.Start()) {
        throw 'ffmpeg did not start for motion analysis.'
    }
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    $process.WaitForExit()
    $stdout = $stdoutTask.Result
    $stderr = $stderrTask.Result
    if ($process.ExitCode -ne 0) {
        throw ("ffmpeg motion analysis failed for {0}: exit={1}" -f $Label, $process.ExitCode)
    }

    $values = New-Object System.Collections.Generic.List[double]
    foreach ($line in (($stdout + "`n" + $stderr) -split "`r?`n")) {
        if ($line -match 'lavfi\.signalstats\.YAVG=([0-9.]+)') {
            $values.Add([double]::Parse($Matches[1], $invariant))
        }
    }
    $samples = $values.ToArray()
    if ($samples.Count -lt 3) {
        throw "$Label produced too few adjacent-frame samples."
    }

    $movingPairs = 0
    $currentStaticPairs = 0
    $maximumStaticPairs = 0
    foreach ($value in $samples) {
        if ($value -ge $DifferenceThreshold) {
            $movingPairs++
            $currentStaticPairs = 0
        }
        else {
            $currentStaticPairs++
            if ($currentStaticPairs -gt $maximumStaticPairs) {
                $maximumStaticPairs = $currentStaticPairs
            }
        }
    }
    $movingRatio = [double]$movingPairs / [double]$samples.Count
    $maximumStaticDuration = $maximumStaticPairs * $SampleIntervalSec
    $ok = $movingPairs -ge $MinimumMovingPairs -and
        $movingRatio -ge $MinimumMovingRatio -and
        $maximumStaticDuration -le $MaximumStaticSec

    return [ordered]@{
        label = $Label
        ok = $ok
        samplePairs = $samples.Count
        movingPairs = $movingPairs
        movingRatio = [Math]::Round($movingRatio, 4)
        threshold = $DifferenceThreshold
        sampleIntervalSec = $SampleIntervalSec
        maximumStaticSec = [Math]::Round($maximumStaticDuration, 3)
    }
}

$resolvedRaw = (Resolve-Path -LiteralPath $RawPath).Path
$resolvedFfmpeg = (Resolve-Path -LiteralPath $FfmpegPath).Path
$FfmpegPath = $resolvedFfmpeg
if ([string]::IsNullOrWhiteSpace($RawMetadataPath)) {
    $RawMetadataPath = [System.IO.Path]::ChangeExtension($resolvedRaw, '.json')
}
if ($RawDurationSec -le 0) {
    $metadata = Get-Content -LiteralPath $RawMetadataPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $RawDurationSec = [double]$metadata.elapsedSeconds
}
if ($RawDurationSec -le 0) {
    throw 'Raw live duration is missing from metadata.'
}

$rawResult = Invoke-MotionSample -InputPath $resolvedRaw -StartSec $RawStartSec -DurationSec $RawDurationSec -Label 'raw'
$finalResult = $null
if (-not [string]::IsNullOrWhiteSpace($FinalPath)) {
    $resolvedFinal = (Resolve-Path -LiteralPath $FinalPath).Path
    $finalResult = Invoke-MotionSample -InputPath $resolvedFinal -StartSec $FinalStartSec -DurationSec $FinalDurationSec -CropFilter 'crop=430:900:260:85' -Label 'final-live-roi'
}
$ok = $rawResult.ok -eq $true -and ($null -eq $finalResult -or $finalResult.ok -eq $true)
$result = [ordered]@{
    ok = $ok
    raw = $rawResult
    final = $finalResult
}
Write-Output ($result | ConvertTo-Json -Depth 8 -Compress)
if (-not $ok) {
    exit 1
}
