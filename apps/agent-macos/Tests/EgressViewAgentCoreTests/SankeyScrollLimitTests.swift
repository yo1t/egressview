import XCTest
@testable import EgressViewAgentCore

/// P3-15。上位8件では「その他」が34%を占めていた。30件へ広げ、画面に入る件数は窓の高さが決め、残りはスクロールで届く。
final class SankeyScrollLimitTests: XCTestCase {
    /// A long tail like the measured one: 656 destinations over a day.
    private func manyPairs(_ count: Int) -> [AppDestinationTotal] {
        (1...count).map {
            AppDestinationTotal(
                processName: "app",
                destination: "dst-\($0).example.com",
                sessionCount: count - $0 + 1,
                bytes: 0,
                observationsWithoutBytes: 0
            )
        }
    }

    func test三十件まで名前を出す() {
        let model = SankeyAggregator().aggregate(manyPairs(100), metric: .sessions)
        let named = model.destinations.filter { !$0.isRemainder }
        XCTAssertEqual(named.count, 30, "上位30件を名前で出していない")
    }

    func test残りはその他へ畳む() {
        // The tail is long enough that raising the limit does not empty it.
        // Measured: 34% at eight names, 21% at thirty.
        let model = SankeyAggregator().aggregate(manyPairs(100), metric: .sessions)
        XCTAssertTrue(model.destinations.contains { $0.isRemainder }, "その他が消えた")
    }

    func test三十件に満たなければその他は出さない() {
        // Otherwise a small network gets an "Other" worth nothing.
        let model = SankeyAggregator().aggregate(manyPairs(5), metric: .sessions)
        XCTAssertFalse(model.destinations.contains { $0.isRemainder })
        XCTAssertEqual(model.destinations.count, 5)
    }

    func test三十件でも一番小さいノードが消えない() {
        // The card is ten rows tall and scrolls, so the layout gets the height
        // thirty rows need rather than squeezing them into ten. A node that
        // rounds to nothing would be a name pointing at no ribbon.
        let model = SankeyAggregator().aggregate(manyPairs(40), metric: .sessions)
        let height = CGFloat(max(model.apps.count, model.destinations.count)) * 21
        let layout = SankeyLayout(nodeWidth: 10, nodeGap: 6)
            .layout(model, in: CGSize(width: 400, height: height))
        let smallest = layout.destinations.map { $0.rect.height }.min() ?? 0
        XCTAssertGreaterThan(smallest, 0, "一番小さい宛先が高さ0になった")
    }

    func test順序は大きい順でその他は最後() {
        let model = SankeyAggregator().aggregate(manyPairs(50), metric: .sessions)
        let values = model.destinations.filter { !$0.isRemainder }.map { $0.value }
        XCTAssertEqual(values, values.sorted(by: >), "大きい順になっていない")
        XCTAssertTrue(model.destinations.last?.isRemainder ?? false, "その他が最後にない")
    }
}
