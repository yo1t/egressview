param(
    [Parameter(Mandatory = $true)] [string] $Source,
    [string] $Destination = 'C:\Program Files\EgressView Agent Dev',
    [string] $AllowedUserSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value,
    [string] $Log
)

$ErrorActionPreference = 'Stop'
if ($Log) { Start-Transcript -LiteralPath $Log -Force | Out-Null }
try {
$serviceName = 'EgressViewAgent'
$eventSource = 'EgressViewAgent'
$sourcePath = (Resolve-Path -LiteralPath $Source).Path
$destinationPath = [System.IO.Path]::GetFullPath($Destination)
if (-not $destinationPath.StartsWith('C:\Program Files\EgressView Agent Dev', [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing destination outside the development service directory: $destinationPath"
}

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
Copy-Item -Path (Join-Path $sourcePath '*') -Destination $destinationPath -Recurse -Force
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
(Get-Service -Name $serviceName) | Select-Object Name, Status, StartType
} catch {
    if ($Log) { ($_ | Out-String) | Set-Content -LiteralPath "$Log.error" }
    throw
} finally {
    if ($Log) { Stop-Transcript | Out-Null }
}
