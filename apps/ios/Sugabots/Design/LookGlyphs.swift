import SwiftUI

/// A head's shape alone, filled in the current foreground, as the web's `ShapeGlyph`.
struct ShapeGlyph: View {
	let shape: String
	var size: CGFloat = 20

	var body: some View {
		Canvas { context, canvas in
			let head = BotLooks.heads[shape] ?? BotLooks.heads["circle"]!
			context.scaleBy(x: canvas.width / 40, y: canvas.height / 40)
			for part in head.parts {
				context.fill(part.path, with: .foreground)
			}
		}
		.frame(width: size, height: size)
		.accessibilityHidden(true)
	}
}

/// A pair of eyes alone, without a head, cropped to the band they sit in, as the web's `EyesGlyph`.
struct EyesGlyph: View {
	let face: String
	var width: CGFloat = 34

	/// The band of the 40-unit face the eyes sit in, as the web's `viewBox="6 12 28 16"`.
	private static let band = CGRect(x: 6, y: 12, width: 28, height: 16)

	var body: some View {
		Canvas { context, canvas in
			let marks = BotLooks.faces[face] ?? BotLooks.faces["dot"]!
			context.scaleBy(x: canvas.width / Self.band.width, y: canvas.height / Self.band.height)
			context.translateBy(x: -Self.band.minX, y: -Self.band.minY)
			for mark in marks {
				mark.draw(in: context, with: .foreground, cap: .round)
			}
		}
		.frame(width: width, height: width * Self.band.height / Self.band.width)
		.accessibilityHidden(true)
	}
}

/// Which part of a look is being chosen.
enum LookPart: Hashable {
	case shape, eyes
}

/// Every head shape, drawn bare in the look's colour, or every pair of eyes,
/// drawn alone, with the colours along the foot, as the web's `LookStep`.
struct LookStep: View {
	@Binding var part: LookPart
	@Binding var look: BotLook

	var body: some View {
		VStack(spacing: 0) {
			HStack(spacing: 16) {
				ForEach([LookPart.shape, .eyes], id: \.self) { one in
					Button(one == .shape ? "Shape" : "Eyes") { part = one }
						.font(Typeface.rubik(15, .semibold))
						.foregroundStyle(part == one ? Palette.foreground : Palette.mutedForeground)
						.accessibilityAddTraits(part == one ? [.isSelected, .isHeader] : .isHeader)
				}
				Spacer()
			}
			.frame(height: 22)
			.padding(.horizontal, 20)
			.padding(.top, 20)
			.padding(.bottom, 16)
			ScrollView {
				LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 8), count: 4), spacing: 8) {
					if part == .shape {
						ForEach(AgentShape.known.map(\.rawValue), id: \.self) { shape in
							tile(label: shape, chosen: shape == look.shape) { look.shape = shape } content: {
								ShapeGlyph(shape: shape, size: 44).foregroundStyle(BotLooks.palettes[look.color]?.face ?? Palette.foreground)
							}
						}
					} else {
						ForEach(AgentFace.known.map(\.rawValue), id: \.self) { face in
							tile(label: face, chosen: face == look.face) { look.face = face } content: {
								EyesGlyph(face: face, width: 44).foregroundStyle(Palette.foreground)
							}
						}
					}
				}
				.padding(.horizontal, 20)
				.padding(.bottom, 16)
			}
			colourRow
				.padding(.horizontal, 16)
				.padding(.vertical, 14)
				.overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(Palette.borderStrong))
				.padding(.horizontal, 20)
				.padding(.bottom, 20)
		}
	}

	/// A square to choose one part from, ringed while it is chosen, as `LookStep`'s `Tile`.
	private func tile(label: String, chosen: Bool, choose: @escaping () -> Void, @ViewBuilder content: () -> some View) -> some View {
		Button(action: choose) {
			content()
				.frame(width: 68, height: 68)
				.background(chosen ? Palette.chip : .clear, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
				.overlay { if chosen { RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Palette.subtleForeground, lineWidth: 1.5) } }
				.contentShape(Rectangle())
		}
		.buttonStyle(.plain)
		.accessibilityLabel(label)
		.accessibilityAddTraits(chosen ? .isSelected : [])
	}

	/// The bot colours as round swatches, two rows of eight, the chosen one ringed, as `ColourRow`.
	private var colourRow: some View {
		LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 8), count: 8), spacing: 12) {
			ForEach(AgentColor.known.map(\.rawValue), id: \.self) { color in
				let face = BotLooks.palettes[color]?.face ?? .gray
				Button { look.color = color } label: {
					Circle()
						.fill(face)
						.frame(width: 28, height: 28)
						.overlay { if look.color == color { Circle().strokeBorder(face, lineWidth: 2).padding(-4) } }
				}
				.buttonStyle(.plain)
				.accessibilityLabel(color)
				.accessibilityAddTraits(look.color == color ? .isSelected : [])
			}
		}
	}
}
