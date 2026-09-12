import Foundation

/// Which countries have just been reached, and how brightly to say so.
///
/// The map shades every country in the local history, which is a picture of
/// where this Mac has ever been. It cannot show what is happening now: a
/// country reached a second ago looks exactly like one reached in August.
///
/// A glow that fades answers that without adding another control. Something
/// lights up, and the light stays a moment after the traffic has gone -- long
/// enough to be noticed by someone who was looking elsewhere on the map, and
/// short enough that a country still lit means recent.
///
/// The decay lives here rather than in the drawing so that it can be asked
/// what it will do, instead of being watched.
public struct CountryGlow: Sendable {
    /// How long a country stays lit after it was last reached.
    ///
    /// Six seconds. Long enough to catch the eye of someone reading the list
    /// on the other side of the screen; short enough that two connections a
    /// minute apart are two events rather than one continuous glow.
    public static let fadeDuration: TimeInterval = 6

    private var touchedAt: [String: Date] = [:]

    public init() {}

    public var isEmpty: Bool { touchedAt.isEmpty }

    /// These countries were just reached.
    ///
    /// A country touched again starts over at full brightness rather than
    /// continuing to fade, because the second connection is as much news as
    /// the first.
    public mutating func touch<S: Sequence>(_ codes: S, at moment: Date = Date())
        where S.Element == String {
        for code in codes { touchedAt[code.uppercased()] = moment }
    }

    /// How lit a country is, from 1 down to 0.
    ///
    /// Eased at both ends -- a cosine, not a straight line. A linear fade
    /// arrives and leaves with a visible edge, which reads as a flicker; this
    /// comes up softly and lets go slowly, which is what makes it an
    /// afterglow rather than a blink.
    public func intensity(for code: String, at now: Date = Date()) -> Double {
        guard let moment = touchedAt[code.uppercased()] else { return 0 }
        let elapsed = now.timeIntervalSince(moment)
        guard elapsed >= 0 else { return 1 }
        guard elapsed < Self.fadeDuration else { return 0 }
        let fraction = elapsed / Self.fadeDuration
        return (1 + cos(.pi * fraction)) / 2
    }

    /// Is anything still lit?
    ///
    /// What the drawing asks before it decides to animate. Nothing lit means
    /// nothing moving, and a map that keeps redrawing an unchanging picture is
    /// how the Windows globe spent 1.11 CPU cores on a still image (P3-16).
    public func isActive(at now: Date = Date()) -> Bool {
        touchedAt.values.contains { now.timeIntervalSince($0) < Self.fadeDuration }
    }

    /// When the last light goes out, so a single wake-up can be scheduled for
    /// it rather than a timer left running.
    public func endsAt() -> Date? {
        touchedAt.values.max().map { $0.addingTimeInterval(Self.fadeDuration) }
    }

    /// Forgets what has gone dark. Without this the dictionary grows for as
    /// long as the window is open.
    public mutating func prune(at now: Date = Date()) {
        touchedAt = touchedAt.filter { now.timeIntervalSince($0.value) < Self.fadeDuration }
    }
}
