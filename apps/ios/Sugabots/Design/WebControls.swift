import SwiftUI

// The web app's controls as a phone draws them (`packages/web/src/ui`),
// at the same sizes, so a page here reads as the same page there.

extension View {
	/// Glass: a translucent fill over a blur of what lies behind, with a hairline
	/// edge inside, in the environment's `glassStyle`.
	func glass<S: InsettableShape>(in shape: S) -> some View {
		modifier(Glass(shape: shape))
	}
}

/// How glass is drawn.
enum GlassStyle {
	/// The web's `glass`: its fill over a trace of the system's thinnest
	/// material. At full strength the material also lightens what it blurs,
	/// unlike the web's `backdrop-filter: blur()`, enough to hide the tab bar's
	/// highlight in dark.
	case web
	/// Frosted, after Slack's header: the system's material at full strength,
	/// lighter than the page, so what scrolls under it blurs into shapes. Every
	/// page's controls use it, so Back looks the same on each.
	case frosted
}

private struct Glass<S: InsettableShape>: ViewModifier {
	let shape: S
	@Environment(\.glassStyle) private var style

	/// How much of the material the web's glass keeps.
	private static var webMaterialStrength: Double { 0.15 }

	func body(content: Content) -> some View {
		switch style {
		case .web:
			content
				.background(Palette.glass, in: shape)
				.background { shape.fill(.ultraThinMaterial).opacity(Self.webMaterialStrength) }
				.overlay(shape.strokeBorder(Palette.glassEdge, lineWidth: 1))
		case .frosted:
			content
				.background(Frost.tint, in: shape)
				.background(.regularMaterial, in: shape)
				.overlay(
					shape.strokeBorder(
						LinearGradient(colors: [Frost.edgeTop, Frost.edgeBottom], startPoint: .top, endPoint: .bottom),
						lineWidth: 1
					)
				)
		}
	}
}

/// Frosted glass's colours.
private enum Frost {
	/// Lifts the glass a step off the page, a light grey in dark.
	static let tint = Palette.themed(light: UIColor(white: 1, alpha: 0.3), dark: UIColor(white: 1, alpha: 0.1))
	/// Its edge: catching the light along the top, fading down the sides.
	static let edgeTop = Palette.themed(light: UIColor(white: 0, alpha: 0.08), dark: UIColor(white: 1, alpha: 0.22))
	static let edgeBottom = Palette.themed(light: UIColor(white: 0, alpha: 0.04), dark: UIColor(white: 1, alpha: 0.04))
}

private struct GlassStyleKey: EnvironmentKey {
	static let defaultValue = GlassStyle.frosted
}

extension EnvironmentValues {
	/// How glass under it is drawn: frosted, or the web's for the tab bar.
	var glassStyle: GlassStyle {
		get { self[GlassStyleKey.self] }
		set { self[GlassStyleKey.self] = newValue }
	}
}

/// The gap above a page's header, as the web's `pt-[max(12px,env(safe-area-inset-top))]`
/// draws it in an installed app: `fromScreenTop` points from the top of the screen,
/// or the safe area where that is deeper. The header is laid out below the safe area
/// already, so the gap is what `fromScreenTop` leaves beyond it: none under a status
/// bar, and all of it in landscape, where the top of the screen has no safe area.
/// Pages fill the screen, so the window's safe area is theirs.
@MainActor
private struct PageTopPadding: ViewModifier {
	let fromScreenTop: CGFloat
	@State private var safeAreaTop = Self.windowSafeAreaTop()

	func body(content: Content) -> some View {
		content
			.padding(.top, max(0, fromScreenTop - safeAreaTop))
			.onReceive(NotificationCenter.default.publisher(for: UIDevice.orientationDidChangeNotification)) { _ in
				safeAreaTop = Self.windowSafeAreaTop()
			}
	}

	@MainActor private static func windowSafeAreaTop() -> CGFloat {
		WindowInsets.current.top
	}
}

/// The app window's safe area: the status bar or Dynamic Island above, and the
/// home indicator below. Pages fill the window, so this is their safe area too.
@MainActor
enum WindowInsets {
	static var current: UIEdgeInsets {
		let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
		return scenes.first { $0.activationState == .foregroundActive }?.keyWindow?.safeAreaInsets
			?? scenes.first?.windows.first?.safeAreaInsets
			?? .zero
	}

	/// How far the tab bar reaches down into the home indicator's band, as
	/// Slack's does, leaving the content more room.
	static let barReach: CGFloat = 12

	/// How far the header rises into the safe area at the top. The Dynamic
	/// Island ends 11 points above the safe area's edge, and the header keeps 8
	/// points below it, so it rises 3; a notch or status bar gives nothing.
	static var headerRise: CGFloat { current.top > 47 ? 3 : 0 }

	/// How far the tab bar sinks into the safe area at the foot: up to `barReach`,
	/// keeping 8 points off the screen's edge.
	static var tabBarSink: CGFloat { min(barReach, max(0, current.bottom - 8)) }
}

/// How far a page's side bars (the tab bar, the composer) sit in from the screen's edges.
let barSideInset: CGFloat = 21

extension View {
	/// The gap above a page's header: see `PageTopPadding`. Pages take 12
	/// points, a dialog's form 16, as the web's `max(…, safe area)` for each.
	func pageTopPadding(_ fromScreenTop: CGFloat = 12) -> some View {
		modifier(PageTopPadding(fromScreenTop: fromScreenTop))
	}

	/// A page header's room: 16 points in from the sides, or `trailing` on the
	/// right where a bar button's own room makes up the rest, the page's top
	/// gap above, and 8 points below.
	func pageHeaderInsets(trailing: CGFloat = 16) -> some View {
		padding(.leading, 16)
			.padding(.trailing, trailing)
			.pageTopPadding()
			.padding(.bottom, 8)
	}
}

/// A phone's round glass control at a page's top corners, as the web's
/// `FLOATING_ON_PHONE` draws it: an icon on a 44-point glass circle, filled
/// stronger while pressed. Its icon is 20 points by default, with Lucide's
/// stroke; where the web gives an icon its own, so does the caller.
struct GlassRoundIcon: View {
	let icon: Lucide
	var size: CGFloat = 20
	var strokeWidth: CGFloat = 2
	var pressed = false

	var body: some View {
		Icon(icon, size: size, strokeWidth: strokeWidth)
			.foregroundStyle(Palette.foreground)
			.frame(width: 44, height: 44)
			.background(pressed ? Palette.hoverStrong : .clear, in: Circle())
			.glass(in: Circle())
	}
}

/// A `GlassRoundIcon` that is a button: Back, Close, a page's + or Mark done.
/// Its icon is Back's chevron's size unless it's given another, as the web's.
struct GlassRoundButton: View {
	let icon: Lucide
	let label: String
	var iconSize: CGFloat = 22
	var strokeWidth: CGFloat = 2.25
	let action: () -> Void

	var body: some View {
		Button(action: action) { EmptyView() }
			.buttonStyle(PressStyle(icon: icon, size: iconSize, strokeWidth: strokeWidth))
			.accessibilityLabel(label)
	}

	/// Draws the button as its icon, filled stronger while pressed, as the web's `active:bg-hover-strong`.
	private struct PressStyle: ButtonStyle {
		let icon: Lucide
		let size: CGFloat
		let strokeWidth: CGFloat

		func makeBody(configuration: Configuration) -> some View {
			GlassRoundIcon(icon: icon, size: size, strokeWidth: strokeWidth, pressed: configuration.isPressed)
				.contentShape(Circle())
		}
	}
}

/// A header's round glass ⋯ that opens a menu. The menu is UIKit's: SwiftUI's
/// `Menu` places its own button clear of the safe area, wherever its frame is,
/// so in a header that reaches into the safe area it would sit lower than the
/// controls beside it.
struct GlassMenuButton: View {
	struct Item {
		let title: String
		let systemImage: String
		let action: () -> Void
	}

	let label: String
	let items: [Item]

	var body: some View {
		GlassRoundIcon(icon: .ellipsis)
			.overlay { MenuTarget(label: label, items: items) }
	}

	/// A clear button over the glass that opens the menu as it's tapped.
	private struct MenuTarget: UIViewRepresentable {
		let label: String
		let items: [Item]

		func makeUIView(context _: Context) -> UIButton {
			let button = UIButton(type: .custom)
			button.showsMenuAsPrimaryAction = true
			return button
		}

		func updateUIView(_ button: UIButton, context _: Context) {
			button.accessibilityLabel = label
			button.menu = UIMenu(children: items.map { item in
				UIAction(title: item.title, image: UIImage(systemName: item.systemImage)) { _ in item.action() }
			})
		}
	}
}

/// Back, at a page's top left on a phone: a glass circle with a chevron.
struct PhoneBackButton: View {
	var label = "Back"
	var action: (() -> Void)?
	@Environment(\.dismiss) private var dismiss

	var body: some View {
		GlassRoundButton(icon: .chevronLeft, label: label) {
			if let action { action() } else { dismiss() }
		}
	}
}

/// Back as words with a chevron, at the top left of the pages outside a
/// workspace and of setup's steps, as the web's `AuthLayout` and onboarding draw it.
struct TextBackButton: View {
	let action: () -> Void

	var body: some View {
		Button(action: action) {
			HStack(spacing: 2) {
				Icon(.chevronLeft, size: 16, strokeWidth: 2.4)
				Text("Back")
			}
			.font(Typeface.rubik(14.5, .medium))
			.foregroundStyle(Palette.foreground)
		}
		.buttonStyle(.plain)
	}
}

/// A quiet text action under a form, such as Forgot password or Skip for now.
struct QuietLinkStyle: ButtonStyle {
	func makeBody(configuration: Configuration) -> some View {
		configuration.label
			.font(Typeface.rubik(14, .medium))
			.foregroundStyle(Palette.mutedForeground)
			.padding(6)
			.opacity(configuration.isPressed ? 0.7 : 1)
	}
}

/// The web's `Button`, in its variants, at a phone's height for a page's main action.
struct WebButtonStyle: ButtonStyle {
	enum Variant {
		/// Filled with the foreground: the one strong action.
		case primary
		case secondary
		/// A step stronger than secondary, to read on a card's fill.
		case muted
		case ghost
		case destructive
	}

	enum Size {
		case small
		case regular
		case large
		/// A phone dialog's footer: full width and 44 tall.
		case phone
		/// A full-screen page's action at its top right: 44 tall and fully
		/// round, as the web's `h-11 rounded-full px-5 text-[15px]`.
		case pill
	}

	var variant = Variant.primary
	var size = Size.regular
	/// Across the whole width, as a form's main action at its foot.
	var fullWidth = false
	@Environment(\.isEnabled) private var isEnabled

	func makeBody(configuration: Configuration) -> some View {
		let pressed = configuration.isPressed
		configuration.label
			.font(Typeface.rubik(fontSize, variant == .ghost || variant == .destructive ? .medium : .semibold))
			.lineLimit(1)
			.padding(.horizontal, horizontalPadding)
			.frame(height: height)
			.frame(maxWidth: size == .phone || fullWidth ? .infinity : nil)
			.foregroundStyle(foreground)
			.background(background(pressed: pressed), in: RoundedRectangle(cornerRadius: size == .pill ? height / 2 : 8, style: .continuous))
			.opacity(!isEnabled && (variant == .ghost || variant == .destructive) ? 0.5 : 1)
			.contentShape(Rectangle())
	}

	private var height: CGFloat {
		switch size {
		case .small: 29
		case .regular: 36
		case .large: 48
		case .phone, .pill: 44
		}
	}

	private var fontSize: CGFloat {
		switch size {
		case .small: 13
		case .regular: 14
		// The web's `text-lg`.
		case .large: 15
		case .phone, .pill: 15
		}
	}

	private var horizontalPadding: CGFloat {
		switch size {
		case .small: 14
		case .regular, .phone: 16
		case .large, .pill: 20
		}
	}

	private var foreground: Color {
		switch variant {
		case .primary: isEnabled ? Palette.primaryForeground : Palette.disabledForeground
		case .secondary, .muted: isEnabled ? Palette.foreground : Palette.disabledForeground
		case .ghost: Palette.mutedForeground
		case .destructive: Palette.destructiveText
		}
	}

	private func background(pressed: Bool) -> Color {
		switch variant {
		case .primary: !isEnabled ? Palette.chip : pressed ? Palette.primaryHover : Palette.primary
		case .secondary: pressed ? Palette.hover : Palette.chip
		case .muted: pressed ? Palette.hoverStrong : Palette.hover
		case .ghost: pressed ? Palette.hover : .clear
		case .destructive: pressed ? Palette.destructiveHover : .clear
		}
	}
}

/// The top of a page that fills the screen, as the web's phone New bot and
/// Look editor: a round button at the left, the title centred, and the page's
/// action, a `.pill` button, at the right.
struct ScreenHeader<Leading: View, Trailing: View>: View {
	let title: String
	@ViewBuilder var leading: Leading
	@ViewBuilder var trailing: Trailing

	var body: some View {
		ZStack {
			Text(title)
				.font(Typeface.rubik(17, .semibold))
				.foregroundStyle(Palette.foreground)
				.accessibilityAddTraits(.isHeader)
			HStack {
				leading
				Spacer()
				trailing
			}
		}
		.padding(.horizontal, 16)
		.pageTopPadding()
	}
}

/// A dialog's form as a phone shows it, the whole screen: Close at the top
/// left and the title centred, the body scrolling under them, and the action
/// across the foot.
struct DialogForm<Body: View>: View {
	let title: String
	/// The footer's button, or nil for a form that acts as it goes.
	var action: String?
	var actionDisabled = false
	/// Shown in place of Close, for a step after the first.
	var onBack: (() -> Void)?
	/// Whether Close shows; hidden while a step can't be left.
	var closable = true
	var gap: CGFloat = 14
	var submit: () -> Void = {}
	@ViewBuilder var content: Body
	@Environment(\.dismiss) private var dismiss

	var body: some View {
		VStack(spacing: 0) {
			ZStack {
				Text(title)
					.font(Typeface.rubik(17, .semibold))
					.foregroundStyle(Palette.foreground)
					.lineLimit(1)
					.padding(.horizontal, 56)
					.accessibilityAddTraits(.isHeader)
				HStack {
					if let onBack {
						GlassRoundButton(icon: .chevronLeft, label: "Back", action: onBack)
					} else if closable {
						GlassRoundButton(icon: .x, label: "Close", iconSize: 20) { dismiss() }
					}
					Spacer()
				}
			}
			.padding(.horizontal, 16)
			.pageTopPadding(16)
			.padding(.bottom, 12)
			ScrollView {
				VStack(alignment: .leading, spacing: gap) { content }
					.padding(.horizontal, 16)
					.padding(.top, 4)
					.padding(.bottom, 20)
			}
			.scrollDismissesKeyboard(.interactively)
			if let action {
				Button(action: submit) { Text(action) }
					.buttonStyle(WebButtonStyle(size: .phone))
					.disabled(actionDisabled)
					.padding(.horizontal, 16)
					.padding(.top, 12)
					.padding(.bottom, 16)
			}
		}
		.background(Palette.panel.ignoresSafeArea())
	}
}

// MARK: Settings

extension View {
	/// A settings card's chrome: the barely lifted fill, its corners rounded, held by its border.
	func settingsCard() -> some View {
		let shape = RoundedRectangle(cornerRadius: 12, style: .continuous)
		return background(Palette.settingsCard).clipShape(shape).overlay(shape.strokeBorder(Palette.settingsCardBorder))
	}
}

/// A settings card: rows on a barely lifted fill, held by its border.
struct SettingsGroup<Content: View, Action: View>: View {
	var label: String?
	var description: String?
	var note: String?
	@ViewBuilder var action: Action
	@ViewBuilder var content: Content

	var body: some View {
		VStack(alignment: .leading, spacing: 0) {
			if label != nil || Action.self != EmptyView.self {
				HStack(spacing: 8) {
					if let label {
						Text(label)
							.font(Typeface.rubik(13, .medium))
							.foregroundStyle(Palette.mutedForeground)
							.frame(maxWidth: .infinity, alignment: .leading)
							.accessibilityAddTraits(.isHeader)
					}
					action
				}
				.padding(.horizontal, 2)
				.padding(.bottom, description == nil ? 10 : 4)
			}
			if let description {
				Text(description)
					.font(Typeface.rubik(13))
					.lineSpacing(3)
					.foregroundStyle(Palette.subtleForeground)
					.padding(.horizontal, 2)
					.padding(.bottom, 10)
			}
			VStack(spacing: 0) { content }
				.settingsCard()
			if let note {
				Text(note)
					.font(Typeface.rubik(13))
					.lineSpacing(3)
					.foregroundStyle(Palette.subtleForeground)
					.padding(.horizontal, 2)
					.padding(.top, 10)
			}
		}
	}
}

extension SettingsGroup where Action == EmptyView {
	init(label: String? = nil, description: String? = nil, note: String? = nil, @ViewBuilder content: () -> Content) {
		self.init(label: label, description: description, note: note, action: { EmptyView() }, content: content)
	}
}

/// The line between a settings card's rows; leave it off after the last.
struct SettingsDivider: View {
	var body: some View {
		Rectangle().fill(Palette.border).frame(height: 1)
	}
}

/// Rows in a settings card, with a line between each and none after the last.
struct DividedRows<Data: RandomAccessCollection, ID: Hashable, Row: View>: View {
	let data: Data
	/// What tells one row from another, as `ForEach`'s `id`.
	let id: KeyPath<Data.Element, ID>
	@ViewBuilder let row: (Data.Element) -> Row

	var body: some View {
		ForEach(Array(data.enumerated()), id: (\EnumeratedSequence<Data>.Element.element).appending(path: id)) { index, element in
			if index > 0 { SettingsDivider() }
			row(element)
		}
	}
}

extension DividedRows where Data.Element: Identifiable, ID == Data.Element.ID {
	init(data: Data, @ViewBuilder row: @escaping (Data.Element) -> Row) {
		self.init(data: data, id: \.id, row: row)
	}
}

/// A row of a settings card: perhaps an icon, its label with a line under it,
/// what it holds at its end, and a chevron when it opens a page.
struct SettingsRow<Leading: View, Trailing: View>: View {
	let label: String
	var sub: String?
	var chevron = false
	@ViewBuilder var leading: Leading
	@ViewBuilder var trailing: Trailing

	var body: some View {
		HStack(spacing: 14) {
			leading
			VStack(alignment: .leading, spacing: 2) {
				Text(label)
					.font(Typeface.rubik(16))
					.foregroundStyle(Palette.foreground)
					.lineLimit(1)
				if let sub {
					Text(sub)
						.font(Typeface.rubik(13))
						.foregroundStyle(Palette.subtleForeground)
				}
			}
			.frame(maxWidth: .infinity, alignment: .leading)
			trailing
			if chevron {
				Icon(.chevronRight, size: 14, strokeWidth: 2).foregroundStyle(Palette.subtleForeground)
			}
		}
		.padding(.horizontal, 16)
		.padding(.vertical, 12)
		.frame(minHeight: 56)
		.contentShape(Rectangle())
	}
}

extension SettingsRow where Leading == EmptyView, Trailing == EmptyView {
	init(label: String, sub: String? = nil, chevron: Bool = false) {
		self.init(label: label, sub: sub, chevron: chevron, leading: { EmptyView() }, trailing: { EmptyView() })
	}
}

extension SettingsRow where Leading == EmptyView {
	init(label: String, sub: String? = nil, chevron: Bool = false, @ViewBuilder trailing: () -> Trailing) {
		self.init(label: label, sub: sub, chevron: chevron, leading: { EmptyView() }, trailing: trailing)
	}
}

extension SettingsRow where Trailing == EmptyView {
	init(label: String, sub: String? = nil, chevron: Bool = false, @ViewBuilder leading: () -> Leading) {
		self.init(label: label, sub: sub, chevron: chevron, leading: leading, trailing: { EmptyView() })
	}
}

/// A settings row shaded under a finger, so a tap shows it landed.
struct SettingsRowPressStyle: ButtonStyle {
	func makeBody(configuration: Configuration) -> some View {
		configuration.label
			.background(configuration.isPressed ? Palette.rowSelected : .clear)
	}
}

/// A settings row with its label at the left and a control filling the rest.
struct SettingsControlRow<Control: View>: View {
	let label: String
	/// Stacks the control under the label, for one too wide to sit beside it.
	var stacked = false
	@ViewBuilder var control: Control

	var body: some View {
		let layout = stacked ? AnyLayout(VStackLayout(alignment: .leading, spacing: 8)) : AnyLayout(HStackLayout(spacing: 14))
		layout {
			Text(label)
				.font(Typeface.rubik(16))
				.foregroundStyle(Palette.foreground)
				.lineLimit(1)
				.frame(minWidth: 96, alignment: .leading)
				.fixedSize()
			control
		}
		.padding(.horizontal, 16)
		.padding(.vertical, 10)
		.frame(minHeight: 56)
	}
}

/// A settings row that is a text field.
struct SettingsFieldRow: View {
	let label: String
	@Binding var value: String
	let placeholder: String
	var maxLength: Int?
	var mono = false
	var secret = false

	var body: some View {
		SettingsControlRow(label: label) {
			Group {
				if secret {
					SecureField("", text: limited, prompt: prompt)
				} else {
					TextField("", text: limited, prompt: prompt)
						.autocorrectionDisabled()
				}
			}
			.font(mono ? Typeface.mono(16) : Typeface.rubik(16))
			.foregroundStyle(Palette.foreground)
			.accessibilityLabel(label)
		}
	}

	private var prompt: Text {
		Text(placeholder).foregroundStyle(Palette.subtleForeground)
	}

	private var limited: Binding<String> {
		maxLength.map { $value.limited(to: $0) } ?? $value
	}
}

extension Binding<String> {
	/// The text cut to `maxLength` characters as it's typed, as a web field's `maxLength`.
	func limited(to maxLength: Int) -> Binding<String> {
		Binding(get: { wrappedValue }, set: { wrappedValue = String($0.prefix(maxLength)) })
	}
}

/// What a setting is, in grey at a row's end.
struct SettingsValue: View {
	let text: String

	var body: some View {
		Text(text)
			.font(Typeface.rubik(15))
			.foregroundStyle(Palette.mutedForeground)
			.lineLimit(1)
			// As the web's `shrink-0`: the value keeps its width, and the label beside it wraps.
			.fixedSize()
	}
}

/// A small outlined button at a row's end.
struct SettingsRowButtonStyle: ButtonStyle {
	@Environment(\.isEnabled) private var isEnabled

	func makeBody(configuration: Configuration) -> some View {
		configuration.label
			.font(Typeface.rubik(13))
			.foregroundStyle(Palette.foreground)
			.padding(.horizontal, 12)
			.frame(height: 30)
			.background(configuration.isPressed ? Palette.rowSelected : .clear, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
			.overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(Palette.borderStrong))
			.opacity(isEnabled ? 1 : 0.5)
	}
}

/// A radio's mark: a ring, filled with a dot when chosen.
struct SettingsRadioMark: View {
	let checked: Bool

	var body: some View {
		Circle()
			.strokeBorder(checked ? Palette.foreground : Palette.borderDashed, lineWidth: 1)
			.frame(width: 16, height: 16)
			.overlay { if checked { Circle().fill(Palette.foreground).frame(width: 8, height: 8) } }
			.accessibilityHidden(true)
	}
}

/// A choice among a card's rows, as the web's provider radios: the choice's
/// initial, its name, perhaps a word beside it such as In use, a line under
/// it, and the radio's mark at the end.
struct SettingsRadioRow: View {
	let name: String
	let description: String
	var badge: String?
	let checked: Bool
	let choose: () -> Void

	var body: some View {
		Button(action: choose) {
			HStack(spacing: 14) {
				SettingsRowIcon { Text(name.prefix(1)) }
				VStack(alignment: .leading, spacing: 2) {
					HStack(spacing: 8) {
						Text(name).font(Typeface.rubik(13, .medium)).foregroundStyle(Palette.foreground)
						if let badge { Text(badge).font(Typeface.rubik(12)).foregroundStyle(Palette.subtleForeground) }
					}
					Text(description).font(Typeface.rubik(12)).foregroundStyle(Palette.subtleForeground)
				}
				.frame(maxWidth: .infinity, alignment: .leading)
				SettingsRadioMark(checked: checked)
			}
			.padding(.horizontal, 16)
			.padding(.vertical, 12)
			.frame(minHeight: 56)
			.contentShape(Rectangle())
		}
		.buttonStyle(SettingsRowPressStyle())
		.accessibilityAddTraits(checked ? .isSelected : [])
	}
}

/// A small square mark at a row's start, such as an initial or a +.
struct SettingsRowIcon<Content: View>: View {
	@ViewBuilder var content: Content

	var body: some View {
		content
			.font(Typeface.rubik(12, .semibold))
			.foregroundStyle(Palette.softForeground)
			.frame(width: 28, height: 28)
			.overlay(RoundedRectangle(cornerRadius: 7, style: .continuous).strokeBorder(Palette.borderStrong))
			.accessibilityHidden(true)
	}
}

/// The last row of a card that adds another of what it lists.
struct SettingsAddRow: View {
	let label: String
	let action: () -> Void

	var body: some View {
		Button(action: action) {
			HStack(spacing: 14) {
				SettingsRowIcon { Icon(.plus, size: 14, strokeWidth: 2) }
				Text(label).font(Typeface.rubik(13)).foregroundStyle(Palette.mutedForeground)
				Spacer(minLength: 0)
			}
			.padding(.horizontal, 16)
			.padding(.vertical, 12)
			.frame(minHeight: 56)
			.contentShape(Rectangle())
		}
		.buttonStyle(SettingsRowPressStyle())
	}
}

/// How a test went: a green or red dot and what it said.
struct SettingsTestOutcome: View {
	let good: Bool
	let text: String

	var body: some View {
		HStack(spacing: 6) {
			Circle().fill(good ? Palette.success : Palette.destructive).frame(width: 6, height: 6)
			Text(text).lineLimit(1)
		}
		.font(Typeface.rubik(12))
		.foregroundStyle(good ? Palette.mutedForeground : Palette.destructiveText)
	}
}

/// A green pill saying something is on, such as Connected.
struct SettingsStatusBadge: View {
	let text: String

	var body: some View {
		HStack(spacing: 6) {
			Circle().fill(Palette.success).frame(width: 6, height: 6)
			Text(text)
		}
		.font(Typeface.rubik(12, .medium))
		.foregroundStyle(Palette.successText)
		.padding(.horizontal, 8)
		.frame(height: 22)
		.background(Palette.success.opacity(0.12), in: Capsule())
	}
}

/// A card for something that can't be undone: what it does, and its red action.
struct SettingsDanger: View {
	let label: String
	let description: String
	let action: String
	var disabledReason: String?
	let onTap: () -> Void

	var body: some View {
		HStack(spacing: 16) {
			VStack(alignment: .leading, spacing: 2) {
				Text(label).font(Typeface.rubik(16)).foregroundStyle(Palette.foreground)
				Text(disabledReason ?? description)
					.font(Typeface.rubik(13))
					.foregroundStyle(Palette.subtleForeground)
			}
			.frame(maxWidth: .infinity, alignment: .leading)
			Button(action, action: onTap)
				.buttonStyle(WebButtonStyle(variant: .destructive, size: .small))
				.disabled(disabledReason != nil)
				.accessibilityLabel(label)
		}
		.padding(.horizontal, 16)
		.padding(.vertical, 12)
		.frame(minHeight: 56)
		.settingsCard()
	}
}

/// A settings page on a phone: Back floating at the top left, perhaps an
/// action at the top right, then the title, a line under it, and the groups.
struct SettingsPage<Content: View, HeaderAction: View>: View {
	var title: String?
	var description: String?
	/// A picture before the title, such as a bot's face.
	var hero: AnyView?
	/// Whether the page has its own Back; the top of a stack has none.
	var back = true
	@ViewBuilder var headerAction: HeaderAction
	@ViewBuilder var content: Content

	var body: some View {
		ScrollView {
			VStack(alignment: .leading, spacing: 32) {
				if let title {
					HStack(spacing: 14) {
						if let hero { hero.frame(width: 44, height: 44) }
						VStack(alignment: .leading, spacing: hero == nil ? 4 : 2) {
							// The web's `text-2xl` on a 30-point line.
							Text(title)
								.font(Typeface.rubik(17, .semibold))
								.tracking(-0.425)
								.frame(minHeight: 30, alignment: .leading)
								.foregroundStyle(Palette.foreground)
								.lineLimit(hero == nil ? nil : 1)
							if let description {
								Text(description)
									.font(Typeface.rubik(13))
									.lineSpacing(3)
									.foregroundStyle(Palette.mutedForeground)
							}
						}
					}
				}
				content
			}
			.padding(.horizontal, 16)
			.padding(.top, back ? 12 : 12)
			.padding(.bottom, 80)
		}
		.safeAreaInset(edge: .top, spacing: 0) {
			if back || HeaderAction.self != EmptyView.self {
				HStack {
					if back { PhoneBackButton() }
					Spacer()
					headerAction
				}
				.pageHeaderInsets()
			}
		}
		.background(Palette.background.ignoresSafeArea())
		.toolbar(.hidden, for: .navigationBar)
	}
}

extension SettingsPage where HeaderAction == EmptyView {
	init(title: String? = nil, description: String? = nil, hero: AnyView? = nil, back: Bool = true, @ViewBuilder content: () -> Content) {
		self.init(title: title, description: description, hero: hero, back: back, headerAction: { EmptyView() }, content: content)
	}
}

/// A search box: a magnifier and the field, as the web's search inputs.
struct SearchField: View {
	enum Style {
		/// On a page: a chip-filled box.
		case filled
		/// At the top of a settings card: an outlined box on the page's colour.
		case inCard
	}

	let placeholder: String
	@Binding var text: String
	var style = Style.filled

	var body: some View {
		let inCard = style == .inCard
		HStack(spacing: inCard ? 8 : 9) {
			Icon(.search, size: inCard ? 14 : 15).foregroundStyle(inCard ? Palette.subtleForeground : Palette.mutedForeground)
			TextField("", text: $text, prompt: Text(placeholder).foregroundStyle(inCard ? Palette.subtleForeground : Palette.mutedForeground))
				.font(Typeface.rubik(16))
				.foregroundStyle(Palette.foreground)
				.autocorrectionDisabled()
				.textInputAutocapitalization(.never)
				.submitLabel(.search)
				.accessibilityLabel(placeholder)
		}
		.padding(.horizontal, inCard ? 10 : 12)
		.padding(.vertical, inCard ? 0 : 9)
		.frame(height: inCard ? 34 : nil)
		.background(inCard ? Palette.background : Palette.chip, in: RoundedRectangle(cornerRadius: inCard ? 10 : 12, style: .continuous))
		.overlay { if inCard { RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(Palette.borderStrong) } }
	}
}

/// A failure in a form, in red, as the web's `Alert`.
struct FormAlert: View {
	let text: String

	var body: some View {
		Text(text)
			.font(Typeface.rubik(13))
			.lineSpacing(2)
			.foregroundStyle(Palette.destructiveText)
			.frame(maxWidth: .infinity, alignment: .leading)
			.accessibilityAddTraits(.isStaticText)
	}
}
