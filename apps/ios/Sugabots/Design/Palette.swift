import SwiftUI
import UIKit

/// The web app's colour tokens (`packages/web/src/app.css`), each as light
/// and dark draw it, in `Palette.generated.swift`. Which one shows follows the
/// theme chosen on You, dark unless changed, as on the web.
enum Palette {
	static func themed(light: UIColor, dark: UIColor) -> Color {
		Color(UIColor { $0.userInterfaceStyle == .dark ? dark : light })
	}
}

/// The theme chosen on You, as the web keeps it: dark, light, or the device's.
enum Theme: String, CaseIterable, Identifiable {
	case dark, light, system

	static let storageKey = "theme"

	var id: String { rawValue }

	var label: String {
		switch self {
		case .dark: "Dark"
		case .light: "Light"
		case .system: "System"
		}
	}

	var colorScheme: ColorScheme? {
		switch self {
		case .dark: .dark
		case .light: .light
		case .system: nil
		}
	}
}

/// The web's type: Rubik, and JetBrains Mono for code, addresses and requests.
enum Typeface {
	static func rubik(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font {
		.custom("Rubik", size: size).weight(weight)
	}

	static func mono(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font {
		.custom("JetBrains Mono", size: size).weight(weight)
	}

	/// Registers the fonts shipped as web fonts, which `UIAppFonts` can't list.
	static func registerWebFonts() {
		for url in Bundle.main.urls(forResourcesWithExtension: "woff2", subdirectory: nil) ?? [] {
			CTFontManagerRegisterFontsForURL(url as CFURL, .process, nil)
		}
	}
}

/// A colour as each appearance draws it, for the bot palettes generated from `@sugabots/avatars`.
struct ThemedColor {
	let light: Color
	let dark: Color

	/// The colour for the appearance showing.
	var resolved: Color {
		Palette.themed(light: UIColor(light), dark: UIColor(dark))
	}
}

extension UIColor {
	/// `#rrggbb`. Anything else is a programming error in a literal, drawn magenta so it shows.
	convenience init(hex: String, alpha: CGFloat = 1) {
		let digits = hex.hasPrefix("#") ? String(hex.dropFirst()) : hex
		guard digits.count == 6, let value = UInt32(digits, radix: 16) else {
			self.init(red: 1, green: 0, blue: 1, alpha: 1)
			return
		}
		self.init(
			red: CGFloat((value >> 16) & 0xFF) / 255,
			green: CGFloat((value >> 8) & 0xFF) / 255,
			blue: CGFloat(value & 0xFF) / 255,
			alpha: alpha
		)
	}
}

extension Color {
	/// `#rrggbb`, drawn the same in either appearance.
	init(hex: String) {
		self.init(UIColor(hex: hex))
	}
}
