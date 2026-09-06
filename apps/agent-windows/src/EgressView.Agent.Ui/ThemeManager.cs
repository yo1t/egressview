using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Media;
using Microsoft.Win32;
using MediaColor = System.Windows.Media.Color;
using MediaColors = System.Windows.Media.Colors;

namespace EgressView.Agent.Ui;

internal static class ThemeManager
{
    private const string PersonalizeKey = @"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize";

    [DllImport("dwmapi.dll")]
    private static extern int DwmGetColorizationColor(out uint colorization, out bool opaqueBlend);

    internal static bool IsDark { get; private set; }

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

        ApplyTheme(resources, dark, ReadSystemAccent(dark));
    }

    internal static void ApplyTheme(ResourceDictionary resources, bool dark, MediaColor accent)
    {
        IsDark = dark;
        var background = dark ? MediaColor.FromRgb(0x20, 0x20, 0x20) : MediaColor.FromRgb(0xF3, 0xF3, 0xF3);
        accent = EnsureTextContrast(accent, background, dark);
        var palette = dark
            ? new Dictionary<string, string>
            {
                ["AppBackgroundBrush"] = "#202020",
                ["SurfaceBrush"] = "#2C2C2C",
                ["SurfaceSecondaryBrush"] = "#323232",
                ["TextPrimaryBrush"] = "#FFFFFF",
                ["TextSecondaryBrush"] = "#C7C7C7",
                ["StrokeBrush"] = "#3D3D3D",
                ["AccentBrush"] = Hex(accent),
                ["AccentHoverBrush"] = Hex(Blend(accent, MediaColors.White, 0.12)),
                ["AccentPressedBrush"] = Hex(Blend(accent, MediaColors.Black, 0.12)),
                ["AccentSoftBrush"] = Hex(Blend(accent, background, 0.78)),
                ["PrimaryButtonTextBrush"] = Hex(ContrastText(accent)),
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
                ["AccentBrush"] = Hex(accent),
                ["AccentHoverBrush"] = Hex(Blend(accent, MediaColors.Black, 0.10)),
                ["AccentPressedBrush"] = Hex(Blend(accent, MediaColors.Black, 0.20)),
                ["AccentSoftBrush"] = Hex(Blend(accent, background, 0.88)),
                ["PrimaryButtonTextBrush"] = Hex(ContrastText(accent)),
                ["SuccessBrush"] = "#0F7B0F",
                ["SuccessSoftBrush"] = "#E9F5E9",
                ["ErrorBrush"] = "#C42B1C",
                ["ErrorSoftBrush"] = "#FDE7E9",
            };

        foreach (var (key, value) in palette)
            resources[key] = new SolidColorBrush(
                (System.Windows.Media.Color)System.Windows.Media.ColorConverter.ConvertFromString(value));
    }

    private static MediaColor ReadSystemAccent(bool dark)
    {
        try
        {
            if (DwmGetColorizationColor(out var value, out _) >= 0)
                return MediaColor.FromRgb((byte)(value >> 16), (byte)(value >> 8), (byte)value);
        }
        catch (DllNotFoundException) { }
        catch (EntryPointNotFoundException) { }
        return dark ? MediaColor.FromRgb(0x60, 0xCD, 0xFF) : MediaColor.FromRgb(0x00, 0x67, 0xC0);
    }

    private static MediaColor EnsureTextContrast(MediaColor accent, MediaColor background, bool dark)
    {
        if (ContrastRatio(accent, background) >= 4.5) return accent;
        var target = dark ? MediaColors.White : MediaColors.Black;
        for (var amount = 0.05; amount <= 1; amount += 0.05)
        {
            var candidate = Blend(accent, target, amount);
            if (ContrastRatio(candidate, background) >= 4.5) return candidate;
        }
        return target;
    }

    private static MediaColor ContrastText(MediaColor background) =>
        ContrastRatio(MediaColors.Black, background) >= ContrastRatio(MediaColors.White, background) ? MediaColors.Black : MediaColors.White;

    private static double ContrastRatio(MediaColor first, MediaColor second)
    {
        var firstLuminance = RelativeLuminance(first);
        var secondLuminance = RelativeLuminance(second);
        return (Math.Max(firstLuminance, secondLuminance) + 0.05) / (Math.Min(firstLuminance, secondLuminance) + 0.05);
    }

    private static double RelativeLuminance(MediaColor color)
    {
        static double Linear(byte component)
        {
            var value = component / 255d;
            return value <= 0.04045 ? value / 12.92 : Math.Pow((value + 0.055) / 1.055, 2.4);
        }
        return 0.2126 * Linear(color.R) + 0.7152 * Linear(color.G) + 0.0722 * Linear(color.B);
    }

    private static MediaColor Blend(MediaColor color, MediaColor target, double amount) => MediaColor.FromRgb(
        (byte)Math.Round(color.R + (target.R - color.R) * amount),
        (byte)Math.Round(color.G + (target.G - color.G) * amount),
        (byte)Math.Round(color.B + (target.B - color.B) * amount));

    private static string Hex(MediaColor color) => $"#{color.R:X2}{color.G:X2}{color.B:X2}";
}
