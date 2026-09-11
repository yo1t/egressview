import CoreGraphics
import EgressViewAgentCore

/// How tall the sankey's contents are, and how little the card may be.
///
/// The arithmetic lived inside the view as two computed properties, where the
/// only way to ask it a question was to draw it. One of them said
///
///     viewportHeight = 10 * rowHeight
///
/// which pinned the diagram to 210 points however large the window was: the
/// card grew and the drawing inside it did not (P3-15). Nothing in the suite
/// could have noticed, because nothing could reach the number.
///
/// The view still decides how to lay itself out. This decides what the numbers
/// are, and can be asked.
public enum SankeyViewport {
    /// One name row, and the heading above the column.
    public static let rowHeight: CGFloat = 18
    public static let headerHeight: CGFloat = 17

    /// The fewest rows the card shows before it starts scrolling.
    ///
    /// Three, so a short window still shows a diagram rather than a scroll bar
    /// with nothing visible above it.
    public static let minimumRows = 3

    /// As tall as the longer column needs.
    ///
    /// No lower bound in rows. The first version floored this at ten, which is
    /// the other half of how the diagram stopped growing.
    public static func contentHeight(rows: Int) -> CGFloat {
        headerHeight + CGFloat(max(rows, 1)) * rowHeight
    }

    /// The least the card may be given.
    public static var minimumHeight: CGFloat {
        headerHeight + CGFloat(minimumRows) * rowHeight
    }

    /// How many name rows a card of this height shows without scrolling.
    ///
    /// The answer that was wrong: it used to be ten, whatever the height.
    public static func visibleRows(inHeight height: CGFloat) -> Int {
        let forRows = height - headerHeight
        guard forRows > 0 else { return 0 }
        return Int(forRows / rowHeight)
    }
}
