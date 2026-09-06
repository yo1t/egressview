param(
    [string] $Version = '0.1.0',
    [string] $Runtime = 'win-x64',
    [string] $Output = (Join-Path $PSScriptRoot '..\artifacts\windows')
)

$ErrorActionPreference = 'Stop'
$agentRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$publishRoot = Join-Path $agentRoot '.publish-msi'
$servicePublish = Join-Path $publishRoot 'service'
$uiPublish = Join-Path $publishRoot 'ui'
$licenseRtf = Join-Path $publishRoot 'license.rtf'
$outputPath = [System.IO.Path]::GetFullPath($Output)

if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw "Version must be numeric major.minor.patch: $Version" }
if ($Runtime -ne 'win-x64') { throw "Only the verified win-x64 runtime is supported: $Runtime" }

New-Item -ItemType Directory -Force -Path $servicePublish, $uiPublish, $outputPath | Out-Null
$licenseText = Get-Content -LiteralPath (Join-Path $agentRoot '..\..\LICENSE') -Raw
$licenseBody = $licenseText.Replace('\', '\\').Replace('{', '\{').Replace('}', '\}') `
    -replace "`r?`n", "\par`r`n"
$licenseDocument = "{\rtf1\ansi\deff0{\fonttbl{\f0 Segoe UI;}}\fs18`r`n$licenseBody`r`n}"
Set-Content -LiteralPath $licenseRtf -Value $licenseDocument -Encoding ascii
dotnet publish (Join-Path $agentRoot 'src\EgressView.Agent.Service\EgressView.Agent.Service.csproj') `
    -c Release -r $Runtime --self-contained true -o $servicePublish
if ($LASTEXITCODE -ne 0) { throw "Service publish failed: $LASTEXITCODE" }
dotnet publish (Join-Path $agentRoot 'src\EgressView.Agent.Ui\EgressView.Agent.Ui.csproj') `
    -c Release -r $Runtime --self-contained true -o $uiPublish
if ($LASTEXITCODE -ne 0) { throw "UI publish failed: $LASTEXITCODE" }

# The output name carries the version, but the intermediate directory does
# not, so an incremental build of a new version judges itself up to date and
# then fails copying an MSI it never linked. Discarding it costs a few
# seconds and removes an error that reads like a WiX fault.
$installerObj = Join-Path $agentRoot 'installer\obj\Release'
if (Test-Path -LiteralPath $installerObj) { Remove-Item -LiteralPath $installerObj -Recurse -Force }
dotnet build (Join-Path $agentRoot 'installer\EgressView.Agent.Installer.wixproj') -c Release `
    -p:ProductVersion=$Version `
    -p:ServicePublishDir=$servicePublish `
    -p:UiPublishDir=$uiPublish `
    -p:LicenseRtf=$licenseRtf `
    -p:OutputPath=$outputPath
if ($LASTEXITCODE -ne 0) { throw "MSI build failed: $LASTEXITCODE" }

$msi = Join-Path $outputPath "EgressView-Agent-Windows-$Version-unsigned.msi"
if (-not (Test-Path -LiteralPath $msi -PathType Leaf)) { throw "MSI was not produced: $msi" }
Get-FileHash -Algorithm SHA256 -LiteralPath $msi | Select-Object Path, Hash
