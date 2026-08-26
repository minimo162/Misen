[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$FfmpegPath,

    [Parameter(Mandatory = $true)]
    [string]$OutputPath,

    [string]$RepoRoot,

    [string]$AgentUrl = 'http://127.0.0.1:3948'
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
    $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
}

$fixedInstruction = 'reports フォルダの各社の報告ファイルを全部読んで、rates のレート表で円換算して、集計台帳.xlsx に会社別に転記して。未提出の会社と、単位や科目名が怪しい会社は『確認事項』シートにまとめて、保存して'
$workspacePath = [System.IO.Path]::GetFullPath((Join-Path $RepoRoot 'demo\renketsu-demo\workspace'))
$ledgerPath = Join-Path $workspacePath '集計台帳.xlsx'
$extractedPath = Join-Path $workspacePath 'work\extracted.json'
$expectedExtractionPath = Join-Path $RepoRoot 'demo\renketsu-demo\validation\extracted.correct.json'
$compareExtractionPath = Join-Path $RepoRoot 'demo\renketsu-demo\validation\compare-extracted.mjs'
$expectedLedgerPath = Join-Path $RepoRoot 'demo\renketsu-demo\validation\expected.json'
$resolvedFfmpeg = (Resolve-Path -LiteralPath $FfmpegPath).Path
$fullOutputPath = [System.IO.Path]::GetFullPath($OutputPath)
$outputDirectory = Split-Path -Parent $fullOutputPath

if (Test-Path -LiteralPath $fullOutputPath) {
    throw "Recording output already exists: $fullOutputPath"
}
if (-not (Test-Path -LiteralPath $ledgerPath)) {
    throw "Ledger not found: $ledgerPath"
}
if (Test-Path -LiteralPath $extractedPath) {
    throw "Stale extraction exists before this take: $extractedPath"
}
if (-not (Test-Path -LiteralPath $expectedExtractionPath) -or -not (Test-Path -LiteralPath $compareExtractionPath) -or -not (Test-Path -LiteralPath $expectedLedgerPath)) {
    throw 'Extraction truth validator is missing.'
}
$ledgerHashBefore = (Get-FileHash -LiteralPath $ledgerPath -Algorithm SHA256).Hash
if (-not (Test-Path -LiteralPath $outputDirectory)) {
    $null = New-Item -ItemType Directory -Path $outputDirectory
}

$info = Invoke-RestMethod -Uri ($AgentUrl + '/api/info') -Method Get
if ([System.IO.Path]::GetFullPath([string]$info.workspace) -ne $workspacePath) {
    throw "coding-agent workspace mismatch: $($info.workspace)"
}
if ([string]$info.provider -ne 'copilot-edge') {
    throw "coding-agent provider mismatch: $($info.provider)"
}

$sessionResponse = Invoke-RestMethod -Uri ($AgentUrl + '/api/sessions') -Method Post -ContentType 'application/json; charset=utf-8' -Body '{}'
$sessionId = [string]$sessionResponse.id
if ([string]::IsNullOrWhiteSpace($sessionId)) {
    throw 'coding-agent did not create a fresh session for this take.'
}

if (-not ('VideoCapture.NativeWindow' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace VideoCapture {
    public static class NativeWindow {
        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool MoveWindow(IntPtr hWnd, int x, int y, int width, int height, bool repaint);
        [DllImport("user32.dll")]
        public static extern bool ShowWindowAsync(IntPtr hWnd, int command);
        [DllImport("user32.dll")]
        public static extern bool SetForegroundWindow(IntPtr hWnd);
    }
}
'@
}

Add-Type -AssemblyName System.Windows.Forms
$virtualScreen = [System.Windows.Forms.SystemInformation]::VirtualScreen
$captureX = [int]$virtualScreen.X
$captureY = [int]$virtualScreen.Y
$captureWidth = [int]($virtualScreen.Width - ($virtualScreen.Width % 2))
$captureHeight = [int]($virtualScreen.Height - ($virtualScreen.Height % 2))
if ($captureWidth -lt 320 -or $captureHeight -lt 240) {
    throw "Capture area is too small: ${captureWidth}x${captureHeight}"
}
$leftWidth = [int][Math]::Floor($captureWidth / 2)
$rightWidth = $captureWidth - $leftWidth

function Move-WindowForDemo {
    param(
        [Parameter(Mandatory = $true)][IntPtr]$Handle,
        [Parameter(Mandatory = $true)][int]$X,
        [Parameter(Mandatory = $true)][int]$Y,
        [Parameter(Mandatory = $true)][int]$Width,
        [Parameter(Mandatory = $true)][int]$Height
    )
    $null = [VideoCapture.NativeWindow]::ShowWindowAsync($Handle, 9)
    Start-Sleep -Milliseconds 300
    if (-not [VideoCapture.NativeWindow]::MoveWindow($Handle, $X, $Y, $Width, $Height, $true)) {
        throw "MoveWindow failed for handle $Handle"
    }
    $null = [VideoCapture.NativeWindow]::SetForegroundWindow($Handle)
    Start-Sleep -Milliseconds 500
}

$edgeWindow = Get-Process -Name msedge -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne 0 } |
    Sort-Object StartTime -Descending |
    Select-Object -First 1
if ($null -eq $edgeWindow) {
    throw 'Visible coding-agent Edge window was not found.'
}
Move-WindowForDemo -Handle $edgeWindow.MainWindowHandle -X $captureX -Y $captureY -Width $captureWidth -Height $captureHeight

$ffmpegArgs = @(
    '-hide_banner',
    '-loglevel', 'warning',
    '-f', 'gdigrab',
    '-framerate', '30',
    '-offset_x', [string]$captureX,
    '-offset_y', [string]$captureY,
    '-video_size', ("{0}x{1}" -f $captureWidth, $captureHeight),
    '-i', 'desktop',
    '-an',
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-crf', '18',
    '-pix_fmt', 'yuv420p',
    $fullOutputPath
)
$escapedArgs = $ffmpegArgs | ForEach-Object {
    if ($_ -match '[\s"]') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ }
}
$startInfo = New-Object System.Diagnostics.ProcessStartInfo
$startInfo.FileName = $resolvedFfmpeg
$startInfo.Arguments = ($escapedArgs -join ' ')
$startInfo.UseShellExecute = $false
$startInfo.RedirectStandardInput = $true
$startInfo.CreateNoWindow = $true
$ffmpegProcess = New-Object System.Diagnostics.Process
$ffmpegProcess.StartInfo = $startInfo
$ffmpegStarted = $false
$excel = $null
$workbook = $null
$ledgerSheet = $null
$issuesSheet = $null
$runResponse = $null
$initialRunId = $null
$inputRetryUsed = $false
$instructionSentAt = $null
$savedAt = $null
$recordingError = $null
$writeEventVerified = $false
$ledgerEventVerified = $false
$extractedFresh = $false
$ledgerFresh = $false
$truthVerified = $false
$ledgerTotalsVerified = $false
$ffmpegVerified = $false

try {
    if (-not $ffmpegProcess.Start()) {
        throw 'ffmpeg did not start.'
    }
    $ffmpegStarted = $true
    Start-Sleep -Seconds 2
    if ($ffmpegProcess.HasExited) {
        throw "ffmpeg exited early with code $($ffmpegProcess.ExitCode)"
    }

    $instructionSentAt = Get-Date
    $body = @{ message = $fixedInstruction; mode = 'work' } | ConvertTo-Json -Compress
    $runResponse = Invoke-RestMethod -Uri ($AgentUrl + '/api/turn') -Method Post -ContentType 'application/json; charset=utf-8' -Body $body
    $initialRunId = if ($null -ne $runResponse.run) { [string]$runResponse.run.id } else { $null }

    if ($runResponse.aborted -eq $true) {
        $retryEvidence = $runResponse | ConvertTo-Json -Depth 20 -Compress
        $isInputRenderFailure = $retryEvidence -match '依頼文の入力|入力(?:内容)?が位置|入力を確認できません|入力欄|有効な送信ボタンが見つかりません'
        if ($isInputRenderFailure -and -not [string]::IsNullOrWhiteSpace($initialRunId)) {
            $inputRetryUsed = $true
            Start-Sleep -Seconds 3
            $retrySessionResponse = Invoke-RestMethod -Uri ($AgentUrl + '/api/sessions') -Method Post -ContentType 'application/json; charset=utf-8' -Body '{}'
            $sessionId = [string]$retrySessionResponse.id
            if ([string]::IsNullOrWhiteSpace($sessionId)) {
                throw 'coding-agent did not create a fresh session for the input retry.'
            }
            $retryBody = @{ message = $fixedInstruction; mode = 'work' } | ConvertTo-Json -Compress
            $runResponse = Invoke-RestMethod -Uri ($AgentUrl + '/api/turn') -Method Post -ContentType 'application/json; charset=utf-8' -Body $retryBody
        }
    }
    $savedAt = Get-Date

    if ($runResponse.aborted -eq $true) {
        throw "Agent run was aborted: $($runResponse.reply)"
    }
    if (-not (Test-Path -LiteralPath $extractedPath)) {
        throw 'Agent run finished without work\extracted.json.'
    }

    $runEvents = @()
    if ($null -ne $runResponse.run -and $null -ne $runResponse.run.events) {
        $runEvents = @($runResponse.run.events)
    }
    $writeRequest = $runEvents |
        Where-Object { $_.type -eq 'tool.requested' -and $_.tool -eq 'host.write_file' -and ([string]$_.summary) -match 'work[\\/]extracted\.json' } |
        Select-Object -Last 1
    if ($null -eq $writeRequest) {
        throw 'Current run did not request write_file for work\extracted.json.'
    }
    $writeSuccess = $runEvents |
        Where-Object { $_.type -eq 'tool.succeeded' -and $_.tool -eq 'host.write_file' -and $_.callId -eq $writeRequest.callId } |
        Select-Object -Last 1
    if ($null -eq $writeSuccess) {
        throw 'Current run did not successfully write work\extracted.json.'
    }
    $writeEventVerified = $true

    $updateRequest = $runEvents |
        Where-Object { $_.type -eq 'tool.requested' -and $_.tool -eq 'host.run_command' -and ([string]$_.summary) -match 'Update-Ledger\.ps1' } |
        Select-Object -Last 1
    if ($null -eq $updateRequest) {
        throw 'Current run did not request Update-Ledger.ps1.'
    }
    $updateSuccess = $runEvents |
        Where-Object { $_.type -eq 'tool.succeeded' -and $_.tool -eq 'host.run_command' -and $_.callId -eq $updateRequest.callId } |
        Select-Object -Last 1
    if ($null -eq $updateSuccess) {
        throw 'Current run did not successfully execute Update-Ledger.ps1.'
    }
    $updateOutput = [string]$updateSuccess.output
    if ([string]::IsNullOrWhiteSpace($updateOutput)) {
        $updateOutput = [string]$updateSuccess.message
    }
    try {
        $updateResult = $updateOutput | ConvertFrom-Json
    }
    catch {
        throw 'Update-Ledger.ps1 did not return its required one-line JSON result.'
    }
    if ($updateResult.ok -ne $true) {
        throw 'Update-Ledger.ps1 did not report ok:true.'
    }
    $expectedLedger = Get-Content -Raw -LiteralPath $expectedLedgerPath | ConvertFrom-Json
    foreach ($metric in @('revenue', 'operatingProfit', 'netIncome', 'totalAssets', 'employees')) {
        if ([decimal]$updateResult.totals.$metric -ne [decimal]$expectedLedger.grandTotals.$metric) {
            throw "Update-Ledger total mismatch: $metric"
        }
    }
    if ([int]$updateResult.processedCompanies -ne 19 -or [int]$updateResult.missingCompanies -ne 1 -or [int]$updateResult.confirmationCount -ne 5) {
        throw 'Update-Ledger company or confirmation counts did not match the truth fixture.'
    }
    $ledgerTotalsVerified = $true
    $ledgerEventVerified = $true

    $extractedItem = Get-Item -LiteralPath $extractedPath
    $extractedFresh = $extractedItem.LastWriteTimeUtc -ge $instructionSentAt.ToUniversalTime()
    if (-not $extractedFresh) {
        throw 'work\extracted.json was not freshly written during the current take.'
    }
    $ledgerHashAfter = (Get-FileHash -LiteralPath $ledgerPath -Algorithm SHA256).Hash
    $ledgerFresh = $ledgerHashAfter -ne $ledgerHashBefore
    if (-not $ledgerFresh) {
        throw '集計台帳.xlsx was not changed by the current take.'
    }

    $truthOutput = & node $compareExtractionPath $extractedPath $expectedExtractionPath 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw ('Extracted values did not match the truth fixture: ' + ($truthOutput -join ' '))
    }
    $truthVerified = $true

    $excel = New-Object -ComObject Excel.Application
    $excel.Visible = $true
    $excel.DisplayAlerts = $false
    $workbook = $excel.Workbooks.Open($ledgerPath)
    Move-WindowForDemo -Handle $edgeWindow.MainWindowHandle -X $captureX -Y $captureY -Width $leftWidth -Height $captureHeight
    Move-WindowForDemo -Handle ([IntPtr]$excel.Hwnd) -X ($captureX + $leftWidth) -Y $captureY -Width $rightWidth -Height $captureHeight

    $ledgerSheet = $workbook.Worksheets.Item('連結台帳')
    $ledgerSheet.Activate()
    $ledgerSheet.Range('A1').Select()
    $excel.ActiveWindow.Zoom = 75
    Start-Sleep -Seconds 7

    $issuesSheet = $workbook.Worksheets.Item('確認事項')
    $issuesSheet.Activate()
    $issuesSheet.Range('A1').Select()
    $excel.ActiveWindow.Zoom = 80
    Start-Sleep -Seconds 7
}
catch {
    $recordingError = $_.Exception.Message
}
finally {
    if ($ffmpegStarted -and -not $ffmpegProcess.HasExited) {
        $ffmpegProcess.StandardInput.WriteLine('q')
        if (-not $ffmpegProcess.WaitForExit(15000)) {
            $ffmpegProcess.Kill()
            $ffmpegProcess.WaitForExit()
        }
    }
    if ($null -ne $workbook) {
        $workbook.Close($false)
    }
    if ($null -ne $excel) {
        $excel.Quit()
    }
    if ($null -ne $ledgerSheet) { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($ledgerSheet) }
    if ($null -ne $issuesSheet) { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($issuesSheet) }
    if ($null -ne $workbook) { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($workbook) }
    if ($null -ne $excel) { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($excel) }
    [GC]::Collect()
    [GC]::WaitForPendingFinalizers()
}

if ($null -eq $recordingError) {
    if (-not $ffmpegStarted -or -not $ffmpegProcess.HasExited -or $ffmpegProcess.ExitCode -ne 0) {
        $recordingError = 'ffmpeg did not finish successfully.'
    }
    elseif (-not (Test-Path -LiteralPath $fullOutputPath) -or (Get-Item -LiteralPath $fullOutputPath).Length -le 0) {
        $recordingError = 'Recording file was not created or is empty.'
    }
    else {
        $ffmpegVerified = $true
    }
}

$elapsedSeconds = if ($null -ne $instructionSentAt -and $null -ne $savedAt) {
    [Math]::Round(($savedAt - $instructionSentAt).TotalSeconds, 3)
} else {
    $null
}
$metadata = [ordered]@{
    ok = ($null -eq $recordingError)
    recording = $fullOutputPath
    instruction = $fixedInstruction
    instructionSentAt = if ($null -ne $instructionSentAt) { $instructionSentAt.ToString('o') } else { $null }
    savedAt = if ($null -ne $savedAt) { $savedAt.ToString('o') } else { $null }
    elapsedSeconds = $elapsedSeconds
    elapsedMinutes = if ($null -ne $elapsedSeconds) { [Math]::Round($elapsedSeconds / 60, 2) } else { $null }
    sessionId = $sessionId
    runId = if ($null -ne $runResponse -and $null -ne $runResponse.run) { [string]$runResponse.run.id } else { $null }
    initialRunId = $initialRunId
    inputRetryUsed = $inputRetryUsed
    writeEventVerified = $writeEventVerified
    ledgerEventVerified = $ledgerEventVerified
    extractedFresh = $extractedFresh
    ledgerFresh = $ledgerFresh
    truthVerified = $truthVerified
    ledgerTotalsVerified = $ledgerTotalsVerified
    ffmpegVerified = $ffmpegVerified
    runStatus = if ($null -ne $runResponse -and $null -ne $runResponse.run) { [string]$runResponse.run.status } else { $null }
    reply = if ($null -ne $runResponse) { [string]$runResponse.reply } else { $null }
    error = $recordingError
}
$metadataPath = [System.IO.Path]::ChangeExtension($fullOutputPath, '.json')
[System.IO.File]::WriteAllText($metadataPath, ($metadata | ConvertTo-Json -Depth 10), (New-Object System.Text.UTF8Encoding($false)))
Write-Output ($metadata | ConvertTo-Json -Compress -Depth 10)

if ($null -ne $recordingError) {
    throw $recordingError
}
