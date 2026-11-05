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

/// The web's `Toggle`, as a phone draws a switch: the system's own.
struct WebToggle: View {
	let label: String
	let isOn: Bool
	let change: (Bool) -> Void

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
		// The system's switch in the system's green: the app's accent, near white in dark, would hide its white knob.
		Toggle(label, isOn: Binding(get: { isOn }, set: change))
			.labelsHidden()
			.tint(Color(uiColor: .systemGreen))
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
	/// field isn't being typed in, `draft` follows `saved`; while a save is
	/// under way, the field can't be typed in.
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
			.disabled(saving)
			.onSubmit { focused.wrappedValue = false }
			.onAppear { draft = saved }
			.onChange(of: saved) { _, value in if !focused.wrappedValue { draft = value } }
			.onChange(of: focused.wrappedValue) { _, isFocused in if !isFocused { commit() } }
	}

	private func commit() {
		guard !saving else { return }
		let next = draft.trimmingCharacters(in: .whitespaces)
		guard next != saved, allowsEmpty || !next.isEmpty else {
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

/// Something added to a list in code type, such as a host or a repository,
/// with who added it under it and, where it may be taken out here, the × that
/// does, as the web's `AddedHostRow` and `BlockedHostRow`.
struct RemovableRow: View {
	/// The × at a row's end: what it is called for VoiceOver, and what it does.
	struct Removal {
		let label: String
		let action: () -> Void
	}

	let name: String
	/// The web sets hosts at 13 and repositories at 13.5.
	var nameSize: CGFloat = 13
	let sub: String
	/// Absent where it can't be taken out here.
	var removal: Removal?

	var body: some View {
		HStack(spacing: 14) {
			VStack(alignment: .leading, spacing: 2) {
				Text(name).font(Typeface.mono(nameSize)).foregroundStyle(Palette.foreground)
				Text(sub).font(Typeface.rubik(13)).foregroundStyle(Palette.subtleForeground)
			}
			.frame(maxWidth: .infinity, alignment: .leading)
			if let removal {
				Button(action: removal.action) { Icon(.x, size: 16).frame(width: 24, height: 24) }
					.buttonStyle(IconPressStyle())
					.accessibilityLabel(removal.label)
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
	let buttonTitle: String
	@Binding var draft: String
	let add: (String) -> Void
	@Environment(\.isEnabled) private var isEnabled

	var body: some View {
		let host = draft.trimmingCharacters(in: .whitespaces).lowercased()
		SettingsControlRow(label: label) {
			TextField("", text: $draft, prompt: Text("api.example.com or *.example.com").foregroundStyle(Palette.mutedForeground))
				.font(Typeface.mono(16))
				.textInputAutocapitalization(.never)
				.autocorrectionDisabled()
				.onSubmit { if !host.isEmpty, isEnabled { add(host) } }
			Button(buttonTitle) { add(host) }
				.font(Typeface.rubik(13, .medium))
				.foregroundStyle(Palette.link)
				.disabled(host.isEmpty)
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

/// A setting typed where it stands and saved when the field is left, as the
/// web's `TextEntryRow`. A secret shows dots once one is saved, until Replace.
struct TextEntryRow: View {
	/// What the row holds.
	enum Value {
		/// Text shown as typed, such as an address, with what is saved, if anything.
		case text(saved: String?)
		/// A secret, such as a key, of which only whether one is saved is known.
		case secret(isSaved: Bool)
	}

	let label: String
	let value: Value
	let placeholder: String
	/// Saves what's typed, trimmed. A failure puts back the saved text, or keeps
	/// a secret's typing to try again.
	let save: (String) async throws -> Void
	/// Takes the saved text away when the field is emptied, for a setting with a
	/// default; absent where emptying the field only puts the saved text back.
	var clear: (() async throws -> Void)?
	/// Asks to take a saved secret away; absent where it can't be.
	var remove: (() -> Void)?
	@State private var draft = ""
	@State private var replacing = false
	@State private var saving = false
	@FocusState private var focused: Bool

	private var savedText: String? {
		guard case let .text(saved) = value else { return nil }
		return saved
	}

	private var isSecret: Bool {
		guard case .secret = value else { return false }
		return true
	}

	var body: some View {
		HStack(spacing: 12) {
			Text(label).font(Typeface.rubik(13)).foregroundStyle(Palette.foreground).frame(width: 82, alignment: .leading)
			if case .secret(isSaved: true) = value, !replacing {
				Text("••••••••").font(Typeface.mono(13)).foregroundStyle(Palette.mutedForeground).frame(maxWidth: .infinity, alignment: .leading)
				Button("Replace") { replacing = true }
					.font(Typeface.rubik(12.5, .medium))
					.foregroundStyle(Palette.foreground)
				if let remove {
					Button("Remove", action: remove)
						.font(Typeface.rubik(12.5, .medium))
						.foregroundStyle(Palette.destructiveText)
				}
			} else {
				Group {
					if isSecret {
						SecureField("", text: $draft, prompt: Text(placeholder).foregroundStyle(Palette.subtleForeground))
					} else {
						TextField("", text: $draft, prompt: Text(placeholder).foregroundStyle(Palette.subtleForeground))
					}
				}
				.font(Typeface.mono(16))
				.foregroundStyle(Palette.foreground)
				.textInputAutocapitalization(.never)
				.autocorrectionDisabled()
				.focused($focused)
				.submitLabel(.done)
				.onSubmit { focused = false }
				.disabled(saving)
				.accessibilityLabel(label)
			}
		}
		.padding(.horizontal, 16)
		.padding(.vertical, 10)
		.frame(minHeight: 48)
		.onAppear { draft = savedText ?? "" }
		.onChange(of: savedText) { _, saved in if !focused { draft = saved ?? "" } }
		.onChange(of: focused) { _, isFocused in if !isFocused { commit() } }
	}

	private func commit() {
		guard !saving else { return }
		let typed = draft.trimmingCharacters(in: .whitespaces)
		if typed.isEmpty {
			if savedText != nil, let clear {
				run(clear)
			} else {
				draft = savedText ?? ""
			}
			return
		}
		guard typed != savedText else { return }
		run { try await save(typed) }
	}

	private func run(_ work: @escaping () async throws -> Void) {
		saving = true
		Task {
			do {
				try await work()
				if isSecret {
					draft = ""
					replacing = false
				}
			} catch {
				if !isSecret { draft = savedText ?? "" }
			}
			saving = false
		}
	}
}

/// Something a settings page does on a tap, such as saving or removing, with
/// whether it is under way and what its last run failed with. A tap while one
/// runs is ignored, so controls that start it can be held with `.disabled(pending)`
/// and a quick second tap never sends it twice.
@MainActor
@Observable
final class SettingsAction {
	/// What `perform` throws when a run is already under way.
	struct Busy: Error {}

	private(set) var pending = false
	/// What the last run failed with, until the next starts.
	var failure: String?

	/// Starts `work`, unless a run is under way.
	func run(_ work: @escaping () async throws -> Void) {
		guard !pending else { return }
		Task { try? await perform(work) }
	}

	/// Runs `work` and waits for it, keeping what it fails with in `failure`
	/// and throwing it on; throws `Busy` without running it while a run is under way.
	func perform(_ work: () async throws -> Void) async throws {
		guard !pending else { throw Busy() }
		pending = true
		failure = nil
		defer { pending = false }
		do {
			try await work()
		} catch {
			failure = error.localizedDescription
			throw error
		}
	}
}

/// Something a page loads: loading, loaded, or failed with what to say.
enum Loadable<Value> {
	case loading
	case loaded(Value)
	case failed(String)

	var value: Value? {
		guard case let .loaded(value) = self else { return nil }
		return value
	}

	var failure: String? {
		guard case let .failed(failure) = self else { return nil }
		return failure
	}

	/// What `load` returns, or what it failed with.
	static func of(_ load: () async throws -> Value) async -> Loadable<Value> {
		do { return .loaded(try await load()) } catch { return .failed(error.localizedDescription) }
	}
}

/// What to do with a field a change can leave alone, set, or empty, such as a provider's key.
enum FieldChange<Value: Codable & Hashable & Sendable> {
	case keep
	case set(Value)
	case clear

	/// As the API takes such a field: omitted to leave it, present but nil to empty it.
	var apiValue: Omittable<Value> {
		switch self {
		case .keep: .omitted
		case let .set(value): .present(value)
		case .clear: .present(nil)
		}
	}
}

/// How a test of a provider or connection went: whether it got through, and what to say.
struct TestResult: Equatable {
	let passed: Bool
	let text: String
}

/// A test's result on a line of its own, as the web's `Success`, a green
/// tick and what passed, or its `Alert`, in red.
struct TestResultLine: View {
	let result: TestResult

	var body: some View {
		if result.passed {
			HStack(spacing: 6) {
				Icon(.circleCheck, size: 16)
				Text(result.text)
			}
			.font(Typeface.rubik(13, .medium))
			.foregroundStyle(Palette.successText)
		} else {
			FormAlert(text: result.text)
		}
	}
}

/// A button that copies `text`, and for a moment after says it has, as the
/// web's copy buttons. `label` draws it, told whether it has just copied.
struct CopyButton<Label: View>: View {
	let text: String
	@ViewBuilder let label: (_ copied: Bool) -> Label
	@State private var copied = false

	/// How long it says it has copied.
	private static var copiedFeedback: Duration { .seconds(2) }

	var body: some View {
		Button {
			UIPasteboard.general.string = text
			copied = true
		} label: {
			label(copied)
		}
		.task(id: copied) {
			guard copied else { return }
			try? await Task.sleep(for: Self.copiedFeedback)
			if !Task.isCancelled { copied = false }
		}
		.onChange(of: text) { copied = false }
	}
}
