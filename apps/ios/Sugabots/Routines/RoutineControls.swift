import SwiftUI

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
