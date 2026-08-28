[CmdletBinding()]
param(
    [string]$DestinationPath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$Arguments = @((Join-Path $PSScriptRoot 'package-release.mjs'))
if (-not [string]::IsNullOrWhiteSpace($DestinationPath)) {
    $Arguments += @('--output', $DestinationPath)
}
& node @Arguments
exit $LASTEXITCODE
