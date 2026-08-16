import Foundation

/// Which rows of the connection log to show.
///
/// One value per column, because the questions asked of this table are
/// per-column ones: what did Safari do, what went to Ireland, what is still
/// open. A single search box cannot express "UDP to port 443" at all.
public struct ConnectionLogFilter: Equatable, Sendable {
    /// Whether a row's data volume was ever measured.
    public enum Volume: String, CaseIterable, Sendable {
        case any
        case measured
        case unmeasured
    }

    public var application = ""
    public var destination = ""
    /// ISO country code, or nil for every country. The empty-string case is
    /// distinct: it means "rows whose address was never placed".
    public var country: String?
    public var isUnplacedCountryOnly = false
    public var networkProtocol: InternetProtocol?
    public var port = ""
    public var collector: CollectorKind?
    public var volume: Volume = .any

    public init() {}

    public var isActive: Bool {
        self != ConnectionLogFilter()
    }

    /// `destinationText` is what the row actually shows, so filtering matches
    /// what the user can see. Typing a hostname must not fail because the row
    /// is stored by address.
    public func matches(
        _ observation: ConnectionObservation,
        destinationText: String,
        countryCode: String?
    ) -> Bool {
        if !application.isEmpty,
           !observation.processName.localizedCaseInsensitiveContains(application) {
            return false
        }
        if !destination.isEmpty,
           !destinationText.localizedCaseInsensitiveContains(destination) {
            return false
        }
        if isUnplacedCountryOnly {
            if countryCode != nil { return false }
        } else if let country, countryCode != country {
            return false
        }
        if let networkProtocol, observation.networkProtocol != networkProtocol {
            return false
        }
        if !port.isEmpty, !String(observation.remotePort).hasPrefix(port) {
            return false
        }
        if let collector, observation.collector != collector {
            return false
        }
        switch volume {
        case .any:
            break
        case .measured:
            if observation.bytesIn == nil && observation.bytesOut == nil { return false }
        case .unmeasured:
            if observation.bytesIn != nil || observation.bytesOut != nil { return false }
        }
        return true
    }
}
