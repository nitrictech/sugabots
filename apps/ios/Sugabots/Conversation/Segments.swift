import Foundation

/// A message's parts in the order it says them, as the web's `segmentsOf`:
/// its words, the collaborations it started, and the requests it put to
/// somebody. Narration before a step is left to the step's line.
enum Segments {
	struct Segment: Identifiable {
		enum Kind {
			case text(String)
			case collaboration(CollaborationPart)
			case toolCall(ToolCallPart)
		}

		let id: String
		let kind: Kind

		var text: String? {
			if case let .text(text) = kind, !text.isEmpty { text } else { nil }
		}

		var isEmptyText: Bool {
			if case let .text(text) = kind { text.isEmpty } else { false }
		}
	}

	/// A reply still being written shows only its collaborations, the calls put
	/// to somebody, and text something has followed: the run it is still writing
	/// waits until it is finished.
	static func of(_ message: Message) -> [Segment] {
		let finished = message.status != .streaming
		// A text run is keyed by where in the message it starts, in UTF-16 units as the web counts.
		var written = 0
		var segments: [Segment] = []
		for (index, part) in message.parts.enumerated() {
			switch part {
			case let .collaboration(collaboration):
				segments.append(Segment(id: collaboration.id, kind: .collaboration(collaboration)))
			case let .toolCall(call):
				// Only a call put to somebody shows as its own card; the rest are steps.
				if wasPutToSomeone(call) {
					segments.append(Segment(id: call.id, kind: .toolCall(call)))
				}
			case let .text(part):
				let text = part.text
				let later = message.parts.dropFirst(index + 1)
				let followed = !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && later.contains { if case .file = $0 { false } else { true } }
				let narration: Bool = if case .toolCall? = later.first { true } else { false }
				if (finished || followed) && !narration {
					segments.append(Segment(id: "text@\(written)", kind: .text(text)))
				}
				written += text.utf16.count
			case .file, .artifact, .unknown:
				break
			}
		}
		// A finished reply that said nothing still shows, so its notes have a row.
		if finished && !segments.contains(where: { if case .text = $0.kind { true } else { false } }) {
			segments.append(Segment(id: "text@\(written)", kind: .text("")))
		}
		return segments
	}

	/// Whether a reply being written has nothing settled to show yet, so shows only as its typing line.
	static func showsNothingYet(_ message: Message) -> Bool {
		guard message.status == .streaming else { return false }
		let hasCallsOrFiles = message.parts.contains { part in
			switch part {
			case .toolCall, .file: true
			default: false
			}
		}
		return !hasCallsOrFiles && of(message).allSatisfy(\.isEmptyText)
	}

	/// Whether a person was asked to allow the call, rather than policy allowing it on its own.
	private static func wasPutToSomeone(_ call: ToolCallPart) -> Bool {
		guard let status = call.approval?.status else { return false }
		return [.pending, .allowed, .denied].contains(status)
	}
}
