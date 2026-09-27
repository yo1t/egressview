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
# Both are built from the same sources and both have now been installed and
# run: x64 throughout development, win-arm64 on Windows 11 on ARM as of
# 0.1.104. Building for ARM rather than leaving it to x64 emulation matters
# more here than in most programs -- the hot path is parsing ETW callbacks,
# which is the last thing worth emulating.
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

# One version names one build.
#
# Windows Installer decides whether to replace a file by comparing its version,
# and every payload here carries the package version. Build twice under one
# number and install the second over the first, and msiexec returns 0 having
# replaced nothing: the machine goes on running the first build while every
# check that reads the version reports the second.
#
# That happened twice on 2026-09-23. 0.1.117 existed as two different builds,
# one of them published; and 0.1.118 was rebuilt with a fix, installed, and
# found thirty-four minutes later still running the code without it.
#
# Refused here, before anything is built, because this is the cheapest place
# to find out and the only one that sees both builds.
$msiName = "EgressView-Agent-Windows-$Version-$arch-unsigned.msi"
$existingMsi = Join-Path $outputPath $msiName
if (Test-Path -LiteralPath $existingMsi) {
    throw ("$msiName already exists in $outputPath, so this build would be a second, different build " +
        "under the same version. Raise the version. If that file was never installed on any machine and never " +
        "published, delete it yourself and build again -- a deliberate act, not something this script decides.")
}
# And a version that was withdrawn is not built again. The publisher refuses
# it too; finding out here costs seconds instead of a build.
$withdrawnList = Join-Path $agentRoot '..\..\release-signing\withdrawn-agent-releases.json'
if (Test-Path -LiteralPath $withdrawnList) {
    $withdrawn = (Get-Content -LiteralPath $withdrawnList -Raw | ConvertFrom-Json).releases |
        Where-Object { $_.platform -eq 'windows' -and $_.version -eq $Version } | Select-Object -First 1
    if ($withdrawn) {
        throw "windows $Version is withdrawn and cannot be built again: $($withdrawn.reason) Superseded by $($withdrawn.supersededBy)."
    }
}

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

# One MSI that speaks the language Windows does.
#
# It is built twice, in English and in Japanese; the difference is written as
# a language transform and embedded in the English package under its language
# id, 1041, and the package is marked as offering both. Windows Installer then
# applies the transform itself when Windows's display language is Japanese:
# no second download, and no way to pick the wrong one. The installer's own
# words are in installer\Package.*.wxl; the dialogs come from WixToolset.UI.
$cultureRoot = Join-Path $installerObj 'cultures'
$builtByCulture = @{}
foreach ($culture in 'en-US', 'ja-JP') {
    $cultureOut = Join-Path $cultureRoot "out-$culture"
    dotnet build (Join-Path $agentRoot 'installer\EgressView.Agent.Installer.wixproj') -c Release `
        -p:ProductVersion=$Version `
        -p:ServicePublishDir=$servicePublish `
        -p:UiPublishDir=$uiPublish `
        -p:LicenseRtf=$licenseRtf `
        -p:PackageArch=$arch `
        -p:Cultures=$culture `
        -p:OutputPath="$cultureOut\" `
        -p:IntermediateOutputPath="$(Join-Path $cultureRoot "obj-$culture")\"
    if ($LASTEXITCODE -ne 0) { throw "MSI build failed ($culture): $LASTEXITCODE" }
    $built = Get-ChildItem -LiteralPath $cultureOut -Recurse -Filter $msiName | Select-Object -First 1
    if (-not $built) { throw "MSI was not produced for $culture under $cultureOut" }
    $builtByCulture[$culture] = $built.FullName
}

[xml]$installerProject = Get-Content -LiteralPath (Join-Path $agentRoot 'installer\EgressView.Agent.Installer.wixproj')
$wixVersion = ($installerProject.Project.Sdk -split '/')[1]
$nugetRoot = if ($env:NUGET_PACKAGES) { $env:NUGET_PACKAGES } else { Join-Path $env:USERPROFILE '.nuget\packages' }
$hostArch = if ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -eq 'Arm64') { 'arm64' } else { 'x64' }
$wix = Join-Path $nugetRoot "wixtoolset.sdk\$wixVersion\tools\net472\$hostArch\wix.exe"
if (-not (Test-Path -LiteralPath $wix -PathType Leaf)) { throw "wix.exe not found at $wix" }
$transform = Join-Path $cultureRoot '1041.mst'
& $wix msi transform -t language $builtByCulture['en-US'] $builtByCulture['ja-JP'] -out $transform -intermediateFolder (Join-Path $cultureRoot 'transform')
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $transform -PathType Leaf)) { throw "Language transform failed: $LASTEXITCODE" }

$msi = Join-Path $outputPath $msiName
New-Item -ItemType Directory -Force -Path $outputPath | Out-Null
Copy-Item -LiteralPath $builtByCulture['en-US'] -Destination $msi
$windowsInstaller = New-Object -ComObject WindowsInstaller.Installer
$database = $windowsInstaller.OpenDatabase($msi, 1)
$storages = $database.OpenView('SELECT `Name`,`Data` FROM _Storages')
$storages.Execute($null)
$record = $windowsInstaller.CreateRecord(2)
$record.StringData(1) = '1041'
$record.SetStream(2, $transform)
$storages.Modify(3, $record)
$storages.Close()
$summary = $database.SummaryInformation(4)
$template = [string]$summary.Property(7)
if ($template -notmatch ';1033$') { throw "Unexpected package template: $template" }
$summary.Property(7) = "$template,1041"
$summary.Persist()
$database.Commit()
[void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($summary)
[void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($storages)
[void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($database)
[System.GC]::Collect(); [System.GC]::WaitForPendingFinalizers()

# Read it back: a package that claims Japanese without carrying it would open
# in English on a Japanese PC and nobody would be told.
$check = $windowsInstaller.OpenDatabase($msi, 0)
$checkTemplate = [string]$check.SummaryInformation(0).Property(7)
$view = $check.OpenView("SELECT ``Name`` FROM _Storages WHERE ``Name``='1041'")
$view.Execute($null)
$embedded = $null -ne $view.Fetch()
$view.Close()
[void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($view)
[void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($check)
[System.GC]::Collect(); [System.GC]::WaitForPendingFinalizers()
if (-not $embedded -or $checkTemplate -notmatch ';1033,1041$') { throw "Japanese transform not embedded: template '$checkTemplate', embedded $embedded" }
"languages: $checkTemplate (Japanese applied by Windows Installer on a Japanese display language)"
Get-FileHash -Algorithm SHA256 -LiteralPath $msi | Select-Object Path, Hash
