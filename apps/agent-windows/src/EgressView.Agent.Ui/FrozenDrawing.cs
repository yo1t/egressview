using System.Windows.Media;
using Brush = System.Windows.Media.Brush;
using Pen = System.Windows.Media.Pen;

namespace EgressView.Agent.Ui;

/// Freezing what a control draws with, before it draws with it.
///
/// This is not a micro-optimisation; it decides the shape of the cost. An
/// unfrozen Freezable handed to a drawing instruction gets an
/// inheritance-context pair registered against the element, and the globe's
/// coastline pass issues one instruction per segment -- about sixteen
/// thousand of them. Tearing that list down again is where the resident
/// window's dispatcher thread was found spending its time, in
/// Freezable.RemoveContextInformation, at 98% of a core with nothing on
/// screen changing.
///
/// Measured on the globe at 330x260: 123 ms per frame before, 13 ms after.
internal static class FrozenDrawing
{
    internal static Pen Frozen(this Pen pen)
    {
        if (pen.CanFreeze) pen.Freeze();
        return pen;
    }

    internal static Geometry Frozen(this Geometry geometry)
    {
        if (geometry.CanFreeze) geometry.Freeze();
        return geometry;
    }

    /// A theme brush arrives unfrozen because the theme can change. Rendering
    /// takes a frozen copy rather than freezing the original, so a later theme
    /// change still reaches the control through its next render.
    internal static Brush Frozen(this Brush brush)
    {
        if (brush.IsFrozen || !brush.CanFreeze) return brush;
        var copy = brush.Clone();
        copy.Freeze();
        return copy;
    }
}
