param(
    [string] $Version = '0.1.0',
    [string] $Runtime = 'win-x64',
    [string] $Output = (Join-Path $PSScriptRoot '..\artifacts\windows')
)

$ErrorActionPreference = 'Stop'
$agentRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$publishRoot = Join-Path $agentRoot ".publish-msi-$Runtime"
$servicePublish = Join-Path $publishRoot 'service'
$uiPublish = Join-Path $publishRoot 'ui'
$licenseRtf = Join-Path $publishRoot 'license.rtf'
$outputPath = [System.IO.Path]::GetFullPath($Output)

if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw "Version must be numeric major.minor.patch: $Version" }
# win-x64 is the one this project has been measured on. win-arm64 builds
# from the same sources and is offered so an ARM machine has something to
# install at all -- the alternative is emulating x64, which is the worst place
# to put a collector whose hot path is parsing ETW callbacks. It has not been
# run on ARM hardware here; the release notes say so.
$arch = switch ($Runtime) {
    'win-x64'   { 'x64' }
    'win-arm64' { 'arm64' }
    default     { throw "Supported runtimes are win-x64 and win-arm64: $Runtime" }
}
$parsedVersion = [version]$Version
# Early development builds shipped with the .NET default 1.0.0.0. A direct
# 0.1.x.0 file version would compare lower and could never replace them. Keep
# the public semver in ProductVersion and map it monotonically above that
# legacy floor for Windows Installer's four-part numeric comparison.
$payloadFileVersion = "1.$($parsedVersion.Major).$($parsedVersion.Minor).$($parsedVersion.Build)"

New-Item -ItemType Directory -Force -Path $servicePublish, $uiPublish, $outputPath | Out-Null
$licenseText = Get-Content -LiteralPath (Join-Path $agentRoot '..\..\LICENSE') -Raw
$licenseBody = $licenseText.Replace('\', '\\').Replace('{', '\{').Replace('}', '\}') `
    -replace "`r?`n", "\par`r`n"
$licenseDocument = "{\rtf1\ansi\deff0{\fonttbl{\f0 Segoe UI;}}\fs18`r`n$licenseBody`r`n}"
Set-Content -LiteralPath $licenseRtf -Value $licenseDocument -Encoding ascii
dotnet publish (Join-Path $agentRoot 'src\EgressView.Agent.Service\EgressView.Agent.Service.csproj') `
    -c Release -r $Runtime --self-contained true -o $servicePublish `
    -p:Version=$Version -p:FileVersion=$payloadFileVersion
if ($LASTEXITCODE -ne 0) { throw "Service publish failed: $LASTEXITCODE" }
dotnet publish (Join-Path $agentRoot 'src\EgressView.Agent.Ui\EgressView.Agent.Ui.csproj') `
    -c Release -r $Runtime --self-contained true -o $uiPublish `
    -p:Version=$Version -p:FileVersion=$payloadFileVersion
if ($LASTEXITCODE -ne 0) { throw "UI publish failed: $LASTEXITCODE" }

# Windows Installer compares the numeric file version before replacing a
# versioned file. If the MSI version advances while these remain at the .NET
# default 1.0.0.0, a successful major upgrade can leave the previous Agent
# binaries in place as "an equal version". Refuse to package that split state.
foreach ($publishedExe in @(
    (Join-Path $servicePublish 'EgressView.Agent.Service.exe'),
    (Join-Path $uiPublish 'EgressView.Agent.Ui.exe')
)) {
    $actualVersion = (Get-Item -LiteralPath $publishedExe).VersionInfo.FileVersion
    $expectedVersion = $payloadFileVersion
    if ($actualVersion -ne $expectedVersion) {
        throw "Published file version mismatch: $publishedExe is $actualVersion, expected $expectedVersion"
    }
}

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
    -p:PackageArch=$arch `
    -p:OutputPath=$outputPath
if ($LASTEXITCODE -ne 0) { throw "MSI build failed: $LASTEXITCODE" }

$msi = Join-Path $outputPath "EgressView-Agent-Windows-$Version-$arch-unsigned.msi"
if (-not (Test-Path -LiteralPath $msi -PathType Leaf)) { throw "MSI was not produced: $msi" }
Get-FileHash -Algorithm SHA256 -LiteralPath $msi | Select-Object Path, Hash
