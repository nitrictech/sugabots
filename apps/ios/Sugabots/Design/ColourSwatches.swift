import SwiftUI

/// Round swatches, the chosen one ringed, as the web's `Swatches` in
/// `LookPicker`. Without `columns`, as many 28-point swatches as fit across the
/// row, spread to its ends, the rest wrapping into the same columns; with it,
/// that many to a row, each up to 32 points, shrinking to fit a narrow row.
struct ColourSwatches: View {
	let colors: [String]
	let swatch: (String) -> Color
	let value: String
	var columns: Int?
	let choose: (String) -> Void

	/// A swatch's width, and the least gap between two, when they wrap.
	private static let size: CGFloat = 28
	private static let gap: CGFloat = 6
	/// The widest a swatch grows, and the gap down as across, in set columns.
	private static let columnSize: CGFloat = 32
	private static let columnGap: CGFloat = 10

	var body: some View {
		Group {
			if let columns {
				LazyVGrid(
					columns: Array(repeating: GridItem(.flexible(maximum: Self.columnSize), spacing: Self.columnGap), count: columns),
					alignment: .leading,
					spacing: Self.columnGap
				) {
					ForEach(colors, id: \.self) { color in swatchButton(color).aspectRatio(1, contentMode: .fit) }
				}
			} else {
				LazyVGrid(columns: [GridItem(.adaptive(minimum: Self.size, maximum: Self.size + 20), spacing: Self.gap)], alignment: .leading, spacing: Self.gap) {
					ForEach(colors, id: \.self) { color in
						swatchButton(color).frame(width: Self.size, height: Self.size).frame(maxWidth: .infinity)
					}
				}
			}
		}
		.padding(.vertical, 5)
		.frame(maxWidth: .infinity)
	}

	private func swatchButton(_ color: String) -> some View {
		Button { choose(color) } label: {
			Circle()
				.fill(swatch(color))
				// The web's ring: a gap in the panel's colour, then the swatch's.
				.overlay { if value == color { Circle().strokeBorder(swatch(color), lineWidth: 2).padding(-5) } }
		}
		.buttonStyle(.plain)
		.accessibilityLabel(color)
		.accessibilityAddTraits(value == color ? .isSelected : [])
	}
}
