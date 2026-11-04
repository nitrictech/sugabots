import SwiftUI
import UIKit

/// A row that darkens while pressed, as the design's rows do.
struct PressableRowStyle: ButtonStyle {
	var pressed: Color = Palette.rowSelected
	var cornerRadius: CGFloat = 0

	func makeBody(configuration: Configuration) -> some View {
		configuration.label
			.contentShape(Rectangle())
			.background(configuration.isPressed ? pressed : .clear, in: RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
	}
}

/// Nothing here, or nothing could be loaded, and what to do about it, as the
/// web's `ui/empty-state.tsx`: perhaps a mark on a tile, a title, and a line
/// under it. It fills the space it's given, centred; in a scrolling page, which
/// gives none, the caller sets a height.
struct EmptyState: View {
	let title: String
	var icon: Lucide?
	var text: String?

	var body: some View {
		VStack(spacing: 10) {
			if let icon {
				Icon(icon, size: 20, strokeWidth: 1.75)
					.foregroundStyle(Palette.mutedForeground)
					.frame(width: 56, height: 56)
					.background(Palette.list, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
					.overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Palette.border))
					.padding(.bottom, 14)
			}
			Text(title).font(Typeface.rubik(15.5, .semibold)).foregroundStyle(Palette.foreground)
			if let text {
				Text(text).font(Typeface.rubik(13)).lineSpacing(5).foregroundStyle(Palette.mutedForeground)
			}
		}
		.multilineTextAlignment(.center)
		.frame(maxWidth: 400)
		.padding(24)
		.frame(maxWidth: .infinity, maxHeight: .infinity)
	}
}

/// A count in a pill, as the web's `CountBadge`: bright, or quiet for what merely waits.
struct CountBadge: View {
	enum Size {
		/// In a tab, as the web's `sm`.
		case small
		/// Beside Back in a conversation's header.
		case large
	}

	let count: Int
	var quiet = false
	var size = Size.small

	/// Past this, the badge says `99+`.
	private static let maxCounted = 99

	var body: some View {
		let large = size == .large
		Text(count > Self.maxCounted ? "\(Self.maxCounted)+" : "\(count)")
			.font(Typeface.rubik(large ? 12 : 10.5, .semibold))
			.monospacedDigit()
			.foregroundStyle(quiet ? Palette.foreground : Palette.primaryForeground)
			.padding(.horizontal, large ? 6 : 5)
			.frame(minWidth: large ? 20 : 18, minHeight: large ? 20 : 16)
			.background(quiet ? Palette.chipStrong : Palette.primary, in: Capsule())
			.accessibilityHidden(true)
	}
}

/// Show more, or Show less once open, under something folded.
struct ShowMoreButton: View {
	@Binding var open: Bool

	var body: some View {
		Button(open ? "Show less" : "Show more") { open.toggle() }
			.font(Typeface.rubik(12))
			.foregroundStyle(Palette.mutedForeground)
			.accessibilityValue(open ? "Expanded" : "Collapsed")
	}
}

/// The web's small icon button: a 20-point circle with a 14-point icon, muted until pressed.
struct SmallIconButton: View {
	let icon: Lucide
	let label: String
	let action: () -> Void

	var body: some View {
		Button(action: action) {
			Icon(icon, size: 14, strokeWidth: 2.2)
				.frame(width: 20, height: 20)
				.contentShape(Circle())
		}
		.buttonStyle(IconPressStyle())
		.accessibilityLabel(label)
	}
}

/// Muted, and filled with the hover colour while pressed, as the web's quiet icon buttons are.
struct IconPressStyle: ButtonStyle {
	func makeBody(configuration: Configuration) -> some View {
		configuration.label
			.foregroundStyle(configuration.isPressed ? Palette.foreground : Palette.mutedForeground)
			.background(configuration.isPressed ? Palette.hover : .clear, in: Circle())
	}
}

/// Glass in a capsule, filled stronger while pressed.
struct CapsuleGlassPressStyle: ButtonStyle {
	func makeBody(configuration: Configuration) -> some View {
		configuration.label
			.background(configuration.isPressed ? Palette.hoverStrong : .clear, in: Capsule())
			.glass(in: Capsule())
	}
}

/// The small Bot tag after a bot's name.
struct BotTag: View {
	var body: some View {
		Text("Bot")
			.font(Typeface.rubik(10.5, .semibold))
			.foregroundStyle(Palette.mutedForeground)
			.padding(.horizontal, 5)
			.padding(.vertical, 1)
			.background(Palette.chip, in: RoundedRectangle(cornerRadius: 4, style: .continuous))
	}
}

/// A line between days, or between a routine's runs: words between two rules.
struct LabelledDivider: View {
	let text: String
	var strong = true

	var body: some View {
		HStack(spacing: 12) {
			Rectangle().fill(Palette.border).frame(height: 1)
			Text(text)
				.font(Typeface.rubik(12, strong ? .semibold : .regular))
				.foregroundStyle(strong ? Palette.mutedForeground : Palette.subtleForeground)
				.fixedSize()
			Rectangle().fill(Palette.border).frame(height: 1)
		}
		.padding(.horizontal, 20)
		.padding(.top, strong ? 10 : 16)
		.padding(.bottom, 6)
	}
}

/// The web's typing dots: three dots rising in turn.
struct TypingDots: View {
	var small = false
	@State private var start = Date.now

	var body: some View {
		let size: CGFloat = small ? 3.5 : 7
		TimelineView(.animation) { timeline in
			let elapsed = timeline.date.timeIntervalSince(start)
			HStack(spacing: small ? 3 : 5) {
				ForEach(0..<3) { index in
					let phase = (elapsed - Double(index) * 0.15).truncatingRemainder(dividingBy: 1.2) / 1.2
					// Up and bright in the first 30% of each 1.2s cycle's 60%, resting after.
					let lift = phase < 0.3 ? phase / 0.3 : phase < 0.6 ? (0.6 - phase) / 0.3 : 0
					Circle()
						.frame(width: size, height: size)
						.opacity(0.35 + 0.65 * max(lift, 0))
						.offset(y: -size * 0.5 * max(lift, 0))
				}
			}
		}
		.accessibilityHidden(true)
	}
}

// MARK: Toast

/// A short note at the foot of the screen, such as "All caught up". Any screen can raise one.
@MainActor
@Observable
final class Toaster {
	private(set) var message: String?
	private var hiding: Task<Void, Never>?

	func show(_ message: String) {
		self.message = message
		hiding?.cancel()
		hiding = Task {
			try? await Task.sleep(for: .seconds(2.2))
			guard !Task.isCancelled else { return }
			self.message = nil
		}
	}
}

struct ToastOverlay: View {
	@Environment(Toaster.self) private var toaster

	var body: some View {
		if let message = toaster.message {
			Text(message)
				.font(Typeface.rubik(13, .medium))
				.foregroundStyle(Palette.background)
				.multilineTextAlignment(.center)
				.padding(.horizontal, 14)
				.padding(.vertical, 10)
				.background(Palette.foreground, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
				.shadow(color: .black.opacity(0.4), radius: 12, y: 8)
				.frame(maxWidth: 340)
				.padding(.bottom, 110)
				.transition(.opacity)
				.accessibilityAddTraits(.updatesFrequently)
		}
	}
}

// MARK: Sheets

/// A sheet's grabber, drawn at the top of its content: the system's floats
/// over the content, where it would cover what a sheet puts at its top.
/// The system's size and colour.
struct SheetGrabber: View {
	var body: some View {
		Capsule().fill(Palette.borderStrong).frame(width: 36, height: 5).padding(.top, 8)
	}
}

extension View {
	/// Presents a sheet as the app's are: at `detents`, on the panel colour, rounded,
	/// with no system grabber, for the content to draw a `SheetGrabber`.
	func phoneSheet(detents: Set<PresentationDetent>) -> some View {
		presentationDetents(detents)
			.presentationDragIndicator(.hidden)
			.presentationBackground(Palette.panel)
			.presentationCornerRadius(22)
	}
}

/// The system's share sheet, which saves a file to Files or sends it elsewhere.
struct ShareSheet: UIViewControllerRepresentable {
	let items: [Any]

	func makeUIViewController(context _: Context) -> UIActivityViewController {
		UIActivityViewController(activityItems: items, applicationActivities: nil)
	}

	func updateUIViewController(_: UIActivityViewController, context _: Context) {}
}

/// A file saved for the share sheet.
struct SavedFile: Identifiable {
	let url: URL
	var id: String { url.absoluteString }
}

// MARK: Navigation

extension UINavigationController {
	/// Keeps swiping back from the left edge working on pages that draw their own Back instead of a navigation bar.
	override open func viewDidLoad() {
		super.viewDidLoad()
		interactivePopGestureRecognizer?.delegate = SwipeBack.delegate
	}
}

/// The swipe back gesture's delegate. Its own object, rather than the navigation
/// controller, because UIKit could one day make `UINavigationController` a
/// gesture delegate itself, and two conformances would clash.
private final class SwipeBack: NSObject, UIGestureRecognizerDelegate {
	/// Kept here because a gesture holds its delegate weakly.
	static let delegate = SwipeBack()

	/// Only while there's a page to go back to. The gesture is on the navigation
	/// controller's view, whose next responder is the controller.
	func gestureRecognizerShouldBegin(_ gesture: UIGestureRecognizer) -> Bool {
		guard let navigation = gesture.view?.next as? UINavigationController else { return false }
		return navigation.viewControllers.count > 1
	}
}
