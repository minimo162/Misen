param(
    [switch]$SkipWorkbook
)

$ErrorActionPreference = 'Stop'

# This script intentionally keeps the records below as the only source of truth.
# It is Windows PowerShell 5.1 compatible and does not use Excel COM.
$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$demoRoot = Split-Path -Parent $scriptRoot
$workspace = Join-Path $demoRoot 'workspace'
$reportsDir = Join-Path $workspace 'reports'
$ratesDir = Join-Path $workspace 'rates'
$validationDir = Join-Path $demoRoot 'validation'

foreach ($directory in @($workspace, $reportsDir, $ratesDir, $validationDir)) {
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
}

$fields = @('revenue', 'operatingProfit', 'netIncome', 'totalAssets', 'employees')
$moneyFields = @('revenue', 'operatingProfit', 'netIncome', 'totalAssets')

# Display-unit text is deliberately varied to exercise unit interpretation. The
# canonical Unit values are ones, thousands, and millions.
$records = @(
    [pscustomobject]@{
        Id = 'JP01'; Name = '架空JPソリューション01'; FileName = 'JP01_円百万円.csv'; Format = 'csv'; Currency = 'JPY'; Unit = 'millions'; DisplayUnit = '百万円'; Header = @('指標', '数値', '単位', '通貨'); SheetName = ''; StartRow = 1
        Labels = [ordered]@{ revenue = '売上高'; operatingProfit = '営業利益'; netIncome = '当期純利益'; totalAssets = '総資産'; employees = '従業員数' }
        Values = [ordered]@{ revenue = 1200; operatingProfit = 180; netIncome = 110; totalAssets = 3500; employees = 320 }
    }
    [pscustomobject]@{
        Id = 'JP02'; Name = '架空JPソリューション02'; FileName = 'JP02_円百万円_列名違い.csv'; Format = 'csv'; Currency = 'JPY'; Unit = 'millions'; DisplayUnit = '百万円'; Header = @('項目', '実績値', '単位', '通貨'); SheetName = ''; StartRow = 1
        Labels = [ordered]@{ revenue = '売上高'; operatingProfit = '営業利益'; netIncome = '当期純利益'; totalAssets = '総資産'; employees = '従業員数' }
        Values = [ordered]@{ revenue = 980; operatingProfit = 120; netIncome = 76; totalAssets = 2800; employees = 210 }
    }
    [pscustomobject]@{
        Id = 'JP03'; Name = '架空JPソリューション03'; FileName = 'JP03_円百万円.csv'; Format = 'csv'; Currency = 'JPY'; Unit = 'millions'; DisplayUnit = '百万円'; Header = @('指標', '数値', '単位', '通貨'); SheetName = ''; StartRow = 1
        Labels = [ordered]@{ revenue = '売上高'; operatingProfit = '営業利益'; netIncome = '当期純利益'; totalAssets = '総資産'; employees = '従業員数' }
        Values = [ordered]@{ revenue = 1560; operatingProfit = 250; netIncome = 160; totalAssets = 4200; employees = 410 }
    }
    [pscustomobject]@{
        Id = 'JP04'; Name = '架空JPソリューション04'; FileName = 'JP04_円百万円_CP932.csv'; Format = 'csv-cp932'; Currency = 'JPY'; Unit = 'millions'; DisplayUnit = '百万円'; Header = @('指標', '数値', '単位', '通貨'); SheetName = ''; StartRow = 1
        Labels = [ordered]@{ revenue = '売上高'; operatingProfit = '営業利益'; netIncome = '当期純利益'; totalAssets = '総資産'; employees = '従業員数' }
        Values = [ordered]@{ revenue = 760; operatingProfit = 85; netIncome = 52; totalAssets = 2100; employees = 160 }
    }
    [pscustomobject]@{
        Id = 'OS01'; Name = '架空OS子会社01'; FileName = 'OS01_USD_ones.csv'; Format = 'csv'; Currency = 'USD'; Unit = 'ones'; DisplayUnit = 'ones'; Header = @('Metric', 'Value', 'Unit', 'Currency'); SheetName = ''; StartRow = 1
        Labels = [ordered]@{ revenue = 'Revenue'; operatingProfit = 'Operating Profit'; netIncome = 'Net Income'; totalAssets = 'Total Assets'; employees = 'Employees' }
        Values = [ordered]@{ revenue = 500000000; operatingProfit = 42000000; netIncome = 31000000; totalAssets = 780000000; employees = 1250 }
    }
    [pscustomobject]@{
        Id = 'OS02'; Name = '架空OS子会社02'; FileName = 'OS02_EUR_thousands.csv'; Format = 'csv'; Currency = 'EUR'; Unit = 'thousands'; DisplayUnit = '千EUR'; Header = @('項目', '値', '単位', '通貨'); SheetName = ''; StartRow = 1
        Labels = [ordered]@{ revenue = '売上高'; operatingProfit = '営業利益'; netIncome = '純利益'; totalAssets = '総資産'; employees = '従業員数' }
        Values = [ordered]@{ revenue = 420000; operatingProfit = 38000; netIncome = 24500; totalAssets = 690000; employees = 980 }
    }
    [pscustomobject]@{
        Id = 'OS03'; Name = '架空OS子会社03'; FileName = 'OS03_CNY_millions.txt'; Format = 'txt'; Currency = 'CNY'; Unit = 'millions'; DisplayUnit = '百万元'; Header = @(); SheetName = ''; StartRow = 1
        Labels = [ordered]@{ revenue = 'Revenue'; operatingProfit = 'Operating profit'; netIncome = 'Net income'; totalAssets = 'Total assets'; employees = 'Employees' }
        Values = [ordered]@{ revenue = 320; operatingProfit = 44; netIncome = 29; totalAssets = 510; employees = 640 }
    }
    [pscustomobject]@{
        Id = 'OS04'; Name = '架空OS子会社04'; FileName = 'OS04_THB_thousands.xlsx'; Format = 'xlsx'; Currency = 'THB'; Unit = 'thousands'; DisplayUnit = '千THB'; Header = @('Metric', 'Amount', 'Scale', 'CCY'); SheetName = '入力データ'; StartRow = 4
        Labels = [ordered]@{ revenue = 'Revenue'; operatingProfit = 'Operating Profit'; netIncome = 'Net Income'; totalAssets = 'Total Assets'; employees = 'Employees' }
        Values = [ordered]@{ revenue = 850000; operatingProfit = 91000; netIncome = 63000; totalAssets = 1200000; employees = 730 }
    }
    [pscustomobject]@{
        Id = 'OS05'; Name = '架空OS子会社05'; FileName = 'OS05_GBP_ones.xlsx'; Format = 'xlsx'; Currency = 'GBP'; Unit = 'ones'; DisplayUnit = 'GBP'; Header = @('項目', '値', '単位', '通貨'); SheetName = 'Summary'; StartRow = 2
        Labels = [ordered]@{ revenue = 'Revenue'; operatingProfit = 'Operating Profit'; netIncome = 'Net Income'; totalAssets = 'Total Assets'; employees = 'Employees' }
        Values = [ordered]@{ revenue = 250000000; operatingProfit = 32000000; netIncome = 21000000; totalAssets = 430000000; employees = 540 }
    }
    [pscustomobject]@{
        Id = 'OS06'; Name = '架空OS子会社06'; FileName = 'OS06_USD_millions_account-variation.csv'; Format = 'csv'; Currency = 'USD'; Unit = 'millions'; DisplayUnit = 'million USD'; Header = @('Metric Name', 'Reported Amount', 'Scale', 'Currency Code'); SheetName = ''; StartRow = 1
        Labels = [ordered]@{ revenue = 'Revenue'; operatingProfit = 'Operating result'; netIncome = 'Net Income'; totalAssets = 'Total Assets'; employees = 'Employees' }
        Values = [ordered]@{ revenue = 780; operatingProfit = 98; netIncome = 61; totalAssets = 1320; employees = 1880 }
    }
    [pscustomobject]@{
        Id = 'OS07'; Name = '架空OS子会社07'; FileName = 'OS07_EUR_ones.txt'; Format = 'txt'; Currency = 'EUR'; Unit = 'ones'; DisplayUnit = 'EUR'; Header = @(); SheetName = ''; StartRow = 1
        Labels = [ordered]@{ revenue = 'Revenue'; operatingProfit = 'Operating Profit'; netIncome = 'Net Income'; totalAssets = 'Total Assets'; employees = 'Employees' }
        Values = [ordered]@{ revenue = 90000000; operatingProfit = 11500000; netIncome = 7200000; totalAssets = 165000000; employees = 430 }
    }
    [pscustomobject]@{
        Id = 'OS08'; Name = '架空OS子会社08'; FileName = 'OS08_CNY_thousands.xlsx'; Format = 'xlsx'; Currency = 'CNY'; Unit = 'thousands'; DisplayUnit = '千CNY'; Header = @('KPI', 'Amount', 'Scale', 'CCY'); SheetName = 'KPI'; StartRow = 6
        Labels = [ordered]@{ revenue = 'Revenue'; operatingProfit = 'Operating Profit'; netIncome = 'Net Income'; totalAssets = 'Total Assets'; employees = 'Employees' }
        Values = [ordered]@{ revenue = 620000; operatingProfit = 74000; netIncome = 51000; totalAssets = 980000; employees = 860 }
    }
    [pscustomobject]@{
        Id = 'OS09'; Name = '架空OS子会社09'; FileName = 'OS09_THB_millions.csv'; Format = 'csv'; Currency = 'THB'; Unit = 'millions'; DisplayUnit = 'million THB'; Header = @('Metric', 'Value', 'Unit', 'Currency'); SheetName = ''; StartRow = 1
        Labels = [ordered]@{ revenue = 'Revenue'; operatingProfit = 'Operating Profit'; netIncome = 'Net Income'; totalAssets = 'Total Assets'; employees = 'Employees' }
        Values = [ordered]@{ revenue = 410; operatingProfit = 55; netIncome = 34; totalAssets = 720; employees = 510 }
    }
    [pscustomobject]@{
        Id = 'OS10'; Name = '架空OS子会社10'; FileName = 'OS10_GBP_thousands.txt'; Format = 'txt'; Currency = 'GBP'; Unit = 'thousands'; DisplayUnit = '千GBP'; Header = @(); SheetName = ''; StartRow = 1
        Labels = [ordered]@{ revenue = 'Revenue'; operatingProfit = 'Operating Profit'; netIncome = 'Net Income'; totalAssets = 'Total Assets'; employees = 'Employees' }
        Values = [ordered]@{ revenue = 330000; operatingProfit = 45000; netIncome = 29000; totalAssets = 640000; employees = 720 }
    }
    [pscustomobject]@{
        Id = 'OS11'; Name = '架空OS子会社11'; FileName = 'OS11_USD_ones.xlsx'; Format = 'xlsx'; Currency = 'USD'; Unit = 'ones'; DisplayUnit = 'USD'; Header = @('Metric', 'Amount', 'Unit', 'Currency'); SheetName = 'Data'; StartRow = 3
        Labels = [ordered]@{ revenue = 'Revenue'; operatingProfit = 'Operating Profit'; netIncome = 'Net Income'; totalAssets = 'Total Assets'; employees = 'Employees' }
        Values = [ordered]@{ revenue = 640000000; operatingProfit = 83000000; netIncome = 57000000; totalAssets = 910000000; employees = 1100 }
    }
    [pscustomobject]@{
        Id = 'OS12'; Name = '架空OS子会社12'; FileName = 'OS12_EUR_millions.csv'; Format = 'csv'; Currency = 'EUR'; Unit = 'millions'; DisplayUnit = 'million EUR'; Header = @('Metric', 'Value', 'Scale', 'Currency'); SheetName = ''; StartRow = 1
        Labels = [ordered]@{ revenue = 'Revenue'; operatingProfit = 'Operating Profit'; netIncome = 'Net Income'; totalAssets = 'Total Assets'; employees = 'Employees' }
        Values = [ordered]@{ revenue = 510; operatingProfit = 66; netIncome = 42; totalAssets = 870; employees = 950 }
    }
    [pscustomobject]@{
        Id = 'OS13'; Name = '架空OS子会社13'; FileName = 'OS13_CNY_ones.txt'; Format = 'txt'; Currency = 'CNY'; Unit = 'ones'; DisplayUnit = 'CNY'; Header = @(); SheetName = ''; StartRow = 1
        Labels = [ordered]@{ revenue = 'Revenue'; operatingProfit = 'Operating Profit'; netIncome = 'Net Income'; totalAssets = 'Total Assets'; employees = 'Employees' }
        Values = [ordered]@{ revenue = 720000000; operatingProfit = 88000000; netIncome = 61000000; totalAssets = 1300000000; employees = 1380 }
    }
    [pscustomobject]@{
        Id = 'OS14'; Name = '架空OS子会社14'; FileName = 'OS14_THB_thousands.csv'; Format = 'csv'; Currency = 'THB'; Unit = 'thousands'; DisplayUnit = '千THB'; Header = @('Item', 'Amount', 'Unit', 'Currency'); SheetName = ''; StartRow = 1
        Labels = [ordered]@{ revenue = 'Revenue'; operatingProfit = 'Operating Profit'; netIncome = 'Net Income'; totalAssets = 'Total Assets'; employees = 'Employees' }
        Values = [ordered]@{ revenue = 1250000; operatingProfit = 155000; netIncome = 101000; totalAssets = 2100000; employees = 670 }
    }
    [pscustomobject]@{
        Id = 'OS15'; Name = '架空OS子会社15'; FileName = 'OS15_GBP_millions.csv'; Format = 'csv'; Currency = 'GBP'; Unit = 'millions'; DisplayUnit = 'million GBP'; Header = @('Metric', 'Amount', 'Scale', 'Currency'); SheetName = ''; StartRow = 1
        Labels = [ordered]@{ revenue = 'Revenue'; operatingProfit = 'Operating Profit'; netIncome = 'Net Income'; totalAssets = 'Total Assets'; employees = 'Employees' }
        Values = [ordered]@{ revenue = 285; operatingProfit = 38; netIncome = 24; totalAssets = 490; employees = 610 }
    }
)

if ($records.Count -ne 19) {
    throw ('Source record count must be 19, got {0}' -f $records.Count)
}

$rates = [ordered]@{
    JPY = 1
    USD = 150
    EUR = 165
    CNY = 21
    THB = 4.2
    GBP = 190
}

function Write-TextWithEncoding {
    param(
        [string]$Path,
        [string[]]$Lines,
        [System.Text.Encoding]$Encoding
    )
    $text = ($Lines -join "`r`n") + "`r`n"
    [System.IO.File]::WriteAllText($Path, $text, $Encoding)
}

$utf8Bom = New-Object System.Text.UTF8Encoding($true)
$cp932 = [System.Text.Encoding]::GetEncoding(932)

# Rates are intentionally simple and fully synthetic.
$rateLines = New-Object System.Collections.Generic.List[string]
$rateLines.Add('Currency,JPYPerUnit')
foreach ($currency in $rates.Keys) {
    $rateLines.Add(('{0},{1}' -f $currency, $rates[$currency]))
}
Write-TextWithEncoding -Path (Join-Path $ratesDir 'レート表.csv') -Lines $rateLines.ToArray() -Encoding $utf8Bom

$sourceQuotes = @{}

function Get-DisplayUnit {
    param($Record, [string]$Field)
    if ($Field -eq 'employees') { return 'persons' }
    return [string]$Record.DisplayUnit
}

function Get-SourceLine {
    param($Record, [string]$Field)
    $label = [string]$Record.Labels[$Field]
    $value = [string]$Record.Values[$Field]
    $unit = Get-DisplayUnit -Record $Record -Field $Field
    if ($Record.Format -like 'csv*') {
        return ('{0},{1},{2},{3}' -f $label, $value, $unit, $Record.Currency)
    }
    if ($Record.Format -eq 'txt') {
        return ($label + ': ' + $value + ' ' + $unit + ' ' + $Record.Currency)
    }
    # XLSX quotes name the logical cell pair; the label itself is also a cell value.
    return ($label + '=' + $value + ' ' + $unit + ' ' + $Record.Currency)
}

foreach ($record in $records) {
    $path = Join-Path $reportsDir $record.FileName
    $lines = New-Object System.Collections.Generic.List[string]
    if ($record.Format -like 'csv*') {
        $lines.Add(($record.Header -join ','))
        foreach ($field in $fields) {
            $lines.Add((Get-SourceLine -Record $record -Field $field))
        }
        $encoding = if ($record.Format -eq 'csv-cp932') { $cp932 } else { $utf8Bom }
        Write-TextWithEncoding -Path $path -Lines $lines.ToArray() -Encoding $encoding
    }
    elseif ($record.Format -eq 'txt') {
        $lines.Add(('Company: ' + $record.Id + ' / ' + $record.Name))
        $lines.Add(('Currency: ' + $record.Currency + '; Unit: ' + $record.DisplayUnit))
        foreach ($field in $fields) {
            $lines.Add((Get-SourceLine -Record $record -Field $field))
        }
        Write-TextWithEncoding -Path $path -Lines $lines.ToArray() -Encoding $utf8Bom
    }
    elseif ($record.Format -eq 'xlsx') {
        # XLSX sources are emitted below after ImportExcel is loaded.
        continue
    }

    $sourceQuotes[$record.Id] = [ordered]@{}
    foreach ($field in $fields) {
        $sourceQuotes[$record.Id][$field] = Get-SourceLine -Record $record -Field $field
    }
}

function Convert-ToNormalizedValues {
    param($Record)
    $rate = [double]$rates[$Record.Currency]
    $unitFactor = 1
    if ($Record.Unit -eq 'thousands') { $unitFactor = 1000 }
    elseif ($Record.Unit -eq 'millions') { $unitFactor = 1000000 }
    $normalized = [ordered]@{}
    foreach ($field in $fields) {
        if ($field -eq 'employees') {
            $normalized[$field] = [int]$Record.Values[$field]
        }
        else {
            $normalized[$field] = [math]::Round(([double]$Record.Values[$field] * $unitFactor * $rate / 1000000), 6)
        }
    }
    return $normalized
}

function Import-ImportExcelDependency {
    param([string]$WorkspacePath)
    $moduleRoot = Join-Path $WorkspacePath 'vendor/ImportExcel/7.8.10'
    $moduleManifest = Join-Path $moduleRoot 'ImportExcel.psd1'
    if (!(Test-Path -LiteralPath $moduleManifest)) {
        Write-Warning ('ImportExcel 7.8.10 is not present at {0}; sources and validation were still generated.' -f $moduleRoot)
        return $false
    }
    $epplus = Get-ChildItem -LiteralPath $moduleRoot -Filter 'EPPlus.dll' -Recurse | Select-Object -First 1
    if ($null -eq $epplus) {
        throw ('ImportExcel found but EPPlus.dll is missing below {0}' -f $moduleRoot)
    }
    try {
        Add-Type -Path $epplus.FullName -ErrorAction SilentlyContinue
    }
    catch {
        # ImportExcel may already have loaded a compatible EPPlus assembly.
    }
    Import-Module $moduleManifest -Force
    if ($null -eq ('OfficeOpenXml.ExcelPackage' -as [type])) {
        throw 'EPPlus assembly verification failed: OfficeOpenXml.ExcelPackage is unavailable.'
    }
    if ($null -eq (Get-Command Export-Excel -ErrorAction SilentlyContinue)) {
        throw 'ImportExcel verification failed: Export-Excel command is unavailable.'
    }
    return $true
}

$importExcelReady = $false
if (!$SkipWorkbook) {
    $importExcelReady = Import-ImportExcelDependency -WorkspacePath $workspace
}

if ($importExcelReady) {
    foreach ($record in $records | Where-Object { $_.Format -eq 'xlsx' }) {
        $rows = New-Object System.Collections.Generic.List[object]
        foreach ($field in $fields) {
            $row = [ordered]@{}
            $row[$record.Header[0]] = [string]$record.Labels[$field]
            $row[$record.Header[1]] = $record.Values[$field]
            $row[$record.Header[2]] = Get-DisplayUnit -Record $record -Field $field
            $row[$record.Header[3]] = $record.Currency
            $rows.Add([pscustomobject]$row)
        }
        Export-Excel -Path (Join-Path $reportsDir $record.FileName) -WorksheetName $record.SheetName -InputObject $rows.ToArray() -StartRow $record.StartRow -AutoSize -TableName ($record.Id + 'Table') -TableStyle Medium2 -ClearSheet
        $sourceQuotes[$record.Id] = [ordered]@{}
        foreach ($field in $fields) {
            $sourceQuotes[$record.Id][$field] = [string]$record.Labels[$field]
        }
    }
}

# Keep validation deterministic even in a source-only run before the C-owned
# ImportExcel vendor is available. These are the exact logical cell labels that
# the XLSX branch writes once the dependency is present.
foreach ($record in ($records | Where-Object { $_.Format -eq 'xlsx' })) {
    if ($null -eq $sourceQuotes[$record.Id]) {
        $sourceQuotes[$record.Id] = [ordered]@{}
        foreach ($field in $fields) {
            $sourceQuotes[$record.Id][$field] = [string]$record.Labels[$field]
        }
    }
}

# Build extracted.correct.json from the records. Quotes are generated from the
# exact source line/cell representation above, never hand-entered separately.
$extractedCompanies = New-Object System.Collections.Generic.List[object]
foreach ($record in $records) {
    $issues = New-Object System.Collections.Generic.List[object]
    if ($record.Id -in @('OS02', 'OS08', 'OS14')) {
        $quote = [string]$sourceQuotes[$record.Id]['revenue']
        $issues.Add([pscustomobject][ordered]@{ type = 'unit_variation'; field = 'revenue'; message = '金額が千単位で記載されているため、通貨レート適用前に桁を補正する'; quote = $quote })
    }
    if ($record.Id -eq 'OS06') {
        $quote = [string]$sourceQuotes[$record.Id]['operatingProfit']
        $issues.Add([pscustomobject][ordered]@{ type = 'account_variation'; field = 'operatingProfit'; message = 'Operating result を operatingProfit として対応付ける'; quote = $quote })
    }
    $quotes = New-Object System.Collections.Generic.List[object]
    foreach ($field in $fields) {
        $quotes.Add([pscustomobject][ordered]@{ field = $field; quote = [string]$sourceQuotes[$record.Id][$field] })
    }
    $extractedCompanies.Add([pscustomobject][ordered]@{
            id = $record.Id
            name = $record.Name
            source = ('reports/' + $record.FileName)
            currency = $record.Currency
            unit = $record.Unit
            values = [ordered]@{
                revenue = $record.Values.revenue
                operatingProfit = $record.Values.operatingProfit
                netIncome = $record.Values.netIncome
                totalAssets = $record.Values.totalAssets
                employees = $record.Values.employees
            }
            quotes = $quotes.ToArray()
            issues = $issues.ToArray()
        })
}
$extracted = [ordered]@{
    companies = $extractedCompanies.ToArray()
    missing = @([pscustomobject][ordered]@{ id = 'OS16'; name = '架空OS子会社16'; type = 'unsubmitted'; quote = 'OS16（架空OS子会社16）に提出ファイルなし' })
}
Write-TextWithEncoding -Path (Join-Path $validationDir 'extracted.correct.json') -Lines @($extracted | ConvertTo-Json -Depth 12) -Encoding $utf8Bom

# Independent calculation #1: normalize directly from source records and rates.
$expectedCompanies = New-Object System.Collections.Generic.List[object]
$totals = [ordered]@{ revenue = 0.0; operatingProfit = 0.0; netIncome = 0.0; totalAssets = 0.0; employees = 0 }
foreach ($record in $records) {
    $normalized = Convert-ToNormalizedValues -Record $record
    foreach ($field in $moneyFields) { $totals[$field] = [math]::Round(([double]$totals[$field] + [double]$normalized[$field]), 6) }
    $totals.employees = [int]$totals.employees + [int]$normalized.employees
    $sourceValues = [ordered]@{}
    foreach ($field in $fields) { $sourceValues[$field] = $record.Values[$field] }
    $expectedCompanies.Add([pscustomobject][ordered]@{
            id = $record.Id
            name = $record.Name
            source = ('reports/' + $record.FileName)
            currency = $record.Currency
            unit = $record.Unit
            normalizedSource = [ordered]@{ currency = $record.Currency; unit = $record.Unit; values = $sourceValues }
            sourceValues = $sourceValues
            expectedLedgerValues = $normalized
            normalizedMillionJPY = $normalized
        })
}
$expected = [ordered]@{
    companies = $expectedCompanies.ToArray()
    grandTotals = $totals
}
Write-TextWithEncoding -Path (Join-Path $validationDir 'expected.json') -Lines @($expected | ConvertTo-Json -Depth 12) -Encoding $utf8Bom

function New-LedgerWorkbook {
    param([string]$Path)
    $ledgerRows = New-Object System.Collections.Generic.List[object]
    foreach ($record in ($records + @([pscustomobject]@{ Id = 'OS16'; Name = '架空OS子会社16'; FileName = ''; Format = ''; Currency = ''; Unit = ''; Values = [ordered]@{} }))) {
        $submitted = if ($record.Id -eq 'OS16') { '未提出' } else { '提出済' }
        $row = [ordered]@{
            '会社ID' = $record.Id
            '会社名' = $record.Name
            '提出状況' = $submitted
            '前期売上高（百万円）' = ''
            '前期営業利益（百万円）' = ''
            '前期純利益（百万円）' = ''
            '前期総資産（百万円）' = ''
            '前期従業員数（人）' = ''
            # These seven current-period headers are the stable interface consumed by C.
            '売上高（百万円）' = ''
            '営業利益（百万円）' = ''
            '当期純利益（百万円）' = ''
            '総資産（百万円）' = ''
            '従業員数（人）' = ''
            '差異売上高' = ''
            '差異営業利益' = ''
            '差異純利益' = ''
            '差異総資産' = ''
            '差異従業員数' = ''
        }
        $ledgerRows.Add([pscustomobject]$row)
    }
    # .ToArray() is intentional: Export-Excel handles a concrete object[] in PS5.1.
    Export-Excel -Path $Path -WorksheetName '連結台帳' -InputObject $ledgerRows.ToArray() -StartRow 3 -TableName 'RenketsuDemoLedger' -TableStyle Medium2 -AutoSize -ClearSheet
    $package = Open-ExcelPackage -Path $Path
    $sheet = $package.Workbook.Worksheets['連結台帳']
    $sheet.Cells['A1:R1'].Merge = $true
    $sheet.Cells['A1'].Value = '連結決算デモ台帳（当期入力待ち）'
    $sheet.Cells['A2'].Value = '単位: 金額は百万円JPY、従業員数は人。前期列は比較入力用。'
    $sheet.Cells['A1:R1'].Style.Font.Bold = $true
    $sheet.Cells['A1:R1'].Style.Font.Size = 14
    $sheet.Cells['A1:R1'].Style.HorizontalAlignment = [OfficeOpenXml.Style.ExcelHorizontalAlignment]::Center
    $sheet.Cells['A3:R3'].Style.Font.Bold = $true
    $sheet.Cells['A3:R3'].Style.WrapText = $true
    $sheet.Cells['A3:R3'].Style.Fill.PatternType = [OfficeOpenXml.Style.ExcelFillStyle]::Solid
    $sheet.Cells['A3:R3'].Style.Fill.BackgroundColor.SetColor([System.Drawing.Color]::FromArgb(31, 78, 121))
    $sheet.Cells['A3:R3'].Style.Font.Color.SetColor([System.Drawing.Color]::White)
    $firstDataRow = 4
    $lastDataRow = 23
    $totalRow = 24
    for ($rowNumber = $firstDataRow; $rowNumber -le $lastDataRow; $rowNumber++) {
        $sheet.Cells[('N' + $rowNumber)].Formula = ('IF(OR(D{0}="",I{0}=""),"",I{0}-D{0})' -f $rowNumber)
        $sheet.Cells[('O' + $rowNumber)].Formula = ('IF(OR(E{0}="",J{0}=""),"",J{0}-E{0})' -f $rowNumber)
        $sheet.Cells[('P' + $rowNumber)].Formula = ('IF(OR(F{0}="",K{0}=""),"",K{0}-F{0})' -f $rowNumber)
        $sheet.Cells[('Q' + $rowNumber)].Formula = ('IF(OR(G{0}="",L{0}=""),"",L{0}-G{0})' -f $rowNumber)
        $sheet.Cells[('R' + $rowNumber)].Formula = ('IF(OR(H{0}="",M{0}=""),"",M{0}-H{0})' -f $rowNumber)
    }
    $sheet.Cells['A24'].Value = '合計'
    foreach ($column in @('D','E','F','G','H','I','J','K','L','M','N','O','P','Q','R')) {
        $sheet.Cells[($column + '24')].Formula = ('SUM({0}4:{0}23)' -f $column)
    }
    $sheet.Cells['A24:R24'].Style.Font.Bold = $true
    $sheet.Cells['A24:R24'].Style.Fill.PatternType = [OfficeOpenXml.Style.ExcelFillStyle]::Solid
    $sheet.Cells['A24:R24'].Style.Fill.BackgroundColor.SetColor([System.Drawing.Color]::FromArgb(221, 235, 247))
    $sheet.View.FreezePanes(4, 1)
    $sheet.Cells['D4:R24'].Style.Numberformat.Format = '#,##0.00'
    $sheet.Cells['H4:H24'].Style.Numberformat.Format = '#,##0'
    $sheet.Cells['M4:M24'].Style.Numberformat.Format = '#,##0'
    $sheet.Cells['R4:R24'].Style.Numberformat.Format = '#,##0'
    if ($null -eq $package.Workbook.Worksheets['確認事項']) {
        $confirm = $package.Workbook.Worksheets.Add('確認事項')
        $confirm.Cells['A1'].Value = '確認事項（入力担当記入欄）'
        $confirm.Cells['A2'].Value = '例: 単位確認、出典ファイル、差異理由、レビュー担当'
        $confirm.Cells['A1:A2'].Style.Font.Bold = $true
        $confirm.Column(1).Width = 70
    }
    Close-ExcelPackage $package
}

if ($importExcelReady) {
    New-LedgerWorkbook -Path (Join-Path $workspace '集計台帳.xlsx')
    Write-Host ('Generated ledger workbook: {0}' -f (Join-Path $workspace '集計台帳.xlsx'))
}
else {
    Write-Warning '集計台帳.xlsx was not generated because ImportExcel is unavailable. Re-run after vendor/ImportExcel/7.8.10 is populated.'
}

Write-Host ('Generated {0} submitted source files, extracted.correct.json, expected.json, and rates.' -f $records.Count)
