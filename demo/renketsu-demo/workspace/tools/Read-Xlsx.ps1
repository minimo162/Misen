[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [Alias('FullName')]
    [string[]]$Path,

    [Parameter(Position = 1)]
    [string]$ImportExcelPath
)

$ErrorActionPreference = 'Stop'
$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $scriptRoot 'lib\Common.ps1')

function Resolve-RenketsuWorkbookPaths {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string[]]$InputPath)

    $found = New-Object System.Collections.Generic.List[string]
    foreach ($inputItem in $InputPath) {
        if ([string]::IsNullOrWhiteSpace($inputItem)) {
            throw 'Workbook path must not be empty.'
        }
        $hasWildcard = $inputItem.IndexOfAny([char[]]'*?[') -ge 0
        if ($hasWildcard) {
            $items = @(Get-ChildItem -Path $inputItem -File -ErrorAction Stop | Where-Object { $_.Extension -ieq '.xlsx' } | Sort-Object FullName)
            if ($null -eq $items -or $items.Count -eq 0) {
                throw "No .xlsx workbooks matched: $inputItem"
            }
            foreach ($item in $items) {
                $full = $item.FullName
                if (-not $found.Contains($full)) {
                    $null = $found.Add($full)
                }
            }
        }
        else {
            $resolved = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($inputItem)
            if (-not (Test-Path -LiteralPath $resolved -PathType Leaf)) {
                throw "Workbook was not found: $inputItem"
            }
            if ([System.IO.Path]::GetExtension($resolved) -notmatch '^\.xlsx$') {
                throw "Only .xlsx workbooks are supported: $inputItem"
            }
            $full = (Resolve-Path -LiteralPath $resolved).ProviderPath
            if (-not $found.Contains($full)) {
                $null = $found.Add($full)
            }
        }
    }
    if ($found.Count -eq 0) {
        throw 'No workbook paths were supplied.'
    }
    if ($found.Count -gt 32) {
        throw 'A single Read-Xlsx call may read at most 32 workbooks.'
    }
    return ($found.ToArray() | Sort-Object)
}

function Read-RenketsuWorkbook {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$WorkbookPath)

    $package = $null
    try {
        $previousWarningPreference = $WarningPreference
        $WarningPreference = 'SilentlyContinue'
        try {
            $package = Open-ExcelPackage -Path $WorkbookPath
        }
        finally {
            $WarningPreference = $previousWarningPreference
        }
        if ($null -eq $package) {
            throw "Could not open workbook: $WorkbookPath"
        }

        $sheetResults = New-Object System.Collections.Generic.List[object]
        foreach ($sheet in $package.Workbook.Worksheets) {
            $rows = New-Object System.Collections.Generic.List[object]
            $textRows = New-Object System.Collections.Generic.List[string]
            $truncated = $false
            $rangeText = $null
            $endRow = 0
            $endColumn = 0
            if ($null -ne $sheet.Dimension) {
                $endRow = [int]$sheet.Dimension.End.Row
                $endColumn = [int]$sheet.Dimension.End.Column
                $rangeText = [string]$sheet.Dimension.Address
            }

            $rowLimit = [Math]::Min($endRow, 5000)
            $columnLimit = [Math]::Min($endColumn, 100)
            if ($rowLimit -lt $endRow -or $columnLimit -lt $endColumn) {
                $truncated = $true
            }

            if ($rowLimit -gt 0 -and $columnLimit -gt 0) {
                for ($row = 1; $row -le $rowLimit; $row++) {
                    $values = New-Object System.Collections.Generic.List[object]
                    $displayValues = New-Object System.Collections.Generic.List[string]
                    for ($column = 1; $column -le $columnLimit; $column++) {
                        $cell = $sheet.Cells[$row, $column]
                        if ($null -eq $cell.Value) {
                            $null = $values.Add($null)
                            $null = $displayValues.Add('')
                        }
                        else {
                            $value = $cell.Value
                            if ($value -is [datetime]) {
                                $null = $values.Add($value.ToString('o', [Globalization.CultureInfo]::InvariantCulture))
                            }
                            elseif ($value -is [string] -or $value -is [char]) {
                                $null = $values.Add([string]$value)
                            }
                            elseif ($value -is [OfficeOpenXml.ExcelErrorValue]) {
                                $null = $values.Add((Get-RenketsuCellText -Cell $cell))
                            }
                            else {
                                $null = $values.Add($value)
                            }
                            $null = $displayValues.Add((Get-RenketsuCellText -Cell $cell))
                        }
                    }
                    $null = $rows.Add($values.ToArray())
                    $null = $textRows.Add(($displayValues.ToArray() -join "`t"))
                }
            }

            $null = $sheetResults.Add([ordered]@{
                name = [string]$sheet.Name
                range = $rangeText
                rows = $rows.ToArray()
                text = ($textRows.ToArray() -join "`n")
                truncated = $truncated
            })
        }

        return [ordered]@{
            path = [System.IO.Path]::GetFullPath($WorkbookPath)
            sheets = $sheetResults.ToArray()
        }
    }
    finally {
        if ($null -ne $package) {
            $package.Dispose()
        }
    }
}

try {
    $resolvedPaths = Resolve-RenketsuWorkbookPaths -InputPath $Path
    $workspacePath = Split-Path -Parent $scriptRoot
    $defaultImportExcelPath = Join-Path $workspacePath 'vendor\ImportExcel\7.8.10'
    $null = Import-RenketsuExcelModule -ImportExcelPath $ImportExcelPath -DefaultPath $defaultImportExcelPath

    $workbooks = New-Object System.Collections.Generic.List[object]
    foreach ($resolvedPath in $resolvedPaths) {
        $null = $workbooks.Add((Read-RenketsuWorkbook -WorkbookPath $resolvedPath))
    }

    $payload = [ordered]@{
        ok = $true
        workbooks = $workbooks.ToArray()
    }
    if ($workbooks.Count -eq 1) {
        $payload['workbook'] = $workbooks[0].path
        $payload['sheets'] = $workbooks[0].sheets
    }
    Write-Output (ConvertTo-RenketsuJsonLine -InputObject $payload)
}
catch {
    Write-RenketsuError -Message $_.Exception.Message -Code 'read_xlsx_failed'
}
