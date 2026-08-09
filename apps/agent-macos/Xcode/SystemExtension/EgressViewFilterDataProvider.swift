import EgressViewAgentCore
import EgressViewNetworkExtension
import OSLog

final class EgressViewFilterDataProvider: PassOnlyFilterDataProvider {
    private let logger = Logger(subsystem: "com.egressview.agent.filter", category: "observation-storage")
    private var journal: ObservationJournal?

    override func startFilter(completionHandler: @escaping (Error?) -> Void) {
        do {
            journal = try ObservationJournal()
            completionHandler(nil)
        } catch {
            logger.error("EgressView App Group storage is unavailable: \(error.localizedDescription, privacy: .public)")
            completionHandler(error)
        }
    }

    override func didObserve(_ observation: ConnectionObservation) {
        guard let journal else {
            return
        }
        do {
            try journal.append([observation])
        } catch {
            logger.error("EgressView could not store flow metadata: \(error.localizedDescription, privacy: .public)")
        }
    }
}
