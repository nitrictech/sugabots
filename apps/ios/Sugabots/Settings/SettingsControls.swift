import SwiftUI

// Controls the web's settings pages use beyond `Design/WebControls.swift`.

/// The web's `SegmentedControl`: choices in a chip, the chosen one lifted.
struct SegmentedChoice<Value: Hashable>: View {
	let label: String
	let options: [(value: Value, label: String)]
	let value: Value?
	/// Stretches the choices across the row, as on a phone's narrow rows.
	var fill = false
	let choose: (Value) -> Void
	@Environment(\.isEnabled) private var isEnabled

	var body: some View {
		HStack(spacing: 0) {
			ForEach(options, id: \.value) { option in
				let chosen = option.value == value
				Button { choose(option.value) } label: {
					Text(option.label)
						.font(Typeface.rubik(12.5, .medium))
						// Stretched across a row, a long choice wraps rather than being cut short, as on the web.
						.lineLimit(fill ? 2 : 1)
						.multilineTextAlignment(.center)
						.foregroundStyle(chosen ? Palette.foreground : Palette.mutedForeground)
						.padding(.horizontal, 11)
						.padding(.vertical, 5)
						// The web's 5px either side of a line of `text-sm`.
						.frame(maxWidth: fill ? .infinity : nil, minHeight: 28, maxHeight: fill ? .infinity : nil)
						.background(chosen ? Palette.personAvatar : .clear, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
						.contentShape(Rectangle())
				}
				.buttonStyle(.plain)
				.accessibilityAddTraits(chosen ? .isSelected : [])
			}
		}
		.padding(2)
		.background(Palette.chip, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
		// Beside a label, the choices keep their width, as the web's `shrink-0`.
		.fixedSize(horizontal: !fill, vertical: false)
		.opacity(isEnabled ? 1 : 0.5)
		.accessibilityElement(children: .contain)
		.accessibilityLabel(label)
	}
}

/// The web's `Toggle`: a 36 by 20 switch, filled with the primary colour when on.
struct WebToggle: View {
	let label: String
	let isOn: Bool
	let change: (Bool) -> Void
	@Environment(\.isEnabled) private var isEnabled
	@Environment(\.colorScheme) private var colorScheme

	init(label: String, isOn: Bool, change: @escaping (Bool) -> Void) {
		self.label = label
		self.isOn = isOn
		self.change = change
	}

	/// A switch bound to a value it changes itself.
	init(label: String, isOn: Binding<Bool>) {
		self.init(label: label, isOn: isOn.wrappedValue) { isOn.wrappedValue = $0 }
	}

	var body: some View {
		Button { change(!isOn) } label: {
			Capsule()
				.fill(isOn ? Palette.switchOn : Palette.borderStrong)
				.frame(width: 36, height: 20)
				.overlay(alignment: isOn ? .trailing : .leading) {
					Circle()
						.fill(isOn ? Palette.primaryForeground : colorScheme == .dark ? Palette.subtleForeground : .white)
						.frame(width: 16, height: 16)
						.padding(2)
				}
				.animation(.easeOut(duration: 0.15), value: isOn)
				.opacity(isEnabled ? 1 : 0.45)
				.contentShape(Rectangle())
		}
		.buttonStyle(.plain)
		.accessibilityLabel(label)
		.accessibilityValue(isOn ? "On" : "Off")
		.accessibilityAddTraits(.isToggle)
	}
}

/// The web's `SettingsNameRow`: a name edited where it stands, saved when the field is left.
struct SettingsNameRow: View {
	let name: String
	let maxLength: Int
	let save: (String) async throws -> Void
	@State private var draft = ""
	@State private var failure: String?
	@FocusState private var focused: Bool

	var body: some View {
		VStack(spacing: 0) {
			SettingsControlRow(label: "Name") {
				TextField("", text: $draft.limited(to: maxLength))
					.font(Typeface.rubik(16))
					.foregroundStyle(Palette.foreground)
					.editsInPlace(draft: $draft, saved: name, focused: $focused) { next in
						failure = nil
						do { try await save(next) } catch {
							failure = error.localizedDescription
							throw error
						}
					}
					.accessibilityLabel("Name")
			}
			if let failure {
				SettingsDivider()
				FormAlert(text: failure).padding(.horizontal, 16).padding(.vertical, 10)
			}
		}
	}
}

extension View {
	/// Makes a text field one edited where it stands, as the web's
	/// `SettingsNameRow` and `ProfileField`: Done or leaving the field saves
	/// what's typed, trimmed. Nothing changed, or nothing typed unless
	/// `allowsEmpty`, puts back what's saved, as does a failed save. While the
	/// field isn't being typed in, `draft` follows `saved`.
	func editsInPlace(
		draft: Binding<String>,
		saved: String,
		allowsEmpty: Bool = false,
		focused: FocusState<Bool>.Binding,
		save: @escaping (String) async throws -> Void
	) -> some View {
		modifier(EditInPlace(draft: draft, saved: saved, allowsEmpty: allowsEmpty, focused: focused, save: save))
	}
}

private struct EditInPlace: ViewModifier {
	@Binding var draft: String
	let saved: String
	let allowsEmpty: Bool
	var focused: FocusState<Bool>.Binding
	let save: (String) async throws -> Void
	@State private var saving = false

	func body(content: Content) -> some View {
		content
			.focused(focused)
			.submitLabel(.done)
			.onSubmit { focused.wrappedValue = false }
			.onAppear { draft = saved }
			.onChange(of: saved) { _, value in if !focused.wrappedValue { draft = value } }
			.onChange(of: focused.wrappedValue) { _, isFocused in if !isFocused { commit() } }
	}

	private func commit() {
		let next = draft.trimmingCharacters(in: .whitespaces)
		guard !saving, next != saved, allowsEmpty || !next.isEmpty else {
			draft = saved
			return
		}
		draft = next
		saving = true
		Task {
			do { try await save(next) } catch { draft = saved }
			saving = false
		}
	}
}

/// A page's settings text in grey under its groups, or a loading line.
struct SettingsNotice: View {
	let text: String

	var body: some View {
		Text(text).font(Typeface.rubik(13)).foregroundStyle(Palette.mutedForeground)
	}
}

/// A grey row saying a list is empty, such as "No bots in this pod yet".
struct SettingsEmptyRow: View {
	let text: String

	var body: some View {
		Text(text)
			.font(Typeface.rubik(16))
			.foregroundStyle(Palette.mutedForeground)
			.frame(maxWidth: .infinity, minHeight: 56, alignment: .leading)
			.padding(.horizontal, 16)
	}
}

/// The round + at a settings page's top right on a phone, as `SettingsAddButton` there.
struct SettingsAddButton: View {
	let label: String
	let action: () -> Void

	var body: some View {
		GlassRoundButton(icon: .plus, label: label, strokeWidth: 2, action: action)
	}
}

// `SettingsRow`'s one-closure inits can't be told apart by a trailing closure,
// so the settings pages name which end the closure fills.
extension SettingsRow where Leading == EmptyView {
	/// A row with what it holds at its end.
	static func trailing(label: String, sub: String? = nil, chevron: Bool = false, @ViewBuilder _ trailing: () -> Trailing) -> SettingsRow {
		SettingsRow(label: label, sub: sub, chevron: chevron, leading: { EmptyView() }, trailing: trailing)
	}
}

extension SettingsRow where Trailing == EmptyView {
	/// A row with a mark at its start.
	static func icon(label: String, sub: String? = nil, chevron: Bool = false, @ViewBuilder _ leading: () -> Leading) -> SettingsRow {
		SettingsRow(label: label, sub: sub, chevron: chevron, leading: leading, trailing: { EmptyView() })
	}
}

/// Something added to a list in code type, such as a host or a repository,
/// with who added it under it and, where it may be taken out here, the × that
/// does, as the web's `AddedHostRow` and `BlockedHostRow`.
struct RemovableRow: View {
	let name: String
	/// The web sets hosts at 13 and repositories at 13.5.
	var nameSize: CGFloat = 13
	let sub: String
	var removeLabel: String?
	/// Absent where it can't be taken out here.
	var remove: (() -> Void)?

	var body: some View {
		HStack(spacing: 14) {
			VStack(alignment: .leading, spacing: 2) {
				Text(name).font(Typeface.mono(nameSize)).foregroundStyle(Palette.foreground)
				Text(sub).font(Typeface.rubik(13)).foregroundStyle(Palette.subtleForeground)
			}
			.frame(maxWidth: .infinity, alignment: .leading)
			if let remove {
				Button(action: remove) { Icon(.x, size: 16).frame(width: 24, height: 24) }
					.buttonStyle(IconPressStyle())
					.accessibilityLabel(removeLabel ?? "Remove \(name)")
			}
		}
		.padding(.horizontal, 16)
		.padding(.vertical, 12)
		.frame(minHeight: 56)
	}
}

/// A host to type in and the button that sends it, such as Allow or Block, as
/// the web's `AddHostRow`. The host goes trimmed and lower-cased; the caller
/// empties `draft` once it is added.
struct AddHostRow: View {
	let label: String
	let action: String
	@Binding var draft: String
	let pending: Bool
	let add: (String) -> Void

	var body: some View {
		let host = draft.trimmingCharacters(in: .whitespaces).lowercased()
		SettingsControlRow(label: label) {
			TextField("", text: $draft, prompt: Text("api.example.com or *.example.com").foregroundStyle(Palette.mutedForeground))
				.font(Typeface.mono(16))
				.textInputAutocapitalization(.never)
				.autocorrectionDisabled()
				.onSubmit { if !host.isEmpty, !pending { add(host) } }
			Button(action) { add(host) }
				.font(Typeface.rubik(13, .medium))
				.foregroundStyle(Palette.link)
				.disabled(pending || host.isEmpty)
		}
	}
}

/// How many hosts a list holds and what they are, opening to name them all,
/// as the web's Trusted hosts and From the workspace rows.
struct HostListRow: View {
	let label: String
	let hosts: [String]
	/// What the row says while closed, such as "12 hosts every pod reaches".
	let summary: String
	@State private var open = false

	var body: some View {
		Button { open.toggle() } label: {
			SettingsRow(label: label, sub: open ? hosts.joined(separator: ", ") : summary, chevron: !open)
		}
		.buttonStyle(SettingsRowPressStyle())
	}
}
