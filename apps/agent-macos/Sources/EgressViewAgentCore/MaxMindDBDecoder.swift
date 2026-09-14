import Foundation

extension MaxMindDB {
    /// A decoded value from the data section.
    ///
    /// Only the shapes a country database actually uses are kept as distinct
    /// cases. The rest decode to `.other` so an unexpected field cannot stop
    /// the lookup that surrounds it -- a database with a field this agent does
    /// not understand should still answer "which country".
    public indirect enum Value: Equatable, Sendable {
        case map([String: Value])
        case array([Value])
        case string(String)
        case uint(UInt64)
        case int(Int64)
        case double(Double)
        case bool(Bool)
        case bytes(Data)
        case other
    }

    /// Reads the MaxMind DB data-section encoding.
    ///
    /// Every value starts with a control byte: the top three bits are the type
    /// (zero meaning "read the next byte and add seven"), the bottom five the
    /// size, with 29/30/31 meaning the size is spelled out in the following
    /// one, two or three bytes. Pointers are their own type and can point
    /// backwards to any value, which is how the format avoids repeating the
    /// same country record tens of thousands of times.
    struct Decoder {
        let bytes: Data
        let dataSectionStart: Int
        /// Pointers may chain. A file that points in a circle would otherwise
        /// hang the agent, so the chain is bounded rather than trusted.
        private static let maximumPointerDepth = 16

        init(bytes: Data, dataSectionStart: Int) {
            self.bytes = bytes
            self.dataSectionStart = dataSectionStart
        }

        func value(at offset: Int) throws -> Value {
            var cursor = offset
            return try value(cursor: &cursor, depth: 0)
        }

        private func byte(at index: Int) throws -> UInt8 {
            guard index >= 0, index < bytes.count else {
                throw Failure.corruptTree("read past the end of the file at \(index)")
            }
            return bytes[index]
        }

        private func value(cursor: inout Int, depth: Int) throws -> Value {
            guard depth <= Self.maximumPointerDepth else {
                throw Failure.corruptTree("pointers chained more than \(Self.maximumPointerDepth) deep")
            }
            let control = try byte(at: cursor)
            cursor += 1
            var type = Int(control >> 5)
            if type == 0 {
                type = Int(try byte(at: cursor)) + 7
                cursor += 1
            }

            if type == 1 {
                let target = try pointerTarget(control: control, cursor: &cursor)
                var pointed = dataSectionStart + target
                return try value(cursor: &pointed, depth: depth + 1)
            }

            let size = try size(control: control, cursor: &cursor)
            switch type {
            case 2:
                let raw = try slice(cursor: &cursor, count: size)
                return .string(String(decoding: raw, as: UTF8.self))
            case 3:
                let raw = try slice(cursor: &cursor, count: size)
                guard size == 8 else { return .other }
                return .double(Double(bitPattern: raw.reduce(UInt64(0)) { $0 << 8 | UInt64($1) }))
            case 4:
                return .bytes(Data(try slice(cursor: &cursor, count: size)))
            case 5, 6, 9, 10:
                // uint16, uint32, uint64, uint128 -- all big-endian and
                // variable length, with zero length meaning zero.
                let raw = try slice(cursor: &cursor, count: size)
                guard size <= 8 else { return .other }
                return .uint(raw.reduce(UInt64(0)) { $0 << 8 | UInt64($1) })
            case 7:
                var fields: [String: Value] = [:]
                for _ in 0..<size {
                    let key = try value(cursor: &cursor, depth: depth + 1)
                    let item = try value(cursor: &cursor, depth: depth + 1)
                    if case let .string(name) = key { fields[name] = item }
                }
                return .map(fields)
            case 8:
                let raw = try slice(cursor: &cursor, count: size)
                let magnitude = raw.reduce(UInt64(0)) { $0 << 8 | UInt64($1) }
                return .int(Int64(Int32(truncatingIfNeeded: Int64(magnitude))))
            case 11:
                var items: [Value] = []
                items.reserveCapacity(size)
                for _ in 0..<size { items.append(try value(cursor: &cursor, depth: depth + 1)) }
                return .array(items)
            case 14:
                return .bool(size != 0)
            case 15:
                let raw = try slice(cursor: &cursor, count: size)
                guard size == 4 else { return .other }
                let pattern = raw.reduce(UInt32(0)) { $0 << 8 | UInt32($1) }
                return .double(Double(Float(bitPattern: pattern)))
            default:
                // Containers and end markers never appear as a field's value in
                // a database this agent reads.
                cursor += size
                return .other
            }
        }

        private func slice(cursor: inout Int, count: Int) throws -> [UInt8] {
            guard count >= 0, cursor + count <= bytes.count else {
                throw Failure.corruptTree("a value of \(count) bytes runs past the end of the file")
            }
            defer { cursor += count }
            return Array(bytes[cursor..<(cursor + count)])
        }

        private func size(control: UInt8, cursor: inout Int) throws -> Int {
            let size = Int(control & 0x1F)
            switch size {
            case 29:
                defer { cursor += 1 }
                return 29 + Int(try byte(at: cursor))
            case 30:
                let high = Int(try byte(at: cursor)), low = Int(try byte(at: cursor + 1))
                cursor += 2
                return 285 + (high << 8 | low)
            case 31:
                let a = Int(try byte(at: cursor)), b = Int(try byte(at: cursor + 1))
                let c = Int(try byte(at: cursor + 2))
                cursor += 3
                return 65_821 + (a << 16 | b << 8 | c)
            default:
                return size
            }
        }

        /// Pointer sizes are biased so that the shorter forms can still reach
        /// far into the data section.
        private func pointerTarget(control: UInt8, cursor: inout Int) throws -> Int {
            let size = Int((control >> 3) & 0x03)
            let value = Int(control & 0x07)
            switch size {
            case 0:
                defer { cursor += 1 }
                return value << 8 | Int(try byte(at: cursor))
            case 1:
                let a = Int(try byte(at: cursor)), b = Int(try byte(at: cursor + 1))
                cursor += 2
                return (value << 16 | a << 8 | b) + 2048
            case 2:
                let a = Int(try byte(at: cursor)), b = Int(try byte(at: cursor + 1))
                let c = Int(try byte(at: cursor + 2))
                cursor += 3
                return (value << 24 | a << 16 | b << 8 | c) + 526_336
            default:
                var target = 0
                for index in 0..<4 { target = target << 8 | Int(try byte(at: cursor + index)) }
                cursor += 4
                return target
            }
        }
    }
}
