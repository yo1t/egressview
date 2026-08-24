import Foundation

/// What happened to the runs before this one.
///
/// The diagnostics export can describe an agent that is running. It cannot
/// describe one that died: the person clicks the button afterwards, and by
/// then the process that failed is gone. On 2026-08-18 this Mac recorded
/// nothing for thirteen and a half hours and there was nothing to look at.
///
/// So each run leaves a mark before it needs one. A run that ends properly
/// says so; a run that stops without saying so is, by the absence, a run that
/// ended unexpectedly. The heartbeat says how far it got before that happened,
/// which is the difference between "it died at once" and "it was alive for
/// hours and quietly stopped recording".
///
/// **Nothing here identifies a destination, a process or a host.** It is
/// timestamps, a build number and a reason, so that including it in the
/// diagnostics export cannot carry the user's traffic out of the machine.
public struct AgentRun: Codable, Equatable, Sendable {
    public enum Ending: String, Codable, Sendable {
        /// The app said goodbye. `applicationWillTerminate` ran.
        case clean
        /// The app never said goodbye: a crash, a force quit, or a machine
        /// that lost power. **These are not distinguishable from here** and
        /// the report must not pretend otherwise.
        case unexpected
    }

    public var startedAt: Date
    public var build: String
    /// Refreshed while the run is alive. After an unexpected ending this is
    /// the last moment the app is known to have been running.
    public var lastHeartbeatAt: Date
    public var endedAt: Date?
    public var ending: Ending?
    /// The newest observation at the last heartbeat. A run that was alive but
    /// had stopped recording looks different from one that was recording until
    /// the moment it stopped, and only this tells them apart.
    public var lastObservationAt: Date?

    public init(
        startedAt: Date,
        build: String,
        lastHeartbeatAt: Date? = nil,
        endedAt: Date? = nil,
        ending: Ending? = nil,
        lastObservationAt: Date? = nil
    ) {
        self.startedAt = startedAt
        self.build = build
        self.lastHeartbeatAt = lastHeartbeatAt ?? startedAt
        self.endedAt = endedAt
        self.ending = ending
        self.lastObservationAt = lastObservationAt
    }

    /// A run with no ending recorded is one that never got to record one.
    public var resolvedEnding: Ending {
        ending ?? (endedAt == nil ? .unexpected : .clean)
    }

    /// How long the app is known to have been running. For an unexpected
    /// ending this is a lower bound -- it died somewhere after the last
    /// heartbeat, and how long after is not knowable from here.
    public var knownDuration: TimeInterval {
        (endedAt ?? lastHeartbeatAt).timeIntervalSince(startedAt)
    }

    /// How long before the end the last observation landed. `nil` when nothing
    /// was ever recorded in that run.
    public var silenceBeforeEnd: TimeInterval? {
        guard let lastObservationAt else { return nil }
        return (endedAt ?? lastHeartbeatAt).timeIntervalSince(lastObservationAt)
    }
}

/// The runs, oldest first, bounded.
public struct AgentRunHistory: Codable, Equatable, Sendable {
    /// Enough to see a pattern -- three crashes in a row is a different story
    /// from one a fortnight ago -- without turning into a file nobody reads.
    public static let limit = 10

    public var runs: [AgentRun]

    public init(runs: [AgentRun] = []) { self.runs = runs }

    public var current: AgentRun? { runs.last }

    /// Runs that ended without saying so, most recent first.
    public func unexpectedEndings(excludingCurrent: Bool = true) -> [AgentRun] {
        let candidates = excludingCurrent ? runs.dropLast() : runs[...]
        return candidates.filter { $0.resolvedEnding == .unexpected }.reversed()
    }

    /// Starts a run, and closes whatever the previous one left open.
    ///
    /// The previous run is marked `unexpected` here rather than at the moment
    /// it died, because at the moment it died there was nothing left to do the
    /// marking. That is the whole mechanism: absence, read later.
    public mutating func beginRun(at date: Date, build: String) {
        if var previous = runs.last, previous.ending == nil {
            previous.ending = .unexpected
            previous.endedAt = nil
            runs[runs.count - 1] = previous
        }
        runs.append(AgentRun(startedAt: date, build: build))
        if runs.count > Self.limit { runs.removeFirst(runs.count - Self.limit) }
    }

    public mutating func heartbeat(at date: Date, lastObservationAt: Date?) {
        guard var run = runs.last, run.ending == nil else { return }
        run.lastHeartbeatAt = date
        if let lastObservationAt { run.lastObservationAt = lastObservationAt }
        runs[runs.count - 1] = run
    }

    public mutating func endRun(at date: Date) {
        guard var run = runs.last, run.ending == nil else { return }
        run.endedAt = date
        run.lastHeartbeatAt = max(run.lastHeartbeatAt, date)
        run.ending = .clean
        runs[runs.count - 1] = run
    }
}

/// Reads and writes the run history in the App Group container.
///
/// Every write is whole-file and atomic. The file is small and rewritten once a
/// minute at most; a partial write here would lose the record of the very
/// crash it exists to describe.
public final class AgentRunRecorder: @unchecked Sendable {
    private let fileURL: URL
    private let lock = NSLock()
    private var history: AgentRunHistory

    public init(fileURL: URL) {
        self.fileURL = fileURL
        self.history = (try? Self.load(from: fileURL)) ?? AgentRunHistory()
    }

    /// `nil` when the App Group container is unavailable, which is a state the
    /// diagnostics report already knows how to describe. Crash history is not
    /// worth failing a launch over.
    public static func inAppGroup(
        fileManager: FileManager = .default,
        groupIdentifier: String = ObservationJournal.appGroupIdentifier,
        fileName: String = "run-history.json"
    ) -> AgentRunRecorder? {
        guard let container = fileManager.containerURL(
            forSecurityApplicationGroupIdentifier: groupIdentifier
        ) else { return nil }
        return AgentRunRecorder(fileURL: container.appendingPathComponent(fileName))
    }

    public static func load(from url: URL) throws -> AgentRunHistory {
        guard FileManager.default.fileExists(atPath: url.path) else {
            return AgentRunHistory()
        }
        let decoder = JSONDecoder()
        // Must match the encoder below. Writing ISO 8601 and reading the
        // default would lose every previous run at the moment they matter.
        decoder.dateDecodingStrategy = .iso8601
        return try decoder.decode(AgentRunHistory.self, from: Data(contentsOf: url))
    }

    public func snapshot() -> AgentRunHistory { lock.withLock { history } }

    @discardableResult
    public func beginRun(at date: Date = Date(), build: String) -> AgentRunHistory {
        mutate { $0.beginRun(at: date, build: build) }
    }

    @discardableResult
    public func heartbeat(
        at date: Date = Date(), lastObservationAt: Date?
    ) -> AgentRunHistory {
        mutate { $0.heartbeat(at: date, lastObservationAt: lastObservationAt) }
    }

    @discardableResult
    public func endRun(at date: Date = Date()) -> AgentRunHistory {
        mutate { $0.endRun(at: date) }
    }

    @discardableResult
    private func mutate(_ change: (inout AgentRunHistory) -> Void) -> AgentRunHistory {
        lock.withLock {
            change(&history)
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
            encoder.dateEncodingStrategy = .iso8601
            // Failing to write must not take the app down with it: this file
            // describes faults, it does not cause them.
            if let data = try? encoder.encode(history) {
                try? data.write(to: fileURL, options: .atomic)
            }
            return history
        }
    }
}
