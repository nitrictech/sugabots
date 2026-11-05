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
			// Another bot asking a channel's bot for help, which the web draws as a row; not drawn here yet.
			if case .collaboration = item { continue }
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
			case .collaboration, .unknown:
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

	/// Whether `message` heads a run drawn with its author's face: after a day
	/// marker, when `dividers` mark days, or as `startsGroup` says, as the web's `startsRun`.
	static func startsRun(_ previous: Message?, _ message: Message, dividers: Bool) -> Bool {
		(dividers && startsNewDay(previous?.createdAt, message.createdAt)) || startsGroup(previous, message)
	}

	/// Where the face of the bot answering is drawn, and whether it's typing now.
	struct AnsweringFace {
		let messageId: String
		let botTyping: Bool
	}

	/// The face that stands for the bot that wrote the newest of `messages`,
	/// as the web's `findAnsweringFace`: the last face drawn for that bot, with
	/// a day marker before each new day when `dividers`. A reply just begun
	/// shows only as its typing line, so its face may be on the bot's reply before.
	static func answeringFace(in messages: [Message], dividers: Bool) -> AnsweringFace? {
		answeringFace(among: messages.indices.map { index in
			let message = messages[index]
			return (message, startsRun(index > 0 ? messages[index - 1] : nil, message, dividers: dividers))
		})
	}

	/// `answeringFace(in:dividers:)` for messages shown in `groups`, where a
	/// face is drawn at the start of each group as well as where `startsGroup`
	/// says, as a day marker, a thread line or a new run ends the group before.
	static func answeringFace(in groups: [Group]) -> AnsweringFace? {
		answeringFace(among: groups.flatMap { group -> [(Message, Bool)] in
			guard case let .messages(messages) = group.content else { return [] }
			return messages.indices.map { index in
				(messages[index], startsGroup(index > 0 ? messages[index - 1] : nil, messages[index]))
			}
		})
	}

	/// The answering face among messages oldest first, each with whether a face is drawn on it.
	private static func answeringFace(among shown: [(message: Message, drawsFace: Bool)]) -> AnsweringFace? {
		guard let newest = shown.last?.message, case .agent = newest.author else { return nil }
		let drawn = shown.last { message, drawsFace in
			drawsFace && sameAuthor(message, newest) && !Segments.showsNothingYet(message)
		}
		return drawn.map { AnsweringFace(messageId: $0.message.id, botTyping: isTyping(newest)) }
	}

	private static func sameAuthor(_ left: Message, _ right: Message) -> Bool {
		switch (left.author, right.author) {
		case let (.person(a), .person(b)): a.id == b.id
		case let (.agent(a), .agent(b)): a.id == b.id
		default: false
		}
	}
}
