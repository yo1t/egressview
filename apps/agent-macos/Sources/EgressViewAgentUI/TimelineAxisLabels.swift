import CoreGraphics

/// Which values the timeline's vertical axis says out loud, given the room.
///
/// The chart drew three labels -- nothing, half, and the tallest bucket -- at
/// every card height, because the fractions were written into the drawing as
/// `[0.0, 0.5, 1.0]`. In a card 160 points tall and Japanese text, the three
/// ran into each other (P3-104):
///
///     10.5 MB
///     5.3 MB      <- touching the one above
///     Zero KB
///
/// Readable, and useless: the axis is where the chart says how far it goes, and
/// three numbers in a clump say nothing about which line is which.
///
/// It was found in a rendered PNG rather than on a Mac, which is the point of
/// P3-105. The height of a card follows the window, so this only happened to
/// someone who made their window small -- the side of the screen the person
/// building it does not look at.
///
/// The decision lives here rather than inside the view for the same reason
/// `SankeyViewport` does: the number that was wrong could only be reached by
/// drawing it.
public enum TimelineAxisLabels {
    /// The clear space two labels keep between their boxes.
    ///
    /// Not zero. Boxes that merely fail to overlap still read as one block,
    /// and the defect being fixed is "these are a clump", not "these collide".
    public static let minimumGap: CGFloat = 3

    /// The fractions of the plot height to draw a gridline and its value at,
    /// from the baseline upward.
    ///
    /// What is given up as the card shrinks, in order: the middle tick, then
    /// the zero. **The top is never given up.** It is the only place the chart
    /// says how big the tallest bucket is, and a chart that has stopped saying
    /// that is a shape with no magnitude -- which is what P3-90 was about, one
    /// defect earlier on the same label.
    public static func fractions(plotHeight: CGFloat, labelHeight: CGFloat) -> [CGFloat] {
        let spacing = labelHeight + minimumGap
        guard spacing > 0 else { return [0, 0.5, 1] }
        if plotHeight >= spacing * 2 { return [0, 0.5, 1] }
        if plotHeight >= spacing { return [0, 1] }
        return [1]
    }

    /// Whether any two of these labels would touch.
    ///
    /// The test that let P3-104 through asked only whether the top label was
    /// clear of the frame. Nothing asked whether it was clear of its
    /// neighbour, and that is the gap this closes.
    public static func labelsCollide(
        _ fractions: [CGFloat], plotHeight: CGFloat, labelHeight: CGFloat
    ) -> Bool {
        let centres = fractions.map { plotHeight * $0 }.sorted()
        return zip(centres, centres.dropFirst()).contains { lower, upper in
            upper - lower < labelHeight + minimumGap
        }
    }
}
