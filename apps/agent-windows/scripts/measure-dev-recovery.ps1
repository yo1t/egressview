param(
    [Parameter(Mandatory = $true)] [string] $Output,
    [string] $InstallRoot = 'C:\Program Files\EgressView Agent Dev'
)

$ErrorActionPreference = 'Stop'
$serviceName = 'EgressViewAgent'
$binary = Join-Path $InstallRoot 'EgressView.Agent.Service.exe'
$database = Join-Path $InstallRoot 'data\egressview-agent.db'

function Get-ServiceProcessId {
    return [int](Get-CimInstance Win32_Service -Filter "Name='$serviceName'").ProcessId
}

function Inspect-Database {
    $text = (& $binary --inspect --data $database | Out-String)
    if ($LASTEXITCODE -ne 0) { throw "inspect failed: $LASTEXITCODE" }
    return ($text | ConvertFrom-Json)
}

$beforePid = Get-ServiceProcessId
if ($beforePid -le 0) { throw 'service is not running before recovery measurement' }
$before = Inspect-Database

Stop-Process -Id $beforePid -Force
$deadline = [DateTime]::UtcNow.AddSeconds(30)
do {
    Start-Sleep -Milliseconds 500
    $afterPid = Get-ServiceProcessId
} while (($afterPid -le 0 -or $afterPid -eq $beforePid) -and [DateTime]::UtcNow -lt $deadline)
if ($afterPid -le 0 -or $afterPid -eq $beforePid) { throw 'service did not recover with a new PID' }

Start-Sleep -Seconds 10
$after = Inspect-Database
[pscustomobject]@{
    measuredAt = [DateTimeOffset]::UtcNow
    beforePid = $beforePid
    afterPid = $afterPid
    beforeCount = $before.database.observationCount
    afterCount = $after.database.observationCount
    beforeIntegrity = $before.database.integrity
    afterIntegrity = $after.database.integrity
    serviceStatus = (Get-Service $serviceName).Status.ToString()
} | ConvertTo-Json | Set-Content -LiteralPath $Output -Encoding UTF8
