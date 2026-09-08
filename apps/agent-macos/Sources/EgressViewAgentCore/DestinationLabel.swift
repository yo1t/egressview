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
/// that still collide, keeps the position where they actually differ. Nothing
/// else is touched: a short name is returned unchanged, and a set with no
/// collisions reads exactly as it did before.
///
/// The first version of this resolved collisions by keeping the head, on the
/// reasoning that a shared tail is what caused them. That held for the case it
/// was written against and failed on the real machine the same night: two rows
/// read `cdn-windows-clien…`, because those names share their head and differ
/// in the tail that keeping the head throws away. **Neither end is reliably the
/// answer**, so this computes where the difference is rather than assuming.
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
        var groups: [String: [String]] = [:]
        for (name, label) in zip(names, first) { groups[label, default: []].append(name) }
        guard groups.values.contains(where: { $0.count > 1 }) else { return first }

        return zip(names, first).map { original, label in
            guard let group = groups[label], group.count > 1 else { return label }
            let shared = sharedEnds(of: group)
            return distinguishing(
                original,
                sharedPrefix: shared.prefix,
                sharedSuffix: shared.suffix,
                limit: width
            )
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

    /// How much of a colliding group's names is shared at each end.
    ///
    /// Everything between the two is where the names differ, and is what a
    /// label has to carry for the column to answer its own heading.
    static func sharedEnds(of names: [String]) -> (prefix: Int, suffix: Int) {
        guard let first = names.first, names.count > 1 else { return (0, 0) }
        var prefix = first.count
        var suffix = first.count
        let reversedFirst = String(first.reversed())
        for other in names.dropFirst() {
            prefix = min(prefix, first.commonPrefix(with: other).count)
            suffix = min(suffix, reversedFirst.commonPrefix(with: String(other.reversed())).count)
        }
        // The two ends must not claim the same characters, or a name shorter
        // than the rest would report a difference it does not have.
        let shortest = names.map(\.count).min() ?? 0
        return (prefix, min(suffix, max(0, shortest - prefix)))
    }

    /// Keeps the characters that separate this name from the ones it collided
    /// with, and spends whatever is left on the head so the name still says
    /// which family it belongs to.
    ///
    /// An ellipsis on either side says the name continues there, which is true
    /// and is the point: two rows now differ where they differ.
    static func distinguishing(
        _ name: String,
        sharedPrefix: Int,
        sharedSuffix: Int,
        limit: Int
    ) -> String {
        let chars = Array(name)
        guard chars.count > limit else { return name }

        let start = min(max(0, sharedPrefix), chars.count - 1)
        let end = max(start + 1, chars.count - max(0, sharedSuffix))

        var budget = limit
        if start > 0 { budget -= 1 }
        let droppedTail = end < chars.count
        if droppedTail { budget -= 1 }
        budget = max(1, budget)

        // The difference begins at `start`, so this region's own head is the
        // part that must survive being cut.
        var body = Array(chars[start..<min(end, chars.count)])
        let truncatedBody = body.count > budget
        if truncatedBody { body = Array(body.prefix(budget)) }

        var head = ""
        if start > 0, budget > body.count {
            head = String(chars.prefix(min(budget - body.count, start)))
        }

        var label = head
        if head.count < start { label += "…" }
        label += String(body)
        if droppedTail || truncatedBody { label += "…" }
        return label
    }
}
