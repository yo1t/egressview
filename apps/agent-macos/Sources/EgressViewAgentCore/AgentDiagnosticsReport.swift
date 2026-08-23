import Foundation

/// How much this Mac has stored, and over what span. Counts and dates only.
public struct ObservationStorageSummary: Equatable, Sendable {
    public let rawObservationCount: Int
    /// Two aggregates, reported separately. `hourly_rollup` is the older
    /// fold and `chart_hourly` is what the charts read since P3-33; a single
    /// "rolled up" figure showed 0 on a machine holding 82,201 chart rows,
    /// which reads as "nothing was folded" when the opposite is true.
    public let rolledUpHourCount: Int
    public let chartHourCount: Int
    public let threatIndicatorCount: Int
    public let oldestObservationAt: Date?
    public let newestObservationAt: Date?

    public init(
        rawObservationCount: Int,
        rolledUpHourCount: Int,
        chartHourCount: Int,
        threatIndicatorCount: Int,
        oldestObservationAt: Date?,
        newestObservationAt: Date?
    ) {
        self.rawObservationCount = rawObservationCount
        self.rolledUpHourCount = rolledUpHourCount
        self.chartHourCount = chartHourCount
        self.threatIndicatorCount = threatIndicatorCount
        self.oldestObservationAt = oldestObservationAt
        self.newestObservationAt = newestObservationAt
    }
}

/// The report a user exports when the agent misbehaves, so a fault can be
/// examined instead of described.
///
/// On 2026-08-18 this Mac recorded nothing for thirteen and a half hours and
/// there was nothing to look at afterwards. Every field here exists because it
/// would have narrowed that down: which build was running, whether the
/// extension answered, when the last observation actually landed, whether the
/// installer's relaunch worked.
///
/// **It carries no destination address, process name or hostname.** A tool
/// that watches what leaves a machine must not be the thing that carries it
/// out. The inputs are typed so they cannot hold one -- the storage summary is
/// counts and dates, not rows -- and the one free-text field, the install log,
/// is redacted before it is included.
public struct AgentDiagnosticsReport: Sendable {
    /// What happened when the installer log was read.
    public enum InstallLog: Sendable, Equatable {
        case contents(String)
        case absent
        /// The file exists as far as anyone else is concerned; this process
        /// could not open it.
        case unreadable(String)
    }

    public struct Inputs: Sendable {
        public var generatedAt: Date
        public var appVersion: String
        public var appBuild: String
        public var osVersion: String
        public var extensionState: String
        /// What is inside the app, always readable.
        public var bundledExtensionVersion: String?
        /// What macOS last said it is running. Nil is the ordinary state on a
        /// healthy Mac: the probe runs only when collection has gone quiet,
        /// because macOS retains request state for every one submitted. A
        /// mismatch between this and the bundled version is the shape of a
        /// real fault, so both are reported rather than one merged figure.
        public var runningExtensionVersion: String?
        public var monitoringEnabled: Bool
        public var health: String
        public var lastObservationAt: Date?
        public var storage: ObservationStorageSummary
        public var isEnrolledWithHub: Bool
        public var deliveryEnabled: Bool
        public var pendingDeliveryCount: Int
        public var oldestPendingAt: Date?
        public var lastAcknowledgedAt: Date?
        public var unreadableStateResetAt: Date?
        public var threatIntelSource: String
        /// Three states, not two. A sandboxed app cannot read /var/log, and
        /// reporting that as "absent" sends the reader looking for a missing
        /// file instead of at the sandbox.
        public var installLog: InstallLog

        public init(
            generatedAt: Date, appVersion: String, appBuild: String, osVersion: String,
            extensionState: String, bundledExtensionVersion: String?,
            runningExtensionVersion: String?, monitoringEnabled: Bool,
            health: String, lastObservationAt: Date?, storage: ObservationStorageSummary,
            isEnrolledWithHub: Bool, deliveryEnabled: Bool, pendingDeliveryCount: Int,
            oldestPendingAt: Date?, lastAcknowledgedAt: Date?, unreadableStateResetAt: Date?,
            threatIntelSource: String, installLog: InstallLog
        ) {
            self.generatedAt = generatedAt
            self.appVersion = appVersion
            self.appBuild = appBuild
            self.osVersion = osVersion
            self.extensionState = extensionState
            self.bundledExtensionVersion = bundledExtensionVersion
            self.runningExtensionVersion = runningExtensionVersion
            self.monitoringEnabled = monitoringEnabled
            self.health = health
            self.lastObservationAt = lastObservationAt
            self.storage = storage
            self.isEnrolledWithHub = isEnrolledWithHub
            self.deliveryEnabled = deliveryEnabled
            self.pendingDeliveryCount = pendingDeliveryCount
            self.oldestPendingAt = oldestPendingAt
            self.lastAcknowledgedAt = lastAcknowledgedAt
            self.unreadableStateResetAt = unreadableStateResetAt
            self.threatIntelSource = threatIntelSource
            self.installLog = installLog
        }
    }

    /// Lines kept from the installer log. Enough to see the last few installs
    /// without turning the report into a file nobody reads.
    public static let installLogLineLimit = 80

    private let inputs: Inputs

    public init(_ inputs: Inputs) { self.inputs = inputs }

    /// Replaces the account name in home paths. The installer log records the
    /// console user, and a person's account name is not needed to diagnose a
    /// failed relaunch.
    public static func redactAccountNames(_ text: String) -> String {
        var output = text
        for pattern in [
            #"/Users/[^/\s"']+"#,
            #"(?i)(console user:?\s*)\S+"#,
            #"(?i)(asuser\s+)\d+"#,
        ] {
            guard let regex = try? NSRegularExpression(pattern: pattern) else { continue }
            let range = NSRange(output.startIndex..., in: output)
            let template = pattern.hasPrefix("/Users/") ? "/Users/<redacted>" : "$1<redacted>"
            output = regex.stringByReplacingMatches(
                in: output, range: range, withTemplate: template
            )
        }
        return output
    }

    /// The last lines of the installer log, redacted and bounded.
    public static func prepareInstallLog(_ text: String?) -> String? {
        guard let text, !text.isEmpty else { return nil }
        let lines = text.split(whereSeparator: \.isNewline)
        let kept = lines.suffix(installLogLineLimit).joined(separator: "\n")
        return redactAccountNames(kept)
    }

    public func render() -> String {
        let stamp = ISO8601DateFormatter()
        stamp.formatOptions = [.withInternetDateTime]
        func when(_ date: Date?) -> String {
            date.map { stamp.string(from: $0) } ?? "never"
        }

        // Padded to the longest label so the file reads as a table. A report
        // is only useful if someone actually reads it.
        func row(_ label: String, _ value: String) -> String {
            "  " + label.padding(toLength: 18, withPad: " ", startingAt: 0) + value
        }

        var lines: [String] = []
        lines.append("EgressView Agent diagnostics")
        lines.append("Generated \(when(inputs.generatedAt))")
        lines.append("")
        lines.append("This file contains no destination address, process name or host name.")
        lines.append("It is plain text so you can read all of it before sending it.")
        lines.append("")
        lines.append("== This Mac")
        lines.append(row("agent", "\(inputs.appVersion) build \(inputs.appBuild)"))
        lines.append(row("macOS", "\(inputs.osVersion)"))
        lines.append("")
        lines.append("== Monitoring")
        lines.append(row("extension", "\(inputs.extensionState)"))
        lines.append(row("extension bundled", inputs.bundledExtensionVersion ?? "unreadable"))
        lines.append(row("extension running", inputs.runningExtensionVersion
            ?? "not asked -- macOS is only queried when collection goes quiet"))
        lines.append(row("enabled", "\(inputs.monitoringEnabled ? "yes" : "no")"))
        lines.append(row("health", inputs.health.isEmpty ? "no warning" : inputs.health))
        lines.append(row("last observation", "\(when(inputs.lastObservationAt))"))
        lines.append("")
        lines.append("== Stored on this Mac")
        lines.append(row("observations", "\(inputs.storage.rawObservationCount)"))
        lines.append(row("folded hours", "\(inputs.storage.rolledUpHourCount)"))
        lines.append(row("chart hours", "\(inputs.storage.chartHourCount)"))
        lines.append(row("threat indicators", "\(inputs.storage.threatIndicatorCount)"))
        lines.append(row("oldest", "\(when(inputs.storage.oldestObservationAt))"))
        lines.append(row("newest", "\(when(inputs.storage.newestObservationAt))"))
        lines.append(row("threat source", "\(inputs.threatIntelSource)"))
        lines.append("")
        lines.append("== Hub")
        lines.append(row("enrolled", "\(inputs.isEnrolledWithHub ? "yes" : "no")"))
        lines.append(row("delivery", "\(inputs.deliveryEnabled ? "on" : "off")"))
        lines.append(row("pending", "\(inputs.pendingDeliveryCount)"))
        lines.append(row("oldest pending", "\(when(inputs.oldestPendingAt))"))
        lines.append(row("last acknowledged", "\(when(inputs.lastAcknowledgedAt))"))
        if let reset = inputs.unreadableStateResetAt {
            lines.append(row("queue reset", "\(when(reset)) -- what it held never reached the Hub"))
        }
        lines.append("")
        lines.append("== Installer log")
        switch inputs.installLog {
        case .contents(let raw):
            if let log = Self.prepareInstallLog(raw) {
                lines.append("  last \(Self.installLogLineLimit) lines, account names removed")
                lines.append("")
                lines.append(log)
            } else {
                lines.append("  empty")
            }
        case .absent:
            lines.append("  absent -- no install has recorded anything here")
        case .unreadable(let reason):
            // Said plainly, because it is the expected state: the agent is
            // sandboxed and /var/log is outside it. The log is still there for
            // whoever asked for this file to read directly.
            lines.append("  not readable by the agent (sandboxed): \(reason)")
            lines.append("  read it directly: sudo tail -40 /var/log/egressview-agent-install.log")
        }
        lines.append("")
        return lines.joined(separator: "\n")
    }
}
