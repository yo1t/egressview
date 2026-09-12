import Foundation

/// What counts as a country when the screen says how many.
///
/// The visited-country history holds one row per region code, and one of those
/// codes is `ZZ` -- the standard placeholder for "region unknown". Counting it
/// reports a country nobody went to, and the reader cannot tell which of the
/// numbers on screen included it. Measured on one Mac: 38 rows, of which one
/// was `ZZ`.
///
/// Whether the map can *draw* a country is a different question and not this
/// one. Two of that Mac's destinations have no outline in the bundled 110m
/// atlas because they are too small -- one of them carrying 9,835 connections
/// -- and they are still places the Mac reached. The count says where traffic
/// went; the map says what can be shaded.
public enum CountryCode {
    /// The placeholder used when a destination's region could not be
    /// determined.
    public static let unknown = "ZZ"

    /// Is this a real region, rather than the placeholder for none?
    ///
    /// `ZZ` is excluded by name rather than by asking the system for a
    /// localized name: the system has a translation for it ("Unknown Region"),
    /// so a nil check alone would count it as a country.
    public static func isRegion(_ code: String) -> Bool {
        let upper = code.uppercased()
        guard upper.count == 2, upper.allSatisfy({ $0.isASCII && $0.isLetter }) else { return false }
        guard upper != unknown else { return false }
        return Locale.current.localizedString(forRegionCode: upper) != nil
    }

    /// Just the real regions, uppercased.
    public static func countries<S: Sequence>(_ codes: S) -> [String] where S.Element == String {
        codes.map { $0.uppercased() }.filter(isRegion)
    }
}
