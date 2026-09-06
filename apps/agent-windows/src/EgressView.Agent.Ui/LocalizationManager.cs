using System.Globalization;
using System.Windows;

namespace EgressView.Agent.Ui;

internal static class LocalizationManager
{
    internal static string EffectiveLanguage => AgentSettings.Language switch
    {
        AgentLanguage.English => "en",
        AgentLanguage.Japanese => "ja",
        _ => CultureInfo.CurrentUICulture.TwoLetterISOLanguageName == "ja" ? "ja" : "en",
    };

    internal static void Apply(ResourceDictionary resources)
    {
        var existing = resources.MergedDictionaries.FirstOrDefault(dictionary =>
            dictionary.Source?.OriginalString.Contains("Strings.", StringComparison.Ordinal) == true);
        if (existing is not null) resources.MergedDictionaries.Remove(existing);
        resources.MergedDictionaries.Add(new ResourceDictionary
        {
            Source = new Uri($"Resources/Strings.{EffectiveLanguage}.xaml", UriKind.Relative),
        });
        CultureInfo.CurrentCulture = CultureInfo.GetCultureInfo(EffectiveLanguage == "ja" ? "ja-JP" : "en-US");
    }

    /// The store emits two sentinels in place of an application name: flows
    /// whose process could not be named, and the remainder past the top few.
    /// They are aggregation buckets, not programs, so they are shown in the
    /// reader's language rather than as the internal token.
    internal static string Application(string name) => name switch
    {
        "Unknown" => Text("FlowUnknown"),
        "Other" => Text("FlowOther"),
        _ => name,
    };

    internal static string Text(string key) =>
        System.Windows.Application.Current.TryFindResource(key) as string ?? key;
}
