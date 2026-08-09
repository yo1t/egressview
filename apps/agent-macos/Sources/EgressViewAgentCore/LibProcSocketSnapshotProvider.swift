import CLibProcBridge
import Darwin
import Foundation

public enum LibProcError: Error, Equatable {
    case collectionFailed(errno: Int32)
}

public protocol SocketSnapshotProviding {
    func snapshot(at date: Date) throws -> [ConnectionObservation]
}

public struct LibProcSocketSnapshotProvider: SocketSnapshotProviding {
    public let capacity: Int32

    public init(capacity: Int32 = 16_384) {
        self.capacity = max(1, capacity)
    }

    public func snapshot(at date: Date = Date()) throws -> [ConnectionObservation] {
        var records = Array(repeating: EGVSocketRecord(), count: Int(capacity))
        let result = records.withUnsafeMutableBufferPointer { buffer in
            egv_list_internet_sockets(buffer.baseAddress, capacity)
        }
        guard result >= 0 else {
            throw LibProcError.collectionFailed(errno: -result)
        }

        return records.prefix(Int(result)).compactMap { record in
            guard let networkProtocol = InternetProtocol(protocolNumber: record.protocol_number) else {
                return nil
            }
            return ConnectionObservation(
                networkProtocol: networkProtocol,
                localAddress: string(from: record.local_address),
                localPort: record.local_port,
                remoteAddress: string(from: record.remote_address),
                remotePort: record.remote_port,
                processID: record.process_id,
                processName: string(from: record.process_name),
                firstObservedAt: date,
                lastObservedAt: date,
                bytesIn: nil,
                bytesOut: nil,
                collector: .libproc,
                confidence: .sampled
            )
        }
    }
}

private extension InternetProtocol {
    init?(protocolNumber: Int32) {
        switch protocolNumber {
        case IPPROTO_TCP:
            self = .tcp
        case IPPROTO_UDP:
            self = .udp
        default:
            return nil
        }
    }
}

private func string<T>(from tuple: T) -> String {
    withUnsafeBytes(of: tuple) { bytes in
        let base = bytes.baseAddress!.assumingMemoryBound(to: CChar.self)
        return String(cString: base)
    }
}
