import SwiftUI

/// A connection's mark, as the web's `ui/connection-mark.tsx` draws it: a
/// catalog app's glyph on a tint of its brand, a mark in its own colours, or
/// for anything else, two letters of its name on grey.
struct ConnectionMark: View {
	enum Size {
		case xs, md, sm, tile, regular, lg

		var box: CGFloat {
			switch self {
			case .xs: 16
			case .md: 24
			case .sm: 32
			case .tile: 34
			case .regular: 40
			case .lg: 44
			}
		}

		var cornerRadius: CGFloat {
			switch self {
			case .xs: 5
			case .md: 7
			case .sm, .tile: 10
			case .regular: 12
			case .lg: 13
			}
		}

		var glyph: CGFloat {
			switch self {
			case .xs: 10
			case .md: 14
			case .sm: 16
			case .tile: 18
			case .regular: 20
			case .lg: 22
			}
		}

		var letters: CGFloat {
			switch self {
			case .xs: 8
			case .md: 11
			case .sm: 12
			case .tile: 13
			case .regular: 12.5
			case .lg: 15
			}
		}
	}

	/// A one-colour glyph on a 24-point square.
	struct Glyph {
		let color: Color
		let tint: ThemedColor
		let path: String
	}

	/// A mark in its own colours on a square of `size`.
	struct ColourGlyph {
		enum Paint {
			case hex(String)
			case token(Token)

			var color: Color {
				switch self {
				case let .hex(hex): Color(hex: hex)
				case .token(.foreground): Palette.foreground
				case .token(.panel): Palette.panel
				}
			}
		}

		/// The theme colours a mark may paint with.
		enum Token {
			case foreground, panel
		}

		struct Part {
			let path: String
			let fill: Paint?
			let stroke: Paint?
			let strokeWidth: CGFloat
			let roundCap: Bool
		}

		let size: CGFloat
		/// Its brand's tint behind it, or nil to sit on the panel inside a hairline.
		let tint: ThemedColor?
		let parts: [Part]
	}

	/// The catalog app or GitHub it is drawn as, from `connectionMarkFor`; nil for its letters.
	let presetId: String?
	let name: String
	var size = Size.regular

	var body: some View {
		let shape = RoundedRectangle(cornerRadius: size.cornerRadius, style: .continuous)
		Group {
			if let presetId, let colour = Self.colourGlyphs[presetId] {
				colourGlyph(colour)
					.frame(width: size.box, height: size.box)
					.background(colour.tint?.resolved ?? Palette.panel, in: shape)
					.overlay { if colour.tint == nil { shape.strokeBorder(Palette.borderSubtle) } }
			} else if let presetId, let glyph = Self.glyphs[presetId] {
				SVGShape(data: glyph.path, box: 24)
					.fill(Self.darkBrands.contains(presetId) ? Palette.foreground : glyph.color)
					.frame(width: size.glyph, height: size.glyph)
					.frame(width: size.box, height: size.box)
					.background(glyph.tint.resolved, in: shape)
			} else {
				Text(Self.letters(of: name))
					.font(Typeface.rubik(size.letters, .semibold))
					.foregroundStyle(Palette.foreground)
					.frame(width: size.box, height: size.box)
					.background(Palette.borderStrong, in: shape)
			}
		}
		.accessibilityHidden(true)
	}

	private func colourGlyph(_ colour: ColourGlyph) -> some View {
		ZStack {
			ForEach(Array(colour.parts.enumerated()), id: \.offset) { _, part in
				if let fill = part.fill {
					SVGShape(data: part.path, box: colour.size).fill(fill.color)
				}
				if let stroke = part.stroke {
					SVGShape(data: part.path, box: colour.size)
						.stroke(stroke.color, style: StrokeStyle(lineWidth: part.strokeWidth * size.glyph / colour.size, lineCap: part.roundCap ? .round : .butt))
				}
			}
		}
		.frame(width: size.glyph, height: size.glyph)
	}

	/// As `connectionLetters`: the first letters of its first two words, or a single word's first two.
	static func letters(of name: String) -> String {
		let words = name.split(whereSeparator: \.isWhitespace)
		guard let first = words.first else { return "?" }
		if words.count >= 2 { return (String(first.prefix(1)) + String(words[1].prefix(1))).uppercased() }
		return String(first.prefix(2)).uppercased()
	}

	/// As `connectionMarkFor`: GitHub's mark for a GitHub connection, a catalog app's for its server, else none.
	static func presetId(kind: String, url: String) -> String? {
		kind == "github" ? "github" : ConnectionPreset.matching(url: url)?.id
	}
}

extension ConnectionPreset {
	/// The catalog entry a connection was made from, by its address's host, as `connectionPresetFor`.
	static func matching(url: String) -> ConnectionPreset? {
		guard let host = host(of: url) else { return nil }
		return catalog.first { self.host(of: $0.url) == host }
	}

	private static func host(of url: String) -> String? {
		guard let match = url.range(of: "^https?://[^/?#]+", options: [.regularExpression, .caseInsensitive]) else { return nil }
		return url[match].split(separator: "/").last.map { $0.lowercased() }
	}
}

/// SVG path data on a square of `box` units, scaled to the frame it's given.
private struct SVGShape: Shape {
	let data: String
	let box: CGFloat

	func path(in rect: CGRect) -> Path {
		SVGPath.path(data).applying(
			CGAffineTransform(translationX: rect.minX, y: rect.minY).scaledBy(x: rect.width / box, y: rect.height / box)
		)
	}
}
