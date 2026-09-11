using System.Text;
using System.Text.RegularExpressions;

namespace EgressView.Agent.Core;

public static partial class UpdateRelaunchCommand
{
    public static string BuildEncodedPowerShell(int currentProcessId, string uiPath, string expectedProductVersion,
        TimeSpan timeout)
    {
        if (currentProcessId <= 0) throw new ArgumentOutOfRangeException(nameof(currentProcessId));
        if (!Path.IsPathFullyQualified(uiPath) || !string.Equals(Path.GetExtension(uiPath), ".exe", StringComparison.OrdinalIgnoreCase))
            throw new ArgumentException("The UI path must be a fully-qualified executable.", nameof(uiPath));
        if (!SafeVersion().IsMatch(expectedProductVersion))
            throw new ArgumentException("The expected product version is invalid.", nameof(expectedProductVersion));
        if (timeout < TimeSpan.FromMinutes(1) || timeout > TimeSpan.FromMinutes(30))
            throw new ArgumentOutOfRangeException(nameof(timeout));

        static string Quote(string value) => value.Replace("'", "''", StringComparison.Ordinal);
        var script = $$"""
            $ErrorActionPreference = 'SilentlyContinue'
            $oldProcessId = {{currentProcessId}}
            $uiPath = '{{Quote(uiPath)}}'
            $expectedVersion = '{{Quote(expectedProductVersion)}}'
            $deadline = [DateTime]::UtcNow.AddSeconds({{(int)timeout.TotalSeconds}})
            while ([DateTime]::UtcNow -lt $deadline) {
                if (Get-Process -Id $oldProcessId -ErrorAction SilentlyContinue) {
                    Start-Sleep -Milliseconds 500
                    continue
                }
                if (Test-Path -LiteralPath $uiPath -PathType Leaf) {
                    $actualVersion = [Diagnostics.FileVersionInfo]::GetVersionInfo($uiPath).ProductVersion
                    if ($actualVersion -and $actualVersion.StartsWith($expectedVersion, [StringComparison]::OrdinalIgnoreCase)) {
                        Start-Sleep -Seconds 2
                        Start-Process -FilePath $uiPath -ArgumentList '--tray'
                        exit 0
                    }
                }
                Start-Sleep -Seconds 1
            }
            exit 1
            """;
        return Convert.ToBase64String(Encoding.Unicode.GetBytes(script));
    }

    [GeneratedRegex(@"^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$", RegexOptions.CultureInvariant)]
    private static partial Regex SafeVersion();
}
