import SwiftUI

/// A model provider's mark, as the web's `ProviderTile`: its logo in an
/// outlined 28-point tile, or a 44-point one on a chip, or its initial where
/// it has no logo.
struct ProviderTile: View {
	let name: String
	let preset: String?
	var large = false

	var body: some View {
		let shape = RoundedRectangle(cornerRadius: large ? 11 : 7, style: .continuous)
		Group {
			if let preset, let logo = ProviderLogos.assets[preset] {
				Image(logo.image)
					.resizable()
					.scaledToFit()
					.frame(width: large ? 22 : 14, height: large ? 22 : 14)
					.scaleEffect(logo.scale)
			} else {
				Text(name.trimmingCharacters(in: .whitespaces).prefix(1).uppercased())
					.font(Typeface.rubik(large ? 15 : 12, .semibold))
					.foregroundStyle(Palette.softForeground)
			}
		}
		.frame(width: large ? 44 : 28, height: large ? 44 : 28)
		.background(large ? Palette.chip : .clear, in: shape)
		.overlay { if !large { shape.strokeBorder(Palette.borderStrong) } }
		.accessibilityHidden(true)
	}
}
