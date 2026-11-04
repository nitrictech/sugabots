import Foundation

/// A conversation's items in groups, as the web's `chatGroupsOf`: runs of
/// messages, and each other item on its own, each marked where a new day
/// (or in a routine's thread, a new run) starts.
enum ChatGroups {
	struct Group: Identifiable {
		enum Content {
			case messages([Message])
			case thread(ChatMessageItem.Thread)
			case paused(Date)
			case run(ChatMessageItem.Routine)
		}

		let id: String
		let at: Date
		let separated: Bool
		var content: Content
	}

	/// How long a quiet spell is before the same author starts a new group.
	private static let longQuiet: TimeInterval = 60 * 60

	static func of(_ items: [ChatMessageItem], byRun: Bool, under: Set<String>) -> [Group] {
		var groups: [Group] = []
		var previousAt: Date?
		for item in items {
			if case let .thread(thread) = item, under.contains(thread.id) { continue }
			let at = item.createdAt
			let separated = byRun ? startsRun(item) : startsNewDay(previousAt, at)
			previousAt = at
			switch item {
			case let .message(messageItem):
				let message = messageItem.message
				if !separated, let last = groups.last, case var .messages(messages) = last.content {
					messages.append(message)
					groups[groups.count - 1].content = .messages(messages)
				} else {
					groups.append(Group(id: item.id, at: at, separated: separated, content: .messages([message])))
				}
			case let .thread(thread):
				groups.append(Group(id: item.id, at: at, separated: separated, content: .thread(thread)))
			case let .routinePaused(paused):
				groups.append(Group(id: item.id, at: at, separated: separated, content: .paused(paused.createdAt)))
			case let .routine(run):
				groups.append(Group(id: item.id, at: at, separated: separated, content: .run(run)))
			case .unknown:
				continue
			}
		}
		return groups
	}

	/// Whether `at` is the first thing shown, or falls on a new day from `previous`, and so wants a day marker.
	static func startsNewDay(_ previous: Date?, _ at: Date, calendar: Calendar = .current) -> Bool {
		guard let previous else { return true }
		return !calendar.isDate(previous, inSameDayAs: at)
	}

	private static func startsRun(_ item: ChatMessageItem) -> Bool {
		switch item {
		case .routine: true
		case let .message(item): item.message.routineResultOf != nil
		default: false
		}
	}

	/// Whether a reply's turn is still going, so the typing line stands in for it, as the web's `isTyping`.
	/// Neither while it waits on a collaborator, whose line says so, nor on an approval, whose card does.
	static func isTyping(_ message: Message) -> Bool {
		if case .collaboration? = message.parts.last { return false }
		let awaiting = message.parts.contains { if case let .toolCall(call) = $0 { call.awaitsApproval } else { false } }
		return message.status == .streaming && !awaiting
	}

	/// Whether `message` starts a group under its author's face and name: a new
	/// author, an hour's quiet, a reply, whose quote sits over its author's name,
	/// or a message after one that opened a collaboration, whose thread line ends that group.
	static func startsGroup(_ previous: Message?, _ message: Message) -> Bool {
		guard let previous, sameAuthor(previous, message), message.replyTo == nil else { return true }
		if previous.parts.contains(where: { if case .collaboration = $0 { true } else { false } }) { return true }
		return message.createdAt.timeIntervalSince(previous.createdAt) >= longQuiet
	}

	private static func sameAuthor(_ left: Message, _ right: Message) -> Bool {
		switch (left.author, right.author) {
		case let (.person(a), .person(b)): a.id == b.id
		case let (.agent(a), .agent(b)): a.id == b.id
		default: false
		}
	}
}
