import Foundation

public enum AgentLanguage: String, CaseIterable, Identifiable {
    case system
    case english
    case japanese

    public static let defaultsKey = "agentLanguage"

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .system: return AgentStrings.text("System Default")
        case .english: return "English"
        case .japanese: return "日本語"
        }
    }

    var languageCode: String? {
        switch self {
        case .system: return nil
        case .english: return "en"
        case .japanese: return "ja"
        }
    }

    var effectiveLanguageCode: String {
        if let languageCode { return languageCode }
        let preferred = Locale.preferredLanguages.first ?? "en"
        return preferred.lowercased().hasPrefix("ja") ? "ja" : "en"
    }

    public var locale: Locale {
        Locale(identifier: effectiveLanguageCode)
    }
}

public enum AgentStrings {
    static var selectedLanguage: AgentLanguage {
        guard let raw = UserDefaults.standard.string(forKey: AgentLanguage.defaultsKey),
              let language = AgentLanguage(rawValue: raw) else {
            return .system
        }
        return language
    }

    public static func text(_ key: String, _ arguments: CVarArg...) -> String {
        text(key, arguments: arguments)
    }

    public static func text(_ key: String, arguments: [CVarArg]) -> String {
        let format = localizationBundle.localizedString(forKey: key, value: key, table: nil)
        guard !arguments.isEmpty else { return format }
        return String(format: format, locale: effectiveLocale, arguments: arguments)
    }

    private static var effectiveLanguageCode: String {
        selectedLanguage.effectiveLanguageCode
    }

    private static var effectiveLocale: Locale {
        selectedLanguage.locale
    }

    /// Where a tool that is not the application should look for the strings.
    ///
    /// `Bundle.main` is the application when the application is running, and
    /// the executable itself when anything else is. A command-line tool
    /// therefore found no `.lproj`, fell through to `.main`, and got the key
    /// back -- which reads as English, because the keys are English sentences.
    /// The render tool looked correct while showing nothing that had been
    /// translated, so it could not have caught a layout that only breaks in
    /// Japanese, where the text has a different width.
    ///
    /// Nil in the application, which keeps using `Bundle.main`.
    public static var resourceDirectoryOverride: URL?

    private static var localizationBundle: Bundle {
        if let root = resourceDirectoryOverride,
           let bundle = Bundle(url: root.appendingPathComponent("\(effectiveLanguageCode).lproj")) {
            return bundle
        }
        guard let path = Bundle.main.path(forResource: effectiveLanguageCode, ofType: "lproj"),
              let bundle = Bundle(path: path) else {
            return .main
        }
        return bundle
    }
}

@MainActor
public final class AgentLanguageSettings: ObservableObject {
    public static let shared = AgentLanguageSettings()

    @Published public var language: AgentLanguage {
        didSet { UserDefaults.standard.set(language.rawValue, forKey: AgentLanguage.defaultsKey) }
    }

    private init() {
        language = AgentStrings.selectedLanguage
    }
}

public func L(_ key: String, _ arguments: CVarArg...) -> String {
    AgentStrings.text(key, arguments: arguments)
}
