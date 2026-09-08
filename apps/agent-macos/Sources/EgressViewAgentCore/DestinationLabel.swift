import Foundation

/// Shortens destination names so that two different destinations do not read
/// the same.
///
/// The sankey column truncates in the middle and gives every row 150 points.
/// Measured on 2026-09-07, that put four rows on screen reading
/// `ipv6-c…ideo.net` — four different CDN nodes, 1.04 GB between them, and no
/// way to tell which was which. The column's heading is "where", and it was
/// not answering (P3-86).
///
/// Middle truncation is the right instinct: a hostname's tail (`.example.com`)
/// is shared by everything in the domain, and its head says which service. What
/// it misses is that when several names collide, **the part that separates them
/// is the part being dropped**.
///
/// So this shortens each name on its own first, and then, only for the names
/// that still collide, keeps enough of the distinguishing middle to tell them
/// apart. Nothing else is touched: a short name is returned unchanged, and a
/// set with no collisions reads exactly as it did before.
public enum DestinationLabel {
    /// Shortens `names` to fit `limit` characters, keeping colliding names
    /// distinguishable.
    ///
    /// - Parameter limit: how many characters a label may use. Below about
    ///   eight there is nothing left to distinguish with, so short limits are
    ///   raised to that.
    public static func shorten(_ names: [String], limit: Int) -> [String] {
        let width = max(8, limit)
        let first = names.map { middleTruncated($0, limit: width) }
        var counts: [String: Int] = [:]
        for label in first { counts[label, default: 0] += 1 }
        guard counts.values.contains(where: { $0 > 1 }) else { return first }

        return zip(names, first).map { original, label in
            counts[label]! > 1 ? distinguishing(original, limit: width) : label
        }
    }

    /// `ipv6-cdn-042.example.video.net` -> `ipv6-cdn…video.net`
    static func middleTruncated(_ name: String, limit: Int) -> String {
        guard name.count > limit else { return name }
        let keep = limit - 1
        let head = keep - keep / 2
        let tail = keep / 2
        return "\(name.prefix(head))…\(name.suffix(tail))"
    }

    /// Keeps the head, where a hostname says which node it is.
    ///
    /// The shared tail is what made the collision, so dropping it is what
    /// resolves one. A trailing ellipsis says the name continues, which is
    /// true and is the point: two rows now differ where they differ.
    static func distinguishing(_ name: String, limit: Int) -> String {
        guard name.count > limit else { return name }
        return "\(name.prefix(limit - 1))…"
    }
}
