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
        _ => report.Total == 0 ? LocalizationManager.Text("WorthALookNothingSummary")
            : Format("WorthALookCountSummaryFormat", report.Total, Unanswered(report)),
    };

    /// The person's answer to one candidate: a verdict, or null to take it
    /// back, and the note, null to keep the one already there.
    internal delegate void Answer(OutboundCandidate candidate, OutboundCandidateVerdict? verdict, string? note);

    /// Of those listed, how many have no answer yet.
    internal static int Unanswered(OutboundCandidateReport report)
    {
        var answered = report.Judgments.Select(judgment => judgment.CandidateId).ToHashSet(StringComparer.Ordinal);
        return report.Candidates.Count(candidate => !answered.Contains(candidate.Id));
    }

    internal static FrameworkElement Build(OutboundCandidateReport report, bool showsAll, Action showAll,
        Answer? answer = null, bool showsChecked = false, Action? showChecked = null, Action? forgetAll = null)
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

        // Answered ones fold away below the list, as on the Mac, so what is
        // left to look at stays at the top.
        var judgments = report.Judgments.ToDictionary(judgment => judgment.CandidateId, StringComparer.Ordinal);
        var open = report.Candidates.Where(candidate => !judgments.ContainsKey(candidate.Id)).ToList();
        var answered = report.Candidates.Where(candidate => judgments.ContainsKey(candidate.Id)).ToList();
        if (report.Candidates.Count > 0 && open.Count == 0)
            panel.Children.Add(Note(LocalizationManager.Text("WorthALookAllAnswered"), 9));

        var visible = showsAll ? open : open.Take(CollapsedCount).ToList();
        foreach (var candidate in visible) panel.Children.Add(Row(candidate, null, answer));
        if (visible.Count < open.Count)
            panel.Children.Add(Link(Format("WorthALookShowAllFormat", open.Count), showAll, 9));
        else if (report.Total > report.Candidates.Count)
            panel.Children.Add(Note(Format("ShowingNewestFormat", report.Candidates.Count, report.Total), 9));

        if (answered.Count > 0)
        {
            if (showsChecked || showChecked is null)
            {
                panel.Children.Add(new TextBlock
                {
                    Text = Format("WorthALookCheckedFormat", answered.Count), FontSize = 14, FontWeight = FontWeights.SemiBold,
                    Margin = new Thickness(0, 16, 0, 0), TextWrapping = TextWrapping.Wrap,
                });
                foreach (var candidate in answered) panel.Children.Add(Row(candidate, judgments[candidate.Id], answer));
            }
            else panel.Children.Add(Link(Format("WorthALookCheckedFormat", answered.Count) + " ▸", showChecked, 16));
        }
        if (answer is not null) panel.Children.Add(Note(LocalizationManager.Text("WorthALookAnswersStayHere"), 12));
        panel.Children.Add(Note(LocalizationManager.Text("WorthALookCaveat"), 9));
        if (forgetAll is not null && judgments.Count > 0) panel.Children.Add(Link(LocalizationManager.Text("WorthALookForgetAll"), forgetAll, 9));
        return panel;
    }

    /// One candidate: what it is, the two answers, and the note.
    private static FrameworkElement Row(OutboundCandidate candidate, OutboundCandidateJudgment? judgment, Answer? answer)
    {
        var row = new StackPanel();
        row.Children.Add(Selectable(Title(candidate)));
        row.Children.Add(Note(Detail(candidate), 1));
        if (judgment is { Note.Length: > 0 }) row.Children.Add(Note(Format("WorthALookNoteFormat", judgment.Note), 3));
        if (answer is null) return row;

        var buttons = new WrapPanel { Margin = new Thickness(0, 6, 0, 0) };
        var note = new System.Windows.Controls.TextBox
        {
            Text = judgment?.Note ?? "", MaxLength = OutboundCandidateJudgment.NoteLimit, TextWrapping = TextWrapping.Wrap,
            AcceptsReturn = true, MinHeight = 48, Margin = new Thickness(0, 6, 0, 0),
        };
        System.Windows.Automation.AutomationProperties.SetName(note, LocalizationManager.Text("WorthALookNoteLabel"));
        var editor = new StackPanel { Visibility = Visibility.Collapsed };
        editor.Children.Add(Note(LocalizationManager.Text("WorthALookNoteLabel"), 6));
        editor.Children.Add(note);

        buttons.Children.Add(VerdictButton(OutboundCandidateVerdict.Expected, judgment?.Verdict,
            () => answer(candidate, OutboundCandidateVerdict.Expected, editor.IsVisible ? note.Text : null)));
        buttons.Children.Add(VerdictButton(OutboundCandidateVerdict.Investigate, judgment?.Verdict,
            () => answer(candidate, OutboundCandidateVerdict.Investigate, editor.IsVisible ? note.Text : null)));
        var noteButton = SmallButton(LocalizationManager.Text(judgment is null ? "WorthALookAddNote" : "WorthALookEditNote"));
        noteButton.Click += (_, _) => editor.Visibility = editor.IsVisible ? Visibility.Collapsed : Visibility.Visible;
        buttons.Children.Add(noteButton);
        if (judgment is not null)
        {
            var takeBack = SmallButton(LocalizationManager.Text("WorthALookTakeBack"));
            takeBack.Click += (_, _) => answer(candidate, null, null);
            buttons.Children.Add(takeBack);
            var save = SmallButton(LocalizationManager.Text("WorthALookSaveNote"));
            save.Margin = new Thickness(0, 6, 0, 0);
            save.HorizontalAlignment = System.Windows.HorizontalAlignment.Left;
            save.Click += (_, _) => answer(candidate, judgment.Verdict, note.Text);
            editor.Children.Add(save);
        }
        else editor.Children.Add(Note(LocalizationManager.Text("WorthALookNoteHint"), 3));
        row.Children.Add(buttons);
        row.Children.Add(editor);
        return row;
    }

    /// The chosen answer stays filled in: blue for expected, orange for look
    /// into it, as on the Mac.
    private static System.Windows.Controls.Button VerdictButton(OutboundCandidateVerdict verdict, OutboundCandidateVerdict? chosen, Action click)
    {
        var expected = verdict == OutboundCandidateVerdict.Expected;
        var button = SmallButton(LocalizationManager.Text(expected ? "WorthALookExpected" : "WorthALookInvestigate"));
        if (chosen == verdict)
        {
            if (expected)
            {
                button.SetResourceReference(System.Windows.Controls.Control.BackgroundProperty, "AccentBrush");
                button.SetResourceReference(System.Windows.Controls.Control.BorderBrushProperty, "AccentBrush");
                button.SetResourceReference(System.Windows.Controls.Control.ForegroundProperty, "PrimaryButtonTextBrush");
            }
            else
            {
                button.SetResourceReference(System.Windows.Controls.Control.BackgroundProperty, "WarningSoftBrush");
                button.SetResourceReference(System.Windows.Controls.Control.BorderBrushProperty, "WarningBrush");
            }
            System.Windows.Automation.AutomationProperties.SetItemStatus(button, LocalizationManager.Text("WorthALookChosen"));
        }
        button.Click += (_, _) => click();
        return button;
    }

    private static System.Windows.Controls.Button SmallButton(string text)
    {
        var button = new System.Windows.Controls.Button { Content = text, Margin = new Thickness(0, 0, 6, 0), FontSize = 12 };
        button.SetResourceReference(FrameworkElement.StyleProperty, "FluentButtonStyle");
        // Set after the style, which would otherwise give the larger size.
        button.Padding = new Thickness(10, 3, 10, 3);
        button.MinHeight = 28;
        return button;
    }

    private static TextBlock Link(string text, Action click, double top)
    {
        var link = new Hyperlink(new Run(text));
        link.SetResourceReference(TextElement.ForegroundProperty, "AccentBrush");
        link.Click += (_, _) => click();
        return new TextBlock(link) { FontSize = 12, Margin = new Thickness(0, top, 0, 0), TextWrapping = TextWrapping.Wrap };
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
