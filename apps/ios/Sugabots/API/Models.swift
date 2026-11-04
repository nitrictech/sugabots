import Foundation

// What the app adds to the API's types in `API.generated.swift`: how it
// identifies them in lists, and what it reads from them often enough to name.

extension Workspace: Identifiable {}
extension Pod: Identifiable {}
extension Agent: Identifiable {}
extension Message: Identifiable {}
extension ToolCallPart: Identifiable {}
extension CollaborationPart: Identifiable {}
extension FilePart: Identifiable {}
extension Thread: Identifiable {}
extension ConversationThread: Identifiable {}
extension BotChannel: Identifiable {}
extension PodChat: Identifiable {}
extension RoutineFeed: Identifiable {}
extension Routine: Identifiable {}
extension RoutineExecution: Identifiable {}
extension ArtifactSummary: Identifiable {}
extension WorkspaceMember: Identifiable {}
extension WorkspaceInvitation: Identifiable {}
extension Connection: Identifiable {}

extension PodPermissions {
	/// Nothing allowed, for a pod drawn before it exists.
	static let none = PodPermissions(
		rename: false, manageMembers: false, leave: false, createAgents: false, updateAgents: false, deleteAgents: false,
		manageConnections: false, manageSandbox: false, useDesktops: false, manageRoutines: false, runRoutines: false, deleteArtifacts: false
	)
}

extension Agent {
	var look: BotLook { BotLook(color: color.rawValue, face: face.rawValue, shape: shape.rawValue) }

	/// Its description, or nil when it has none or it was left empty.
	var givenDescription: String? { description.flatMap { $0.isEmpty ? nil : $0 } }
}

extension AgentParticipant {
	var look: BotLook { BotLook(color: color.rawValue, face: face.rawValue, shape: shape.rawValue) }
}

extension WorkspaceModel: Identifiable {
	var id: String { "\(providerName)/\(modelId)" }
	var name: String { displayName ?? modelId }
}

extension ThreadDetails {
	/// Who is in a pod's channel, each counted in words: `1 person`, `2 bots`.
	var headCount: (people: String, bots: String) {
		(Names.count(members.count, "person", "people"), Names.count(crew.compactMap(\.agent).count, "bot", "bots"))
	}
}

// MARK: Messages

extension Message {
	/// The files the message carries, in order.
	var files: [FilePart] {
		parts.compactMap { if case let .file(file) = $0 { file } else { nil } }
	}
}

extension MessageAuthor {
	var name: String {
		switch self {
		case let .person(person): person.name
		case let .agent(agent): agent.name
		case let .routineTrigger(trigger): trigger.routineName
		case .unknown: "Someone"
		}
	}

	var personId: String? {
		if case let .person(person) = self { person.id } else { nil }
	}}

extension ToolCallPart {
	var awaitsApproval: Bool { status == .awaitingApproval && approval?.status == .pending }
}

extension ThreadParticipant: Identifiable {
	var id: String {
		switch self {
		case let .person(person): person.id
		case let .agent(agent): agent.id
		case .unknown: ""
		}
	}

	var name: String {
		switch self {
		case let .person(person): person.name
		case let .agent(agent): agent.name
		case .unknown: ""
		}
	}

	var handle: String {
		switch self {
		case let .person(person): person.handle
		case let .agent(agent): agent.handle
		case .unknown: ""
		}
	}

	var agent: AgentParticipant? {
		if case let .agent(agent) = self { agent } else { nil }
	}
}

// MARK: Conversations

extension ChatListItem: Identifiable {
	var id: String { conversation.id }
	var isNew: Bool { unreadMessages > 0 || needsApproval }
	/// Whether it waits on the person: an approval, or a mention of them.
	var needsYou: Bool { needsApproval || mentionsYou }
}

extension ListedRoutine: Identifiable {
	var id: String { routine.id }
}

extension ChatList.Chat: Identifiable {
	var id: String { conversation.id }
}

extension ChatList.Channel: Identifiable {
	var id: String { conversation.id }
	var isNew: Bool { unreadMessages > 0 || needsApproval }
	/// Whether it waits on the person: an approval, or a mention of them.
	var needsYou: Bool { needsApproval || mentionsYou }
}

extension ChatMessageItem: Identifiable {
	/// The message, when the item is one.
	var message: Message? {
		if case let .message(item) = self { item.message } else { nil }
	}

	/// Unique across kinds, as the web keys them.
	var id: String {
		switch self {
		case let .message(item): "message:\(item.message.id)"
		case let .routine(run): "routine:\(run.id)"
		case let .routinePaused(paused): "routine_paused:\(paused.id)"
		case let .thread(thread): "thread:\(thread.id)"
		case let .unknown(kind): "unknown:\(kind)"
		}
	}

	var createdAt: Date {
		switch self {
		case let .message(item): item.message.createdAt
		case let .routine(run): run.createdAt
		case let .routinePaused(paused): paused.createdAt
		case let .thread(thread): thread.createdAt
		case .unknown: .distantPast
		}
	}
}

extension ChatMessageItem.Thread: Identifiable {}
extension ChatMessageItem.Routine: Identifiable {}

extension ChatHistoryEntry: Identifiable {
	var id: String { threadId }
}

// MARK: Inbox and approvals

extension ActivityItem: Identifiable {
	var id: String {
		switch self {
		case let .mentionOrMessage(message): message.messageId
		case let .routine(run): run.threadId
		case let .collaboration(collaboration): collaboration.threadId
		case let .unknown(kind): "unknown:\(kind)"
		}
	}

	var podId: String? {
		switch self {
		case let .mentionOrMessage(message): message.podId
		case let .routine(run): run.podId
		case let .collaboration(collaboration): collaboration.podId
		case .unknown: nil
		}
	}

	var conversationId: String? {
		switch self {
		case let .mentionOrMessage(message): message.conversationId
		case let .routine(run): run.conversationId
		case let .collaboration(collaboration): collaboration.conversationId
		case .unknown: nil
		}
	}

	var at: Date {
		switch self {
		case let .mentionOrMessage(message): message.at
		case let .routine(run): run.at
		case let .collaboration(collaboration): collaboration.at
		case .unknown: .distantPast
		}
	}

	var unread: Bool {
		switch self {
		case let .mentionOrMessage(message): message.unread
		case let .routine(run): run.unread
		case let .collaboration(collaboration): collaboration.unread
		case .unknown: false
		}
	}

	var preview: String? {
		switch self {
		case let .mentionOrMessage(message): message.preview
		case let .routine(run): run.preview
		case let .collaboration(collaboration): collaboration.brief
		case .unknown: nil
		}
	}
}

/// A tool call somebody was asked to approve, waiting or answered, as Approvals lists both.
struct ApprovalEntry: Identifiable {
	let call: ToolCallPart
	let agent: AgentParticipant
	let podId: String
	let threadId: String
	let conversationId: String?
	/// Present once somebody answered it.
	let answer: AnsweredApproval.Answer?

	var id: String { call.id }

	init(_ request: ApprovalRequest) {
		call = request.call
		agent = request.agent
		podId = request.podId
		threadId = request.threadId
		conversationId = request.conversationId
		answer = nil
	}

	init(_ request: AnsweredApproval) {
		call = request.call
		agent = request.agent
		podId = request.podId
		threadId = request.threadId
		conversationId = request.conversationId
		answer = request.answer
	}
}

// MARK: Notifications

extension NotificationLevel: Identifiable {
	var id: String { rawValue }

	var label: String { Self.labels[rawValue] ?? "Something else" }

	var symbol: String {
		switch self {
		case .all: "bell.badge"
		case .mentions: "at"
		case .nothing, .unknown: "bell.slash"
		}
	}
}

/// A pod or one of its bots, where a person may choose a level of their own.
enum NotificationPlace: Hashable {
	case pod(id: String)
	case bot(id: String, podId: String)

	var kind: NotificationPlaceKind {
		switch self {
		case .pod: .pod
		case .bot: .bot
		}
	}

	var id: String {
		switch self {
		case let .pod(id), let .bot(id, _): id
		}
	}
}

extension NotificationSettings {
	/// The level chosen for the place itself, or nil when it follows the one above it.
	func levelChosen(for place: NotificationPlace) -> NotificationLevel? {
		switch place {
		case let .pod(id): pods[id]
		case let .bot(id, _): bots[id]
		}
	}

	/// The level a place follows when none is chosen for it: its pod's, or the person's own.
	func levelAbove(_ place: NotificationPlace) -> NotificationLevel {
		if case let .bot(_, podId) = place, let podLevel = pods[podId] { return podLevel }
		return level
	}

	/// When the place's mute ends, or nil when it isn't muted for a while.
	func mutedUntil(_ place: NotificationPlace, now: Date = .now) -> Date? {
		let until: Date? =
			switch place {
			case let .pod(id): mutedUntil.pods[id]
			case let .bot(id, _): mutedUntil.bots[id]
			}
		guard let until, until > now else { return nil }
		return until
	}

	/// Whether the place is muted, for good or for a while.
	func isMuted(_ place: NotificationPlace) -> Bool {
		mutedUntil(place) != nil || levelChosen(for: place) == .nothing
	}
}
