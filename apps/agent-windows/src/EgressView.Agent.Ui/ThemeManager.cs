using System.Windows;
using System.Windows.Media;
using Microsoft.Win32;

namespace EgressView.Agent.Ui;

internal static class ThemeManager
{
    private const string PersonalizeKey = @"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize";

    internal static void ApplySystemTheme(ResourceDictionary resources)
    {
        var dark = false;
        try
        {
            using var key = Registry.CurrentUser.OpenSubKey(PersonalizeKey);
            dark = key?.GetValue("AppsUseLightTheme") is int value && value == 0;
        }
        catch
        {
            // Windows defaults to the light app theme. Theme detection must
            // never prevent the monitoring UI from opening.
        }

        var palette = dark
            ? new Dictionary<string, string>
            {
                ["AppBackgroundBrush"] = "#202020",
                ["SurfaceBrush"] = "#2C2C2C",
                ["SurfaceSecondaryBrush"] = "#323232",
                ["TextPrimaryBrush"] = "#FFFFFF",
                ["TextSecondaryBrush"] = "#C7C7C7",
                ["StrokeBrush"] = "#3D3D3D",
                ["AccentBrush"] = "#60CDFF",
                ["AccentHoverBrush"] = "#7CD7FF",
                ["AccentPressedBrush"] = "#4CC2FF",
                ["AccentSoftBrush"] = "#14364A",
                ["PrimaryButtonTextBrush"] = "#00131F",
                ["SuccessBrush"] = "#6CCB5F",
                ["SuccessSoftBrush"] = "#18351B",
                ["ErrorBrush"] = "#FF99A4",
                ["ErrorSoftBrush"] = "#442326",
            }
            : new Dictionary<string, string>
            {
                ["AppBackgroundBrush"] = "#F3F3F3",
                ["SurfaceBrush"] = "#FFFFFF",
                ["SurfaceSecondaryBrush"] = "#F9F9F9",
                ["TextPrimaryBrush"] = "#1A1A1A",
                ["TextSecondaryBrush"] = "#616161",
                ["StrokeBrush"] = "#E5E5E5",
                ["AccentBrush"] = "#0067C0",
                ["AccentHoverBrush"] = "#005A9E",
                ["AccentPressedBrush"] = "#004578",
                ["AccentSoftBrush"] = "#E5F1FB",
                ["PrimaryButtonTextBrush"] = "#FFFFFF",
                ["SuccessBrush"] = "#0F7B0F",
                ["SuccessSoftBrush"] = "#E9F5E9",
                ["ErrorBrush"] = "#C42B1C",
                ["ErrorSoftBrush"] = "#FDE7E9",
            };

        foreach (var (key, value) in palette)
            resources[key] = new SolidColorBrush(
                (System.Windows.Media.Color)System.Windows.Media.ColorConverter.ConvertFromString(value));
    }
}
