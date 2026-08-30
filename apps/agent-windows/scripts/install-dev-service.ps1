param(
    [Parameter(Mandatory = $true)] [string] $Source,
    [Parameter(Mandatory = $true)] [string] $UiSource,
    [string] $Destination = 'C:\Program Files\EgressView Agent Dev',
    [string] $AllowedUserSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value,
    [switch] $DisableUiAutoStart,
    [string] $Log
)

$ErrorActionPreference = 'Stop'
if ($Log) { Start-Transcript -LiteralPath $Log -Force | Out-Null }
try {
$serviceName = 'EgressViewAgent'
$eventSource = 'EgressViewAgent'
$sourcePath = (Resolve-Path -LiteralPath $Source).Path
$uiSourcePath = (Resolve-Path -LiteralPath $UiSource).Path
$destinationPath = [System.IO.Path]::GetFullPath($Destination)
$allowedRoot = 'C:\Program Files\EgressView Agent Dev'
if (-not ($destinationPath.Equals($allowedRoot, [StringComparison]::OrdinalIgnoreCase) -or
          $destinationPath.StartsWith($allowedRoot + [System.IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase))) {
    throw "Refusing destination outside the development service directory: $destinationPath"
}
$sid = [System.Security.Principal.SecurityIdentifier]::new($AllowedUserSid)
if (-not $sid.AccountDomainSid -or
    $sid.IsWellKnown([System.Security.Principal.WellKnownSidType]::LocalSystemSid) -or
    $sid.IsWellKnown([System.Security.Principal.WellKnownSidType]::LocalServiceSid) -or
    $sid.IsWellKnown([System.Security.Principal.WellKnownSidType]::NetworkServiceSid)) {
    throw "AllowedUserSid must identify an interactive user account: $AllowedUserSid"
}
$currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
if (-not $DisableUiAutoStart -and $currentSid -ne $AllowedUserSid) {
    throw "Cannot register UI auto-start in another user's HKCU. Run as the UI user or use -DisableUiAutoStart."
}
$serviceBinarySource = Join-Path $sourcePath 'EgressView.Agent.Service.exe'
$uiBinarySource = Join-Path $uiSourcePath 'EgressView.Agent.Ui.exe'
if (-not (Test-Path -LiteralPath $serviceBinarySource -PathType Leaf)) { throw "Service executable not found: $serviceBinarySource" }
if (-not (Test-Path -LiteralPath $uiBinarySource -PathType Leaf)) { throw "UI executable not found: $uiBinarySource" }

$existing = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
if (-not [System.Diagnostics.EventLog]::SourceExists($eventSource)) {
    New-EventLog -LogName Application -Source $eventSource
}
$registry = 'HKLM:\SOFTWARE\EgressView\Agent'
New-Item -Path $registry -Force | Out-Null
New-ItemProperty -Path $registry -Name AllowedUserSid -Value $AllowedUserSid -PropertyType String -Force | Out-Null
if ($existing) {
    Stop-Service -Name $serviceName -Force -ErrorAction SilentlyContinue
    $existing.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(20))
}

New-Item -ItemType Directory -Path $destinationPath -Force | Out-Null
$uiPath = Join-Path $destinationPath 'ui'
$installedUi = Join-Path $uiPath 'EgressView.Agent.Ui.exe'
if (Test-Path -LiteralPath $installedUi -PathType Leaf) {
    & $installedUi --exit-ui
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    do {
        $runningUi = Get-Process -Name 'EgressView.Agent.Ui' -ErrorAction SilentlyContinue |
            Where-Object { $_.Path -and $_.Path.Equals($installedUi, [StringComparison]::OrdinalIgnoreCase) }
        if (-not $runningUi) { break }
        Start-Sleep -Milliseconds 200
    } while ([DateTime]::UtcNow -lt $deadline)
    if ($runningUi) { throw 'The running EgressView UI did not exit; installation stopped without overwriting it.' }
}
Copy-Item -Path (Join-Path $sourcePath '*') -Destination $destinationPath -Recurse -Force
$null = New-Item -ItemType Directory -Path $uiPath -Force
Copy-Item -Path (Join-Path $uiSourcePath '*') -Destination $uiPath -Recurse -Force
$dataPath = Join-Path $destinationPath 'data'
New-Item -ItemType Directory -Path $dataPath -Force | Out-Null

# Remove inherited user-writable permissions from service-owned state. SIDs avoid localized account names.
& icacls.exe $dataPath /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-19:(OI)(CI)M' | Out-Null
if ($LASTEXITCODE -ne 0) { throw "icacls failed: $LASTEXITCODE" }

$binary = Join-Path $destinationPath 'EgressView.Agent.Service.exe'
if (-not $existing) {
    & sc.exe create $serviceName 'binPath=' "`"$binary`"" 'start=' 'demand' 'obj=' 'NT AUTHORITY\LocalService' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "sc create failed: $LASTEXITCODE" }
} else {
    & sc.exe config $serviceName 'binPath=' "`"$binary`"" 'start=' 'demand' 'obj=' 'NT AUTHORITY\LocalService' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "sc config failed: $LASTEXITCODE" }
}

& sc.exe failure $serviceName 'reset=' '86400' 'actions=' 'restart/3000/restart/10000/restart/30000' | Out-Null
if ($LASTEXITCODE -ne 0) { throw "sc failure failed: $LASTEXITCODE" }
& sc.exe failureflag $serviceName '1' | Out-Null
if ($LASTEXITCODE -ne 0) { throw "sc failureflag failed: $LASTEXITCODE" }

Start-Service -Name $serviceName
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$runName = 'EgressView Agent'
if ($DisableUiAutoStart) {
    Remove-ItemProperty -Path $runKey -Name $runName -ErrorAction SilentlyContinue
} else {
    New-Item -Path $runKey -Force | Out-Null
    New-ItemProperty -Path $runKey -Name $runName -Value ('"{0}"' -f $installedUi) -PropertyType String -Force | Out-Null
}
(Get-Service -Name $serviceName) | Select-Object Name, Status, StartType,
    @{ Name = 'AllowedUserSid'; Expression = { $AllowedUserSid } },
    @{ Name = 'UiPath'; Expression = { $installedUi } },
    @{ Name = 'UiAutoStart'; Expression = { -not $DisableUiAutoStart } }
} catch {
    if ($Log) { ($_ | Out-String) | Set-Content -LiteralPath "$Log.error" }
    throw
} finally {
    if ($Log) { Stop-Transcript | Out-Null }
}
