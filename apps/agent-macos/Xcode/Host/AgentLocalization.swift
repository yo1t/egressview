import Foundation

enum AgentLanguage: String, CaseIterable, Identifiable {
    case system
    case english
    case japanese

    static let defaultsKey = "agentLanguage"

    var id: String { rawValue }

    var title: String {
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
}

enum AgentStrings {
    static var selectedLanguage: AgentLanguage {
        guard let raw = UserDefaults.standard.string(forKey: AgentLanguage.defaultsKey),
              let language = AgentLanguage(rawValue: raw) else {
            return .system
        }
        return language
    }

    static func text(_ key: String, _ arguments: CVarArg...) -> String {
        text(key, arguments: arguments)
    }

    static func text(_ key: String, arguments: [CVarArg]) -> String {
        let format = localizationBundle.localizedString(forKey: key, value: key, table: nil)
        guard !arguments.isEmpty else { return format }
        return String(format: format, locale: effectiveLocale, arguments: arguments)
    }

    private static var effectiveLanguageCode: String {
        if let explicit = selectedLanguage.languageCode { return explicit }
        let preferred = Locale.preferredLanguages.first ?? "en"
        return preferred.lowercased().hasPrefix("ja") ? "ja" : "en"
    }

    private static var effectiveLocale: Locale {
        Locale(identifier: effectiveLanguageCode)
    }

    private static var localizationBundle: Bundle {
        guard let path = Bundle.main.path(forResource: effectiveLanguageCode, ofType: "lproj"),
              let bundle = Bundle(path: path) else {
            return .main
        }
        return bundle
    }
}

@MainActor
final class AgentLanguageSettings: ObservableObject {
    static let shared = AgentLanguageSettings()

    @Published var language: AgentLanguage {
        didSet { UserDefaults.standard.set(language.rawValue, forKey: AgentLanguage.defaultsKey) }
    }

    private init() {
        language = AgentStrings.selectedLanguage
    }
}

func L(_ key: String, _ arguments: CVarArg...) -> String {
    AgentStrings.text(key, arguments: arguments)
}
