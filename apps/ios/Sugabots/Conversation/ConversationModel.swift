import Foundation
import Observation

/// One open conversation, as the web's `ConversationChat` keeps it: the
/// thread's details, the pages of its items (messages, runs, threads started
/// here), its side threads, and what the person is sending. The thread's
/// event stream keeps it live.
@MainActor
@Observable
final class ConversationModel {
	/// The conversation's own thread, whose id is the conversation's.
	let threadId: String
	private let store: WorkspaceStore

	private(set) var details: ThreadDetails?
	/// The items of the pages loaded, newest page last.
	private(set) var pageItems: [ChatMessageItem] = []
	/// Where older items start, while there are any.
	private(set) var olderCursor: String?
	private(set) var loadingOlder = false
	private(set) var pagesLoaded = 0
	/// The newest messages, as the thread's details and its stream keep them.
	private(set) var liveMessages: [Message] = []
	/// Messages the person sent that the server hasn't confirmed yet.
	private(set) var sendingMessages: [Message] = []
	/// The conversation's side threads: collaborations and routine runs.
	private(set) var entries: [ChatHistoryEntry] = []
	private(set) var loadError: String?
	private(set) var messagesFailed = false
	/// Why a reply somebody asked for is not coming. The server keeps these in no history.
	private(set) var notices: [String] = []
	/// The turn in progress, which Stop cancels.
	private(set) var runningTurnId: String?
	private(set) var typing: [String: (person: PersonParticipant, until: Date)] = [:]

	private var listening: Task<Void, Never>?
	private var refetching: Task<Void, Never>?

	/// How many items a page holds.
	private static let pageSize = 50
	/// How long a person is shown typing after they last said so: twice the gap between their signals.
	private static let typingShownFor: TimeInterval = 6

	/// Whether its items come from its conversation's pages; a side thread, which isn't a conversation of its own, shows its thread's messages only.
	private let paged: Bool

	init(threadId: String, store: WorkspaceStore, paged: Bool = true) {
		self.threadId = threadId
		self.store = store
		self.paged = paged
		// Shown at once as it was left, while `load` brings it up to date.
		if paged, let left = store.leftConversations[threadId] { restore(left) }
	}

	/// What a conversation showed when it was left.
	struct Snapshot {
		let details: ThreadDetails
		let pageItems: [ChatMessageItem]
		let olderCursor: String?
		let pagesLoaded: Int
		let entries: [ChatHistoryEntry]
	}

	private func restore(_ left: Snapshot) {
		details = left.details
		liveMessages = left.details.messages.sorted { $0.createdAt < $1.createdAt }
		pageItems = left.pageItems
		olderCursor = left.olderCursor
		pagesLoaded = left.pagesLoaded
		entries = left.entries
	}

	/// Keeps what's shown for the next time the conversation opens.
	private func keep() {
		guard paged, let details, loadError == nil, !messagesFailed else { return }
		store.leftConversations[threadId] = Snapshot(details: details, pageItems: pageItems, olderCursor: olderCursor, pagesLoaded: pagesLoaded, entries: entries)
	}

	var thread: Thread? { details?.thread }
	var conversationId: String { thread?.conversationId ?? threadId }
	var isPodChat: Bool { thread?.type == .podChat }
	var isBotChannel: Bool { thread?.type == .botChannel }
	var isRoutineFeed: Bool { thread?.type == .routineFeed }
	var isRunning: Bool { runningTurnId != nil || thread?.status == .running }

	/// Every item to show, oldest first: the pages, what is being sent, and the live messages over both.
	var items: [ChatMessageItem] {
		var byId: [String: ChatMessageItem] = [:]
		for item in pageItems { byId[item.id] = item }
		for message in sendingMessages { byId["message:\(message.id)"] = .message(.init(message: message)) }
		for message in liveMessages { byId["message:\(message.id)"] = .message(.init(message: message)) }
		return byId.values.sorted { $0.createdAt < $1.createdAt }
	}

	/// The ids of messages still being sent.
	var sendingIds: Set<String> {
		let saved = Set(pageItems.compactMap { if case let .message(item) = $0 { item.message.id } else { nil } } + liveMessages.map(\.id))
		return Set(sendingMessages.map(\.id).filter { !saved.contains($0) })
	}

	/// Everybody who can be mentioned here: those in the thread, then the pod's bots and people.
	var mentionable: [ThreadParticipant] {
		guard let details else { return [] }
		var joined = Set(details.participants.map(\.id))
		var all = details.participants
		for member in details.crew where !joined.contains(member.id) {
			all.append(member)
			joined.insert(member.id)
		}
		for person in details.members where !joined.contains(person.id) {
			all.append(.person(person))
			joined.insert(person.id)
		}
		return all
	}

	/// People typing now, but not the person themselves.
	var peopleTyping: [PersonParticipant] {
		typing.values.filter { $0.until > .now }.map(\.person).sorted { $0.name < $1.name }
	}

	// MARK: Loading and listening

	func start() async {
		await load()
		guard listening == nil else { return }
		listening = Task { [weak self, client = store.client, threadId] in
			for await event in EventStream.thread(threadId, client: client) {
				self?.apply(event)
			}
		}
	}

	func stop() {
		listening?.cancel()
		refetching?.cancel()
		keep()
	}

	func load() async {
		// A conversation the pods' lists show is its own thread, so its pages can load
		// alongside its details instead of a round trip after them.
		if paged, store.listedKind(of: threadId) != nil {
			async let details: Void = loadDetails()
			async let page: Void = loadNewestPage()
			async let history: Void = loadHistory()
			_ = await (details, page, history)
			keep()
			return
		}
		await loadDetails()
		guard loadError == nil, paged, thread?.conversationId != nil else { return }
		async let page: Void = loadNewestPage()
		async let history: Void = loadHistory()
		_ = await (page, history)
		keep()
	}

	private func loadDetails() async {
		do {
			let details = try await store.client.threads.get(threadId: threadId, limit: String(Self.pageSize))
			self.details = details
			liveMessages = details.messages.sorted { $0.createdAt < $1.createdAt }
			if details.thread.status != .running { runningTurnId = nil }
			loadError = nil
		} catch {
			// A conversation already showing from when it was left stays shown; the next refresh tries again.
			if details == nil { loadError = error.localizedDescription }
		}
	}

	private func loadNewestPage() async {
		do {
			let page = try await store.client.chats.messages(conversationId: conversationId, limit: String(Self.pageSize))
			// Older pages loaded before stay; the newest is replaced.
			let newest = Set(page.items.map(\.id))
			let older = pageItems.filter { !newest.contains($0.id) && pagesLoaded > 1 }
			pageItems = older + page.items
			if pagesLoaded <= 1 { olderCursor = page.nextCursor }
			pagesLoaded = max(pagesLoaded, 1)
			messagesFailed = false
		} catch {
			// Leaving the page cancels the request, which isn't a failure to say.
			if !(error is CancellationError) && (error as? URLError)?.code != .cancelled {
				print("Messages failed: \(error)")
				messagesFailed = true
			}
		}
	}

	private func loadHistory() async {
		if let page = try? await store.client.chats.history(conversationId: conversationId) {
			entries = page.items
		}
	}

	/// Loads the page of items before those shown.
	func loadOlder() async {
		guard let cursor = olderCursor, !loadingOlder else { return }
		loadingOlder = true
		defer { loadingOlder = false }
		guard
			let page = try? await store.client.chats.messages(conversationId: conversationId, cursor: cursor, limit: String(Self.pageSize))
		else { return }
		pageItems = page.items + pageItems
		olderCursor = page.nextCursor
		pagesLoaded += 1
	}

	/// Refetches once events stop arriving for a moment: what an event could not say exactly.
	private func refetchSoon() {
		refetching?.cancel()
		refetching = Task {
			try? await Task.sleep(for: .milliseconds(250))
			guard !Task.isCancelled else { return }
			await load()
		}
	}

	// MARK: Events

	private func apply(_ streamed: StreamEvent) {
		guard let event = streamed.decode(ThreadUpdateEvent.self) else { return refetchSoon() }
		switch event {
		case let .messageCreated(created):
			upsert(created.message)
			notices = []
			if let personId = created.message.author.personId { typing[personId] = nil }
			if created.message.threadId != threadId { refetchSoon() }
		case let .messageDelta(delta):
			appendDelta(delta)
		case let .messageCompleted(completed):
			// The stored parts place tool calls in the final text exactly, which deltas cannot.
			update(completed.messageId) { $0.status = completed.status }
			refetchSoon()
		case let .messageFailed(failed):
			guard !failed.willRetry else { return }
			update(failed.messageId) {
				$0.status = .failed
				$0.error = failed.error
			}
		case let .toolCallStarted(changed):
			upsertToolCall(changed.toolCall, in: changed.messageId)
		case let .toolCallCompleted(changed):
			upsertToolCall(changed.toolCall, in: changed.messageId)
		case let .toolCallUpdated(changed):
			upsertToolCall(changed.toolCall, in: changed.messageId)
		case let .messageReactionsChanged(changed):
			update(changed.messageId) { $0.reactions = changed.reactions }
		case let .turnStarted(started):
			runningTurnId = started.turnId
		case .turnCompleted:
			runningTurnId = nil
			refetchSoon()
		case let .threadNotice(notice):
			notices.append(notice.notice)
		case let .personTyping(typing):
			guard typing.person.id != store.user.id else { return }
			self.typing[typing.person.id] = (typing.person, Date.now.addingTimeInterval(Self.typingShownFor))
		default:
			refetchSoon()
		}
	}

	private func upsert(_ message: Message) {
		sendingMessages.removeAll { $0.id == message.id }
		if let index = liveMessages.firstIndex(where: { $0.id == message.id }) {
			liveMessages[index] = message
		} else {
			liveMessages.append(message)
			liveMessages.sort { $0.createdAt < $1.createdAt }
		}
	}

	private func update(_ messageId: String, _ change: (inout Message) -> Void) {
		if let index = liveMessages.firstIndex(where: { $0.id == messageId }) {
			change(&liveMessages[index])
			return
		}
		if let index = pageItems.firstIndex(where: { $0.id == "message:\(messageId)" }), case var .message(item) = pageItems[index] {
			change(&item.message)
			pageItems[index] = .message(item)
			return
		}
		refetchSoon()
	}

	/// Appends streamed text where it belongs. `offset` says how much came before
	/// it, so a repeat is skipped and a gap is filled by refetching. Offsets
	/// count UTF-16 code units, as JavaScript strings do.
	private func appendDelta(_ delta: ThreadUpdateEvent.MessageDelta) {
		guard let index = liveMessages.firstIndex(where: { $0.id == delta.messageId }) else { return refetchSoon() }
		let written = liveMessages[index].content.utf16.count
		guard delta.offset <= written else { return refetchSoon() }
		let fresh = String(decoding: Array(delta.text.utf16.dropFirst(written - delta.offset)), as: UTF16.self)
		guard !fresh.isEmpty else { return }
		liveMessages[index].content += fresh
		if case let .text(part)? = liveMessages[index].parts.last {
			liveMessages[index].parts[liveMessages[index].parts.count - 1] = .text(TextPart(text: part.text + fresh))
		} else {
			liveMessages[index].parts.append(.text(TextPart(text: fresh)))
		}
	}

	private func upsertToolCall(_ call: ToolCallPart, in messageId: String) {
		guard let index = liveMessages.firstIndex(where: { $0.id == messageId }) else { return refetchSoon() }
		let existing = liveMessages[index].parts.firstIndex {
			if case let .toolCall(part) = $0 { part.id == call.id } else { false }
		}
		if let existing {
			liveMessages[index].parts[existing] = .toolCall(call)
		} else {
			liveMessages[index].parts.append(.toolCall(call))
		}
	}

	// MARK: Doing things

	/// Sends `text` with `files`, answering `replyTo`, shown at once and confirmed when the server has it.
	func send(_ text: String, replyTo: MessageReplyTo?, files: [FilePart] = []) async throws {
		let id = UUID().uuidString.lowercased()
		let sending = Message(
			id: id,
			threadId: threadId,
			author: .person(PersonParticipant(id: store.user.id, name: store.user.name, email: store.user.email, handle: "", image: store.user.image)),
			status: .complete,
			parts: (text.isEmpty ? [] : [.text(TextPart(text: text))]) + files.map { .file($0) },
			content: text,
			replyTo: replyTo,
			createdAt: .now
		)
		sendingMessages.append(sending)
		do {
			let sent = try await store.client.chats.send(
				conversationId: conversationId,
				id: id,
				message: text,
				attachments: files.isEmpty ? nil : files.map(\.id),
				replyTo: replyTo?.id
			)
			upsert(sent)
		} catch {
			sendingMessages.removeAll { $0.id == id }
			throw error
		}
	}

	/// Starts a thread from this channel with `bot` from `text`, as mentioning a bot does, or between people with none.
	@discardableResult
	func startThread(_ text: String, with bot: AgentParticipant?, replyTo: MessageReplyTo?, files: [FilePart] = []) async throws -> StartedThread {
		let started = try await store.client.chats.startThread(
			conversationId: conversationId,
			id: UUID().uuidString.lowercased(),
			message: text,
			attachments: files.isEmpty ? nil : files.map(\.id),
			hostAgentId: bot?.id,
			replyTo: replyTo?.id
		)
		if paged { await loadNewestPage() }
		if let pod = store.pod(id: thread?.podId ?? "") { await store.refreshChatList(pod) }
		return started
	}

	/// The thread started from `message` in this channel, started now if it has none.
	func thread(from message: Message) async throws -> ConversationThread {
		let started = try await store.client.chats.threadFrom(messageId: message.id)
		await loadNewestPage()
		if let pod = store.pod(id: thread?.podId ?? "") { await store.refreshChatList(pod) }
		return started
	}

	/// Marks the thread done, or with false, reopens it.
	func setDone(_ done: Bool) async throws {
		if done {
			try await store.client.chats.markDone(conversationId: conversationId)
		} else {
			try await store.client.chats.reopen(conversationId: conversationId)
		}
		await load()
		if let pod = store.pod(id: thread?.podId ?? "") { await store.refreshChatList(pod) }
	}

	/// Adds the person's `emoji` to `message`, or takes it away.
	func toggleReaction(_ emoji: String, on message: Message) async {
		let mine = message.reactions?.first { $0.emoji == emoji }?.people.contains { $0.id == store.user.id } ?? false
		update(message.id) { changed in
			var reactions = changed.reactions ?? []
			if let index = reactions.firstIndex(where: { $0.emoji == emoji }) {
				if mine {
					reactions[index].people.removeAll { $0.id == self.store.user.id }
					if reactions[index].people.isEmpty { reactions.remove(at: index) }
				} else {
					reactions[index].people.append(.init(id: self.store.user.id, name: self.store.user.name, at: .now))
				}
			} else if !mine {
				reactions.append(MessageReaction(emoji: emoji, people: [.init(id: self.store.user.id, name: self.store.user.name, at: .now)]))
			}
			changed.reactions = reactions
		}
		do {
			if mine {
				_ = try await store.client.threads.unreact(messageId: message.id, emoji: emoji)
			} else {
				_ = try await store.client.threads.react(messageId: message.id, emoji: emoji)
			}
		} catch {
			refetchSoon()
		}
	}

	/// Records that the person has read the conversation to its newest message.
	func markRead() async {
		await store.markRead(conversationId: conversationId)
	}

	/// Says the person is writing, which others watching see for a few seconds.
	func signalTyping() async {
		try? await store.client.events.typing(threadId: threadId)
	}

	func stopReply() async {
		guard let runningTurnId else { return }
		try? await store.client.threads.cancelTurn(turnId: runningTurnId)
	}
}

