import Foundation

/// Downloads the same public threat feeds the Hub reads, for agents that have
/// no Hub.
///
/// These are plain list downloads, not lookup services: no key, no query, and
/// **no destination from this Mac is sent anywhere**. What it does reveal is
/// that this Mac asked at all, which is why it stays something the user turns
/// on rather than something done for them.
public struct ThreatFeedDownloader: Sendable {
    /// The same four feeds `src/threat-intel.js` uses. Kept identical on
    /// purpose: a standalone agent and a Hub-connected one should not disagree
    /// about what is dangerous.
    public static let feeds: [(url: URL, kind: FeedKind, source: String)] = [
        (URL(string: "https://feodotracker.abuse.ch/downloads/ipblocklist.csv")!, .feodo, "feodo"),
        (URL(string: "https://threatfox.abuse.ch/export/csv/ip-port/recent/")!, .threatfox, "threatfox"),
        (URL(string: "https://urlhaus.abuse.ch/downloads/csv_recent/")!, .urlhaus, "urlhaus"),
        (URL(string: "https://www.spamhaus.org/drop/drop.txt")!, .spamhausDrop, "spamhaus"),
    ]

    public enum FeedKind: Sendable {
        case feodo
        case threatfox
        case urlhaus
        case spamhausDrop
    }

    public enum DownloadError: Error, Equatable {
        /// Every feed failed. One failing is normal and is not reported.
        case allFeedsFailed
    }

    private let transport: any GeoCacheTransport

    public init(transport: any GeoCacheTransport = URLSessionGeoCacheTransport(timeout: 60)) {
        self.transport = transport
    }

    public func download() async throws -> [ThreatIndicator] {
        var indicators: [ThreatIndicator] = []
        var anySucceeded = false
        for feed in Self.feeds {
            var request = URLRequest(url: feed.url)
            request.httpMethod = "GET"
            request.httpShouldHandleCookies = false
            guard let (data, response) = try? await transport.fetch(request),
                  response.statusCode == 200,
                  let text = String(data: data, encoding: .utf8)
            else {
                // One feed being down is ordinary. Failing the whole refresh
                // for it would throw away three working lists.
                continue
            }
            anySucceeded = true
            indicators.append(contentsOf: Self.parse(text, kind: feed.kind, source: feed.source))
        }
        guard anySucceeded else { throw DownloadError.allFeedsFailed }
        return indicators
    }

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

    /// `first_seen_utc,ioc_id,ioc_value(ip:port),ioc_type,threat_type,…,malware`
    static func parseThreatFox(_ text: String, source: String) -> [ThreatIndicator] {
        lines(text).compactMap { line in
            guard !line.hasPrefix("#") else { return nil }
            let fields = csvFields(String(line))
            guard fields.count > 2 else { return nil }
            // Strips the port: the indicator is the host, and keeping the port
            // would stop it matching the same host reached on another one.
            let value = fields[2].split(separator: ":").first.map(String.init) ?? fields[2]
            guard isPlausibleIPv4(value) else { return nil }
            let malware = fields.count > 5 ? fields[5] : ""
            return ThreatIndicator(
                kind: .ip, value: value, source: source,
                tag: malware.isEmpty ? "malware infrastructure" : malware
            )
        }
    }

    /// `id,dateadded,url,url_status,…,threat,…`
    static func parseURLhaus(_ text: String, source: String) -> [ThreatIndicator] {
        lines(text).compactMap { line in
            guard !line.hasPrefix("#") else { return nil }
            let fields = csvFields(String(line))
            guard fields.count > 2, let host = URL(string: fields[2])?.host, !host.isEmpty else {
                return nil
            }
            let isAddress = isPlausibleIPv4(host)
            return ThreatIndicator(
                kind: isAddress ? .ip : .domain,
                value: isAddress ? host : host.lowercased(),
                source: source,
                tag: "malware distribution"
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
