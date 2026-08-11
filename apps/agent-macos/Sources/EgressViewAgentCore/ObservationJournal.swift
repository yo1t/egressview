import Darwin
import Foundation

public struct ObservationJournalStatistics: Equatable, Sendable {
    public let storedBytes: UInt64
    public let maximumStoredBytes: UInt64
    public let recordCount: Int
    public let oldestObservationAt: Date?
    public let newestObservationAt: Date?
}

public struct ObservationJournalSnapshot: Equatable, Sendable {
    public let observations: [ConnectionObservation]
    public let statistics: ObservationJournalStatistics
}

public final class ObservationJournal: @unchecked Sendable {
    public static let appGroupIdentifier = "group.com.egressview.agent"

    private let fileURL: URL
    private let archiveURL: URL
    private let lockURL: URL
    private let maximumFileSize: UInt64
    private let lock = NSLock()
    private let encoder: JSONEncoder
    private let decoder: JSONDecoder

    public init(fileURL: URL, maximumFileSize: UInt64 = 10 * 1_024 * 1_024) {
        self.fileURL = fileURL
        self.archiveURL = fileURL.appendingPathExtension("1")
        self.lockURL = fileURL.appendingPathExtension("lock")
        self.maximumFileSize = max(1_024, maximumFileSize)
        self.encoder = JSONEncoder()
        self.encoder.dateEncodingStrategy = .iso8601
        self.decoder = JSONDecoder()
        self.decoder.dateDecodingStrategy = .iso8601
    }

    public convenience init(fileManager: FileManager = .default) throws {
        guard let containerURL = fileManager.containerURL(
            forSecurityApplicationGroupIdentifier: Self.appGroupIdentifier
        ) else {
            throw ObservationJournalError.appGroupUnavailable
        }
        self.init(fileURL: containerURL.appendingPathComponent("observations.jsonl"))
    }

    public func append(_ observations: [ConnectionObservation]) throws {
        guard !observations.isEmpty else { return }
        let payload = try observations.reduce(into: Data()) { output, observation in
            output.append(try encoder.encode(observation))
            output.append(0x0A)
        }

        try lock.withLock {
            try prepareDirectory()
            try withProcessLock {
                let currentSize = fileSize(at: fileURL)
                if currentSize > 0, currentSize + UInt64(payload.count) > maximumFileSize {
                    try rotate()
                }
                let handle = try openForAppending()
                defer { try? handle.close() }
                try handle.seekToEnd()
                try handle.write(contentsOf: payload)
                try applyPrivatePermissions(to: fileURL)
            }
        }
    }

    public func latest(limit: Int = 500) throws -> [ConnectionObservation] {
        try snapshot(limit: limit).observations
    }

    public func snapshot(limit: Int = 500) throws -> ObservationJournalSnapshot {
        return try lock.withLock {
            try prepareDirectory()
            return try withProcessLock {
                let observations = try readObservations()
                var latestByKey: [String: ConnectionObservation] = [:]
                for observation in observations {
                    if let existing = latestByKey[observation.stableKey],
                       observation.lastObservedAt <= existing.lastObservedAt {
                        continue
                    } else {
                        latestByKey[observation.stableKey] = observation
                    }
                }
                let latest = limit > 0 ? latestByKey.values
                    .sorted { $0.lastObservedAt > $1.lastObservedAt }
                    .prefix(limit)
                    .map { $0 } : []
                return ObservationJournalSnapshot(
                    observations: latest,
                    statistics: statistics(for: observations)
                )
            }
        }
    }

    @discardableResult
    public func removeObservations(before cutoff: Date) throws -> Int {
        try lock.withLock {
            try prepareDirectory()
            return try withProcessLock {
                let existing = try readObservations()
                let retained = existing.filter { $0.lastObservedAt >= cutoff }
                guard retained.count != existing.count else { return 0 }
                try rewrite(retained)
                return existing.count - retained.count
            }
        }
    }

    @discardableResult
    public func removeAll() throws -> Int {
        try lock.withLock {
            try prepareDirectory()
            return try withProcessLock {
                let count = try readObservations().count
                try rewrite([])
                return count
            }
        }
    }

    private func prepareDirectory() throws {
        let directory = fileURL.deletingLastPathComponent()
        try FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
        try applyPrivatePermissions(to: directory, permissions: 0o700)
    }

    private func openForAppending() throws -> FileHandle {
        if !FileManager.default.fileExists(atPath: fileURL.path) {
            guard FileManager.default.createFile(
                atPath: fileURL.path,
                contents: nil,
                attributes: [.posixPermissions: 0o600]
            ) else {
                throw ObservationJournalError.createFailed
            }
        }
        return try FileHandle(forWritingTo: fileURL)
    }

    private func rotate() throws {
        let fileManager = FileManager.default
        if fileManager.fileExists(atPath: archiveURL.path) {
            try fileManager.removeItem(at: archiveURL)
        }
        if fileManager.fileExists(atPath: fileURL.path) {
            try fileManager.moveItem(at: fileURL, to: archiveURL)
            try applyPrivatePermissions(to: archiveURL)
        }
    }

    private func readObservations() throws -> [ConnectionObservation] {
        var observations: [ConnectionObservation] = []
        for url in [archiveURL, fileURL] where FileManager.default.fileExists(atPath: url.path) {
            let data = try Data(contentsOf: url, options: .mappedIfSafe)
            observations.append(contentsOf: data.split(separator: 0x0A).compactMap { line in
                try? decoder.decode(ConnectionObservation.self, from: Data(line))
            })
        }
        return observations
    }

    private func statistics(for observations: [ConnectionObservation]) -> ObservationJournalStatistics {
        let storedBytes = [archiveURL, fileURL].reduce(UInt64(0)) { total, url in
            total + fileSize(at: url)
        }
        return ObservationJournalStatistics(
            storedBytes: storedBytes,
            maximumStoredBytes: maximumFileSize * 2,
            recordCount: observations.count,
            oldestObservationAt: observations.map(\.lastObservedAt).min(),
            newestObservationAt: observations.map(\.lastObservedAt).max()
        )
    }

    private func rewrite(_ observations: [ConnectionObservation]) throws {
        let lines = try observations.map { observation -> Data in
            var line = try encoder.encode(observation)
            line.append(0x0A)
            return line
        }
        let currentStart = suffixStartIndex(in: lines, maximumBytes: maximumFileSize)
        let currentLines = Array(lines[currentStart...])
        let olderLines = Array(lines[..<currentStart])
        let archiveStart = suffixStartIndex(in: olderLines, maximumBytes: maximumFileSize)
        let archiveLines = Array(olderLines[archiveStart...])

        try atomicallyReplace(fileURL, with: currentLines)
        if archiveLines.isEmpty {
            if FileManager.default.fileExists(atPath: archiveURL.path) {
                try FileManager.default.removeItem(at: archiveURL)
            }
        } else {
            try atomicallyReplace(archiveURL, with: archiveLines)
        }
    }

    private func suffixStartIndex(in lines: [Data], maximumBytes: UInt64) -> Int {
        var start = lines.endIndex
        var size = UInt64(0)
        while start > lines.startIndex {
            let candidate = lines.index(before: start)
            let lineSize = UInt64(lines[candidate].count)
            if start < lines.endIndex, size + lineSize > maximumBytes {
                break
            }
            start = candidate
            size += lineSize
        }
        return start
    }

    private func atomicallyReplace(_ destination: URL, with lines: [Data]) throws {
        let temporaryURL = destination
            .deletingLastPathComponent()
            .appendingPathComponent(".\(destination.lastPathComponent).\(UUID().uuidString).tmp")
        var payload = Data()
        lines.forEach { payload.append($0) }
        try payload.write(to: temporaryURL, options: .withoutOverwriting)
        try applyPrivatePermissions(to: temporaryURL)
        guard Darwin.rename(temporaryURL.path, destination.path) == 0 else {
            let code = errno
            try? FileManager.default.removeItem(at: temporaryURL)
            throw ObservationJournalError.replaceFailed(code)
        }
    }

    private func fileSize(at url: URL) -> UInt64 {
        let attributes = try? FileManager.default.attributesOfItem(atPath: url.path)
        return (attributes?[.size] as? NSNumber)?.uint64Value ?? 0
    }

    private func withProcessLock<T>(_ operation: () throws -> T) throws -> T {
        let descriptor = Darwin.open(
            lockURL.path,
            O_CREAT | O_RDWR,
            S_IRUSR | S_IWUSR
        )
        guard descriptor >= 0 else {
            throw ObservationJournalError.lockFailed(errno)
        }
        defer { Darwin.close(descriptor) }
        guard flock(descriptor, LOCK_EX) == 0 else {
            throw ObservationJournalError.lockFailed(errno)
        }
        defer { flock(descriptor, LOCK_UN) }
        try applyPrivatePermissions(to: lockURL)
        return try operation()
    }

    private func applyPrivatePermissions(to url: URL, permissions: Int = 0o600) throws {
        try FileManager.default.setAttributes([.posixPermissions: permissions], ofItemAtPath: url.path)
    }
}

public enum ObservationJournalError: LocalizedError {
    case appGroupUnavailable
    case createFailed
    case lockFailed(Int32)
    case replaceFailed(Int32)

    public var errorDescription: String? {
        switch self {
        case .appGroupUnavailable:
            return "The EgressView App Group container is unavailable"
        case .createFailed:
            return "The local observation journal could not be created"
        case .lockFailed(let code):
            return "The local observation journal could not be locked (errno \(code))"
        case .replaceFailed(let code):
            return "The local observation journal could not be replaced (errno \(code))"
        }
    }
}

private extension NSLock {
    func withLock<T>(_ operation: () throws -> T) rethrows -> T {
        lock()
        defer { unlock() }
        return try operation()
    }
}
