using Microsoft.Win32;

namespace EgressView.Agent.Core;

/// <summary>
/// The maker and model of this PC as its firmware reports them, the same
/// values <c>Win32_ComputerSystem</c> shows, for the Hub's device list
/// (P3-199). Read from the registry so the Agent needs no WMI dependency.
/// </summary>
public static class WindowsHardware
{
    private const string BiosKey = @"HARDWARE\DESCRIPTION\System\BIOS";

    public static (string? Manufacturer, string? Model) Read()
    {
        try
        {
            using var key = Registry.LocalMachine.OpenSubKey(BiosKey, writable: false);
            return (Clean(key?.GetValue("SystemManufacturer") as string), Clean(key?.GetValue("SystemProductName") as string));
        }
        catch (Exception exception) when (exception is System.Security.SecurityException or UnauthorizedAccessException or IOException)
        {
            return (null, null);
        }
    }

    /// <summary>
    /// Trimmed, without control characters, at most 100 characters, and null
    /// for the placeholders board makers leave in unfilled firmware: a name
    /// that says nothing is worse in the device list than no name.
    /// </summary>
    public static string? Clean(string? value)
    {
        if (value is null) return null;
        var text = new string(value.Where(ch => !char.IsControl(ch)).ToArray()).Trim();
        if (text.Length == 0) return null;
        string[] placeholders = ["To Be Filled By O.E.M.", "System manufacturer", "System Product Name", "Default string", "O.E.M."];
        if (placeholders.Any(placeholder => string.Equals(text, placeholder, StringComparison.OrdinalIgnoreCase))) return null;
        return text.Length <= 100 ? text : text[..100];
    }
}
