using System.Globalization;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Documents;
using EgressView.Agent.Core;

namespace EgressView.Agent.Ui;

/// Traffic worth a look over the last 14 days (P3-192, P3-193 phase 2).
///
/// Lives in Insights, not in the overview card's detail: fourteen days do not
/// belong beside a period picker, and a list the pointer has to rest on to see
/// is a list nobody finds. The card keeps <see cref="Summary"/>.
internal static class OutboundCandidatesView
{
    /// Opens short because the AI conversation sits below it on the same screen.
    internal const int CollapsedCount = 10;

    /// One line for the overview card. A low share keeps its warning here,
    /// because a count alone would read as all there is.
    internal static string Summary(OutboundCandidateReport report) => report.State switch
    {
        OutboundCandidateState.Learning => LocalizationManager.Text("WorthALookLearningSummary"),
        OutboundCandidateState.LowByteCoverage => Format("WorthALookLowCoverageSummaryFormat", report.Total),
        _ => report.Total == 0 ? LocalizationManager.Text("WorthALookNothingSummary") : Format("WorthALookCountSummaryFormat", report.Total),
    };

    internal static FrameworkElement Build(OutboundCandidateReport report, bool showsAll, Action showAll)
    {
        var panel = new StackPanel();
        panel.Children.Add(new TextBlock
        {
            Text = LocalizationManager.Text("WorthALook"), FontSize = 17, FontWeight = FontWeights.SemiBold, TextWrapping = TextWrapping.Wrap,
        });
        if (report.State == OutboundCandidateState.Learning)
        {
            // Said in hours, and said to be slow on a PC that is often off:
            // this can stay for weeks there, and that is the right answer.
            panel.Children.Add(Note(Format("WorthALookLearningFormat", report.MonitoredHours, OutboundCandidateRules.LearningSeconds / 3600), 9));
            return panel;
        }
        if (report.State == OutboundCandidateState.LowByteCoverage)
            panel.Children.Add(Note(Format("WorthALookLowCoverageFormat", report.ByteCoverageShare), 9));
        if (report.Candidates.Count == 0)
            panel.Children.Add(Note(LocalizationManager.Text("WorthALookNothing"), 9));

        var visible = showsAll ? report.Candidates : report.Candidates.Take(CollapsedCount).ToList();
        foreach (var candidate in visible)
        {
            panel.Children.Add(Selectable(Title(candidate)));
            panel.Children.Add(Note(Detail(candidate), 1));
        }
        if (visible.Count < report.Candidates.Count)
        {
            var link = new Hyperlink(new Run(Format("WorthALookShowAllFormat", report.Candidates.Count)));
            link.SetResourceReference(TextElement.ForegroundProperty, "AccentBrush");
            link.Click += (_, _) => showAll();
            panel.Children.Add(new TextBlock(link) { FontSize = 12, Margin = new Thickness(0, 9, 0, 0) });
        }
        else if (report.Total > report.Candidates.Count)
            panel.Children.Add(Note(Format("ShowingNewestFormat", report.Candidates.Count, report.Total), 9));
        panel.Children.Add(Note(LocalizationManager.Text("WorthALookCaveat"), 9));
        return panel;
    }

    private static string Title(OutboundCandidate candidate) =>
        candidate.Application is { } application && candidate.Destination is { } destination
            ? $"{application} → {destination}" : LocalizationManager.Text("WorthALookThisPc");

    /// The day is the UTC day the baseline counts by, shown as that date: in
    /// local time a day west of Greenwich would read as the day before.
    private static string Detail(OutboundCandidate candidate)
    {
        var day = candidate.At.UtcDateTime.ToString("d", CultureInfo.CurrentCulture);
        var sent = AnomalyDetailView.Bytes(candidate.BytesOut);
        var usual = AnomalyDetailView.Bytes(candidate.UsualBytesOut ?? 0);
        return candidate.Kind switch
        {
            OutboundCandidateKind.NewPair => Format("WorthALookNewPairFormat", day, sent),
            OutboundCandidateKind.AboveUsual => Format("WorthALookAboveUsualFormat", day, sent, usual),
            _ => Format("WorthALookMachineFormat", day, sent, usual),
        };
    }

    private static string Format(string key, params object[] values) =>
        string.Format(CultureInfo.CurrentCulture, LocalizationManager.Text(key), values);

    /// A name here is what gets searched for or passed on next.
    private static System.Windows.Controls.TextBox Selectable(string text)
    {
        var box = new System.Windows.Controls.TextBox
        {
            Text = text, IsReadOnly = true, BorderThickness = new Thickness(0), Padding = new Thickness(0),
            Background = System.Windows.Media.Brushes.Transparent, TextWrapping = TextWrapping.Wrap,
            // A text box keeps two pixels inside its edge; the lines around it do not.
            Margin = new Thickness(-2, 9, 0, 0),
        };
        box.SetResourceReference(System.Windows.Controls.Control.ForegroundProperty, "TextPrimaryBrush");
        return box;
    }

    private static TextBlock Note(string text, double top)
    {
        var block = new TextBlock { Text = text, FontSize = 12, TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, top, 0, 0) };
        block.SetResourceReference(TextBlock.ForegroundProperty, "TextSecondaryBrush");
        return block;
    }
}
