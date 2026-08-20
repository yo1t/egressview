import EgressViewAgentCore
import Foundation

/// Keeps the local threat indicator set up to date.
///
/// Two sources, and the choice between them is never made automatically. A Hub
/// supplies the indicators when there is one; without a Hub the agent can
/// download the same public feeds itself, but only if the user turned that on.
///
/// Deriving the source from whether the Hub is reachable would mean an hour of
/// Hub downtime silently starts contacting third parties -- the traffic leaving
/// this Mac would change with nobody touching anything. So a Hub-enrolled agent
/// uses its Hub and says the data is stale when it cannot; it does not fall
/// back.
@MainActor
final class ThreatIntelController: ObservableObject {
    enum Status: Equatable {
        case idle
        case fetching
        case updated(count: Int, at: Date)
        case unchanged(at: Date)
        case hubHasNoFeeds
        case notEnabled
        case failed(String)
        /// Fetched, but not from everywhere. The count is real and incomplete,
        /// and saying only the count would hide that.
        case partial(count: Int, missing: [String], at: Date)
    }

    @Published private(set) var status: Status = .idle
    @Published private(set) var availability: ThreatIntelAvailability = .notFetchedYet

    private let store: ObservationStore?
    private let credentialStore: any AgentCredentialStoring
    private let agentVersion: String
    private let preferences = ThreatIntelPreferences()
    private let timer = PeriodicWork()

    /// Refreshed hourly. The feeds move a few times a day, so an hourly check
    /// is mostly 304s, and a longer interval would leave a newly enrolled Mac
    /// unable to say anything for most of a day.
    private static let refreshInterval: TimeInterval = 3_600

    init(
        store: ObservationStore?,
        credentialStore: any AgentCredentialStoring,
        agentVersion: String
    ) {
        self.store = store
        self.credentialStore = credentialStore
        self.agentVersion = agentVersion
    }

    /// Whether a Hub credential is stored.
    ///
    /// Cached. This is read from SwiftUI `body`, which re-evaluates freely, and
    /// the underlying call is a **synchronous keychain read**. On 2026-08-19 the
    /// agent's main thread was seen wedged inside exactly that call, waiting on
    /// `securityd` in every sample. A settings screen must not be able to hang
    /// the app by being redrawn.
    ///
    /// Enrolment changes rarely and never behind the app's back, so re-reading
    /// per redraw bought nothing. `refresh()` picks up a change on its next run;
    /// `forgetHubState()` makes it immediate when enrolment is what changed.
    /// **Assumed true until the keychain has actually been read.**
    ///
    /// The unknown state has to fall somewhere, and it falls on the side that
    /// offers the user less: while this is a guess, the direct-download setting
    /// stays hidden. Guessing the other way would put a third-party download
    /// switch in front of someone whose Hub supplies the same data, on no
    /// evidence at all.
    ///
    /// Published rather than read on demand, because `body` re-evaluates freely
    /// and reading it means a **synchronous keychain call**. The agent's main
    /// thread was found wedged inside one on 2026-08-19, in every frame of a
    /// three-second profile. A settings screen must not be able to hang the app
    /// by being redrawn.
    @Published private(set) var hasHub = true

    /// Reads enrolment off the main thread and publishes it.
    func refreshHubState() async {
        hasHub = await credentialStore.loadDetached() != nil
    }

    /// Call when the agent enrols or un-enrols, so the next look is fresh.
    func forgetHubState() {
        Task {
            await refreshHubState()
            await refresh()
        }
    }

    /// Only offered without a Hub. Offering both would mean contacting third
    /// parties for something already in hand, and the promise that no
    /// destination leaves this Mac would quietly stop being true.
    var isDirectDownloadAvailable: Bool { !hasHub }

    /// The one rule that picks a source, stated in `ThreatIntelSource` and
    /// pinned by tests there. Read from enrolment, never from whether the Hub
    /// answered.
    private var source: ThreatIntelSource {
        ThreatIntelSource.decide(
            isEnrolledWithHub: hasHub,
            isDirectDownloadEnabled: preferences.isDirectDownloadEnabled
        )
    }

    var isDirectDownloadEnabled: Bool {
        get { preferences.isDirectDownloadEnabled }
        set {
            preferences.isDirectDownloadEnabled = newValue
            if !newValue {
                // Turning it off clears what it produced. A setting that leaves
                // its results behind has not really been turned off.
                try? store?.replaceThreatIndicators([])
                preferences.etag = nil
                availability = .notEnabled
                status = .notEnabled
            }
            Task { await refresh() }
        }
    }

    func start() {
        loadAvailabilityFromStore()
        Task {
            // Before anything reads it, so the settings screen never sees the
            // assumed value for longer than it takes to answer.
            await refreshHubState()
            await refresh()
        }
        timer.start(every: Self.refreshInterval) { [weak self] in
            Task { @MainActor in await self?.refresh() }
        }
    }

    func stop() {
        timer.stop()
    }

    private func loadAvailabilityFromStore() {
        guard let store, let count = try? store.threatIndicatorCount(), count > 0 else { return }
        availability = .checked(indicatorCount: count, fetchedAt: preferences.lastFetch)
    }

    func refresh() async {
        guard let store else { return }
        switch source {
        case .hub:
            // A missing credential here would mean it disappeared between the
            // decision and now. Nothing is fetched, and in particular the
            // third-party path is not reached: an unreadable keychain must not
            // look like "no Hub".
            guard let credential = await credentialStore.loadDetached() else { return }
            await refreshFromHub(store: store, credential: credential)
        case .directDownload:
            await refreshFromFeeds(store: store)
        case .none:
            // Nothing is fetching them, so nothing should still be matched
            // against them. Leaving the last Hub's indicators in place while
            // the screen says "not switched on" makes the two disagree, and
            // findings would be attributed to a source no longer in use.
            if (try? store.threatIndicatorCount()).map({ $0 > 0 }) ?? false {
                try? store.replaceThreatIndicators([])
                preferences.etag = nil
            }
            availability = .notEnabled
            status = .notEnabled
        }
    }

    private func refreshFromHub(store: ObservationStore, credential: AgentCredential) async {
        status = .fetching
        let fetcher = ThreatIntelFetcher(
            hubURL: credential.hubURL,
            token: credential.token,
            userAgent: "EgressViewAgent/\(agentVersion)"
        )
        do {
            switch try await fetcher.fetch(knownETag: preferences.etag) {
            case .unchanged:
                preferences.lastFetch = Date()
                status = .unchanged(at: Date())
                loadAvailabilityFromStore()
            case .hubHasNoFeeds:
                // Not an error, and not "no threats". The Hub is simply not
                // running feeds, and the screen has to say which.
                try store.replaceThreatIndicators([])
                availability = .hubHasNoFeeds
                status = .hubHasNoFeeds
            case let .updated(indicators, etag, fetchedAt):
                try store.replaceThreatIndicators(indicators)
                preferences.etag = etag
                preferences.lastFetch = Date()
                availability = .checked(
                    indicatorCount: indicators.count, fetchedAt: fetchedAt ?? Date()
                )
                status = .updated(count: indicators.count, at: Date())
            }
        } catch {
            // What is already stored is kept. A failed fetch is not evidence
            // that the indicators in hand are wrong, and dropping them would
            // turn a network blip into "no threats found".
            status = .failed(Self.describe(error))
            loadAvailabilityFromStore()
        }
    }

    private func refreshFromFeeds(store: ObservationStore) async {
        status = .fetching
        do {
            let result = try await ThreatFeedDownloader().download()
            try store.replaceThreatIndicators(result.indicators)
            preferences.lastFetch = Date()
            availability = .checked(indicatorCount: result.indicators.count, fetchedAt: Date())
            status = result.isComplete
                ? .updated(count: result.indicators.count, at: Date())
                : .partial(
                    count: result.indicators.count,
                    missing: result.missingSources,
                    at: Date()
                )
        } catch {
            status = .failed(Self.describe(error))
            loadAvailabilityFromStore()
        }
    }

    static func describe(_ error: any Error) -> String {
        switch error {
        case ThreatIntelFetchError.insecureURL:
            return L("The Hub address is not HTTPS, so threat information was not requested.")
        case let ThreatIntelFetchError.httpStatus(code) where code == 401 || code == 403:
            return L("The Hub refused the request. Re-enrol this Mac to fetch threat information.")
        case let ThreatIntelFetchError.httpStatus(code):
            return L("The Hub returned HTTP %lld.", code)
        case let ThreatIntelFetchError.unsupportedSchemaVersion(version):
            return L("This Hub sends threat data this agent does not understand (version %lld).", version)
        case let ThreatIntelFetchError.transport(reason):
            return L("Could not reach the Hub: %@", reason)
        default:
            return String(describing: error)
        }
    }
}
