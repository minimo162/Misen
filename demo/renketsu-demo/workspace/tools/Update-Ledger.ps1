[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [Alias('ExtractedPath')]
    [string]$Extracted,

    [Parameter(Mandatory = $true, Position = 1)]
    [string]$Rates,

    [Parameter(Mandatory = $true, Position = 2)]
    [string]$Ledger,

    [Parameter(Position = 3)]
    [string]$ImportExcelPath
)

$ErrorActionPreference = 'Stop'
$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $scriptRoot 'lib\Common.ps1')

function Read-RenketsuJsonInput {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$InputPathOrJson)

    $candidate = $InputPathOrJson
    $isPath = $false
    if (-not ($candidate.TrimStart().StartsWith('{') -or $candidate.TrimStart().StartsWith('['))) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            $isPath = $true
        }
    }
    if ($isPath) {
        $raw = [System.IO.File]::ReadAllText((Resolve-Path -LiteralPath $candidate).ProviderPath, [Text.Encoding]::UTF8)
    }
    else {
        $raw = $candidate
    }
    if ([string]::IsNullOrWhiteSpace($raw)) {
        throw 'Extracted JSON is empty.'
    }
    try {
        return ($raw | ConvertFrom-Json -ErrorAction Stop)
    }
    catch {
        throw "Extracted JSON is invalid: $($_.Exception.Message)"
    }
}

function Get-RenketsuArray {
    [CmdletBinding()]
    param([object]$Value)

    if ($null -eq $Value) {
        return @()
    }
    if ($Value -is [System.Array]) {
        return $Value
    }
    return @($Value)
}

function Find-RenketsuLedgerSheet {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][object]$Workbook)

    foreach ($preferredName in @('連結台帳', 'Ledger')) {
        foreach ($sheet in $Workbook.Worksheets) {
            if ([string]$sheet.Name -ceq $preferredName) {
                return $sheet
            }
        }
    }
    throw '連結台帳 or Ledger worksheet was not found.'
}

function Find-RenketsuHeaders {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][object]$Worksheet)

    if ($null -eq $Worksheet.Dimension) {
        throw 'Ledger worksheet is empty.'
    }
    $expected = [ordered]@{
        id = '会社ID'
        name = '会社名'
        status = '提出状況'
        revenue = '売上高（百万円）'
        operatingProfit = '営業利益（百万円）'
        netIncome = '当期純利益（百万円）'
        totalAssets = '総資産（百万円）'
        employees = '従業員数（人）'
    }
    $found = @{}
    $headerRow = 0
    $maxRow = [Math]::Min([int]$Worksheet.Dimension.End.Row, 15)
    $maxColumn = [int]$Worksheet.Dimension.End.Column
    for ($row = 1; $row -le $maxRow; $row++) {
        $rowFound = @{}
        for ($column = 1; $column -le $maxColumn; $column++) {
            $text = (Get-RenketsuCellText -Cell $Worksheet.Cells[$row, $column]).Trim()
            foreach ($key in $expected.Keys) {
                if ($text -ceq $expected[$key]) {
                    if ($rowFound.ContainsKey($key)) {
                        throw "Duplicate ledger header '$($expected[$key])' in row $row."
                    }
                    $rowFound[$key] = $column
                }
            }
        }
        if ($rowFound.Count -gt 0) {
            if ($headerRow -ne 0 -and $rowFound.Count -ne 0) {
                # All required headers must be on one stable row; do not merge rows.
                throw 'Ledger headers were found on multiple rows.'
            }
            $headerRow = $row
            $found = $rowFound
            break
        }
    }
    if ($headerRow -eq 0) {
        throw 'Ledger header row was not found in the first 15 rows.'
    }
    $required = @('id', 'name', 'revenue', 'operatingProfit', 'netIncome', 'totalAssets', 'employees')
    foreach ($key in $required) {
        if (-not $found.ContainsKey($key)) {
            throw "Required ledger header '$($expected[$key])' is missing."
        }
    }
    return [pscustomobject]@{ Row = $headerRow; Columns = $found; Expected = $expected }
}

function Get-RenketsuInputValue {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][object]$Values,
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$CompanyId
    )

    $value = Get-RenketsuPropertyValue -InputObject $Values -Name $Name
    return (ConvertTo-RenketsuDecimal -Value $value -FieldName "$CompanyId.values.$Name" -AllowNull)
}

function Add-RenketsuConfirmationRow {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][object]$Rows,
        [string]$Id,
        [string]$Name,
        [string]$Source,
        [string]$Field,
        [string]$Type,
        [string]$Message,
        [string]$Quote
    )

    $null = $Rows.Add([ordered]@{
        '会社ID' = $Id
        '会社名' = $Name
        '出典' = $Source
        'フィールド' = $Field
        '種別' = $Type
        'メッセージ' = $Message
        '該当引用' = $Quote
    })
}

try {
    $extractedObject = Read-RenketsuJsonInput -InputPathOrJson $Extracted
    $companies = Get-RenketsuArray -Value (Get-RenketsuPropertyValue -InputObject $extractedObject -Name 'companies')
    if ($null -eq (Get-RenketsuPropertyValue -InputObject $extractedObject -Name 'companies')) {
        throw 'Extracted JSON must contain companies[].'
    }
    $missing = Get-RenketsuArray -Value (Get-RenketsuPropertyValue -InputObject $extractedObject -Name 'missing')

    $ratePath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Rates)
    if (-not (Test-Path -LiteralPath $ratePath -PathType Leaf)) {
        throw "Rates CSV was not found: $Rates"
    }
    $rateRows = Import-Csv -LiteralPath $ratePath
    $ratesByCurrency = @{}
    foreach ($rateRow in $rateRows) {
        $currencyValue = Get-RenketsuPropertyValue -InputObject $rateRow -Name 'Currency'
        $rateValue = Get-RenketsuPropertyValue -InputObject $rateRow -Name 'JPYPerUnit'
        if ($null -eq $currencyValue -or $null -eq $rateValue) {
            throw 'Rates CSV must contain Currency and JPYPerUnit columns.'
        }
        $currency = ([string]$currencyValue).Trim().ToUpperInvariant()
        if ([string]::IsNullOrWhiteSpace($currency)) {
            throw 'Rates CSV contains an empty Currency.'
        }
        if ($ratesByCurrency.ContainsKey($currency)) {
            throw "Rates CSV contains duplicate Currency: $currency"
        }
        $ratesByCurrency[$currency] = ConvertTo-RenketsuDecimal -Value $rateValue -FieldName "Rates.$currency"
    }

    $workspacePath = Split-Path -Parent $scriptRoot
    $defaultImportExcelPath = Join-Path $workspacePath 'vendor\ImportExcel\7.8.10'
    $null = Import-RenketsuExcelModule -ImportExcelPath $ImportExcelPath -DefaultPath $defaultImportExcelPath

    $ledgerPath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Ledger)
    if (-not (Test-Path -LiteralPath $ledgerPath -PathType Leaf)) {
        throw "Ledger workbook was not found: $Ledger"
    }
    if ([System.IO.Path]::GetExtension($ledgerPath) -notmatch '^\.xlsx$') {
        throw "Only .xlsx ledgers are supported: $Ledger"
    }

    $unitFactors = [ordered]@{
        ones = [decimal]1
        thousands = [decimal]1000
        millions = [decimal]1000000
    }
    $moneyFields = @('revenue', 'operatingProfit', 'netIncome', 'totalAssets')
    $ledgerMetrics = @('revenue', 'operatingProfit', 'netIncome', 'totalAssets', 'employees')
    $processedValues = @{}
    $companyById = @{}
    $missingById = @{}
    $companyIds = New-Object System.Collections.Generic.List[string]
    $missingIds = New-Object System.Collections.Generic.List[string]
    $unitVariationCompanies = @{}
    $accountVariationCompanies = @{}
    $convertedCompanies = @{}
    $unitNormalizedCompanies = @{}

    foreach ($company in $companies) {
        $companyIdValue = Get-RenketsuPropertyValue -InputObject $company -Name 'id'
        $companyId = if ($null -eq $companyIdValue) { '' } else { ([string]$companyIdValue).Trim() }
        if ([string]::IsNullOrWhiteSpace($companyId)) {
            throw 'Every companies[] item requires a non-empty id.'
        }
        if ($companyById.ContainsKey($companyId) -or $missingById.ContainsKey($companyId)) {
            throw "Duplicate company id in extracted input: $companyId"
        }
        $companyById[$companyId] = $company
        $null = $companyIds.Add($companyId)
        $nameValue = Get-RenketsuPropertyValue -InputObject $company -Name 'name'
        $currencyValue = Get-RenketsuPropertyValue -InputObject $company -Name 'currency'
        $unitValue = Get-RenketsuPropertyValue -InputObject $company -Name 'unit'
        $values = Get-RenketsuPropertyValue -InputObject $company -Name 'values'
        if ($null -eq $values) {
            throw "$companyId.values is required."
        }
        $currency = if ($null -eq $currencyValue) { '' } else { ([string]$currencyValue).Trim().ToUpperInvariant() }
        if (-not $ratesByCurrency.ContainsKey($currency)) {
            throw "No JPYPerUnit rate for currency $currency ($companyId)."
        }
        if ($currency -ne 'JPY') {
            $convertedCompanies[$companyId] = $true
        }
        $unit = if ($null -eq $unitValue) { '' } else { ([string]$unitValue).Trim().ToLowerInvariant() }
        if (-not $unitFactors.Contains($unit)) {
            throw "Invalid unit '$unit' for $companyId; expected ones, thousands, or millions."
        }
        if ($unit -ne 'millions') {
            $unitNormalizedCompanies[$companyId] = $true
        }

        $converted = @{}
        foreach ($moneyField in $moneyFields) {
            $sourceValue = Get-RenketsuInputValue -Values $values -Name $moneyField -CompanyId $companyId
            if ($null -eq $sourceValue) {
                $converted[$moneyField] = $null
            }
            else {
                $converted[$moneyField] = ($sourceValue * $unitFactors[$unit] * $ratesByCurrency[$currency] / [decimal]1000000)
            }
        }
        $converted['employees'] = Get-RenketsuInputValue -Values $values -Name 'employees' -CompanyId $companyId
        $processedValues[$companyId] = $converted

        $issues = Get-RenketsuArray -Value (Get-RenketsuPropertyValue -InputObject $company -Name 'issues')
        foreach ($issue in $issues) {
            $kind = Get-RenketsuIssueKind -Issue $issue
            if ($kind -eq 'unit') {
                $unitVariationCompanies[$companyId] = $true
            }
            elseif ($kind -eq 'account') {
                $accountVariationCompanies[$companyId] = $true
            }
        }
    }

    foreach ($missingItem in $missing) {
        $missingIdValue = Get-RenketsuPropertyValue -InputObject $missingItem -Name 'id'
        $missingId = if ($null -eq $missingIdValue) { '' } else { ([string]$missingIdValue).Trim() }
        if ([string]::IsNullOrWhiteSpace($missingId)) {
            throw 'Every missing[] item requires a non-empty id.'
        }
        if ($missingById.ContainsKey($missingId) -or $companyById.ContainsKey($missingId)) {
            throw "Duplicate company id in missing input: $missingId"
        }
        $typeValue = Get-RenketsuPropertyValue -InputObject $missingItem -Name 'type'
        if ($null -eq $typeValue -or ([string]$typeValue).Trim().ToLowerInvariant() -ne 'unsubmitted') {
            throw "missing[$missingId] must have type=unsubmitted."
        }
        $missingById[$missingId] = $missingItem
        $null = $missingIds.Add($missingId)
    }

    $package = $null
    $confirmationRows = New-Object System.Collections.Generic.List[object]
    $totals = [ordered]@{
        revenue = [decimal]0
        operatingProfit = [decimal]0
        netIncome = [decimal]0
        totalAssets = [decimal]0
        employees = [decimal]0
    }
    try {
        $previousWarningPreference = $WarningPreference
        $WarningPreference = 'SilentlyContinue'
        try {
            $package = Open-ExcelPackage -Path $ledgerPath
        }
        finally {
            $WarningPreference = $previousWarningPreference
        }
        if ($null -eq $package) {
            throw "Could not open ledger workbook: $Ledger"
        }
        $ledgerSheet = Find-RenketsuLedgerSheet -Workbook $package.Workbook
        $headers = Find-RenketsuHeaders -Worksheet $ledgerSheet
        $columns = $headers.Columns
        $lastRow = [int]$ledgerSheet.Dimension.End.Row
        $rowsById = @{}
        $totalRows = New-Object System.Collections.Generic.List[int]
        for ($row = $headers.Row + 1; $row -le $lastRow; $row++) {
            $idText = (Get-RenketsuCellText -Cell $ledgerSheet.Cells[$row, $columns.id]).Trim()
            if ([string]::IsNullOrWhiteSpace($idText)) {
                continue
            }
            if ($idText -ceq '合計' -or $idText -ieq 'TOTAL' -or $idText -ieq 'Total') {
                $null = $totalRows.Add($row)
                continue
            }
            if ($rowsById.ContainsKey($idText)) {
                throw "Duplicate ledger company id: $idText"
            }
            $rowsById[$idText] = $row
        }

        foreach ($companyId in $companyIds.ToArray()) {
            if (-not $rowsById.ContainsKey($companyId)) {
                throw "Extracted company id is missing from Ledger worksheet: $companyId"
            }
            $row = [int]$rowsById[$companyId]
            $values = $processedValues[$companyId]
            foreach ($metric in $ledgerMetrics) {
                $column = [int]$columns[$metric]
                $value = $values[$metric]
                if ($null -eq $value) {
                    $ledgerSheet.Cells[$row, $column].Value = $null
                }
                else {
                    $ledgerSheet.Cells[$row, $column].Value = $value
                    $totals[$metric] = $totals[$metric] + $value
                }
            }
        }
        foreach ($missingId in $missingIds.ToArray()) {
            if (-not $rowsById.ContainsKey($missingId)) {
                throw "Missing company id is absent from Ledger worksheet: $missingId"
            }
            $row = [int]$rowsById[$missingId]
            foreach ($metric in $ledgerMetrics) {
                $ledgerSheet.Cells[$row, [int]$columns[$metric]].Value = $null
            }
        }

        # Keep template totals formulas, but ensure they are recalculated on save.
        foreach ($totalRow in $totalRows.ToArray()) {
            foreach ($metric in $ledgerMetrics) {
                $totalCell = $ledgerSheet.Cells[$totalRow, [int]$columns[$metric]]
                if ($null -ne $totalCell.Formula -and -not [string]::IsNullOrWhiteSpace([string]$totalCell.Formula)) {
                    continue
                }
                $firstDataRow = $headers.Row + 1
                $lastDataRow = $totalRow - 1
                if ($lastDataRow -ge $firstDataRow) {
                    $address = $ledgerSheet.Cells[$firstDataRow, [int]$columns[$metric]].Address + ':' + $ledgerSheet.Cells[$lastDataRow, [int]$columns[$metric]].Address
                    $totalCell.Formula = '=SUM(' + $address + ')'
                }
            }
        }

        foreach ($companyId in $companyIds.ToArray()) {
            $company = $companyById[$companyId]
            $nameValue = Get-RenketsuPropertyValue -InputObject $company -Name 'name'
            $sourceValue = Get-RenketsuPropertyValue -InputObject $company -Name 'source'
            $name = if ($null -eq $nameValue) { '' } else { [string]$nameValue }
            $source = if ($null -eq $sourceValue) { '' } else { [string]$sourceValue }
            $issues = Get-RenketsuArray -Value (Get-RenketsuPropertyValue -InputObject $company -Name 'issues')
            foreach ($issue in $issues) {
                $kind = Get-RenketsuIssueKind -Issue $issue
                $typeValue = Get-RenketsuPropertyValue -InputObject $issue -Name 'type'
                $displayType = if ($null -eq $typeValue) { $kind } else { [string]$typeValue }
                if ([string]::IsNullOrWhiteSpace($kind)) {
                    $kind = if ($null -eq $typeValue) { 'issue' } else { [string]$typeValue }
                }
                Add-RenketsuConfirmationRow -Rows $confirmationRows -Id $companyId -Name $name -Source $source -Field (Get-RenketsuIssueField -Issue $issue) -Type $displayType -Message (Get-RenketsuIssueMessage -Issue $issue) -Quote (Get-RenketsuIssueQuote -Issue $issue)
            }
        }
        foreach ($missingId in $missingIds.ToArray()) {
            $missingItem = $missingById[$missingId]
            $nameValue = Get-RenketsuPropertyValue -InputObject $missingItem -Name 'name'
            $quoteValue = Get-RenketsuPropertyValue -InputObject $missingItem -Name 'quote'
            $name = if ($null -eq $nameValue) { '' } else { [string]$nameValue }
            $quote = if ($null -eq $quoteValue) { '' } else { [string]$quoteValue }
            Add-RenketsuConfirmationRow -Rows $confirmationRows -Id $missingId -Name $name -Source '' -Field '' -Type 'unsubmitted' -Message '未提出' -Quote $quote
        }

        $existingConfirmation = $null
        foreach ($sheet in $package.Workbook.Worksheets) {
            if ([string]$sheet.Name -ceq '確認事項') {
                $existingConfirmation = $sheet
                break
            }
        }
        if ($null -ne $existingConfirmation) {
            $package.Workbook.Worksheets.Delete($existingConfirmation.Index)
        }
        $confirmationSheet = $package.Workbook.Worksheets.Add('確認事項')
        $confirmationHeaders = @('会社ID', '会社名', '出典', 'フィールド', '種別', 'メッセージ', '該当引用')
        for ($column = 0; $column -lt $confirmationHeaders.Count; $column++) {
            $confirmationSheet.Cells[1, ($column + 1)].Value = $confirmationHeaders[$column]
            $confirmationSheet.Cells[1, ($column + 1)].Style.Font.Bold = $true
        }
        $confirmationRowIndex = 2
        foreach ($item in $confirmationRows.ToArray()) {
            for ($column = 0; $column -lt $confirmationHeaders.Count; $column++) {
                $confirmationSheet.Cells[$confirmationRowIndex, ($column + 1)].Value = $item[$confirmationHeaders[$column]]
            }
            $confirmationRowIndex++
        }
        if ($confirmationHeaders.Count -gt 0) {
            $confirmationSheet.Cells[1, 1, [Math]::Max(1, $confirmationRowIndex - 1), $confirmationHeaders.Count].AutoFitColumns()
        }

        $previousWarningPreference = $WarningPreference
        $WarningPreference = 'SilentlyContinue'
        try {
            # EPPlus 4.5's optional calculator writes #VALUE! for valid SUM formulas.
            # Keep template formulas intact and let Excel recalculate on open.
            Close-ExcelPackage -ExcelPackage $package
        }
        finally {
            $WarningPreference = $previousWarningPreference
        }
        $package = $null

        $payload = [ordered]@{
            ok = $true
            ledger = [System.IO.Path]::GetFullPath($ledgerPath)
            processedCompanies = $companyById.Count
            missingCompanies = $missingById.Count
            convertedCompanies = $convertedCompanies.Count
            unitNormalizedCompanies = $unitNormalizedCompanies.Count
            unitVariations = $unitVariationCompanies.Count
            accountVariations = $accountVariationCompanies.Count
            confirmationCount = $confirmationRows.Count
            totals = $totals
        }
        Write-Output (ConvertTo-RenketsuJsonLine -InputObject $payload)
    }
    finally {
        if ($null -ne $package) {
            $package.Dispose()
        }
    }
}
catch {
    Write-RenketsuError -Message $_.Exception.Message -Code 'update_ledger_failed'
}
