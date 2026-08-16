import Foundation

/// Turns the local history into a CSV file the user can take elsewhere.
///
/// The point of the export is that the data stops being locked inside this app:
/// a spreadsheet, a notebook, or a colleague's script should be able to read it
/// without knowing anything about EgressView. So the output is plain RFC 4180
/// with no preamble, no comment lines and no merged cells -- anything clever
/// here becomes someone else's parse error.
public enum ObservationCSV {
    public static let columns = [
        "first_observed_at",
        "last_observed_at",
        "process_name",
        "bundle_id",
        "protocol",
        "local_address",
        "local_port",
        "remote_address",
        "remote_port",
        "remote_hostname",
        "bytes_in",
        "bytes_out",
        "collector",
        "confidence",
    ]

    public static func export(
        _ observations: [ConnectionObservation],
        formatter: ISO8601DateFormatter = ObservationCSV.timestampFormatter
    ) -> String {
        var lines = [columns.joined(separator: ",")]
        for observation in observations {
            // Built up statement by statement rather than as one 14-element
            // literal. The literal compiled here and defeated the type checker
            // on CI ("unable to type-check this expression in reasonable
            // time"), which is a difference in compiler version, not in taste.
            var row: [String] = []
            row.append(formatter.string(from: observation.firstObservedAt))
            row.append(formatter.string(from: observation.lastObservedAt))
            row.append(observation.processName)
            row.append(observation.bundleID ?? "")
            row.append(observation.networkProtocol.rawValue)
            row.append(observation.localAddress)
            row.append(String(observation.localPort))
            row.append(observation.remoteAddress)
            row.append(String(observation.remotePort))
            row.append(observation.remoteHostname ?? "")
            // Byte counts are measured when a connection ends, so an open
            // connection has none. Empty says "not measured"; a zero would say
            // "measured, and it was nothing", which is a different claim and a
            // false one.
            row.append(observation.bytesIn.map(String.init) ?? "")
            row.append(observation.bytesOut.map(String.init) ?? "")
            row.append(observation.collector.rawValue)
            row.append(observation.confidence.rawValue)
            lines.append(row.map(field).joined(separator: ","))
        }
        // A trailing newline: POSIX tools treat a file without one as truncated.
        return lines.joined(separator: "\n") + "\n"
    }

    public static let timestampFormatter: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()

    /// Quotes a value only when it has to be, and doubles any quote inside it.
    static func field(_ value: String) -> String {
        guard value.contains(where: { $0 == "," || $0 == "\"" || $0 == "\n" || $0 == "\r" })
        else { return value }
        return "\"\(value.replacingOccurrences(of: "\"", with: "\"\""))\""
    }

    /// A file name that carries the period, so exports of different windows do
    /// not overwrite each other or become indistinguishable in a folder.
    public static func suggestedFileName(from: Date, to: Date) -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyyMMdd-HHmm"
        formatter.locale = Locale(identifier: "en_US_POSIX")
        return "egressview-\(formatter.string(from: from))-to-\(formatter.string(from: to)).csv"
    }
}
