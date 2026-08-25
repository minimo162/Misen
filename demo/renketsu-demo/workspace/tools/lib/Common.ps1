Set-StrictMode -Version 2.0

function Resolve-RenketsuImportExcelManifest {
    [CmdletBinding()]
    param(
        [string]$ImportExcelPath,
        [Parameter(Mandatory = $true)]
        [string]$DefaultPath
    )

    $paths = New-Object System.Collections.Generic.List[string]
    if (-not [string]::IsNullOrWhiteSpace($ImportExcelPath)) {
        $resolved = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($ImportExcelPath)
        $null = $paths.Add($resolved)
    }
    $null = $paths.Add($ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($DefaultPath))

    foreach ($candidate in $paths.ToArray()) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            if ([System.IO.Path]::GetFileName($candidate) -ieq 'ImportExcel.psd1') {
                return (Resolve-Path -LiteralPath $candidate).ProviderPath
            }
            continue
        }
        if (-not (Test-Path -LiteralPath $candidate -PathType Container)) {
            continue
        }
        $manifest = Join-Path $candidate 'ImportExcel.psd1'
        if (Test-Path -LiteralPath $manifest -PathType Leaf) {
            return (Resolve-Path -LiteralPath $manifest).ProviderPath
        }
        $nested = Get-ChildItem -LiteralPath $candidate -Filter 'ImportExcel.psd1' -File -Recurse -ErrorAction SilentlyContinue | Sort-Object FullName
        if ($nested) {
            return $nested[0].FullName
        }
    }
    throw 'ImportExcel.psd1 was not found in the vendored module path.'
}

function Import-RenketsuExcelModule {
    [CmdletBinding()]
    param(
        [string]$ImportExcelPath,
        [Parameter(Mandatory = $true)]
        [string]$DefaultPath
    )

    $manifest = Resolve-RenketsuImportExcelManifest -ImportExcelPath $ImportExcelPath -DefaultPath $DefaultPath
    $previousWarningPreference = $WarningPreference
    $WarningPreference = 'SilentlyContinue'
    try {
        $null = Import-Module -Name $manifest -Force -DisableNameChecking -ErrorAction Stop
    }
    finally {
        $WarningPreference = $previousWarningPreference
    }
    return $manifest
}

function ConvertTo-RenketsuJsonLine {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [object]$InputObject
    )

    $json = $InputObject | ConvertTo-Json -Compress -Depth 40
    return ($json -replace '[\r\n]+', '')
}

function Write-RenketsuError {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$Message,
        [string]$Code = 'error'
    )

    $safeMessage = ($Message -replace '[\r\n]+', ' ').Trim()
    if ($env:RENKETSU_TEST_THROW_ON_ERROR -eq '1') {
        throw ($Code + ': ' + $safeMessage)
    }
    $payload = [ordered]@{
        ok = $false
        error = $safeMessage
        code = $Code
    }
    Write-Output (ConvertTo-RenketsuJsonLine -InputObject $payload)
    exit 1
}

function Test-RenketsuPropertyExists {
    [CmdletBinding()]
    param(
        [object]$InputObject,
        [Parameter(Mandatory = $true)]
        [string]$Name
    )

    if ($null -eq $InputObject) {
        return $false
    }
    return ($null -ne $InputObject.PSObject.Properties[$Name])
}

function Get-RenketsuPropertyValue {
    [CmdletBinding()]
    param(
        [object]$InputObject,
        [Parameter(Mandatory = $true)]
        [string]$Name
    )

    if ($null -eq $InputObject) {
        return $null
    }
    $property = $InputObject.PSObject.Properties[$Name]
    if ($null -eq $property) {
        return $null
    }
    return $property.Value
}

function Get-RenketsuCellText {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [object]$Cell
    )

    if ($null -ne $Cell.Text -and -not [string]::IsNullOrEmpty([string]$Cell.Text)) {
        return [string]$Cell.Text
    }
    if ($null -eq $Cell.Value) {
        return ''
    }
    if ($Cell.Value -is [datetime]) {
        return $Cell.Value.ToString('o', [Globalization.CultureInfo]::InvariantCulture)
    }
    return [string]$Cell.Value
}

function ConvertTo-RenketsuDecimal {
    [CmdletBinding()]
    param(
        [object]$Value,
        [Parameter(Mandatory = $true)]
        [string]$FieldName,
        [switch]$AllowNull
    )

    if ($null -eq $Value) {
        if ($AllowNull) {
            return $null
        }
        throw "$FieldName is required and must be numeric."
    }
    $text = ([string]$Value).Trim()
    if ([string]::IsNullOrWhiteSpace($text)) {
        if ($AllowNull) {
            return $null
        }
        throw "$FieldName is required and must be numeric."
    }
    $number = [decimal]0
    $styles = [Globalization.NumberStyles]::Float -bor [Globalization.NumberStyles]::AllowThousands
    $normalized = $text.Replace(' ', '').Replace(',', '')
    if ([decimal]::TryParse($normalized, $styles, [Globalization.CultureInfo]::InvariantCulture, [ref]$number)) {
        return $number
    }
    throw "$FieldName must be numeric: $text"
}

function Get-RenketsuIssueKind {
    [CmdletBinding()]
    param([object]$Issue)

    $typeValue = Get-RenketsuPropertyValue -InputObject $Issue -Name 'type'
    if ($null -eq $typeValue) {
        return ''
    }
    $typeText = ([string]$typeValue).Trim().ToLowerInvariant()
    if ($typeText -match 'unit') {
        return 'unit'
    }
    if ($typeText -match 'account') {
        return 'account'
    }
    return ''
}

function Get-RenketsuIssueField {
    [CmdletBinding()]
    param([object]$Issue)

    $field = Get-RenketsuPropertyValue -InputObject $Issue -Name 'field'
    if ($null -eq $field) {
        $field = Get-RenketsuPropertyValue -InputObject $Issue -Name 'account'
    }
    if ($null -eq $field) {
        return ''
    }
    return [string]$field
}

function Get-RenketsuIssueMessage {
    [CmdletBinding()]
    param([object]$Issue)

    $message = Get-RenketsuPropertyValue -InputObject $Issue -Name 'message'
    if ($null -eq $message) {
        $message = Get-RenketsuPropertyValue -InputObject $Issue -Name 'reason'
    }
    if ($null -eq $message) {
        return ''
    }
    return [string]$message
}

function Get-RenketsuIssueQuote {
    [CmdletBinding()]
    param([object]$Issue)

    $quote = Get-RenketsuPropertyValue -InputObject $Issue -Name 'quote'
    if ($null -eq $quote) {
        $quote = Get-RenketsuPropertyValue -InputObject $Issue -Name 'exactQuote'
    }
    if ($null -eq $quote) {
        return ''
    }
    return [string]$quote
}
