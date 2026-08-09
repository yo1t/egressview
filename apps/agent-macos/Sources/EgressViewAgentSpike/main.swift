import EgressViewAgentCore
import Foundation

let provider = LibProcSocketSnapshotProvider()
do {
    let date = Date()
    var deduplicator = ObservationDeduplicator()
    let observations = deduplicator.merge(try provider.snapshot(at: date), observedAt: date)
    if CommandLine.arguments.contains("--summary") {
        let tcp = observations.filter { $0.networkProtocol == .tcp }.count
        let udp = observations.filter { $0.networkProtocol == .udp }.count
        let ipv6 = observations.filter { $0.remoteAddress.contains(":") }.count
        print("observations=\(observations.count) tcp=\(tcp) udp=\(udp) ipv6=\(ipv6)")
        exit(EXIT_SUCCESS)
    }
    let encoder = JSONEncoder()
    encoder.dateEncodingStrategy = .iso8601
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    FileHandle.standardOutput.write(try encoder.encode(observations))
    FileHandle.standardOutput.write(Data("\n".utf8))
} catch {
    FileHandle.standardError.write(Data("Collection failed: \(error)\n".utf8))
    exit(EXIT_FAILURE)
}
