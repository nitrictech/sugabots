import SwiftUI

// Controls the routine pages share, each as the web draws it on a phone.

/// A settings row that is a switch, named by its label.
struct SwitchRow: View {
	let label: String
	@Binding var isOn: Bool
	var fontSize: CGFloat = 16

	var body: some View {
		HStack(spacing: 12) {
			Text(label)
				.font(Typeface.rubik(fontSize))
				.foregroundStyle(Palette.foreground)
				.frame(maxWidth: .infinity, alignment: .leading)
			WebToggle(label: label, isOn: $isOn)
		}
		.padding(.horizontal, 16)
		.padding(.vertical, 10)
		.frame(minHeight: 56)
	}
}

/// The web's `SettingsChoiceRow` on a phone: the label over a segmented choice across the row.
struct SettingsChoiceRow<Value: Hashable>: View {
	let label: String
	let options: [(value: Value, label: String)]
	let value: Value?
	let choose: (Value) -> Void

	var body: some View {
		VStack(alignment: .leading, spacing: 8) {
			Text(label).font(Typeface.rubik(16)).foregroundStyle(Palette.foreground)
			SegmentedChoice(label: label, options: options, value: value, fill: true, choose: choose)
		}
		.padding(.horizontal, 16)
		.padding(.vertical, 10)
		.frame(minHeight: 56)
	}
}

/// The web's `Note`: an aside on the list colour, with an info mark.
struct InfoNote: View {
	let text: String

	var body: some View {
		HStack(alignment: .top, spacing: 12) {
			Icon(.info, size: 16).foregroundStyle(Palette.subtleForeground).padding(.top, 2)
			Text(text)
				.font(Typeface.rubik(14))
				.lineSpacing(4)
				.foregroundStyle(Palette.softForeground)
				.frame(maxWidth: .infinity, alignment: .leading)
		}
		.padding(.horizontal, 16)
		.padding(.vertical, 12)
		.background(Palette.list, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
	}
}

/// How a run went, or that its routine is paused, as a dot and a word, as the
/// web's `RunOutcome`.
struct RunStatusLabel: View {
	enum Outcome {
		case passed, failed, running, cancelled, paused

		/// A run's state, as the dot beside it says it.
		init(state: RoutineExecutionState) {
			switch state {
			case .completed: self = .passed
			case .failed: self = .failed
			case .cancelled: self = .cancelled
			case .queued, .running, .unknown: self = .running
			}
		}

		var label: String {
			switch self {
			case .passed: "Passed"
			case .failed: "Failed"
			case .running: "Running"
			case .cancelled: "Cancelled"
			case .paused: "Paused"
			}
		}

		var dot: Color {
			switch self {
			case .passed: Palette.success
			case .failed: Palette.destructiveText
			case .running: Palette.subtleForeground
			case .cancelled, .paused: Palette.disabledForeground
			}
		}
	}

	let outcome: Outcome

	var body: some View {
		HStack(spacing: 6) {
			Circle().fill(outcome.dot).frame(width: 6, height: 6)
			Text(outcome.label)
		}
		.font(Typeface.rubik(12))
		.foregroundStyle(Palette.mutedForeground)
	}
}

/// A settings row whose value is picked from a menu, its arrow at the end, as the web's `MenuRow`.
struct MenuRow<Value: Hashable, Mark: View>: View {
	let label: String
	let options: [(value: Value, label: String)]
	let value: Value
	@ViewBuilder var mark: (Value) -> Mark
	let choose: (Value) -> Void

	var body: some View {
		Menu {
			ForEach(Array(options.enumerated()), id: \.offset) { _, option in
				Button { choose(option.value) } label: {
					if option.value == value { Label(option.label, systemImage: "checkmark") } else { Text(option.label) }
				}
			}
		} label: {
			HStack(spacing: 12) {
				Text(label)
					.font(Typeface.rubik(16))
					.foregroundStyle(Palette.foreground)
					.frame(minWidth: 96, alignment: .leading)
				HStack(spacing: 10) {
					mark(value)
					Text(options.first { $0.value == value }?.label ?? "")
						.font(Typeface.rubik(14.5))
						.foregroundStyle(Palette.foreground)
						.lineLimit(1)
				}
				.frame(maxWidth: .infinity, alignment: .leading)
				Icon(.chevronDown, size: 15, strokeWidth: 2.4).foregroundStyle(Palette.subtleForeground)
			}
			.padding(.horizontal, 16)
			.padding(.vertical, 10)
			.frame(minHeight: 46)
			.contentShape(Rectangle())
		}
		.accessibilityLabel("\(label): \(options.first { $0.value == value }?.label ?? "")")
	}
}

extension MenuRow where Mark == EmptyView {
	init(label: String, options: [(value: Value, label: String)], value: Value, choose: @escaping (Value) -> Void) {
		self.init(label: label, options: options, value: value, mark: { _ in EmptyView() }, choose: choose)
	}
}

/// A round − or + beside a stepped value.
struct StepButton: View {
	let icon: Lucide
	let label: String
	let action: (() -> Void)?

	var body: some View {
		Button { action?() } label: {
			Icon(icon, size: 14, strokeWidth: 2.4)
				.foregroundStyle(Palette.foreground)
				.frame(width: 30, height: 30)
				.background(Palette.chip, in: Circle())
		}
		.buttonStyle(.plain)
		.disabled(action == nil)
		.opacity(action == nil ? 0.45 : 1)
		.accessibilityLabel(label)
	}
}

/// A row with a value between − and +.
struct StepperRow: View {
	let label: String
	let value: String
	let lessLabel: String
	let moreLabel: String
	/// Nil when the value is as low as it goes.
	let onLess: (() -> Void)?
	/// Nil when the value is as high as it goes.
	let onMore: (() -> Void)?

	var body: some View {
		HStack(spacing: 12) {
			Text(label).font(Typeface.rubik(16)).foregroundStyle(Palette.foreground).frame(minWidth: 96, alignment: .leading)
			Spacer(minLength: 0)
			StepButton(icon: .minus, label: lessLabel, action: onLess)
			Text(value)
				.font(Typeface.rubik(16, .semibold))
				.monospacedDigit()
				.foregroundStyle(Palette.foreground)
				.frame(minWidth: 64)
				.accessibilityLabel(label)
				.accessibilityValue(value)
			StepButton(icon: .plus, label: moreLabel, action: onMore)
		}
		.padding(.horizontal, 16)
		.padding(.vertical, 10)
		.frame(minHeight: 46)
	}
}
