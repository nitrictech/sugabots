import Foundation
import Observation
import os

/// One open conversation, as the web's `ConversationChat` keeps it: the
/// thread's details, the pages of its items (messages, runs, threads started
/// here), its side threads, and what the person is sending. The thread's
/// event stream keeps it live while a screen calls `listen()`.
@MainActor
@Observable
final class ConversationModel {
	/// Where a model's items come from.
	enum ItemSource {
		/// The conversation's pages of items and its side threads. What is shown is
		/// kept in the store when the last screen stops listening, and shown at once
		/// the next time a model of the conversation is made.
		case conversationPages
		/// The thread's newest messages alone, as its details carry them: a side
		/// thread, which isn't a conversation of its own, or a channel opened only to
		/// start a thread from.
		case threadMessages
	}

	/// How sending a draft ended.
	enum SubmitOutcome {
		case sent
		/// Not sent, with why in words for the person.
		case failed(String)
	}

	/// The conversation's own thread, whose id is the conversation's.
	let threadId: String
	private let store: WorkspaceStore
	private let source: ItemSource

	private(set) var details: ThreadDetails?
	/// The items of the pages loaded, newest page last.
	private(set) var pageItems: [ChatMessageItem] = [] { didSet { rebuildItems() } }
	/// Where older items start, while there are any.
	private(set) var olderCursor: String?
	private(set) var pagesLoaded = 0
	/// Whether a load has finished since the model was made, so its items are
	/// current rather than as the conversation was left.
	private(set) var isLoaded = false
	/// The newest messages, as the thread's details and its stream keep them.
	private(set) var liveMessages: [Message] = [] { didSet { rebuildItems() } }
	/// Messages the person sent that the server hasn't confirmed yet.
	private(set) var sendingMessages: [Message] = [] { didSet { rebuildItems() } }
	/// Every item to show, oldest first: the pages, what is being sent, and the live messages over both.
	private(set) var items: [ChatMessageItem] = []
	/// The ids of messages still being sent.
	private(set) var sendingIds: Set<String> = []
	/// The conversation's side threads: collaborations and routine runs.
	private(set) var entries: [ChatHistoryEntry] = []
	private(set) var loadError: String?
	/// Why a reply somebody asked for is not coming. The server keeps these in no history.
	private(set) var notices: [String] = []
	/// The turn in progress.
	private(set) var runningTurnId: String?

	private var newestPageFailed = false
	private var olderPageFailed = false
	private var historyFailed = false
	/// People typing now, by id, each until their last signal runs out.
	private var typing: [String: TypingPerson] = [:]
	private var lastTypingSignal = Date.distantPast

	/// The stream of the thread's events, while any screen listens.
	private var streaming: Task<Void, Never>?
	/// How many screens are listening now: a conversation and its Details may overlap while one is pushed over the other.
	private var listeners = 0
	private var reloading: Task<Void, Never>?
	private var refetching: Task<Void, Never>?
	private var loadingOlderPage: Task<Bool, Never>?

	/// How many items a page holds.
	private static let pageSize = 50
	/// How long a person is shown typing after they last said so: twice the gap between their signals.
	private static let typingShownFor: Duration = .seconds(6)
	/// How often a person still typing says so again, as the web's composer does.
	private static let typingSignalInterval: TimeInterval = 3
	/// How long events must stop arriving before what they couldn't say exactly is fetched again.
	private static let refetchDelay: Duration = .milliseconds(250)
	/// The status of a message the server refused as written, whose reason is worth showing.
	private static let badRequestStatus = 400
	private static let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "Sugabots", category: "Conversation")

	init(threadId: String, store: WorkspaceStore, source: ItemSource = .conversationPages) {
		self.threadId = threadId
		self.store = store
		self.source = source
		// Shown at once as it was left, while `listen` brings it up to date.
		if source == .conversationPages, let left = store.leftConversations[threadId] { restore(left) }
		rebuildItems()
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
		show(left.details)
		pageItems = left.pageItems
		olderCursor = left.olderCursor
		pagesLoaded = left.pagesLoaded
		entries = left.entries
	}

	/// Keeps what's shown for the next time the conversation opens.
	private func keep() {
		guard source == .conversationPages, let details, loadError == nil, !messagesFailed else { return }
		store.leftConversations[threadId] = Snapshot(details: details, pageItems: pageItems, olderCursor: olderCursor, pagesLoaded: pagesLoaded, entries: entries)
	}

	var thread: Thread? { details?.thread }
	var conversationId: String { thread?.conversationId ?? threadId }
	var isPodChat: Bool { thread?.type == .podChat }
	var isBotChannel: Bool { thread?.type == .botChannel }
	var isRoutineFeed: Bool { thread?.type == .routineFeed }
	var isRunning: Bool { runningTurnId != nil || thread?.status == .running }
	/// Whether the newest page, an older page, or the side threads failed to load.
	var messagesFailed: Bool { newestPageFailed || olderPageFailed || historyFailed }
	var loadingOlder: Bool { loadingOlderPage != nil }

	private func rebuildItems() {
		var byId: [String: ChatMessageItem] = [:]
		for item in pageItems { byId[item.id] = item }
		for message in sendingMessages { byId["message:\(message.id)"] = .message(.init(message: message)) }
		for message in liveMessages { byId["message:\(message.id)"] = .message(.init(message: message)) }
		items = byId.values.sorted { $0.createdAt < $1.createdAt }
		let saved = Set(pageItems.compactMap(\.message?.id) + liveMessages.map(\.id))
		sendingIds = Set(sendingMessages.map(\.id).filter { !saved.contains($0) })
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

	/// People typing now, but not the person themselves, by name.
	var peopleTyping: [PersonParticipant] {
		typing.values.map(\.person).sorted { $0.name < $1.name }
	}

	/// The person's messages waiting behind a reply in progress, by id.
	var queuedBehindReply: Set<String> {
		guard let since = details?.queuedSince else { return [] }
		return Set(items.compactMap { item -> String? in
			guard let message = item.message, message.author.personId != nil, message.createdAt >= since else { return nil }
			return message.id
		})
	}

	/// What each message row needs from this conversation, once its details
	/// have loaded. `looks` are the pod's connections by handle; files are
	/// fetched from `filesConversationId`.
	func messageContext(looks: [String: ConnectionLook], filesConversationId: String) -> MessageContext? {
		guard let details else { return nil }
		let messages = items.compactMap(\.message)
		return MessageContext(
			podId: details.thread.podId,
			mentionable: mentionable,
			capabilities: details.capabilities,
			looks: looks,
			fileNames: Dictionary(messages.flatMap(\.files).map { ($0.id, $0.name) }, uniquingKeysWith: { first, _ in first }),
			threadActivityAt: Dictionary(entries.map { ($0.threadId, $0.latestActivityAt) }, uniquingKeysWith: { first, _ in first }),
			queued: queuedBehindReply,
			sending: sendingIds,
			inRoutineThread: isRoutineFeed,
			userId: store.user.id,
			conversationId: filesConversationId
		)
	}

	/// The bot a pod channel's `draft` mentions first, whom sending it starts a thread with; nil anywhere else.
	func threadBot(for draft: String) -> AgentParticipant? {
		guard isPodChat, let crew = details?.crew else { return nil }
		return Mentions.firstBot(in: draft, among: crew)
	}

	// MARK: Loading and listening

	/// Loads the conversation and keeps it live from its thread's events until
	/// the calling task is cancelled. Screens showing the model each call it
	/// from their own task; the stream runs while any of them listens, and when
	/// the last stops, what is shown is kept for the next time it opens.
	func listen() async {
		listeners += 1
		if streaming == nil {
			streaming = Task { await streamEvents() }
		}
		await Self.waitUntilCancelled()
		listeners -= 1
		guard listeners == 0 else { return }
		streaming?.cancel()
		streaming = nil
		refetching?.cancel()
		keep()
	}

	private func streamEvents() async {
		await reload()
		// A refused thread stream just stops: the workspace's own stream reports a refusal such as an expired token.
		do {
			for try await event in EventStream.thread(threadId, client: store.client) {
				apply(event)
			}
		} catch {}
	}

	/// Returns once the calling task is cancelled.
	private static func waitUntilCancelled() async {
		while !Task.isCancelled {
			// Throws, ending the wait, as soon as the task is cancelled.
			try? await Task.sleep(for: .seconds(60 * 60))
		}
	}

	/// Loads the thread's details and its newest items again. A reload still
	/// under way is abandoned, so an older response never replaces a newer one.
	func reload() async {
		reloading?.cancel()
		let task = Task { await load() }
		reloading = task
		await task.value
	}

	private func load() async {
		if source == .conversationPages, store.isListed(threadId) {
			// A conversation the pods' lists show is its own thread, so its pages can load
			// alongside its details instead of a round trip after them.
			async let details: Void = loadDetails()
			async let pages: Void = loadPages()
			_ = await (details, pages)
		} else {
			await loadDetails()
			if loadError == nil, source == .conversationPages, thread?.conversationId != nil {
				await loadPages()
			}
		}
		if !Task.isCancelled { isLoaded = true }
	}

	private func loadDetails() async {
		do {
			let loaded = try await store.client.threads.get(threadId: threadId, limit: Self.pageSize)
			guard !Task.isCancelled else { return }
			show(loaded)
		} catch {
			guard !error.isCancellation, !Task.isCancelled else { return }
			Self.log.error("Thread details failed: \(String(describing: error))")
			// A conversation already showing from when it was left stays shown; the next refresh tries again.
			if details == nil { loadError = error.localizedDescription }
		}
	}

	private func show(_ details: ThreadDetails) {
		self.details = details
		liveMessages = details.messages.sorted { $0.createdAt < $1.createdAt }
		if details.thread.status != .running { runningTurnId = nil }
		loadError = nil
	}

	/// Loads the conversation's newest page of items and its side threads, together.
	private func loadPages() async {
		async let page: Void = loadNewestPage()
		async let history: Void = loadHistory()
		_ = await (page, history)
	}

	private func loadNewestPage() async {
		do {
			let page = try await store.client.chats.messages(conversationId: conversationId, limit: Self.pageSize)
			guard !Task.isCancelled else { return }
			// Older pages loaded before stay; the newest is replaced.
			let newest = Set(page.items.map(\.id))
			let older = pageItems.filter { !newest.contains($0.id) && pagesLoaded > 1 }
			pageItems = older + page.items
			if pagesLoaded <= 1 { olderCursor = page.nextCursor }
			pagesLoaded = max(pagesLoaded, 1)
			newestPageFailed = false
		} catch {
			guard !error.isCancellation, !Task.isCancelled else { return }
			Self.log.error("Messages failed: \(String(describing: error))")
			newestPageFailed = true
		}
	}

	private func loadHistory() async {
		do {
			let page = try await store.client.chats.history(conversationId: conversationId)
			guard !Task.isCancelled else { return }
			entries = page.items
			historyFailed = false
		} catch {
			guard !error.isCancellation, !Task.isCancelled else { return }
			Self.log.error("Side threads failed: \(String(describing: error))")
			historyFailed = true
		}
	}

	/// Loads the page of items before those shown, and reports whether it did.
	/// Called while a page is loading, it waits for that page instead.
	@discardableResult
	func loadOlder() async -> Bool {
		if let loadingOlderPage { return await loadingOlderPage.value }
		guard let cursor = olderCursor else { return false }
		let task = Task { await loadOlderPage(from: cursor) }
		loadingOlderPage = task
		let loaded = await task.value
		loadingOlderPage = nil
		return loaded
	}

	private func loadOlderPage(from cursor: String) async -> Bool {
		do {
			let page = try await store.client.chats.messages(conversationId: conversationId, cursor: cursor, limit: Self.pageSize)
			pageItems = page.items + pageItems
			olderCursor = page.nextCursor
			pagesLoaded += 1
			olderPageFailed = false
			return true
		} catch {
			if !error.isCancellation {
				Self.log.error("Older messages failed: \(String(describing: error))")
				olderPageFailed = true
			}
			return false
		}
	}

	/// Loads older pages until the message with `messageId` is among `items`,
	/// with at most `maxPages` pages loaded in all, and reports whether it is.
	func loadUntilShown(messageId: String, maxPages: Int) async -> Bool {
		while !items.contains(where: { $0.message?.id == messageId }) {
			guard olderCursor != nil, pagesLoaded < maxPages, await loadOlder() else { return false }
		}
		return true
	}

	/// Refetches once events stop arriving for a moment: what an event could not say exactly.
	private func refetchSoon() {
		refetching?.cancel()
		refetching = Task {
			try? await Task.sleep(for: Self.refetchDelay)
			guard !Task.isCancelled else { return }
			await reload()
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
			showTyping(typing.person)
		default:
			refetchSoon()
		}
	}

	/// Shows `person` typing for `typingShownFor`, unless they say so again meanwhile.
	private func showTyping(_ person: PersonParticipant) {
		let signal = UUID()
		typing[person.id] = TypingPerson(person: person, signal: signal)
		Task { [weak self] in
			try? await Task.sleep(for: Self.typingShownFor)
			guard let self, self.typing[person.id]?.signal == signal else { return }
			self.typing[person.id] = nil
		}
	}

	private func upsert(_ message: Message) {
		sendingMessages.removeAll { $0.id == message.id }
		if let index = liveMessages.firstIndex(where: { $0.id == message.id }) {
			liveMessages[index] = message
		} else {
			liveMessages = (liveMessages + [message]).sorted { $0.createdAt < $1.createdAt }
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
		var message = liveMessages[index]
		let written = message.content.utf16.count
		guard delta.offset <= written else { return refetchSoon() }
		let fresh = String(decoding: Array(delta.text.utf16.dropFirst(written - delta.offset)), as: UTF16.self)
		guard !fresh.isEmpty else { return }
		message.content += fresh
		if case let .text(part)? = message.parts.last {
			message.parts[message.parts.count - 1] = .text(TextPart(text: part.text + fresh))
		} else {
			message.parts.append(.text(TextPart(text: fresh)))
		}
		liveMessages[index] = message
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

	/// Sends `draft` with the files attached to it, answering `replyTo`: in a
	/// pod's channel as a new thread with the bot `draft` names first, else as a
	/// message here. When sending fails the files go back into `attachments`.
	func submit(_ draft: String, replyTo: MessageReplyTo?, attachments: ComposerAttachments?) async -> SubmitOutcome {
		let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
		let bot = threadBot(for: draft)
		let deliver: ([FilePart]) async throws -> Void = { files in
			if let bot {
				try await self.startThread(text, with: bot, replyTo: replyTo, files: files)
			} else {
				try await self.send(text, replyTo: replyTo, files: files)
			}
		}
		do {
			if let attachments {
				try await attachments.send(through: deliver)
			} else {
				try await deliver([])
			}
			return .sent
		} catch {
			if bot != nil { return .failed("The thread was not started. Your message is still here.") }
			if let failure = error as? APIFailure, failure.status == Self.badRequestStatus {
				return .failed("Message not sent. \(failure.message).")
			}
			return .failed("Message not sent. Your draft is still here.")
		}
	}

	/// Sends `text` with `files`, answering `replyTo`, shown at once and confirmed when the server has it.
	private func send(_ text: String, replyTo: MessageReplyTo?, files: [FilePart]) async throws {
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
	func startThread(_ text: String, with bot: AgentParticipant?, replyTo: MessageReplyTo?, files: [FilePart]) async throws -> StartedThread {
		let started = try await store.client.chats.startThread(
			conversationId: conversationId,
			id: UUID().uuidString.lowercased(),
			message: text,
			attachments: files.isEmpty ? nil : files.map(\.id),
			hostAgentId: bot?.id,
			replyTo: replyTo?.id
		)
		await showStartedThread()
		return started
	}

	/// The thread started from `message` in this channel, started now if it has none.
	func thread(from message: Message) async throws -> ConversationThread {
		let started = try await store.client.chats.threadFrom(messageId: message.id)
		await showStartedThread()
		return started
	}

	/// Brings in a thread just started here: its line in the conversation's items and its place in the pod's list.
	private func showStartedThread() async {
		if source == .conversationPages { await reload() }
		await refreshPodChatList()
	}

	/// Marks the thread done, or with false, reopens it.
	func setDone(_ done: Bool) async throws {
		if done {
			try await store.client.chats.markDone(conversationId: conversationId)
		} else {
			try await store.client.chats.reopen(conversationId: conversationId)
		}
		await reload()
		await refreshPodChatList()
	}

	/// Refreshes the chat list of the pod the conversation is in, which lists its threads and whether each is done.
	private func refreshPodChatList() async {
		guard let podId = thread?.podId, let pod = store.pod(id: podId) else { return }
		await store.refreshChatList(pod)
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

	/// Tells others watching that the person is writing, at most once every
	/// `typingSignalInterval`. Others show it for a few seconds; a lost signal
	/// only shortens that, so a failure is not reported.
	func noteTyping() {
		guard Date.now.timeIntervalSince(lastTypingSignal) > Self.typingSignalInterval else { return }
		lastTypingSignal = .now
		Task { try? await store.client.events.typing(threadId: threadId) }
	}
}

/// Somebody shown typing, and which of their signals put them there.
private struct TypingPerson {
	let person: PersonParticipant
	let signal: UUID
}

private extension Error {
	/// Whether the error is a request given up because its task was cancelled, as leaving a page does: nothing to report.
	var isCancellation: Bool {
		self is CancellationError || (self as? URLError)?.code == .cancelled
	}
}

/// A conversation's model is one open conversation, the same however often a route names it.
extension ConversationModel: Hashable {
	nonisolated static func == (lhs: ConversationModel, rhs: ConversationModel) -> Bool { lhs === rhs }
	nonisolated func hash(into hasher: inout Hasher) { hasher.combine(ObjectIdentifier(self)) }
}
