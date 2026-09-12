import XCTest
@testable import EgressViewAgentCore

/// The afterglow on the country map (P3-109).
final class CountryGlowTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 20_000)

    func test触れた直後は最大() {
        var glow = CountryGlow()
        glow.touch(["JP"], at: now)
        XCTAssertEqual(glow.intensity(for: "JP", at: now), 1, accuracy: 0.001)
    }

    func test時間とともに弱まる() {
        var glow = CountryGlow()
        glow.touch(["JP"], at: now)
        let early = glow.intensity(for: "JP", at: now.addingTimeInterval(1))
        let late = glow.intensity(for: "JP", at: now.addingTimeInterval(4))
        XCTAssertLessThan(late, early)
        XCTAssertGreaterThan(late, 0)
    }

    func test余韻が切れたら消える() {
        var glow = CountryGlow()
        glow.touch(["JP"], at: now)
        XCTAssertEqual(
            glow.intensity(for: "JP", at: now.addingTimeInterval(CountryGlow.fadeDuration)), 0
        )
    }

    func test両端がなめらか() {
        // A straight line arrives and leaves with a visible edge, which reads
        // as a flicker rather than an afterglow. Near both ends the change per
        // unit time is smaller than in the middle.
        var glow = CountryGlow()
        glow.touch(["JP"], at: now)
        func value(_ seconds: Double) -> Double {
            glow.intensity(for: "JP", at: now.addingTimeInterval(seconds))
        }
        let step = CountryGlow.fadeDuration / 10
        let atStart = abs(value(0) - value(step))
        let atMiddle = abs(value(CountryGlow.fadeDuration / 2 - step / 2)
                           - value(CountryGlow.fadeDuration / 2 + step / 2))
        let atEnd = abs(value(CountryGlow.fadeDuration - step) - value(CountryGlow.fadeDuration))
        XCTAssertLessThan(atStart, atMiddle, "立ち上がりが直線的")
        XCTAssertLessThan(atEnd, atMiddle, "消え際が直線的")
    }

    func test触れ直すと最初から() {
        var glow = CountryGlow()
        glow.touch(["JP"], at: now)
        let again = now.addingTimeInterval(4)
        glow.touch(["JP"], at: again)
        XCTAssertEqual(glow.intensity(for: "JP", at: again), 1, accuracy: 0.001)
    }

    func test触れていない国は光らない() {
        var glow = CountryGlow()
        glow.touch(["JP"], at: now)
        XCTAssertEqual(glow.intensity(for: "US", at: now), 0)
    }

    func test大文字小文字を問わない() {
        var glow = CountryGlow()
        glow.touch(["jp"], at: now)
        XCTAssertEqual(glow.intensity(for: "JP", at: now), 1, accuracy: 0.001)
    }

    func test何も光っていなければ動かさない() {
        // What the drawing asks before it animates. A map that keeps redrawing
        // an unchanging picture is how the Windows globe spent 1.11 CPU cores
        // on a still image (P3-16).
        var glow = CountryGlow()
        XCTAssertFalse(glow.isActive(at: now))
        glow.touch(["JP"], at: now)
        XCTAssertTrue(glow.isActive(at: now))
        XCTAssertFalse(glow.isActive(at: now.addingTimeInterval(CountryGlow.fadeDuration)))
    }

    func test最後の光が消える時刻を言える() {
        var glow = CountryGlow()
        glow.touch(["JP"], at: now)
        glow.touch(["US"], at: now.addingTimeInterval(2))
        XCTAssertEqual(
            glow.endsAt(), now.addingTimeInterval(2 + CountryGlow.fadeDuration)
        )
    }

    func test消えたものは忘れる() {
        // Otherwise the dictionary grows for as long as the window is open.
        var glow = CountryGlow()
        glow.touch(["JP"], at: now)
        glow.prune(at: now.addingTimeInterval(CountryGlow.fadeDuration + 1))
        XCTAssertTrue(glow.isEmpty)
    }
}
