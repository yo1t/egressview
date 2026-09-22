import Foundation
import XCTest
@testable import EgressViewAgentCore

final class ObservationStoreTests: XCTestCase {
    private var directory: URL!

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("egressview-store-\(UUID().uuidString)")
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: directory)
    }

    private func makeStore(retention: ObservationRetention = ObservationRetention()) throws -> ObservationStore {
        try ObservationStore(
            fileURL: directory.appendingPathComponent("history.sqlite"), retention: retention
        )
    }

    // P3-158. Deleting rows does not make the file smaller: SQLite keeps the
    // pages on a free list. On a real Mac that had reached 30% free -- 93 MB
    // of a 311.5 MB file -- and stayed there, because nothing ever vacuumed.
    // From the user's side, they deleted their history and the disk gave
    // nothing back.
    func test保持で消した分がファイルから返る() throws {
        let store = try makeStore()
        let url = directory.appendingPathComponent("history.sqlite")
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        let old = now.addingTimeInterval(-40 * 86_400)
        // Enough rows that the file is worth measuring, and distinct enough
        // that the rollup cannot fold them into a handful.
        try store.append((0..<4_000).map {
            observation(
                process: "App\($0 % 200)",
                remote: "203.0.113.\($0 % 250)",
                at: old.addingTimeInterval(Double($0) * 7)
            )
        })
        try store.append([observation(at: now)])

        // Everything the store occupies, because in WAL mode the pages live
        // in the -wal file until a checkpoint and a measurement of the
        // database file alone would show no change at all.
        func bytesOnDisk() -> Int64 {
            ["", "-wal", "-shm"].reduce(0) { total, suffix in
                let path = url.path + suffix
                let size = (try? FileManager.default.attributesOfItem(atPath: path)[.size])
                    .flatMap { ($0 as? NSNumber)?.int64Value } ?? 0
                return total + size
            }
        }

        let before = bytesOnDisk()
        try store.compact(now: now)
        let freed = try store.reclaimFreeSpace()
        let after = bytesOnDisk()

        XCTAssertGreaterThan(freed, 0, "nothing was given back")
        XCTAssertLessThan(after, before, "the disk did not shrink")
        XCTAssertEqual(try store.statistics().rawCount, 1, "the surviving row is still there")
        XCTAssertEqual(
            try store.reclaimFreeSpace(), 0,
            "ran a second time with nothing left to reclaim"
        )
    }

    // A vacuum writes a second copy of the file before swapping it in. Running
    // one to recover a few pages costs more than it returns, and on a laptop
    // it is the moment the disk is most needed.
    func test空きが少なければ書き直さない() throws {
        let store = try makeStore()
        let url = directory.appendingPathComponent("history.sqlite")
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        try store.append((0..<200).map {
            observation(remote: "203.0.113.\($0 % 250)", at: now.addingTimeInterval(Double($0)))
        })

        // The database file itself, not the total: a vacuum checkpoints the
        // -wal into it, so if one ran this size cannot be what it was.
        func databaseFileSize() -> Int64 {
            (try? FileManager.default.attributesOfItem(atPath: url.path)[.size])
                .flatMap { ($0 as? NSNumber)?.int64Value } ?? -1
        }
        let before = databaseFileSize()

        XCTAssertEqual(try store.reclaimFreeSpace(), 0)
        XCTAssertEqual(databaseFileSize(), before, "the file was rewritten for nothing")
    }

    private func observation(
        process: String = "Safari",
        remote: String = "203.0.113.5",
        at: Date,
        bytesIn: UInt64? = 100,
        bytesOut: UInt64? = 200,
        hostname: String? = nil
    ) -> ConnectionObservation {
        ConnectionObservation(
            networkProtocol: .tcp,
            localAddress: "192.0.2.10",
            localPort: 49_152,
            remoteAddress: remote,
            remotePort: 443,
            processID: 501,
            processName: process,
            bundleID: "com.apple.\(process.lowercased())",
            firstObservedAt: at,
            lastObservedAt: at,
            bytesIn: bytesIn,
            bytesOut: bytesOut,
            collector: .networkExtension,
            confidence: .exact,
            remoteHostname: hostname
        )
    }

    func testOutboundTrafficWindowIsCapturedOnceAndSurvivesRestart() throws {
        let url = directory.appendingPathComponent("history.sqlite")
        let completedWindowStart = Date(timeIntervalSince1970: 1_800_000_000)
        let captureTime = completedWindowStart.addingTimeInterval(901)
        do {
            let store = try ObservationStore(fileURL: url)
            try store.append([
                observation(
                    process: "Safari", remote: "203.0.113.5",
                    at: completedWindowStart.addingTimeInterval(100), bytesOut: 40
                ),
                observation(
                    process: "Mail", remote: "198.51.100.8",
                    at: completedWindowStart.addingTimeInterval(200), bytesOut: 60
                ),
            ])

            let captured = try XCTUnwrap(store.captureOutboundTrafficWindow(now: captureTime))
            XCTAssertEqual(captured.current.startedAt, completedWindowStart)
            XCTAssertEqual(captured.current.bytesOut, 100)
            XCTAssertEqual(captured.current.observationCount, 2)
            XCTAssertEqual(captured.current.observationsWithBytes, 2)
            XCTAssertEqual(captured.current.applicationCount, 2)
            XCTAssertEqual(captured.current.destinationCount, 2)
            XCTAssertEqual(captured.current.largestApplicationBytesOut, 60)
            XCTAssertTrue(captured.baseline.isEmpty)
            XCTAssertNil(try store.captureOutboundTrafficWindow(now: captureTime))
        }

        let reopened = try ObservationStore(fileURL: url)
        XCTAssertNil(try reopened.captureOutboundTrafficWindow(now: captureTime))
    }

    func testOutboundAnomalyCountUsesDetectionTimeAndSurvivesRestart() throws {
        let url = directory.appendingPathComponent("history.sqlite")
        let window = Date(timeIntervalSince1970: 1_800_000_000)
        do {
            let store = try ObservationStore(fileURL: url)
            try store.append([observation(at: window.addingTimeInterval(30))])
            let captured = try XCTUnwrap(
                store.captureOutboundTrafficWindow(now: window.addingTimeInterval(901))
            )
            try store.recordOutboundAnomaly(
                windowStart: captured.current.startedAt, kind: .distributedTransfer
            )
            XCTAssertEqual(
                try store.outboundAnomalyCount(
                    from: window.addingTimeInterval(-1), to: window.addingTimeInterval(900)
                ),
                1
            )
            XCTAssertEqual(
                try store.outboundAnomalyCount(
                    from: window.addingTimeInterval(1), to: window.addingTimeInterval(900)
                ),
                0
            )
        }

        let reopened = try ObservationStore(fileURL: url)
        XCTAssertEqual(
            try reopened.outboundAnomalyCount(
                from: window.addingTimeInterval(-1), to: window.addingTimeInterval(900)
            ),
            1
        )
    }

    func testCountryHistoryIsBoundedByCountryAndSurvivesRetention() throws {
        let store = try makeStore(retention: ObservationRetention(retentionDays: 1, rawDays: 1))
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        try store.replaceGeoLocations((1...100).map {
            GeoLocation(
                ip: "203.0.113.\($0)", latitude: 35, longitude: 139,
                countryCode: "JP", city: "Tokyo"
            )
        })
        try store.append((1...100).map {
            observation(
                process: $0.isMultiple(of: 2) ? "Safari" : "Mail",
                remote: "203.0.113.\($0)", at: now.addingTimeInterval(Double($0)),
                hostname: "site-\($0).example"
            )
        })

        var rows = try store.countryVisitSummaries()
        XCTAssertEqual(rows.count, 1, "one hundred destinations in one country remain one row")
        XCTAssertEqual(rows[0].countryCode, "JP")
        XCTAssertEqual(rows[0].connectionCount, 100)

        try store.compact(now: now.addingTimeInterval(3 * 86_400))
        rows = try store.countryVisitSummaries()
        XCTAssertEqual(rows.map(\.countryCode), ["JP"], "normal retention does not erase visited countries")
    }

    func testMonitoringStartIsTheFirstCoverageSessionAndDoesNotFollowTheSelectedPeriod() throws {
        let store = try makeStore()
        let first = Date(timeIntervalSince1970: 1_800_000_000)
        try store.beginCoverageSession(at: first)
        try store.endCoverageSession(at: first.addingTimeInterval(60))
        try store.beginCoverageSession(at: first.addingTimeInterval(3_600))

        XCTAssertEqual(try store.monitoringStartedAt(), first)
        XCTAssertEqual(try store.statistics().monitoringStartedAt, first)
    }

    func testCountryHistoryIsOrderedByConnectionCountThenRecency() throws {
        let store = try makeStore()
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        try store.replaceGeoLocations([
            GeoLocation(ip: "203.0.113.5", latitude: 35, longitude: 139,
                        countryCode: "JP", city: "Tokyo"),
            GeoLocation(ip: "198.51.100.8", latitude: 37, longitude: -122,
                        countryCode: "US", city: "California"),
        ])
        try store.append([
            observation(remote: "203.0.113.5", at: now),
            observation(remote: "203.0.113.5", at: now.addingTimeInterval(1)),
            observation(remote: "203.0.113.5", at: now.addingTimeInterval(2)),
            observation(remote: "198.51.100.8", at: now.addingTimeInterval(10)),
        ])

        let rows = try store.countryVisitSummaries()
        XCTAssertEqual(rows.map(\.countryCode), ["JP", "US"])
        XCTAssertEqual(rows.map(\.connectionCount), [3, 1])
    }

    func testKnownCountryUpdatesWaitForFlushButANewCountryDoesNot() throws {
        let url = directory.appendingPathComponent("history.sqlite")
        let store = try ObservationStore(fileURL: url, countrySummaryFlushInterval: 3_600)
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        try store.replaceGeoLocations([
            GeoLocation(ip: "203.0.113.5", latitude: 35, longitude: 139,
                        countryCode: "JP", city: "Tokyo"),
        ])
        try store.append([observation(remote: "203.0.113.5", at: now, hostname: "first.example")])
        XCTAssertEqual(try store.countryVisitSummaries().first?.connectionCount, 1)

        try store.append([observation(
            process: "Mail", remote: "203.0.113.5", at: now.addingTimeInterval(10),
            hostname: "latest.example"
        )])
        XCTAssertEqual(
            try store.countryVisitSummaries().first?.connectionCount, 1,
            "an already-known country is aggregated in memory instead of written every second"
        )

        try store.flushCountryVisitSummary()
        let row = try XCTUnwrap(try store.countryVisitSummaries().first)
        XCTAssertEqual(row.connectionCount, 2)
        XCTAssertEqual(row.lastSiteName, "latest.example")
        XCTAssertEqual(row.lastProcessName, "Mail")
    }

    func testGeoRefreshResolvesAPreviouslyUnknownDestination() throws {
        let store = try makeStore()
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        try store.append([observation(
            remote: "198.51.100.8", at: now, hostname: "delayed.example"
        )])
        XCTAssertTrue(try store.countryVisitSummaries().isEmpty)

        try store.replaceGeoLocations([
            GeoLocation(ip: "198.51.100.8", latitude: 37, longitude: -122,
                        countryCode: "US", city: "California"),
        ])
        let row = try XCTUnwrap(try store.countryVisitSummaries().first)
        XCTAssertEqual(row.countryCode, "US")
        XCTAssertEqual(row.lastSiteName, "delayed.example")
        XCTAssertEqual(row.lastProcessName, "Safari")
    }

    func testDeletingAllHistoryAlsoDeletesTheAllTimeCountryMemory() throws {
        let store = try makeStore()
        try store.replaceGeoLocations([
            GeoLocation(ip: "203.0.113.5", latitude: 35, longitude: 139,
                        countryCode: "JP", city: "Tokyo"),
        ])
        try store.append([observation(remote: "203.0.113.5", at: Date())])
        XCTAssertFalse(try store.countryVisitSummaries().isEmpty)

        try store.removeAll()
        XCTAssertTrue(try store.countryVisitSummaries().isEmpty)
    }

    func testAThousandObservationsAddOnlyBoundedCountryWork() throws {
        let store = try makeStore()
        let now = Date()
        let locations = (0..<1_000).map { index in
            let address = "198.\(index / 254).\((index / 16) % 254).\(index % 254)"
            return GeoLocation(
                ip: address, latitude: 35, longitude: 139,
                countryCode: index.isMultiple(of: 2) ? "JP" : "US", city: nil
            )
        }
        try store.replaceGeoLocations(locations)
        let observations = locations.enumerated().map { index, location in
            observation(
                process: index.isMultiple(of: 3) ? "Safari" : "Mail",
                remote: location.ip, at: now.addingTimeInterval(Double(index) / 1_000)
            )
        }

        let started = ContinuousClock.now
        try store.append(observations)
        let elapsed = ContinuousClock.now - started

        XCTAssertEqual(try store.countryVisitSummaries().count, 2)
        XCTAssertLessThan(
            elapsed, .seconds(1),
            "country aggregation must remain small beside the observation inserts"
        )
    }

    func testStoresAndReadsBackObservationsNewestFirst() throws {
        let store = try makeStore()
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        try store.append([
            observation(process: "Safari", at: now.addingTimeInterval(-60)),
            observation(process: "Mail", at: now),
        ])

        let rows = try store.observations()
        XCTAssertEqual(rows.map(\.processName), ["Mail", "Safari"])
        XCTAssertEqual(rows[0].bytesIn, 100)
        XCTAssertEqual(rows[0].bundleID, "com.apple.mail")
        XCTAssertEqual(rows[0].remotePort, 443)
    }

    func testPreservesAMissingByteCountAsUnknownRatherThanZero() throws {
        // Zero reads as "no traffic". Unknown has to stay unknown, or a chart
        // will confidently draw silence where there was simply no measurement.
        let store = try makeStore()
        try store.append([observation(at: Date(), bytesIn: nil, bytesOut: nil)])
        let row = try XCTUnwrap(try store.observations().first)
        XCTAssertNil(row.bytesIn)
        XCTAssertNil(row.bytesOut)
    }

    func testHonoursTheRequestedPeriodRatherThanWhateverFits() throws {
        // The failure this replaces: the settings screen offered 1/7/30/90 days
        // while the journal held about six hours.
        let store = try makeStore()
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let batch = (0..<2_000).map {
            observation(remote: "203.0.113.\($0 % 254)", at: now.addingTimeInterval(-Double($0) * 60))
        }
        try store.append(batch)

        let statistics = try store.statistics()
        XCTAssertEqual(statistics.rawCount, 2_000)
        // 2000 minutes back is a little over 33 hours, which the journal could
        // not have held at all.
        let oldest = try XCTUnwrap(statistics.oldestObservedAt)
        XCTAssertGreaterThan(now.timeIntervalSince(oldest), 24 * 3_600)
    }

    func testFoldsRawRowsOlderThanTheRawWindowIntoHourlyTotals() throws {
        let store = try makeStore(retention: ObservationRetention(retentionDays: 30, rawDays: 14))
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let old = now.addingTimeInterval(-20 * 86_400)
        try store.append([
            observation(at: old, bytesIn: 10, bytesOut: 20),
            observation(at: old.addingTimeInterval(60), bytesIn: 5, bytesOut: 7),
            observation(at: now, bytesIn: 1, bytesOut: 2),
        ])

        let folded = try store.compact(now: now)
        XCTAssertEqual(folded, 2)

        let statistics = try store.statistics()
        XCTAssertEqual(statistics.rawCount, 1, "recent rows stay raw")
        XCTAssertEqual(statistics.rolledUpCount, 1, "two sessions in one hour fold to one row")

        let rows = try store.hourlyRollup(
            from: old.addingTimeInterval(-3_600), to: old.addingTimeInterval(3_600)
        )
        XCTAssertEqual(rows.count, 1)
        XCTAssertEqual(rows[0].sessionCount, 2)
        XCTAssertEqual(rows[0].bytesIn, 15)
        XCTAssertEqual(rows[0].bytesOut, 27)
    }

    func testChartsSeeOneContinuousSeriesAcrossTheFoldBoundary() throws {
        // A chart spanning the boundary must not show a cliff where folding
        // happened; raw and folded rows have to add up to the same totals.
        let store = try makeStore(retention: ObservationRetention(retentionDays: 30, rawDays: 14))
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let old = now.addingTimeInterval(-20 * 86_400)
        try store.append([
            observation(at: old, bytesOut: 1_000),
            observation(at: now.addingTimeInterval(-60), bytesOut: 500),
        ])

        let before = try store.hourlyRollup(from: old.addingTimeInterval(-3_600), to: now)
        try store.compact(now: now)
        let after = try store.hourlyRollup(from: old.addingTimeInterval(-3_600), to: now)

        XCTAssertEqual(before.map(\.bytesOut).reduce(0, +), 1_500)
        XCTAssertEqual(after.map(\.bytesOut).reduce(0, +), 1_500)
        XCTAssertEqual(before.map(\.sessionCount).reduce(0, +), after.map(\.sessionCount).reduce(0, +))
    }

    func testDropsFoldedDataOnceItPassesTheRetentionPeriod() throws {
        let store = try makeStore(retention: ObservationRetention(retentionDays: 7, rawDays: 1))
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        try store.append([
            observation(at: now.addingTimeInterval(-10 * 86_400)),
            observation(at: now.addingTimeInterval(-3 * 86_400)),
        ])

        try store.compact(now: now)
        let statistics = try store.statistics()
        XCTAssertEqual(statistics.rawCount, 0)
        XCTAssertEqual(statistics.rolledUpCount, 1, "the 10-day-old hour is past the 7-day retention")
    }

    func testRepeatedCompactionDoesNotMultiplyTotals() throws {
        let store = try makeStore(retention: ObservationRetention(retentionDays: 30, rawDays: 1))
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let old = now.addingTimeInterval(-5 * 86_400)
        try store.append([observation(at: old, bytesIn: 40, bytesOut: 60)])

        try store.compact(now: now)
        try store.compact(now: now)
        try store.compact(now: now)

        let rows = try store.hourlyRollup(
            from: old.addingTimeInterval(-3_600), to: old.addingTimeInterval(3_600)
        )
        XCTAssertEqual(rows.count, 1)
        XCTAssertEqual(rows[0].sessionCount, 1)
        XCTAssertEqual(rows[0].bytesIn, 40)
    }

    func testDeletesHistoryBeforeADateWithoutDeletingEverything() throws {
        // The journal could only delete all history; the settings screen needs
        // a period.
        let store = try makeStore()
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        try store.append([
            observation(at: now.addingTimeInterval(-2 * 86_400)),
            observation(at: now),
        ])

        let removed = try store.removeObservations(before: now.addingTimeInterval(-86_400))
        XCTAssertEqual(removed, 1)
        XCTAssertEqual(try store.statistics().rawCount, 1)
    }

    func testDeletingHistoryLeavesNothingTheChartsCanRedraw() throws {
        // Measured on a real store before this was fixed: deleting history
        // before a date left 62,142 rows in the chart aggregate, 38,780 of
        // them still carrying the destination host name, and the charts drew
        // the deleted hours as if nothing had happened.
        let store = try makeStore()
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let old = now.addingTimeInterval(-3 * 86_400)
        try store.append([
            observation(at: old, hostname: "deleted.example"),
            observation(at: now, hostname: "kept.example"),
        ])
        try store.foldCompletedHoursForCharts(now: now.addingTimeInterval(3_600))
        XCTAssertGreaterThan(try store.storageSummary().chartHourCount, 0)

        _ = try store.removeObservations(before: now.addingTimeInterval(-86_400))

        let deletedPeriod = try store.appDestinationTotals(
            from: old.addingTimeInterval(-3_600), to: old.addingTimeInterval(3_600)
        )
        XCTAssertTrue(
            deletedPeriod.isEmpty,
            "the deleted period is still drawable: \(deletedPeriod)"
        )
        XCTAssertEqual(try store.storageSummary().chartHourCount, 1)
    }

    func testDeletingHistoryKeepsWhatSurvivedOfTheBoundaryHour() throws {
        // The hour containing the cutoff is deleted whole, because part of it
        // was asked for. The rest of that hour is still the user's, and must
        // not turn into an empty hour in the chart.
        let store = try makeStore()
        let hour = Date(timeIntervalSince1970: 1_800_000_000)
        let cutoff = hour.addingTimeInterval(1_800)
        try store.append([
            observation(at: hour.addingTimeInterval(60)),
            observation(remote: "203.0.113.9", at: cutoff.addingTimeInterval(60)),
        ])
        try store.foldCompletedHoursForCharts(now: hour.addingTimeInterval(7_200))

        _ = try store.removeObservations(before: cutoff)

        let rows = try store.appDestinationTotals(
            from: hour, to: hour.addingTimeInterval(3_600)
        )
        XCTAssertEqual(rows.count, 1)
        XCTAssertEqual(rows.first?.sessionCount, 1)
    }

    func testDeletingHistoryTrimsCoverageRatherThanDroppingIt() throws {
        // Dropping a session that spans the cutoff would report the minutes
        // after it as unobserved, which is the one thing coverage exists to
        // say truthfully.
        let store = try makeStore()
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let cutoff = now.addingTimeInterval(-86_400)
        try store.beginCoverageSession(at: now.addingTimeInterval(-3 * 86_400))
        try store.endCoverageSession(at: now)

        _ = try store.removeObservations(before: cutoff)

        let sessions = try store.coverageSessions(
            from: now.addingTimeInterval(-4 * 86_400), to: now
        )
        XCTAssertEqual(sessions.count, 1)
        XCTAssertEqual(
            sessions.first?.start.timeIntervalSince1970, cutoff.timeIntervalSince1970
        )
    }

    func testRetentionPrunesTheChartAggregateToo() throws {
        // Measured on a real store: the chart aggregate was never pruned by
        // retention and grew by 1.5 MB a day for as long as the agent ran.
        let store = try makeStore(retention: ObservationRetention(retentionDays: 30, rawDays: 14))
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        try store.append([observation(at: now.addingTimeInterval(-40 * 86_400))])
        try store.foldCompletedHoursForCharts(now: now.addingTimeInterval(-39 * 86_400))
        XCTAssertGreaterThan(try store.storageSummary().chartHourCount, 0)

        _ = try store.compact(now: now)

        XCTAssertEqual(try store.storageSummary().chartHourCount, 0)
    }

    func testSurvivesReopeningTheSameFile() throws {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let url = directory.appendingPathComponent("history.sqlite")
        do {
            let store = try ObservationStore(fileURL: url)
            try store.append([observation(at: now)])
        }
        let reopened = try ObservationStore(fileURL: url)
        XCTAssertEqual(try reopened.statistics().rawCount, 1)
    }

    func testRawWindowNeverOutlivesTheRetentionPeriod() {
        // Keeping raw rows past the retention period cannot be honoured, and a
        // user shortening retention should not have to remember this.
        XCTAssertEqual(ObservationRetention(retentionDays: 1, rawDays: 14).rawDays, 1)
        XCTAssertEqual(ObservationRetention(retentionDays: 90, rawDays: 14).rawDays, 14)
        XCTAssertEqual(ObservationRetention(retentionDays: 7, rawDays: 0).rawDays, 1)
    }

    func testUnsupportedRetentionFallsBackToTheDefault() {
        XCTAssertEqual(ObservationRetention(retentionDays: 45).retentionDays, 30)
        XCTAssertEqual(ObservationRetention(retentionDays: 90).retentionDays, 90)
    }
}
