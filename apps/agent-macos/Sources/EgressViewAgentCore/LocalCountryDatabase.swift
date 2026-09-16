import Foundation

/// The country table kept on this Mac, and what the agent is obliged to say
/// about it.
///
/// Opening it is deferred and the result is remembered: most runs never have a
/// file at all, and the ones that do should pay for parsing the metadata once
/// rather than on every address (P3-117).
///
/// The existing routes stay. This is another source, tried first because it is
/// the only one that asks nobody: the Hub and the third-party service remain
/// exactly as they were, for the addresses no local table can place and for
/// the machines that have no table at all.
public final class LocalCountryDatabase: @unchecked Sendable {
    /// MaxMind's licence requires moving to a new build promptly and destroying
    /// anything older than thirty days after a new one is released. A copy this
    /// old is therefore not merely stale -- continuing to use it breaks the
    /// terms the file came under.
    public static let maximumAge: TimeInterval = 30 * 24 * 60 * 60

    /// Required by the licence wherever the data is used.
    public static let attribution =
        "This product includes GeoLite Data created by MaxMind, available from https://www.maxmind.com"

    public enum State: Equatable, Sendable {
        case absent
        case ready(builtAt: Date, databaseType: String)
        /// Readable, but older than the licence allows anyone to keep using.
        case expired(builtAt: Date)
        case unreadable(String)

        public var isUsable: Bool { if case .ready = self { return true }; return false }
    }

    private let url: URL
    private let lock = NSLock()
    private var loaded = false
    private var database: MaxMindDB?
    private var failure: String?

    /// Where the file lives when the agent has one.
    public static func defaultURL(
        containerURL: URL? = FileManager.default.containerURL(
            forSecurityApplicationGroupIdentifier: "group.com.egressview.agent"
        )
    ) -> URL? {
        containerURL?.appendingPathComponent("GeoLite2-Country.mmdb")
    }

    public init(url: URL) {
        self.url = url
    }

    public func state(now: Date = Date()) -> State {
        lock.withLock {
            loadLocked()
            guard let database else {
                if let failure { return .unreadable(failure) }
                return .absent
            }
            if database.metadata.age(now: now) > Self.maximumAge {
                return .expired(builtAt: database.metadata.builtAt)
            }
            return .ready(
                builtAt: database.metadata.builtAt, databaseType: database.metadata.databaseType
            )
        }
    }

    /// The country for an address, or nil when this Mac cannot answer.
    ///
    /// Nil for a file that is absent, unreadable or out of date: an answer from
    /// a copy nobody is allowed to keep using is not an answer worth giving,
    /// and the other routes are still there.
    public func countryCode(for address: String, now: Date = Date()) -> String? {
        lock.withLock {
            loadLocked()
            guard let database, database.metadata.age(now: now) <= Self.maximumAge else {
                return nil
            }
            return try? database.countryCode(for: address)
        }
    }

    /// Re-reads the file. Called after an update replaces it.
    public func reload() {
        lock.withLock {
            loaded = false
            database = nil
            failure = nil
        }
    }

    private func loadLocked() {
        guard !loaded else { return }
        loaded = true
        guard FileManager.default.fileExists(atPath: url.path) else { return }
        do {
            database = try MaxMindDB(contentsOf: url)
        } catch let error as MaxMindDB.Failure {
            failure = String(describing: error)
        } catch {
            failure = error.localizedDescription
        }
    }
}
