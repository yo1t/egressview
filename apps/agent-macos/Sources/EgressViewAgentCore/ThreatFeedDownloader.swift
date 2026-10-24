import Foundation

/// Downloads the same public threat feeds the Hub reads, for agents that have
/// no Hub.
///
/// These are plain list downloads, not lookup services: no query, and **no
/// destination from this Mac is sent anywhere**. What it does reveal is that
/// this Mac asked at all, which is why it stays something the user turns on
/// rather than something done for them.
///
/// ThreatFox and URLhaus need the user's own abuse.ch Auth-Key. abuse.ch
/// retired the keyless downloads on 2026-10-22 (they answer 410 Gone), so
/// without a key those two are not requested at all and are reported as
/// needing one, not as failed.
public struct ThreatFeedDownloader: Sendable {
    public struct Feed: Sendable {
        public let kind: FeedKind
        public let source: String
        /// Set for feeds anyone can download.
        let publicURL: URL?
        /// Set for the abuse.ch exports that take the Auth-Key in the path.
        let abuseChExportHost: String?

        public var requiresAbuseChKey: Bool { abuseChExportHost != nil }

        /// The address to fetch, or nil when this feed needs a key and there
        /// is none.
        public func url(abuseChAuthKey: String?) -> URL? {
            if let publicURL { return publicURL }
            guard let host = abuseChExportHost,
                  let key = abuseChAuthKey?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !key.isEmpty,
                  let encoded = key.addingPercentEncoding(withAllowedCharacters: .alphanumerics)
            else { return nil }
            return URL(string: "https://\(host)/v2/files/exports/\(encoded)/recent.csv")
        }
    }

    /// The same four feeds `src/threat-intel.js` uses, at the same addresses.
    /// Kept identical on purpose: a standalone agent and a Hub-connected one
    /// should not disagree about what is dangerous.
    public static let feeds: [Feed] = [
        Feed(kind: .feodo, source: "feodo",
             publicURL: URL(string: "https://feodotracker.abuse.ch/downloads/ipblocklist.csv")!,
             abuseChExportHost: nil),
        Feed(kind: .threatfox, source: "threatfox", publicURL: nil,
             abuseChExportHost: "threatfox-api.abuse.ch"),
        Feed(kind: .urlhaus, source: "urlhaus", publicURL: nil,
             abuseChExportHost: "urlhaus-api.abuse.ch"),
        Feed(kind: .spamhausDrop, source: "spamhaus",
             publicURL: URL(string: "https://www.spamhaus.org/drop/drop.txt")!,
             abuseChExportHost: nil),
    ]

    /// Where to get a free abuse.ch Auth-Key.
    public static let abuseChAuthKeyURL = URL(string: "https://auth.abuse.ch/")!

    public enum FeedKind: Sendable {
        case feodo
        case threatfox
        case urlhaus
        case spamhausDrop
    }

    public enum DownloadError: Error, Equatable {
        /// Every feed that was requested failed. One failing is normal and is
        /// not reported this way.
        case allFeedsFailed
    }

    /// What came back, including which feeds did not, and why.
    ///
    /// The count alone is not enough to judge by. Three of the four feeds
    /// returned nothing for the whole life of this code and the screen went on
    /// showing a total, because a feed that yields no rows looks exactly like a
    /// feed with nothing to report. Whoever turned this on could not tell.
    public struct DownloadResult: Sendable, Equatable {
        public let indicators: [ThreatIndicator]
        /// Feeds that failed outright, or returned something that parsed to
        /// nothing. Named so they can be said out loud.
        public let missingSources: [String]
        /// Feeds not requested because there is no abuse.ch Auth-Key.
        public let sourcesNeedingKey: [String]
        /// Feeds where abuse.ch refused the Auth-Key (401/403).
        public let sourcesRejectingKey: [String]

        public init(
            indicators: [ThreatIndicator],
            missingSources: [String],
            sourcesNeedingKey: [String] = [],
            sourcesRejectingKey: [String] = []
        ) {
            self.indicators = indicators
            self.missingSources = missingSources
            self.sourcesNeedingKey = sourcesNeedingKey
            self.sourcesRejectingKey = sourcesRejectingKey
        }

        /// Every feed that contributed nothing this time, whatever the reason.
        public var unreadSources: [String] {
            missingSources + sourcesRejectingKey + sourcesNeedingKey
        }

        public var isComplete: Bool { unreadSources.isEmpty }

        /// This download, with the indicators already held for any feed that
        /// was not read this time.
        ///
        /// A download replaces the stored set, so without this a partial one
        /// threw away what it could not replace. On 2026-10-24 a fallback
        /// download on a Hub-enrolled Mac swapped the Hub's 11,438 indicators
        /// for 1,693 -- Feodo and Spamhaus only -- because ThreatFox and
        /// URLhaus answered 410. The fallback meant to cover for an absent Hub
        /// narrowed the check to about a seventh of what it had been.
        public func keepingPrevious(_ previous: [ThreatIndicator]) -> (
            indicators: [ThreatIndicator], keptSources: [String]
        ) {
            let unread = Set(unreadSources)
            let kept = previous.filter { $0.source.map(unread.contains) ?? false }
            let keptSources = unreadSources.filter { source in kept.contains { $0.source == source } }
            return (indicators + kept, keptSources)
        }
    }

    private let transport: any GeoCacheTransport
    private let abuseChAuthKey: String?

    public init(
        transport: any GeoCacheTransport = URLSessionGeoCacheTransport(timeout: 60),
        abuseChAuthKey: String? = nil
    ) {
        self.transport = transport
        self.abuseChAuthKey = abuseChAuthKey
    }

    public func download() async throws -> DownloadResult {
        var indicators: [ThreatIndicator] = []
        var missing: [String] = []
        var needingKey: [String] = []
        var rejectingKey: [String] = []
        var anySucceeded = false
        for feed in Self.feeds {
            guard let url = feed.url(abuseChAuthKey: abuseChAuthKey) else {
                needingKey.append(feed.source)
                continue
            }
            var request = URLRequest(url: url)
            request.httpMethod = "GET"
            request.httpShouldHandleCookies = false
            guard let (data, response) = try? await transport.fetch(request) else {
                // One feed being down is ordinary, so the refresh continues --
                // but it is recorded rather than shrugged off.
                missing.append(feed.source)
                continue
            }
            if feed.requiresAbuseChKey, response.statusCode == 401 || response.statusCode == 403 {
                rejectingKey.append(feed.source)
                continue
            }
            guard response.statusCode == 200, let text = String(data: data, encoding: .utf8) else {
                missing.append(feed.source)
                continue
            }
            anySucceeded = true
            let parsed = Self.parse(text, kind: feed.kind, source: feed.source)
            if parsed.isEmpty, !Self.publishesEmptyLists.contains(feed.source) {
                // Downloaded and understood nothing. That is a parser or a
                // changed format, not a quiet day, and it is the exact failure
                // that went unnoticed for the life of this code.
                missing.append(feed.source)
                continue
            }
            indicators.append(contentsOf: parsed)
        }
        guard anySucceeded else { throw DownloadError.allFeedsFailed }
        return DownloadResult(
            indicators: indicators, missingSources: missing,
            sourcesNeedingKey: needingKey, sourcesRejectingKey: rejectingKey
        )
    }

    /// Feeds that legitimately publish nothing for long stretches, so an empty
    /// result from them is a fact rather than a fault.
    ///
    /// Feodo Tracker's blocklist has been empty since 2026-03-04. Treating that
    /// as a broken feed would put a warning on screen that never clears, and a
    /// warning that never clears is one nobody reads.
    static let publishesEmptyLists: Set<String> = ["feodo"]

    public static func parse(
        _ text: String, kind: FeedKind, source: String
    ) -> [ThreatIndicator] {
        switch kind {
        case .feodo: return parseFeodo(text, source: source)
        case .threatfox: return parseThreatFox(text, source: source)
        case .urlhaus: return parseURLhaus(text, source: source)
        case .spamhausDrop: return parseSpamhausDrop(text, source: source)
        }
    }

    /// `first_seen_utc,dst_ip,dst_port,…,malware`
    static func parseFeodo(_ text: String, source: String) -> [ThreatIndicator] {
        lines(text).compactMap { line in
            guard !line.hasPrefix("#") else { return nil }
            let fields = csvFields(String(line))
            guard fields.count > 1, isPlausibleIPv4(fields[1]) else { return nil }
            let malware = fields.count > 4 ? fields[4] : ""
            return ThreatIndicator(
                kind: .ip, value: fields[1], source: source,
                tag: malware.isEmpty ? "botnet C2" : "\(malware) C2"
            )
        }
    }

    /// `first_seen_utc,ioc_id,ioc_value,ioc_type,threat_type,fk_malware,malware_alias,malware_printable,…`
    ///
    /// Read the way the Hub reads it (`parseThreatFox` in `src/threat-intel.js`):
    /// ip:port IOCs become addresses; domain and url IOCs become names keyed by
    /// host (a url on an IPv4 address becomes that address); hashes are
    /// skipped. A compromised legitimate site, a file on a shared service, or
    /// an IOC ThreatFox rates below 75 is low confidence.
    static func parseThreatFox(_ text: String, source: String) -> [ThreatIndicator] {
        // Column positions come from the header when there is one; the keyed
        // export added columns that moved confidence_level.
        var confidenceColumn: Int?
        var compromisedColumn: Int?
        var indicators: [ThreatIndicator] = []
        for line in lines(text) {
            var header = Substring(line)
            if header.hasPrefix("#") { header = header.dropFirst().drop { $0 == " " } }
            if header.hasPrefix("\"first_seen") {
                let names = csvFields(String(header))
                confidenceColumn = names.firstIndex(of: "confidence_level")
                compromisedColumn = names.firstIndex(of: "is_compromised")
                continue
            }
            guard !line.hasPrefix("#") else { continue }
            let fields = csvFields(String(line))
            guard fields.count > 2 else { continue }
            let ioc = fields[2]
            let type = fields.count > 3 ? fields[3] : "ip:port"
            let malware = [6, 7, 5].lazy
                .compactMap { fields.count > $0 ? fields[$0] : nil }
                .first { !$0.isEmpty && $0 != "None" } ?? ""

            switch type {
            case "domain", "url":
                let rawHost = type == "url" ? URL(string: ioc)?.host : ioc
                guard var host = rawHost?.lowercased(), host.contains(".") else { continue }
                if host.hasSuffix(".") { host.removeLast() }
                let field = { (column: Int?) -> String in
                    guard let column, fields.count > column else { return "" }
                    return fields[column]
                }
                let compromised = field(compromisedColumn) == "True"
                let level = Int(field(confidenceColumn))
                let sharedHosting = Self.confidence(forHost: host) == .low
                let low = compromised || sharedHosting || (level.map { $0 < 75 } ?? false)
                let name = malware.isEmpty ? "malware infrastructure" : malware
                let note = compromised ? " (compromised legitimate site)"
                    : sharedHosting ? " (file hosting service)" : ""
                let isAddress = isPlausibleIPv4(host)
                indicators.append(ThreatIndicator(
                    kind: isAddress ? .ip : .domain, value: host, source: source,
                    tag: name + note, confidence: low ? .low : .high
                ))
            case "ip:port":
                // Strips the port: the indicator is the host, and keeping the
                // port would stop it matching the same host reached on another.
                let value = ioc.split(separator: ":").first.map(String.init) ?? ioc
                guard isPlausibleIPv4(value) else { continue }
                indicators.append(ThreatIndicator(
                    kind: .ip, value: value, source: source,
                    tag: malware.isEmpty ? "malware infrastructure" : malware
                ))
            default:
                continue
            }
        }
        // One indicator can appear as several IOCs. The stronger reading wins,
        // so a C2 address is never downgraded by a weaker report of the same
        // host -- the same rule as the Hub.
        var kept: [String: Int] = [:]
        var result: [ThreatIndicator] = []
        for indicator in indicators {
            let key = "\(indicator.kind.rawValue):\(indicator.value)"
            if let index = kept[key] {
                if result[index].confidence == .low, indicator.confidence == .high {
                    result[index] = indicator
                }
                continue
            }
            kept[key] = result.count
            result.append(indicator)
        }
        return result
    }

    /// `id,dateadded,url,url_status,…,threat,…`
    /// Services that host other people's files.
    ///
    /// URLhaus lists the URL malware was served from. A match on one of these
    /// says something was hosted there, not that the host is hostile, so it is
    /// low confidence.
    ///
    /// **The same list exists in `src/threat-intel.js` on the Hub.** Two
    /// copies is the price of the Agent judging without one; a test asserts
    /// they hold the same entries, because an Agent that disagrees with its
    /// Hub about the same destination is the defect P3-19 exists to prevent.
    public static let lowConfidenceDomains: Set<String> = [
        "github.com", "raw.githubusercontent.com", "gist.githubusercontent.com",
        "gitlab.com", "bitbucket.org",
        "drive.google.com", "docs.google.com", "storage.googleapis.com",
        "dropbox.com", "dl.dropboxusercontent.com",
        "onedrive.live.com", "1drv.ms",
        "cdn.discordapp.com", "media.discordapp.net",
        "pastebin.com", "paste.ee",
        "transfer.sh", "anonfiles.com",
        "amazonaws.com", "s3.amazonaws.com",
        "cloudfront.net", "azureedge.net", "blob.core.windows.net",
        "archive.org",
    ]

    /// Matches the Hub: the host itself, or its last two labels.
    public static func confidence(forHost host: String) -> ThreatIndicator.Confidence {
        let lowered = host.lowercased()
        let parent = lowered.split(separator: ".").suffix(2).joined(separator: ".")
        return lowConfidenceDomains.contains(lowered) || lowConfidenceDomains.contains(parent)
            ? .low : .high
    }

    static func parseURLhaus(_ text: String, source: String) -> [ThreatIndicator] {
        lines(text).compactMap { line in
            guard !line.hasPrefix("#") else { return nil }
            let fields = csvFields(String(line))
            guard fields.count > 2, let host = URL(string: fields[2])?.host, !host.isEmpty else {
                return nil
            }
            let isAddress = isPlausibleIPv4(host)
            let confidence = isAddress ? ThreatIndicator.Confidence.high : Self.confidence(forHost: host)
            return ThreatIndicator(
                kind: isAddress ? .ip : .domain,
                value: isAddress ? host : host.lowercased(),
                source: source,
                tag: confidence == .low
                    ? "file hosting service (low confidence)"
                    : "malware distribution",
                confidence: confidence
            )
        }
    }

    /// `1.2.3.0/24 ; SBL123456`
    static func parseSpamhausDrop(_ text: String, source: String) -> [ThreatIndicator] {
        lines(text).compactMap { line in
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            guard !trimmed.isEmpty, !trimmed.hasPrefix(";"), !trimmed.hasPrefix("#") else {
                return nil
            }
            let cidr = trimmed.split(separator: ";").first?
                .trimmingCharacters(in: .whitespaces) ?? ""
            guard ThreatMatcher.parseCIDR(cidr) != nil else { return nil }
            return ThreatIndicator(
                kind: .cidr, value: cidr, source: source,
                tag: "Spamhaus DROP (hijacked network)"
            )
        }
    }

    /// Splits a feed into lines, whatever it ends them with.
    ///
    /// `split(separator: "\n")` looks like it does this and does not. Swift
    /// treats `"\r\n"` as a **single** `Character`, so a CRLF file contains no
    /// `"\n"` character at all: the whole download comes back as one line,
    /// that line starts with `#`, and every parser here drops it as a comment.
    ///
    /// Three of the four feeds ship CRLF. They returned **zero indicators from
    /// the day this was written until 2026-08-20**, with no error anywhere --
    /// a failed feed is skipped by design, and a feed that parses to nothing is
    /// indistinguishable from one that had nothing to report. Only Spamhaus,
    /// which ships LF, ever worked.
    static func lines(_ text: String) -> [Substring] {
        text.split(whereSeparator: \.isNewline)
    }

    /// Minimal RFC 4180 reader: enough for feeds that quote fields containing
    /// commas, which these do.
    static func csvFields(_ line: String) -> [String] {
        var fields: [String] = []
        var current = ""
        var inQuotes = false
        var iterator = line.makeIterator()
        while let character = iterator.next() {
            if character == "\"" {
                inQuotes.toggle()
            } else if character == "," && !inQuotes {
                fields.append(current.trimmingCharacters(in: .whitespaces))
                current = ""
            } else {
                current.append(character)
            }
        }
        fields.append(current.trimmingCharacters(in: .whitespaces))
        return fields
    }

    static func isPlausibleIPv4(_ text: String) -> Bool {
        ThreatMatcher.ipv4ToNumber(text) != nil
    }
}

/// Where the user's abuse.ch Auth-Key lives: the Keychain, beside the other
/// credentials the agent holds, and never in preferences.
public struct AbuseChKeyStore: Sendable {
    static let account = "abuse-ch-auth-key"

    private let keys: any AgentAPIKeyStoring

    public init(keys: any AgentAPIKeyStoring = KeychainAgentAPIKeyStore(
        service: "com.egressview.agent.abuse-ch"
    )) {
        self.keys = keys
    }

    /// Off the caller's thread: a keychain call can stall (see
    /// `AgentCredentialStoring.loadDetached`).
    public func load() async -> String? {
        (try? await keys.loadDetached(provider: Self.account)) ?? nil
    }

    public func save(_ key: String) async throws {
        try await keys.saveDetached(key, provider: Self.account)
    }

    public func clear() async throws {
        try await keys.deleteDetached(provider: Self.account)
    }
}
