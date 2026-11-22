import EgressViewAgentUI
import EgressViewAgentCore
import Foundation
import os

extension Notification.Name {
    /// Posted when the person answers a candidate, takes an answer back, or
    /// forgets all of them, so a shared list follows without waiting an hour.
    static let outboundCandidateAnswersChanged = Notification.Name("EgressViewOutboundCandidateAnswersChanged")
    /// Posted when answers the Hub's administrator gave were taken in, so the
    /// window shows them without waiting for its next refresh.
    static let outboundCandidateAnswersTakenFromHub = Notification.Name("EgressViewOutboundCandidateAnswersTakenFromHub")
}

/// Sends the "worth a look" list and the person's answers to the Hub, when the
/// person turned that on in Settings (P3-194).
///
/// Checked every hour and whenever an answer or the setting changes; sent only
/// when what the Hub would show has changed, or six hours have passed. Turning
/// it off sends one request that deletes the list from the Hub, and keeps
/// trying until the Hub has taken it.
///
/// While sharing is on, it also takes in the answers the Hub's administrator
/// gave (P3-194 stage 2): as soon as a delivery reply says the Hub's answers
/// changed, which on a Mac that is delivering is within seconds, and every
/// hour in case no reply came.
@MainActor
final class OutboundCandidateSharingController: ObservableObject {
    static let shared = OutboundCandidateSharingController()

    enum Status: Equatable {
        case off
        case notEnrolled
        case waiting
        case sent(at: Date)
        case removedFromHub
        case hubTooOld
        case failed(String)
    }

    @Published private(set) var status: Status = .off
    @Published var isEnabled: Bool {
        didSet {
            guard isEnabled != oldValue else { return }
            preferences.isEnabled = isEnabled
            if isEnabled { preferences.lastSentHash = nil }
            check()
        }
    }
    @Published var includesNotes: Bool {
        didSet {
            guard includesNotes != oldValue else { return }
            preferences.includesNotes = includesNotes
            check()
        }
    }

    private let logger = Logger(subsystem: "com.egressview.agent.macos", category: "candidate-sharing")
    private let preferences = OutboundCandidateSharingPreferences()
    private let timer = PeriodicWork()
    private var store: ObservationStore?
    private var credentialStore: (any AgentCredentialStoring)?
    private var userAgent = "EgressViewAgent/unknown"
    private var isSending = false
    private var checkAgain = false
    private var observer: NSObjectProtocol?
    private var isTakingIn = false
    private var takeInFailedAt: Date?

    private static let checkInterval: TimeInterval = 3_600
    /// After a failed fetch, delivery replies (every few seconds) do not ask
    /// again for this long.
    private static let takeInRetryInterval: TimeInterval = 60

    private init() {
        isEnabled = preferences.isEnabled
        includesNotes = preferences.includesNotes
        status = preferences.isEnabled ? .waiting : .off
    }

    func start(store: ObservationStore?, credentialStore: any AgentCredentialStoring, agentVersion: String) {
        self.store = store
        self.credentialStore = credentialStore
        userAgent = "EgressViewAgent/\(agentVersion)"
        observer = NotificationCenter.default.addObserver(
            forName: .outboundCandidateAnswersChanged, object: nil, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.check() }
        }
        timer.start(every: Self.checkInterval, runNow: true) { [weak self] in
            MainActor.assumeIsolated {
                self?.check()
                self?.takeInAnswers(hourly: true)
            }
        }
    }

    func stop() {
        timer.stop()
        if let observer { NotificationCenter.default.removeObserver(observer) }
        observer = nil
    }

    /// What a delivery reply said about the Hub's answers: nil from a Hub
    /// that does not answer candidates.
    func hubAnswersVersion(_ version: Int?) {
        guard let version else {
            noteHubTakesAnswers(false)
            return
        }
        noteHubTakesAnswers(true)
        if version != preferences.appliedAnswersVersion { takeInAnswers(hourly: false) }
    }

    /// A Hub that starts or stops answering candidates is sent the list again,
    /// with or without `notesShared`.
    private func noteHubTakesAnswers(_ value: Bool) {
        guard preferences.hubTakesAnswers != value else { return }
        preferences.hubTakesAnswers = value
        if !value { preferences.hubHasNotesShared = false }
        preferences.lastSentHash = nil
        check()
    }

    /// Fetches and applies the Hub's answers. The hourly call also asks a Hub
    /// not yet known to answer, which is how a Mac that shares the list but
    /// does not deliver observations finds out.
    private func takeInAnswers(hourly: Bool) {
        guard preferences.isEnabled, !isTakingIn else { return }
        guard hourly || preferences.hubTakesAnswers else { return }
        if !hourly, let failed = takeInFailedAt, Date().timeIntervalSince(failed) < Self.takeInRetryInterval { return }
        guard let store, let credentialStore else { return }
        isTakingIn = true
        Task { [weak self] in
            await self?.runTakeIn(store: store, credentialStore: credentialStore)
            self?.isTakingIn = false
        }
    }

    private func runTakeIn(store: ObservationStore, credentialStore: any AgentCredentialStoring) async {
        guard let credential = await credentialStore.loadDetached() else { return }
        let fetcher = OutboundCandidateAnswersFetcher(
            hubURL: credential.hubURL, token: credential.token, userAgent: userAgent
        )
        do {
            let answers = try await fetcher.fetch()
            noteHubTakesAnswers(true)
            let takesNotes = preferences.hubHasNotesShared && preferences.includesNotes
            let changed = try await Task.detached(priority: .utility) { () throws -> Int in
                let report = try store.outboundCandidates()
                return try store.applyHubOutboundCandidateAnswers(
                    answers.answers, candidates: report.candidates, takesNotes: takesNotes
                )
            }.value
            preferences.appliedAnswersVersion = answers.version
            takeInFailedAt = nil
            if changed > 0 {
                logger.notice("took in hub answers changed=\(changed, privacy: .public) version=\(answers.version, privacy: .public)")
                NotificationCenter.default.post(name: .outboundCandidateAnswersTakenFromHub, object: nil)
                // Sends the list back with the new answers, so the Hub sees
                // this Mac has them.
                NotificationCenter.default.post(name: .outboundCandidateAnswersChanged, object: nil)
            }
        } catch OutboundCandidateShareError.hubTooOld {
            noteHubTakesAnswers(false)
        } catch {
            takeInFailedAt = Date()
            logger.error("taking in hub answers failed: \(String(describing: error), privacy: .public)")
        }
    }

    /// Sends if something is owed. A check that arrives during a send runs
    /// once more afterwards, so the last change is never left unsent.
    func check() {
        guard !isSending else { checkAgain = true; return }
        isSending = true
        Task { [weak self] in
            await self?.run()
            guard let self else { return }
            self.isSending = false
            if self.checkAgain {
                self.checkAgain = false
                self.check()
            }
        }
    }

    private func run() async {
        let enabled = preferences.isEnabled
        guard enabled || preferences.hubMayHoldList else {
            status = .off
            return
        }
        guard let store, let credentialStore else { return }
        guard let credential = await credentialStore.loadDetached() else {
            status = enabled ? .notEnrolled : .off
            return
        }

        let payload: OutboundCandidateSharePayload?
        if enabled {
            let notes = preferences.includesNotes
            let takesAnswers = preferences.hubTakesAnswers
            payload = await Task.detached(priority: .utility) { () -> OutboundCandidateSharePayload? in
                guard let report = try? store.outboundCandidates(),
                      let judgments = try? store.outboundCandidateJudgments()
                else { return nil }
                return OutboundCandidateSharePayload(
                    report: report, judgments: judgments, includesNotes: notes, hubTakesAnswers: takesAnswers
                )
            }.value
            guard payload != nil else {
                status = .failed(L("The list could not be read."))
                return
            }
        } else {
            payload = nil
        }

        let hash = try? payload?.contentHash()
        let plan = OutboundCandidateSharePlan.decide(
            isEnabled: enabled, hubMayHoldList: preferences.hubMayHoldList,
            lastSentHash: preferences.lastSentHash, lastSentAt: preferences.lastSentAt,
            currentHash: hash
        )
        let uploader = OutboundCandidateUploader(
            hubURL: credential.hubURL, token: credential.token, userAgent: userAgent
        )
        do {
            switch plan {
            case .nothing:
                if enabled, let at = preferences.lastSentAt { status = .sent(at: at) }
                return
            case .sendList:
                guard let payload else { return }
                try await uploader.send(payload)
                let now = Date()
                preferences.lastSentHash = hash
                preferences.lastSentAt = now
                preferences.hubMayHoldList = true
                preferences.hubHasNotesShared = payload.notesShared == true
                status = .sent(at: now)
                logger.notice("sent entries=\(payload.entries.count, privacy: .public) total=\(payload.total, privacy: .public)")
            case .sendOff:
                try await uploader.send(.off())
                preferences.hubMayHoldList = false
                preferences.hubHasNotesShared = false
                preferences.appliedAnswersVersion = nil
                preferences.lastSentHash = nil
                preferences.lastSentAt = nil
                status = .removedFromHub
                logger.notice("removed from hub")
            }
        } catch OutboundCandidateShareError.hubTooOld {
            // Nothing reached it, so nothing is held there.
            if !enabled { preferences.hubMayHoldList = false }
            status = .hubTooOld
        } catch {
            logger.error("send failed: \(String(describing: error), privacy: .public)")
            status = .failed(Self.describe(error))
        }
    }

    private static func describe(_ error: Error) -> String {
        switch error as? OutboundCandidateShareError {
        case .insecureURL:
            return L("Not sent: the Hub address is not HTTPS.")
        case .httpStatus(let code):
            return String(format: L("Not sent: the Hub answered %lld."), Int64(code))
        default:
            return L("Not sent: the Hub could not be reached. It is tried again within an hour.")
        }
    }

    var statusText: String {
        switch status {
        case .off:
            return L("Not sent.")
        case .notEnrolled:
            return L("Not sent: this Mac is not enrolled with a Hub.")
        case .waiting:
            return L("Waiting to send.")
        case .sent(let at):
            return String(format: L("Last sent %@."), at.formatted(date: .abbreviated, time: .shortened))
        case .removedFromHub:
            return L("Removed from the Hub.")
        case .hubTooOld:
            return L("Not sent: the Hub is too old to receive this. Update the Hub.")
        case .failed(let message):
            return message
        }
    }
}
