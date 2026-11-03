import CryptoKit
import SwiftUI

/// How a bot's colour is drawn: its face and eyes, and the tint behind what it says with the text on it.
struct BotPalette {
	let face: Color
	let eyes: Color
	let tint: ThemedColor
	let text: ThemedColor
	/// Links and inline code in what the bot says.
	let mono: ThemedColor
}

/// A pod colour's tile tint, and the swatch its initial is written in.
struct PodPalette {
	let tile: ThemedColor
	let swatch: Color
}

/// One filled piece of a head, in the 40-unit square a face is drawn in.
enum HeadPart {
	case path(String)
	case circle(cx: Double, cy: Double, r: Double)

	/// The piece's outline in the 40-unit square. A head's pieces are filled one
	/// by one rather than as one path, so where they overlap stays filled.
	var path: Path {
		switch self {
		case let .path(data): SVGPath.path(data)
		case let .circle(cx, cy, r): Path(ellipseIn: CGRect(x: cx - r, y: cy - r, width: 2 * r, height: 2 * r))
		}
	}
}

/// Where a head's eyes sit, and how large, against a full-size face.
struct EyePlacement {
	let x: Double
	let y: Double
	let scale: Double
}

struct HeadShape {
	let parts: [HeadPart]
	let eyes: EyePlacement
}

/// One mark on a face: an eye, or both eyes as one stroke.
enum FaceMark {
	case circle(cx: Double, cy: Double, r: Double)
	case rect(x: Double, y: Double, width: Double, height: Double, rx: Double)
	case stroke(String, width: Double)

	/// Draws the mark in the 40-unit square `context` is scaled to. `cap` ends a
	/// stroked mark: a bot's face leaves them square, as the web's avatar does,
	/// while the look picker's eyes round them, as the web's `EyesGlyph` does.
	func draw(in context: GraphicsContext, with shading: GraphicsContext.Shading, cap: CGLineCap) {
		switch self {
		case let .circle(cx, cy, r):
			context.fill(Path(ellipseIn: CGRect(x: cx - r, y: cy - r, width: 2 * r, height: 2 * r)), with: shading)
		case let .rect(x, y, width, height, rx):
			context.fill(Path(roundedRect: CGRect(x: x, y: y, width: width, height: height), cornerRadius: rx), with: shading)
		case let .stroke(data, width):
			context.stroke(SVGPath.path(data), with: shading, style: StrokeStyle(lineWidth: width, lineCap: cap))
		}
	}
}

/// The side of the square faces are drawn in, as `FACE_VIEWBOX_SIZE` in `@sugabots/avatars`.
private let faceViewboxSize = 40.0

/// A bot's face: its head in its colour, with its eyes, `size` points square.
struct BotFace: View {
	let look: BotLook
	var size: CGFloat = 24

	var body: some View {
		Canvas { context, canvas in
			let palette = BotLooks.palettes[look.color] ?? BotLooks.palettes["green"]!
			let head = BotLooks.heads[look.shape] ?? BotLooks.heads["circle"]!
			let marks = BotLooks.faces[look.face] ?? BotLooks.faces["dot"]!
			context.scaleBy(x: canvas.width / faceViewboxSize, y: canvas.height / faceViewboxSize)

			for part in head.parts {
				context.fill(part.path, with: .color(palette.face))
			}

			let eyes = head.eyes
			let centre = faceViewboxSize / 2
			var eyeContext = context
			eyeContext.translateBy(x: eyes.x, y: eyes.y)
			eyeContext.scaleBy(x: eyes.scale, y: eyes.scale)
			eyeContext.translateBy(x: -centre, y: -centre)
			for mark in marks {
				mark.draw(in: eyeContext, with: .color(palette.eyes), cap: .butt)
			}
		}
		.frame(width: size, height: size)
		.accessibilityHidden(true)
	}
}

/// How a bot looks, by the names the API gives its colour, eyes and head.
struct BotLook: Hashable {
	var color: String
	var face: String
	var shape: String
}

/// A person's initial on a grey disc, covered by their picture when they have
/// one, or else their Gravatar when their email has one, as the web draws them.
struct PersonAvatar: View {
	let name: String
	/// Absent where the person is not known by an address, such as an empty thread's header.
	var email: String?
	var image: String?
	var size: CGFloat = 24

	var body: some View {
		ZStack {
			Circle().fill(Palette.personAvatar)
			Text(Self.initials(of: name))
				.font(Typeface.rubik(max(9, (size * 0.34).rounded()), .bold))
				.foregroundStyle(Palette.personAvatarForeground)
			if let picture {
				// A failed load, such as an address with no Gravatar, leaves the initial showing.
				AsyncImage(url: picture) { phase in
					if let loaded = phase.image {
						loaded.resizable().scaledToFill()
					}
				}
				.clipShape(Circle())
			}
		}
		.frame(width: size, height: size)
		.accessibilityHidden(true)
	}

	private var picture: URL? {
		if let image, let url = URL(string: image) { return url }
		return email.map { Gravatar.url(for: $0, points: size) }
	}

	static func initial(of name: String) -> String {
		name.trimmingCharacters(in: .whitespaces).first.map { String($0).uppercased() } ?? "?"
	}

	/// As the web's `initials`: the first and last names' first letters, or a single name's first two.
	static func initials(of name: String) -> String {
		let parts = name.split(whereSeparator: \.isWhitespace)
		guard let first = parts.first else { return "?" }
		let last = parts.count > 1 ? parts.last : nil
		return (last.map { String(first.prefix(1)) + String($0.prefix(1)) } ?? String(first.prefix(2))).uppercased()
	}
}

/// Somebody's face: a bot's, or a person's avatar. Nobody, or a kind this app
/// doesn't know, leaves the space empty, so what follows lines up with its neighbours.
struct ParticipantFace: View {
	let participant: ThreadParticipant?
	let size: CGFloat

	var body: some View {
		switch participant {
		case let .agent(agent): BotFace(look: agent.look, size: size)
		case let .person(person): PersonAvatar(name: person.name, email: person.email, image: person.image, size: size)
		case .unknown, nil: Color.clear.frame(width: size, height: size)
		}
	}
}

/// Gravatar's address for an email, as `gravatarUrl` in the web app's `ui/avatar.tsx` builds it.
enum Gravatar {
	/// Drawn at three times its size, so it stays sharp on every iPhone screen.
	private static let pixelsPerPoint: CGFloat = 3

	/// Answers 404 when the address has no Gravatar, rather than a generated placeholder.
	static func url(for email: String, points: CGFloat) -> URL {
		let normalized = email.trimmingCharacters(in: .whitespaces).lowercased()
		let hash = SHA256.hash(data: Data(normalized.utf8)).map { String(format: "%02x", $0) }.joined()
		return URL(string: "https://gravatar.com/avatar/\(hash)?s=\(Int(points * pixelsPerPoint))&d=404")!
	}
}

/// A channel's face: a `#` on a rounded tile.
struct ChannelFace: View {
	let size: CGFloat

	var body: some View {
		Icon(.hash, size: size * 26 / 60, strokeWidth: 2)
			.foregroundStyle(Palette.softForeground)
			.frame(width: size, height: size)
			.background(Palette.chip, in: RoundedRectangle(cornerRadius: size * 0.3, style: .continuous))
			.accessibilityHidden(true)
	}
}

/// A pod's tile, as the web's rail draws it: its initial in its colour on a
/// tint of it, or a person for a Personal pod.
struct PodTile: View {
	let pod: Pod
	var size: CGFloat = 46
	var cornerRadius: CGFloat = 14

	var body: some View {
		let palette = pod.color.flatMap { BotLooks.pods[$0.rawValue] }
		Group {
			if pod.kind == .personal {
				Icon(.user, size: size * 20 / 46, strokeWidth: 2)
			} else {
				Text(PersonAvatar.initial(of: pod.name))
					.font(Typeface.rubik(size * 18 / 46, .semibold))
			}
		}
		.foregroundStyle(palette?.swatch ?? Palette.foreground)
		.frame(width: size, height: size)
		.background(palette?.tile.resolved ?? Palette.tile, in: RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
		.accessibilityHidden(true)
	}
}
