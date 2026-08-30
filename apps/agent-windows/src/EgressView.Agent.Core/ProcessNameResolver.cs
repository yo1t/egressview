using System.Diagnostics;

namespace EgressView.Agent.Core;

public static class ProcessNameResolver
{
    public static string? Resolve(int processId)
    {
        if (processId <= 0) return null;
        try
        {
            using var process = Process.GetProcessById(processId);
            var name = process.ProcessName;
            return string.IsNullOrWhiteSpace(name) || name.Length > 256 || name.Any(char.IsControl) ? null : name;
        }
        catch (Exception) { return null; }
    }
}
