[CmdletBinding()]
param(
    [string] $ReportPath
)

$ErrorActionPreference = 'Stop'
$agentRoot = Split-Path -Parent $PSScriptRoot

if ($ReportPath) {
    $rawReport = Get-Content -LiteralPath $ReportPath -Raw
} else {
    $solution = Join-Path $agentRoot 'EgressViewAgent.Windows.slnx'
    $rawReport = & dotnet package list --project $solution --vulnerable --include-transitive --format json | Out-String
    if ($LASTEXITCODE -ne 0) {
        throw "NuGet vulnerability audit failed with exit code $LASTEXITCODE."
    }
}

try {
    $report = $rawReport | ConvertFrom-Json
} catch {
    throw "NuGet vulnerability audit returned invalid JSON: $($_.Exception.Message)"
}

$findings = @(
    foreach ($project in @($report.projects | Where-Object { $null -ne $_ })) {
        foreach ($framework in @($project.frameworks | Where-Object { $null -ne $_ })) {
            foreach ($groupName in @('topLevelPackages', 'transitivePackages')) {
                foreach ($package in @($framework.$groupName | Where-Object { $null -ne $_ })) {
                    foreach ($vulnerability in @($package.vulnerabilities | Where-Object { $null -ne $_ })) {
                        [pscustomobject]@{
                            Project = $project.path
                            Framework = $framework.framework
                            Package = $package.id
                            Version = $package.resolvedVersion
                            Severity = $vulnerability.severity
                            Advisory = $vulnerability.advisoryUrl
                        }
                    }
                }
            }
        }
    }
)

if ($findings.Count -gt 0) {
    $findings | Format-Table -AutoSize | Out-String | Write-Host
    throw "NuGet vulnerability audit found $($findings.Count) vulnerable package reference(s)."
}

Write-Host "NuGet vulnerability audit passed for $(@($report.projects).Count) Windows Agent projects (including transitive packages)."
