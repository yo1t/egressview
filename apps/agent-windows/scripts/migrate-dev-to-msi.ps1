param(
    [Parameter(Mandatory = $true)] [string] $MsiPath,
    [Parameter(Mandatory = $true)] [string] $ExpectedUserSid
)

$ErrorActionPreference = 'Stop'
$serviceName = 'EgressViewAgent'
$devRoot = 'C:\Program Files\EgressView Agent Dev'
$msiRoot = 'C:\Program Files\EgressView Agent'
$devService = Join-Path $devRoot 'EgressView.Agent.Service.exe'
$devUi = Join-Path $devRoot 'ui\EgressView.Agent.Ui.exe'
$msiService = Join-Path $msiRoot 'service\EgressView.Agent.Service.exe'
$msiUi = Join-Path $msiRoot 'ui\EgressView.Agent.Ui.exe'
$msiData = Join-Path $msiRoot 'service\data'
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [System.Security.Principal.WindowsPrincipal] $identity

if (-not $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run this migration from an elevated PowerShell session.'
}
$expectedSid = [System.Security.Principal.SecurityIdentifier]::new($ExpectedUserSid)
if ($identity.User.Value -ne $expectedSid.Value) {
    throw "Elevated identity SID does not match the intended UI user: $($identity.User.Value)"
}
$resolvedMsi = (Resolve-Path -LiteralPath $MsiPath).Path
if ([System.IO.Path]::GetExtension($resolvedMsi) -ne '.msi') { throw "Not an MSI file: $resolvedMsi" }

$service = Get-CimInstance Win32_Service -Filter "Name='$serviceName'"
if (-not $service) { throw "The development service is not installed: $serviceName" }
$serviceBinary = $service.PathName.Trim('"')
if (-not $serviceBinary.Equals($devService, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to replace an unexpected service binary: $serviceBinary"
}
if (-not (Test-Path -LiteralPath $devService -PathType Leaf)) { throw "Development service binary is missing: $devService" }
if (Test-Path -LiteralPath $msiRoot) { throw "MSI destination already exists; refusing an ambiguous migration: $msiRoot" }

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupRoot = Join-Path 'C:\ProgramData\EgressView' "MigrationBackup-$stamp"
$backupData = Join-Path $backupRoot 'data'
$logPath = Join-Path $backupRoot 'msi-install.log'
New-Item -ItemType Directory -Path $backupData -Force | Out-Null

$registry = Get-ItemProperty 'HKLM:\SOFTWARE\EgressView\Agent' -ErrorAction SilentlyContinue
$existingAutoStart = (Get-ItemProperty $runKey -ErrorAction SilentlyContinue).'EgressView Agent'
@(
    "CapturedAt=$([DateTimeOffset]::UtcNow.ToString('O'))"
    "ServicePath=$serviceBinary"
    "StartMode=$($service.StartMode)"
    "StartName=$($service.StartName)"
    "AllowedUserSid=$($registry.AllowedUserSid)"
    "UserAutoStart=$existingAutoStart"
) | Set-Content -LiteralPath (Join-Path $backupRoot 'migration-state.txt') -Encoding utf8

if (Test-Path -LiteralPath $devUi -PathType Leaf) {
    & $devUi --exit-ui
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    do {
        $runningUi = Get-Process -Name 'EgressView.Agent.Ui' -ErrorAction SilentlyContinue |
            Where-Object { $_.Path -and $_.Path.Equals($devUi, [StringComparison]::OrdinalIgnoreCase) }
        if (-not $runningUi) { break }
        Start-Sleep -Milliseconds 200
    } while ([DateTime]::UtcNow -lt $deadline)
    if ($runningUi) { throw 'The development UI did not exit; no Service change was made.' }
}

$windowsService = Get-Service -Name $serviceName
if ($windowsService.Status -ne 'Stopped') {
    Stop-Service -Name $serviceName -Force
    $windowsService.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(30))
}

$devData = Join-Path $devRoot 'data'
if (Test-Path -LiteralPath $devData -PathType Container) {
    Get-ChildItem -LiteralPath $devData -Force | Copy-Item -Destination $backupData -Recurse -Force
}

$deleted = $false
try {
    & sc.exe delete $serviceName | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Could not remove development Service registration: $LASTEXITCODE" }
    $deleted = $true
    $deadline = [DateTime]::UtcNow.AddSeconds(15)
    while ((Get-Service -Name $serviceName -ErrorAction SilentlyContinue) -and [DateTime]::UtcNow -lt $deadline) {
        Start-Sleep -Milliseconds 250
    }
    if (Get-Service -Name $serviceName -ErrorAction SilentlyContinue) { throw 'Development Service registration did not disappear.' }

    New-Item -ItemType Directory -Path $msiData -Force | Out-Null
    if (Test-Path -LiteralPath $devData -PathType Container) {
        Get-ChildItem -LiteralPath $devData -Force | Copy-Item -Destination $msiData -Recurse -Force
    }

    $arguments = @('/i', ('"{0}"' -f $resolvedMsi), '/qn', '/norestart', '/l*v', ('"{0}"' -f $logPath))
    $install = Start-Process msiexec.exe -ArgumentList $arguments -Wait -PassThru -WindowStyle Hidden
    if ($install.ExitCode -ne 0) { throw "MSI installation failed with exit code $($install.ExitCode). See $logPath" }

    $installed = Get-CimInstance Win32_Service -Filter "Name='$serviceName'"
    if (-not $installed -or -not $installed.PathName.Trim('"').Equals($msiService, [StringComparison]::OrdinalIgnoreCase)) {
        throw "MSI did not register the expected Service binary: $($installed.PathName)"
    }
    $installedRegistry = Get-ItemProperty 'HKLM:\SOFTWARE\EgressView\Agent'
    if ($installedRegistry.AllowedUserSid -ne $ExpectedUserSid) { throw 'MSI registered an unexpected UI user SID.' }
    if (-not (Test-Path -LiteralPath $msiUi -PathType Leaf)) { throw "MSI UI is missing: $msiUi" }
    $machineRunValue = (Get-ItemProperty 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Run').'EgressView Agent'
    if ($machineRunValue -ne ('"{0}"' -f $msiUi)) { throw "MSI registered an unexpected UI auto-start path: $machineRunValue" }
    if ((Get-Service -Name $serviceName).Status -ne 'Running') { Start-Service -Name $serviceName }
    if ($existingAutoStart -eq ('"{0}"' -f $devUi)) {
        Remove-ItemProperty -Path $runKey -Name 'EgressView Agent'
    }

    [pscustomobject]@{
        Result = 'Installed'
        Service = $serviceName
        Status = (Get-Service -Name $serviceName).Status
        StartMode = $installed.StartMode
        ServicePath = $installed.PathName
        UiPath = $msiUi
        BackupPath = $backupRoot
        MsiLog = $logPath
    } | Format-List
}
catch {
    if ($deleted -and -not (Get-Service -Name $serviceName -ErrorAction SilentlyContinue)) {
        & sc.exe create $serviceName "binPath=" "`"$devService`"" "start=" demand "obj=" 'NT AUTHORITY\LocalService' | Out-Null
        if ($LASTEXITCODE -eq 0) {
            & sc.exe failure $serviceName 'reset=' 86400 'actions=' 'restart/3000/restart/10000/restart/30000' | Out-Null
            Start-Service -Name $serviceName -ErrorAction SilentlyContinue
        }
    }
    throw
}
