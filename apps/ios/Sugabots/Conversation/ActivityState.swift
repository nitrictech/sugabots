import Foundation

/// How a side thread stands, a routine's run or a collaboration, as the web's `ActivityState`.
enum ActivityState {
	case running, waitingOnYou, done, failed

	/// How a side thread stands as its entry in a conversation's history says,
	/// as the web's `activityStateOf`: running until it ends, and while no entry
	/// has loaded.
	init(historyEntry entry: ChatHistoryEntry?) {
		switch entry?.status {
		case .failed, .cancelled: self = .failed
		case .completed: self = .done
		default: self = .running
		}
	}

	/// How a routine's run stands, by the state of its execution.
	init(routineRun state: RoutineExecutionState) {
		switch state {
		case .completed: self = .done
		case .failed, .cancelled: self = .failed
		case .queued, .running, .unknown: self = .running
		}
	}

	/// How a collaboration stands, by its status: waiting on the person while it needs their approval.
	init(collaboration status: CollaborationStatus) {
		switch status {
		case .waiting: self = .running
		case .pending: self = .waitingOnYou
		case .answered: self = .done
		case .failed, .unknown: self = .failed
		}
	}

	func routineText(_ name: String) -> String {
		switch self {
		case .running: "\(name) is running"
		case .waitingOnYou: "\(name) is waiting on your approval"
		case .done: "\(name) ran"
		case .failed: "\(name) failed"
		}
	}

	func collaborationText(host: String, other: String) -> String {
		switch self {
		case .running: "\(host) is talking to \(other)"
		case .waitingOnYou: "\(host) is waiting on your approval"
		case .done: "\(host) collaborated with \(other)"
		case .failed: "Collaboration with \(other) failed"
		}
	}
}
