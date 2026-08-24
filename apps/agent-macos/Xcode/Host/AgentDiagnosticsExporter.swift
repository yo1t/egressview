import AppKit
import EgressViewAgentCore
import os

/// Writes the diagnostics report to a file the user chooses.
///
/// It writes rather than sends. A send would add a destination to the list of
/// things this agent promises about, and the promise is short on purpose. The
/// file is plain text so the user can read all of it before passing it on.
@MainActor
final class AgentDiagnosticsExporter {
    private let logger = Logger(subsystem: "com.egressview.agent.macos", category: "diagnostics")
    private let installLogPath = "/var/log/egressview-agent-install.log"

    /// Optional on purpose. A store that could not be opened is one of the
    /// faults this report has to be able to describe, so requiring one would
    /// make the export unavailable in exactly that case.
    private let store: ObservationStore?
    private let extensionVersion: () -> SystemExtensionVersion?
    private let monitoring: () -> AgentMonitoringStatus
    private let hubDelivery: HubDeliveryController
    private let threatIntel: ThreatIntelController

    init(
        store: ObservationStore?,
        extensionVersion: @escaping () -> SystemExtensionVersion?,
        monitoring: @escaping () -> AgentMonitoringStatus,
        hubDelivery: HubDeliveryController,
        threatIntel: ThreatIntelController
    ) {
        self.store = store
        self.extensionVersion = extensionVersion
        self.monitoring = monitoring
        self.hubDelivery = hubDelivery
        self.threatIntel = threatIntel
    }

    func export() {
        let report = AgentDiagnosticsReport(gather()).render()

        NSApplication.shared.activate(ignoringOtherApps: true)
        let panel = NSSavePanel()
        panel.title = L("Save EgressView Agent diagnostics")
        panel.nameFieldStringValue = defaultFileName()
        panel.allowedContentTypes = [.plainText]
        // The point of writing rather than sending is that the user can look
        // first. Say so where they are deciding.
        panel.message = L("Plain text, containing no destination address, process name or host name. Open it and read it before you send it anywhere.")

        guard panel.runModal() == .OK, let url = panel.url else { return }
        do {
            try report.write(to: url, atomically: true, encoding: .utf8)
        } catch {
            logger.error("diagnostics export failed: \(error.localizedDescription, privacy: .public)")
            let alert = NSAlert()
            alert.messageText = L("Could not save the diagnostics file")
            alert.informativeText = error.localizedDescription
            alert.runModal()
        }
    }

    /// A sandboxed app cannot read /var/log. Saying so is the point: "absent"
    /// would send the reader looking for a missing file instead of at the
    /// sandbox, and the log is still there for whoever asked for this export.
    private func readInstallLog() -> AgentDiagnosticsReport.InstallLog {
        guard FileManager.default.fileExists(atPath: installLogPath) else {
            // The sandbox hides it rather than reporting it missing, so a
            // negative here is not proof of absence either.
            return .unreadable("not visible from inside the app sandbox")
        }
        do {
            return .contents(try String(contentsOfFile: installLogPath, encoding: .utf8))
        } catch {
            return .unreadable(error.localizedDescription)
        }
    }

    /// Read straight out of the app, so it is present even on a Mac where
    /// nothing has gone wrong. The probe that reports what macOS is *running*
    /// only fires during silence, which meant this field said "unknown" on
    /// every healthy machine -- exactly the machines a first report comes from.
    private func bundledExtensionVersion() -> String? {
        let url = Bundle.main.bundleURL
            .appendingPathComponent("Contents/Library/SystemExtensions")
            .appendingPathComponent("com.egressview.agent.filter.systemextension")
            .appendingPathComponent("Contents/Info.plist")
        guard let plist = NSDictionary(contentsOf: url),
              let short = plist["CFBundleShortVersionString"] as? String,
              let build = plist["CFBundleVersion"] as? String
        else { return nil }
        return "\(short) build \(build)"
    }

    private func defaultFileName() -> String {
        let stamp = DateFormatter()
        stamp.dateFormat = "yyyyMMdd-HHmmss"
        return "egressview-agent-diagnostics-\(stamp.string(from: Date())).txt"
    }

    /// Every read here is defensive. The report is wanted precisely when
    /// something is broken, so a failure to read one field must not lose the
    /// other fields with it.
    private func gather() -> AgentDiagnosticsReport.Inputs {
        let status = monitoring()
        // -1 rather than 0: "could not be read" and "nothing stored" are
        // different faults, and reporting the second when the first happened
        // would send the reader looking in the wrong place.
        let storage = (try? store?.storageSummary()) ?? ObservationStorageSummary(
            rawObservationCount: -1, rolledUpHourCount: -1, chartHourCount: -1,
            threatIndicatorCount: -1,
            oldestObservationAt: nil, newestObservationAt: nil
        )
        // Taken from the controller rather than by reopening the queue: a
        // second handle while the sender holds it would fail exactly when the
        // agent is already in the state this export exists to explain.
        let queue = hubDelivery.latestQueueStatus
        let info = Bundle.main.infoDictionary ?? [:]

        return AgentDiagnosticsReport.Inputs(
            generatedAt: Date(),
            appVersion: info["CFBundleShortVersionString"] as? String ?? "unknown",
            appBuild: info["CFBundleVersion"] as? String ?? "unknown",
            osVersion: ProcessInfo.processInfo.operatingSystemVersionString,
            // The status label is what the user sees in the menu bar, so a
            // report and a screenshot describe the same thing.
            extensionState: status.label,
            bundledExtensionVersion: bundledExtensionVersion(),
            runningExtensionVersion: extensionVersion().map {
                "\($0.shortVersion) build \($0.bundleVersion)"
            },
            monitoringEnabled: status.isMonitoringOn,
            health: status.menuBarLabel.isEmpty ? "no warning" : status.menuBarLabel,
            lastObservationAt: storage.newestObservationAt,
            storage: storage,
            isEnrolledWithHub: threatIntel.hasHub,
            deliveryEnabled: hubDelivery.deliveryEnabled,
            pendingDeliveryCount: queue?.pendingCount ?? -1,
            oldestPendingAt: queue?.oldestPendingAt,
            lastAcknowledgedAt: queue?.lastAcknowledgedAt,
            unreadableStateResetAt: queue?.unreadableStateResetAt,
            threatIntelSource: String(describing: threatIntel.activeSource),
            // Read fresh rather than held: the export exists to describe a
            // fault, and a copy taken at launch would predate it.
            runHistory: AgentRunRecorder.inAppGroup()?.snapshot() ?? AgentRunHistory(),
            installLog: readInstallLog()
        )
    }
}
