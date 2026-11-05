import Foundation

/// Whom a mention can name, as the web's `MentionTarget`: a person or a bot,
/// or with `@here` or `@channel`, everyone who can see the conversation.
/// `@here` or `@channel`, which a person writes to notify everyone who can see the conversation.
struct GroupMention: Hashable {
	let handle: String
	/// The people it would notify: the pod's people but its writer, never a bot.
	let notifies: [PersonParticipant]

	var target: MentionTarget { .group(handle: handle) }
}

enum MentionTarget: Hashable {
	case participant(ThreadParticipant)
	case group(handle: String)

	var handle: String {
		switch self {
		case let .participant(participant): participant.handle
		case let .group(handle): handle
		}
	}

	/// What tells it apart from the others in a list of them, as `mentionTargetKey`.
	var key: String {
		switch self {
		case let .participant(.person(person)): "person-\(person.id)"
		case let .participant(.agent(agent)): "agent-\(agent.id)"
		case let .participant(participant): "unknown-\(participant.id)"
		case let .group(handle): handle
		}
	}

	var participant: ThreadParticipant? {
		if case let .participant(participant) = self { participant } else { nil }
	}
}

/// Mentions in text, as `@sugabots/contracts` finds them: `@handle` for a
/// person or bot somebody may mention here, or `@here` and `@channel` for everyone.
enum Mentions {
	/// What may not come just before a mention's `@`, as the inside of a
	/// character class, as `NOT_BEFORE_MENTION` in `@sugabots/contracts`: a word
	/// character, so an email address is not a mention, and a `.` or `@`, so
	/// neither is a domain or `@@`. Spelled out rather than as `\w`, which in
	/// Swift takes in letters beyond ASCII where JavaScript's does not. Regex
	/// literals don't compose, so the patterns below are built from strings.
	private static let notBeforeMention = "A-Za-z0-9_.@"
	private static let notBeforeMentionCharacter = try! Regex("[\(notBeforeMention)]")
	/// A handle as a mention writes it: ASCII letters and digits, in runs joined by
	/// single hyphens. Both cases are spelled out rather than matched ignoring
	/// case, which in Swift also takes in letters that fold to ASCII, as `K` does.
	private static let handle = "[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*"

	/// `@handle`, as `MENTION` in `@sugabots/contracts`. Swift's regexes can't
	/// look behind, so what comes before the `@` is matched as the first group,
	/// and the handle, without its `@`, is the second. Matched a Unicode scalar
	/// at a time, as JavaScript does, so a handle ends before an accent that
	/// would join its last letter.
	private static let pattern = try! Regex(
		"(^|[^\(notBeforeMention)])@(\(handle))",
		as: (Substring, Substring, Substring).self
	).matchingSemantics(.unicodeScalar)

	/// A mention a space or line break has finished, as the composer turns into
	/// a chip: what comes before the `@` as the first group, then `@handle`.
	static let finished = try! Regex(
		"(^|[^\(notBeforeMention)])(@\(handle))(?=\\s)",
		as: (Substring, Substring, Substring).self
	).matchingSemantics(.unicodeScalar)

	/// The handles that address everyone in a conversation, as `GROUP_MENTION_HANDLES`.
	static let groupHandles = ["here", "channel"]

	/// The threads whose messages notify people, where `@here` and `@channel` reach somebody, as `NOTIFYING_THREAD_TYPES`.
	private static let notifyingThreadTypes: Set<ThreadType> = [.conversation, .podChat, .botChannel]

	/// Whether the `@` at `index` in `text` can start a mention, as the contract's `canStartMention`.
	static func canStart(at index: String.Index, in text: String) -> Bool {
		guard index < text.endIndex, text[index] == "@" else { return false }
		guard index > text.startIndex else { return true }
		return String(text[text.index(before: index)]).wholeMatch(of: notBeforeMentionCharacter) == nil
	}

	/// `text` split around its mentions, as `splitAroundMentions`: text at even
	/// indexes and, between them, each mentioned handle as written, without its `@`.
	static func split(_ text: String) -> [String] {
		var parts: [String] = []
		var rest = text.startIndex
		for match in text.matches(of: pattern) {
			let at = text.unicodeScalars.index(before: match.2.startIndex)
			parts.append(String(text.unicodeScalars[rest..<at]))
			parts.append(String(match.2))
			rest = match.2.endIndex
		}
		parts.append(String(text.unicodeScalars[rest...]))
		return parts
	}

	/// A piece of text split around its mentions.
	enum Piece {
		/// Words between mentions, as written.
		case text(String)
		/// A mentioned handle as written, without its `@`.
		case mention(handle: String)

		/// The piece as it reads in the text, a mention with its `@`.
		var written: String {
			switch self {
			case let .text(text): text
			case let .mention(handle): "@\(handle)"
			}
		}
	}

	/// `text` split around its mentions, as `split`, each piece saying which it is.
	static func pieces(of text: String) -> [Piece] {
		split(text).enumerated().map { index, part in index.isMultiple(of: 2) ? .text(part) : .mention(handle: part) }
	}

	/// The handles `text` mentions, lowercased, in order, as the contract's `mentionedHandles`.
	static func handles(in text: String) -> [String] {
		var found: [String] = []
		for (index, part) in split(text).enumerated() where index % 2 == 1 && !found.contains(part.lowercased()) {
			found.append(part.lowercased())
		}
		return found
	}

	/// Those among `mentionable` whom `text` mentions.
	static func mentioned(in text: String, among mentionable: [ThreadParticipant]) -> [ThreadParticipant] {
		let named = handles(in: text)
		return mentionable.filter { named.contains($0.handle) }
	}

	/// The bot `text` mentions first among `crew`, whom sending from a pod's
	/// channel starts a thread with, as the web's `firstBotNamed`; any named
	/// after it are only mentioned.
	static func firstBot(in text: String, among crew: [ThreadParticipant]) -> AgentParticipant? {
		let bots = crew.compactMap(\.agent)
		return handles(in: text).lazy.compactMap { handle in bots.first { $0.handle == handle } }.first
	}

	/// `@here` and `@channel` as a message's writer can use them in a thread of
	/// `threadType`, each notifying `members`, the pod's people, but the writer,
	/// as `groupMentionsBy`. `writerPersonId` is the writer's id when a person
	/// writes, and nil for a bot or a routine. None where they would notify
	/// nobody, so they stay text.
	static func groupMentions(
		writtenBy writerPersonId: String?,
		members: [PersonParticipant],
		threadType: ThreadType?
	) -> [GroupMention] {
		guard let writerPersonId, let threadType, notifyingThreadTypes.contains(threadType) else { return [] }
		let notifies = members.filter { $0.id != writerPersonId }
		if notifies.isEmpty { return [] }
		return groupHandles.map { GroupMention(handle: $0, notifies: notifies) }
	}

	/// Whom `handle`, as a mention writes it, names among `mentionable`, as
	/// `targetWithHandle`. A person whose handle is `here` or `channel` is
	/// mentioned with everyone else.
	static func target(withHandle handle: String, among mentionable: [MentionTarget]) -> MentionTarget? {
		let lowered = handle.lowercased()
		return mentionable.first { if case .group(lowered) = $0 { true } else { false } }
			?? mentionable.first { $0.handle == lowered }
	}
}
