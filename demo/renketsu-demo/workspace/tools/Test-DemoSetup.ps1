[CmdletBinding()]
param(
    [string]$WorkspacePath,
    [string]$RepoPath,
    [string]$ImportExcelPath
)

$ErrorActionPreference = 'Stop'
$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $scriptRoot 'lib\Common.ps1')

$allOk = $true
$tempRoot = $null

function ConvertTo-DemoAscii {
    param([object]$Value)

    if ($null -eq $Value) {
        return ''
    }
    return ([regex]::Replace([string]$Value, '[^\x00-\x7F]', '?'))
}

function Write-DemoOk {
    param([string]$Message)

    Write-Host ('OK ' + (ConvertTo-DemoAscii $Message))
}

function Write-DemoNg {
    param([string]$Message)

    $script:allOk = $false
    Write-Host ('NG ' + (ConvertTo-DemoAscii $Message))
}

function Find-DemoFirstPath {
    param(
        [Parameter(Mandatory = $true)][string]$BasePath,
        [Parameter(Mandatory = $true)][string[]]$RelativePaths
    )

    foreach ($relative in $RelativePaths) {
        $candidate = Join-Path $BasePath $relative
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            return (Resolve-Path -LiteralPath $candidate).ProviderPath
        }
    }
    return $null
}

function Get-DemoChildJson {
    param(
        [Parameter(Mandatory = $true)][string]$ScriptPath,
        [Parameter(Mandatory = $true)][string[]]$Arguments
    )

    # Invoke the tools in this already-authorized PowerShell process. This
    # avoids a second interpreter/policy boundary and keeps the diagnosis
    # aligned with the normal offline run contract.
    $previousThrowMode = $env:RENKETSU_TEST_THROW_ON_ERROR
    try {
        $env:RENKETSU_TEST_THROW_ON_ERROR = '1'
        if ($Arguments.Count -eq 1) {
            $raw = & $ScriptPath $Arguments[0] 2>&1
        }
        elseif ($Arguments.Count -eq 2) {
            $raw = & $ScriptPath $Arguments[0] $Arguments[1] 2>&1
        }
        elseif ($Arguments.Count -eq 3) {
            $raw = & $ScriptPath $Arguments[0] $Arguments[1] $Arguments[2] 2>&1
        }
        else {
            throw 'Unexpected child argument count.'
        }
    }
    finally {
        if ($null -eq $previousThrowMode) {
            Remove-Item Env:RENKETSU_TEST_THROW_ON_ERROR -ErrorAction SilentlyContinue
        }
        else {
            $env:RENKETSU_TEST_THROW_ON_ERROR = $previousThrowMode
        }
    }
    $jsonLine = $null
    foreach ($line in $raw) {
        $lineText = [string]$line
        if ($lineText.Trim().StartsWith('{')) {
            $jsonLine = $lineText.Trim()
        }
    }
    if ($null -eq $jsonLine) {
        throw 'Tool did not emit JSON.'
    }
    try {
        $object = $jsonLine | ConvertFrom-Json -ErrorAction Stop
    }
    catch {
        throw 'Tool emitted invalid JSON.'
    }
    if ($object.ok -ne $true) {
        $errorText = Get-RenketsuPropertyValue -InputObject $object -Name 'error'
        if ($null -eq $errorText) {
            $errorText = 'unknown tool error'
        }
        throw ("Tool failed: " + [string]$errorText)
    }
    return $object
}

function Copy-DemoJsonObject {
    param([Parameter(Mandatory = $true)][object]$InputObject)

    return (($InputObject | ConvertTo-Json -Compress -Depth 40) | ConvertFrom-Json -ErrorAction Stop)
}

function Assert-DemoUpdateRejected {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][object]$InputObject,
        [Parameter(Mandatory = $true)][string]$RatesPath,
        [Parameter(Mandatory = $true)][string]$LedgerTemplate,
        [Parameter(Mandatory = $true)][string]$TempPath,
        [Parameter(Mandatory = $true)][string]$UpdateScript
    )

    $caseLedger = Join-Path $TempPath ('reject-' + $Name + '.xlsx')
    Copy-Item -LiteralPath $LedgerTemplate -Destination $caseLedger -Force
    $inputJson = $InputObject | ConvertTo-Json -Compress -Depth 40
    try {
        $null = Get-DemoChildJson -ScriptPath $UpdateScript -Arguments @($inputJson, $RatesPath, $caseLedger)
        Write-DemoNg ('negative validation accepted: ' + $Name)
    }
    catch {
        Write-DemoOk ('negative validation rejected: ' + $Name)
    }
}

function Compare-DemoExpected {
    param(
        [Parameter(Mandatory = $true)][object]$Actual,
        [Parameter(Mandatory = $true)][object]$Expected,
        [Parameter(Mandatory = $true)][object]$WorkbookResult
    )

    function ConvertTo-DemoDecimalValue {
        param([object]$Value)

        if ($null -eq $Value -or [string]::IsNullOrWhiteSpace([string]$Value)) {
            return $null
        }
        $number = [decimal]0
        $text = ([string]$Value).Replace(',', '').Trim()
        if ([decimal]::TryParse($text, [Globalization.NumberStyles]::Float, [Globalization.CultureInfo]::InvariantCulture, [ref]$number)) {
            return $number
        }
        return $null
    }

    $keys = @('processedCompanies', 'missingCompanies', 'convertedCompanies', 'unitNormalizedCompanies', 'unitVariations', 'accountVariations', 'confirmationCount', 'totals')
    foreach ($key in $keys) {
        $expectedValue = Get-RenketsuPropertyValue -InputObject $Expected -Name $key
        if ($null -eq $expectedValue) {
            continue
        }
        $actualValue = Get-RenketsuPropertyValue -InputObject $Actual -Name $key
        if ($null -eq $actualValue) {
            return "expected field missing: $key"
        }
        $expectedJson = $expectedValue | ConvertTo-Json -Compress -Depth 20
        $actualJson = $actualValue | ConvertTo-Json -Compress -Depth 20
        if ($expectedJson -ne $actualJson) {
            return "expected mismatch: $key"
        }
    }

    $grandTotals = Get-RenketsuPropertyValue -InputObject $Expected -Name 'grandTotals'
    if ($null -ne $grandTotals) {
        $actualTotals = Get-RenketsuPropertyValue -InputObject $Actual -Name 'totals'
        foreach ($metric in @('revenue', 'operatingProfit', 'netIncome', 'totalAssets', 'employees')) {
            $expectedNumber = ConvertTo-DemoDecimalValue (Get-RenketsuPropertyValue -InputObject $grandTotals -Name $metric)
            $actualNumber = ConvertTo-DemoDecimalValue (Get-RenketsuPropertyValue -InputObject $actualTotals -Name $metric)
            if ($null -eq $expectedNumber -or $null -eq $actualNumber -or $expectedNumber -ne $actualNumber) {
                return "expected grand total mismatch: $metric"
            }
        }
    }

    $expectedCompanies = Get-RenketsuPropertyValue -InputObject $Expected -Name 'companies'
    if ($null -ne $expectedCompanies) {
        $ledgerSheet = $null
        foreach ($sheet in $WorkbookResult.sheets) {
            if ([string]$sheet.name -ceq '連結台帳' -or [string]$sheet.name -ceq 'Ledger') {
                $ledgerSheet = $sheet
                break
            }
        }
        if ($null -eq $ledgerSheet) {
            return 'expected ledger sheet was not found'
        }
        $headerIndex = -1
        $headerColumns = @{}
        $sheetRows = @($ledgerSheet.rows)
        for ($rowIndex = 0; $rowIndex -lt $sheetRows.Count; $rowIndex++) {
            $row = @($sheetRows[$rowIndex])
            for ($columnIndex = 0; $columnIndex -lt $row.Count; $columnIndex++) {
                if ([string]$row[$columnIndex] -ceq '会社ID') {
                    $headerIndex = $rowIndex
                }
                foreach ($metric in @('revenue', 'operatingProfit', 'netIncome', 'totalAssets', 'employees')) {
                    $label = @{
                        revenue = '売上高（百万円）'
                        operatingProfit = '営業利益（百万円）'
                        netIncome = '当期純利益（百万円）'
                        totalAssets = '総資産（百万円）'
                        employees = '従業員数（人）'
                    }[$metric]
                    if ([string]$row[$columnIndex] -ceq $label) {
                        $headerColumns[$metric] = $columnIndex
                    }
                }
            }
            if ($headerIndex -ge 0 -and $headerColumns.Count -eq 5) {
                break
            }
        }
        if ($headerIndex -lt 0 -or $headerColumns.Count -ne 5) {
            return 'expected ledger headers were not found'
        }
        $ledgerRowsById = @{}
        for ($rowIndex = $headerIndex + 1; $rowIndex -lt $sheetRows.Count; $rowIndex++) {
            $row = @($sheetRows[$rowIndex])
            if ($row.Count -gt 0 -and -not [string]::IsNullOrWhiteSpace([string]$row[0])) {
                $ledgerRowsById[[string]$row[0]] = $row
            }
        }
        foreach ($expectedCompany in @($expectedCompanies)) {
            $companyId = [string](Get-RenketsuPropertyValue -InputObject $expectedCompany -Name 'id')
            if (-not $ledgerRowsById.ContainsKey($companyId)) {
                return "expected company missing from ledger: $companyId"
            }
            $expectedValues = Get-RenketsuPropertyValue -InputObject $expectedCompany -Name 'expectedLedgerValues'
            $actualRow = $ledgerRowsById[$companyId]
            foreach ($metric in @('revenue', 'operatingProfit', 'netIncome', 'totalAssets', 'employees')) {
                $expectedNumber = ConvertTo-DemoDecimalValue (Get-RenketsuPropertyValue -InputObject $expectedValues -Name $metric)
                $actualNumber = ConvertTo-DemoDecimalValue $actualRow[$headerColumns[$metric]]
                if ($null -eq $expectedNumber -or $null -eq $actualNumber -or $expectedNumber -ne $actualNumber) {
                    return "expected ledger value mismatch: $companyId/$metric"
                }
            }
        }
    }
    return $null
}

try {
    if ([string]::IsNullOrWhiteSpace($WorkspacePath)) {
        $WorkspacePath = Split-Path -Parent $scriptRoot
    }
    $WorkspacePath = [System.IO.Path]::GetFullPath($WorkspacePath)
    if ([string]::IsNullOrWhiteSpace($RepoPath)) {
        $RepoPath = [System.IO.Path]::GetFullPath((Join-Path $WorkspacePath '..\..\..'))
    }
    else {
        $RepoPath = [System.IO.Path]::GetFullPath($RepoPath)
    }

    $defaultImportExcelPath = Join-Path $WorkspacePath 'vendor\ImportExcel\7.8.10'
    try {
        $manifest = Resolve-RenketsuImportExcelManifest -ImportExcelPath $ImportExcelPath -DefaultPath $defaultImportExcelPath
        $null = Import-RenketsuExcelModule -ImportExcelPath $ImportExcelPath -DefaultPath $defaultImportExcelPath
        $moduleVersion = [string]((Get-Item -LiteralPath $manifest).Directory.Name)
        $dllPath = Join-Path (Split-Path -Parent $manifest) 'EPPlus.dll'
        if (-not (Test-Path -LiteralPath $dllPath -PathType Leaf)) {
            throw 'EPPlus.dll was not found beside ImportExcel.psd1.'
        }
        $assemblyName = [System.Reflection.AssemblyName]::GetAssemblyName($dllPath)
        $assemblyVersion = [string]$assemblyName.Version
        if ($assemblyVersion -notmatch '^4\.5\.3\.') {
            throw "EPPlus version is not 4.5.3.x: $assemblyVersion"
        }
        Write-DemoOk "ImportExcel $moduleVersion EPPlus $assemblyVersion"
    }
    catch {
        Write-DemoNg ('ImportExcel check failed: ' + $_.Exception.Message)
    }

    $validationPath = Join-Path (Split-Path -Parent $WorkspacePath) 'validation'
    $extractedPath = Find-DemoFirstPath -BasePath $validationPath -RelativePaths @('extracted.correct.json', 'extracted.json', 'input.json')
    $ratesPath = Find-DemoFirstPath -BasePath $WorkspacePath -RelativePaths @('rates\レート表.csv', 'rates.csv', 'data\rates.csv', 'validation\rates.csv')
    $ledgerPath = Find-DemoFirstPath -BasePath $WorkspacePath -RelativePaths @('集計台帳.xlsx', 'Ledger.xlsx', 'ledger.xlsx', 'data\Ledger.xlsx', 'data\ledger.xlsx')
    $expectedPath = Find-DemoFirstPath -BasePath $validationPath -RelativePaths @('expected.json', 'expected-output.json')

    $dataObject = $null
    if ($null -ne $extractedPath) {
        try {
            $dataObject = [IO.File]::ReadAllText($extractedPath, [Text.Encoding]::UTF8) | ConvertFrom-Json -ErrorAction Stop
            $companiesValue = Get-RenketsuPropertyValue -InputObject $dataObject -Name 'companies'
            $missingValue = Get-RenketsuPropertyValue -InputObject $dataObject -Name 'missing'
            if ($null -eq $companiesValue) { $companies = @() } else { $companies = @($companiesValue) }
            if ($null -eq $missingValue) { $missing = @() } else { $missing = @($missingValue) }
            $quoteCount = 0
            $issueCount = 0
            foreach ($company in $companies) {
                $quotesValue = Get-RenketsuPropertyValue -InputObject $company -Name 'quotes'
                $issuesValue = Get-RenketsuPropertyValue -InputObject $company -Name 'issues'
                if ($null -ne $quotesValue) {
                    $quoteCount += @($quotesValue).Count
                }
                if ($null -ne $issuesValue) {
                    $issueCount += @($issuesValue).Count
                }
            }
            Write-DemoOk "demo data counts companies=$($companies.Count) missing=$($missing.Count) quotes=$quoteCount issues=$issueCount"
        }
        catch {
            Write-DemoNg ('demo data parse failed: ' + $_.Exception.Message)
        }
    }
    else {
        Write-DemoNg 'demo data fixture not found'
    }

    $tempRoot = Join-Path ([IO.Path]::GetTempPath()) ('renketsu-demo-test-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null
    try {
        if ($null -eq $extractedPath -or $null -eq $ratesPath -or $null -eq $ledgerPath) {
            Write-DemoNg 'roundtrip fixture missing'
        }
        else {
            $tempLedger = Join-Path $tempRoot 'Ledger.xlsx'
            Copy-Item -LiteralPath $ledgerPath -Destination $tempLedger -Force
            $readScript = Join-Path $scriptRoot 'Read-Xlsx.ps1'
            $updateScript = Join-Path $scriptRoot 'Update-Ledger.ps1'
            try {
                $readBefore = Get-DemoChildJson -ScriptPath $readScript -Arguments @($tempLedger)
                $updateResult = Get-DemoChildJson -ScriptPath $updateScript -Arguments @($extractedPath, $ratesPath, $tempLedger)
                $readAfter = Get-DemoChildJson -ScriptPath $readScript -Arguments @($tempLedger)
                $sheetNames = New-Object System.Collections.Generic.List[string]
                foreach ($sheet in $readAfter.sheets) {
                    $null = $sheetNames.Add([string]$sheet.name)
                }
                if (-not $sheetNames.Contains('連結台帳') -or -not $sheetNames.Contains('確認事項')) {
                    throw 'roundtrip output lacks 連結台帳 or confirmation sheet'
                }
                if ($null -ne $expectedPath) {
                    $expected = [IO.File]::ReadAllText($expectedPath, [Text.Encoding]::UTF8) | ConvertFrom-Json -ErrorAction Stop
                    $mismatch = Compare-DemoExpected -Actual $updateResult -Expected $expected -WorkbookResult $readAfter
                    if ($null -ne $mismatch) {
                        throw $mismatch
                    }
                    Write-DemoOk 'roundtrip and expected comparison'
                }
                else {
                    Write-DemoOk 'roundtrip (no expected file present)'
                }
            }
            catch {
                Write-DemoNg ('roundtrip failed: ' + $_.Exception.Message)
            }

            if ($null -ne $dataObject) {
                $zeroRatesPath = Join-Path $tempRoot 'rates-zero.csv'
                $zeroRateLines = New-Object System.Collections.Generic.List[string]
                foreach ($rateLine in [IO.File]::ReadAllLines($ratesPath)) {
                    if ($rateLine -match '^USD,') {
                        $null = $zeroRateLines.Add('USD,0')
                    }
                    else {
                        $null = $zeroRateLines.Add($rateLine)
                    }
                }
                $utf8Bom = New-Object Text.UTF8Encoding($true)
                [IO.File]::WriteAllLines($zeroRatesPath, $zeroRateLines.ToArray(), $utf8Bom)
                Assert-DemoUpdateRejected -Name 'nonpositive-rate' -InputObject (Copy-DemoJsonObject $dataObject) -RatesPath $zeroRatesPath -LedgerTemplate $ledgerPath -TempPath $tempRoot -UpdateScript $updateScript

                $nullMetric = Copy-DemoJsonObject $dataObject
                $nullMetric.companies[0].values.revenue = $null
                Assert-DemoUpdateRejected -Name 'null-metric' -InputObject $nullMetric -RatesPath $ratesPath -LedgerTemplate $ledgerPath -TempPath $tempRoot -UpdateScript $updateScript

                $omittedCompany = Copy-DemoJsonObject $dataObject
                $omittedCompany.companies = @($omittedCompany.companies | Select-Object -Skip 1)
                Assert-DemoUpdateRejected -Name 'omitted-ledger-company' -InputObject $omittedCompany -RatesPath $ratesPath -LedgerTemplate $ledgerPath -TempPath $tempRoot -UpdateScript $updateScript

                $missingQuotes = Copy-DemoJsonObject $dataObject
                $missingQuotes.companies[0].PSObject.Properties.Remove('quotes')
                Assert-DemoUpdateRejected -Name 'missing-quotes' -InputObject $missingQuotes -RatesPath $ratesPath -LedgerTemplate $ledgerPath -TempPath $tempRoot -UpdateScript $updateScript

                $missingIssues = Copy-DemoJsonObject $dataObject
                $missingIssues.companies[0].PSObject.Properties.Remove('issues')
                Assert-DemoUpdateRejected -Name 'missing-issues' -InputObject $missingIssues -RatesPath $ratesPath -LedgerTemplate $ledgerPath -TempPath $tempRoot -UpdateScript $updateScript

                $unknownIssue = Copy-DemoJsonObject $dataObject
                $unknownIssueCompany = $unknownIssue.companies | Where-Object { @($_.issues).Count -gt 0 } | Select-Object -First 1
                $unknownIssueCompany.issues[0].type = 'other_variation'
                Assert-DemoUpdateRejected -Name 'unknown-issue-type' -InputObject $unknownIssue -RatesPath $ratesPath -LedgerTemplate $ledgerPath -TempPath $tempRoot -UpdateScript $updateScript

                $emptyIssueQuote = Copy-DemoJsonObject $dataObject
                $emptyIssueCompany = $emptyIssueQuote.companies | Where-Object { @($_.issues).Count -gt 0 } | Select-Object -First 1
                $emptyIssueCompany.issues[0].quote = ''
                Assert-DemoUpdateRejected -Name 'empty-issue-quote' -InputObject $emptyIssueQuote -RatesPath $ratesPath -LedgerTemplate $ledgerPath -TempPath $tempRoot -UpdateScript $updateScript

                $emptyMissingQuote = Copy-DemoJsonObject $dataObject
                $emptyMissingQuote.missing[0].quote = ''
                Assert-DemoUpdateRejected -Name 'empty-missing-quote' -InputObject $emptyMissingQuote -RatesPath $ratesPath -LedgerTemplate $ledgerPath -TempPath $tempRoot -UpdateScript $updateScript
            }
            else {
                Write-DemoNg 'negative validation fixture unavailable'
            }
        }
    }
    finally {
        if ($null -ne $tempRoot -and (Test-Path -LiteralPath $tempRoot -PathType Container)) {
            Remove-Item -LiteralPath $tempRoot -Recurse -Force
        }
    }

    $serverPath = Join-Path $RepoPath 'apps\coding-agent\dist\server.js'
    $smokePath = Join-Path $RepoPath 'apps\coding-agent\dist\smoke.js'
    $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($null -eq $nodeCommand) {
        $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
    }
    if ((Test-Path -LiteralPath $serverPath -PathType Leaf) -and (Test-Path -LiteralPath $smokePath -PathType Leaf) -and $null -ne $nodeCommand) {
        try {
            $nodePath = if (-not [string]::IsNullOrWhiteSpace([string]$nodeCommand.Path)) { $nodeCommand.Path } else { $nodeCommand.Source }
            Push-Location (Join-Path $RepoPath 'apps\coding-agent')
            try {
                & $nodePath 'dist\smoke.js' 2>&1 | Out-Null
                if ($LASTEXITCODE -ne 0) {
                    throw "node dist/smoke.js exit $LASTEXITCODE"
                }
            }
            finally {
                Pop-Location
            }
            Write-DemoOk 'coding-agent dist smoke and node.exe'
        }
        catch {
            Write-DemoNg ('coding-agent smoke failed: ' + $_.Exception.Message)
        }
    }
    else {
        Write-DemoNg 'coding-agent dist/server.js, dist/smoke.js, or node.exe missing'
    }

    $edgeCandidates = @(
        (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'),
        (Join-Path ${env:ProgramFiles} 'Microsoft\Edge\Application\msedge.exe')
    )
    $edgeFound = $false
    foreach ($edgeCandidate in $edgeCandidates) {
        if (-not [string]::IsNullOrWhiteSpace($edgeCandidate) -and (Test-Path -LiteralPath $edgeCandidate -PathType Leaf)) {
            $edgeFound = $true
            break
        }
    }
    if (-not $edgeFound) {
        $edgeProcess = Get-Process -Name msedge -ErrorAction SilentlyContinue
        if ($null -ne $edgeProcess) {
            $edgeFound = $true
        }
    }
    if ($edgeFound) {
        Write-DemoOk 'msedge.exe present'
    }
    else {
        Write-DemoNg 'msedge.exe not found'
    }
}
catch {
    Write-DemoNg ('setup test failed: ' + $_.Exception.Message)
}
finally {
    if ($null -ne $tempRoot -and (Test-Path -LiteralPath $tempRoot -PathType Container)) {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force
    }
}

if ($allOk) {
    Write-Host 'RESULT ALL OK'
    exit 0
}
Write-Host 'RESULT FAILED'
exit 1
