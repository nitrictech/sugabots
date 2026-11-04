import SwiftUI

/// A conversation as the web's `ConversationChat` shows it on a phone: a
/// pod's channel, a bot's channel, a thread, or a routine's thread. Its
/// header floats over the messages, which start with an introduction and
/// follow the newest as they arrive, and the composer sits at the foot over
/// the tabs.
struct ConversationScreen: View {
	let threadId: String
	let title: String
	/// A message to open at, pointed out for a moment, as from the Inbox.
	var focusMessageId: String?
	@Environment(WorkspaceStore.self) private var store
	@State private var model: ConversationModel?

	var body: some View {
		ZStack {
			Palette.background.ignoresSafeArea()
			if let model {
				ConversationContent(model: model, fallbackTitle: title, focusMessageId: focusMessageId)
			} else {
				ProgressView()
			}
		}
		.task(id: threadId) {
			let model = ConversationModel(threadId: threadId, store: store)
			self.model = model
			await model.start()
		}
		.onDisappear { model?.stop() }
	}
}

/// What a conversation is, for its header, introduction and composer.
enum ConversationKind {
	/// A pod's channel, by its name.
	case podChat(name: String)
	case botChannel(Agent)
	case botThread(Agent)
	/// A thread between people.
	case peopleThread

	var agent: Agent? {
		switch self {
		case let .botChannel(agent), let .botThread(agent): agent
		default: nil
		}
	}
}

@MainActor
private struct ConversationContent: View {
	let model: ConversationModel
	let fallbackTitle: String
	let focusMessageId: String?
	@State private var focused = false
	@State private var focusNotFound = false
	@Environment(WorkspaceStore.self) private var store
	@State private var draft = ""
	@State private var replyingTo: MessageReplyTo?
	@State private var attachments: ComposerAttachments?
	@State private var sending = false
	@State private var sendError: String?
	@State private var lastTypingSignal = Date.distantPast
	@State private var opened: Route?
	@State private var sideThread: SideThread?
	@State private var showingComputer = false
	@State private var showingDetails = false
	@State private var highlighted: String?
	@State private var latestInView = true
	/// The pod's connections, by handle, for naming and marking a bot's steps.
	@State private var looks: [String: ConnectionLook] = [:]
	/// Whether the composer has the keyboard, as `Composer.focused` says.
	@State private var composing = false

	/// How often a person still typing says so again, as the web's composer does.
	private static let typingSignalInterval: TimeInterval = 3
	private static let foot = "foot"
	/// How long a message jumped to stays highlighted.
	private static let pointedOutFor: Duration = .seconds(2)
	/// The space over the first message, under the floating header.
	private static let headerRoom: CGFloat = 64

	var body: some View {
		let kind = kind
		let pod = model.thread.flatMap { store.pod(id: $0.podId) }
		ZStack(alignment: .top) {
			GeometryReader { viewport in
			ScrollViewReader { scroller in
				ScrollView {
					// Anchored to the foot, so a short conversation sits just over the composer.
					LazyVStack(alignment: .leading, spacing: 0) {
						log(kind: kind, pod: pod, scroller: scroller)
						Color.clear.frame(height: 16).id(Self.foot)
							.onAppear {
								latestInView = true
								markRead()
							}
							.onDisappear { latestInView = false }
					}
					.padding(.top, Self.headerRoom)
					.modifier(FootOfShortConversation(height: viewport.size.height))
				}
				.defaultScrollAnchor(.bottom)
				.scrollDismissesKeyboard(.interactively)
				.onChange(of: model.items.count) { _, _ in jumpToFocus(scroller) }
				.onChange(of: model.items.last?.id) { _, _ in
					guard latestInView else { return }
					withAnimation { scroller.scrollTo(Self.foot, anchor: .bottom) }
					markRead()
				}
			}
			}
			ConversationHeader(
				model: model,
				kind: kind,
				pod: pod,
				fallbackTitle: fallbackTitle,
				openDetails: { showingDetails = true },
				openComputer: { showingComputer = true },
				openRoutines: {
					if let pod, let agent = kind.agent { opened = .routines(pod, agent: agent) }
				}
			)
		}
		.safeAreaInset(edge: .bottom, spacing: 0) { foot(kind: kind, pod: pod) }
		.toolbar(.hidden, for: .navigationBar)
		.navigationDestination(item: $opened) { RouteDestination(route: $0) }
		.navigationDestination(isPresented: $showingDetails) {
			ConversationDetails(model: model, kind: kind)
				.toolbar(.hidden, for: .navigationBar)
		}
		.sheet(item: $sideThread) { side in
			SideThreadSheet(threadId: side.id, conversationId: model.conversationId, entry: model.entries.first { $0.threadId == side.id }, chatAgentId: kind.agent?.id) {
				openSideThread($0)
			}
		}
		.sheet(isPresented: $showingComputer) {
			if let agent = kind.agent { ComputerSheet(agent: agent, conversationId: model.conversationId) }
		}
		.onAppear {
			if attachments == nil { attachments = ComposerAttachments(conversationId: model.conversationId, client: store.client) }
			#if DEBUG
			// `SUGABOTS_DETAILS=1` opens Details over the first conversation at launch, for screenshots.
			if DebugLaunch.takeDetailsOpening() {
				Task {
					try? await Task.sleep(for: .seconds(1.5))
					showingDetails = true
				}
			}
			#endif
		}
		.onChange(of: draft) { _, text in
			signalTyping(text)
			Drafts.save(text, key: draftKey("draft"))
		}
		.onChange(of: replyingTo) { _, reply in
			Drafts.save(reply.flatMap { try? String(data: JSONEncoder().encode($0), encoding: .utf8) } ?? "", key: draftKey("draft-reply"))
		}
		.task(id: model.thread?.podId) {
			// What was being written here last, kept on the device as the web keeps it in the browser.
			guard model.thread != nil, draft.isEmpty else { return }
			draft = Drafts.load(draftKey("draft"))
			replyingTo = Drafts.load(draftKey("draft-reply")).data(using: .utf8).flatMap { try? JSONDecoder().decode(MessageReplyTo.self, from: $0) }
		}
		.task(id: model.thread?.podId) {
			guard let podId = model.thread?.podId else { return }
			looks = await store.connectionLooks(podId: podId)
		}
	}

	private var kind: ConversationKind {
		guard let thread = model.thread else { return .peopleThread }
		if thread.type == .podChat {
			// The pod's list has a rename as soon as it's made; the thread's own title waits for its details to reload.
			return .podChat(name: store.podChat(model.conversationId, in: thread.podId)?.title ?? thread.title)
		}
		if let agent = thread.hostAgentId.flatMap(store.agent(id:)) {
			return thread.type == .botChannel ? .botChannel(agent) : .botThread(agent)
		}
		return .peopleThread
	}

	private var host: AgentParticipant? {
		guard let agent = kind.agent else { return nil }
		return model.details?.participants.compactMap(\.agent).first { $0.id == agent.id } ?? AgentParticipant(agent)
	}

	// MARK: The log

	@ViewBuilder private func log(kind: ConversationKind, pod: Pod?, scroller: ScrollViewProxy) -> some View {
		if let details = model.details, let pod {
			let items = model.items
			let routineFeed = model.isRoutineFeed
			let byMessage = Self.threadsByMessage(items)
			let groups = ChatGroups.of(items, byRun: routineFeed, under: Set(byMessage.values.flatMap { $0 }.map(\.id)))
			let context = messageContext(details: details, pod: pod)
			let actions = messageActions(kind: kind, pod: pod, scroller: scroller)
			if model.messagesFailed {
				FormAlert(text: "Messages could not be loaded. Reload this page to try again.").padding(.horizontal, 20)
			}
			if model.olderCursor != nil {
				Button(model.loadingOlder ? "Loading…" : "Load older messages") { Task { await model.loadOlder() } }
					.font(Typeface.rubik(14, .medium))
					.foregroundStyle(Palette.foreground)
					.disabled(model.loadingOlder)
					.frame(maxWidth: .infinity)
					.padding(.vertical, 8)
			} else if model.pagesLoaded > 0 {
				Intro(details: details, kind: kind, pod: pod)
			}
			ForEach(groups) { group in
				if group.separated {
					LabelledDivider(text: routineFeed ? Self.runWords(group.at) : Times.day(group.at), strong: !routineFeed)
				}
				switch group.content {
				case let .messages(messages):
					ForEach(Array(messages.enumerated()), id: \.element.id) { index, message in
						let previous = index > 0 ? messages[index - 1] : nil
						if case .routineTrigger = message.author {
							RoutineTriggerCard(message: message)
						} else {
							MessageRow(
								message: message,
								startsGroup: ChatGroups.startsGroup(previous, message),
								context: context,
								actions: actions,
								highlighted: highlighted == message.id,
								threadLines: byMessage[message.id].map { threads in
									AnyView(ForEach(threads) { thread in
										ThreadLine(item: thread, startedBy: message.author) { openThread(thread) }
									})
								}
							)
							.id(message.id)
						}
					}
				case let .thread(thread):
					ThreadLine(item: thread, startedBy: nil) { openThread(thread) }
						.padding(.leading, 70)
						.padding(.trailing, 20)
						.padding(.vertical, 2)
				case let .paused(at):
					PausedLine(at: at)
				case let .run(run):
					if let routine = details.routine, let host {
						RunMessage(
							item: run,
							agent: host,
							pod: pod,
							routine: routine,
							latest: routine.failed && run.id == Self.latestRunId(items),
							mentionable: model.mentionable
						)
					} else {
						ActivityRow(run: run, entry: model.entries.first { $0.threadId == run.threadId }) { openSideThread(run.threadId) }
					}
				}
			}
			if let routine = details.routine {
				NextRunDivider(routine: routine)
			}
			if focusNotFound {
				Text("Could not find the message you opened in this chat.")
					.font(Typeface.rubik(14))
					.foregroundStyle(Palette.mutedForeground)
					.frame(maxWidth: .infinity)
					.padding(.vertical, 8)
			}
			ForEach(Array(model.notices.enumerated()), id: \.offset) { index, notice in
				Text(notice)
					.font(Typeface.rubik(12))
					.foregroundStyle(Palette.destructiveText)
					.frame(maxWidth: .infinity)
					.padding(.top, index == 0 ? 12 : 4)
			}
		} else if let error = model.loadError {
			EmptyState(title: "Could not load this conversation", text: error).frame(minHeight: 320)
		}
	}

	private func messageContext(details: ThreadDetails, pod: Pod) -> MessageContext {
		let fileNames = Dictionary(
			model.items.flatMap { $0.message?.files ?? [] }.map { ($0.id, $0.name) },
			uniquingKeysWith: { first, _ in first }
		)
		return MessageContext(
			podId: pod.id,
			mentionable: model.mentionable,
			canApprove: details.capabilities?.approveToolCalls ?? false,
			looks: looks,
			fileNames: fileNames,
			threadActivityAt: Dictionary(model.entries.map { ($0.threadId, $0.latestActivityAt) }, uniquingKeysWith: { first, _ in first }),
			queued: queuedBehindReply(),
			sending: model.sendingIds,
			inRoutineThread: model.isRoutineFeed,
			userId: store.user.id,
			conversationId: model.conversationId
		)
	}

	private func messageActions(kind: ConversationKind, pod: Pod, scroller: ScrollViewProxy) -> MessageActions {
		let channel: Bool = switch kind {
		case .podChat, .botChannel: true
		default: false
		}
		return MessageActions(
			reply: { message in
				replyingTo = MessageReplyTo(id: message.id, author: message.author, preview: Previews.quoted(message))
				composing = true
			},
			startThread: channel ? { message in startThread(from: message) } : nil,
			react: { message, emoji in Task { await model.toggleReaction(emoji, on: message) } },
			openThread: { openSideThread($0) },
			openArtifact: { artifactId in opened = .artifact(podId: pod.id, artifactId: artifactId, version: nil) },
			openDesktop: { showingComputer = true },
			jumpTo: { messageId in
				withAnimation { scroller.scrollTo(messageId, anchor: .center) }
				Task { await pointOut(messageId) }
			}
		)
	}

	/// The person's messages waiting behind a reply in progress.
	private func queuedBehindReply() -> Set<String> {
		guard let since = model.details?.queuedSince else { return [] }
		return Set(model.items.compactMap { item -> String? in
			guard let message = item.message, message.author.personId != nil, message.createdAt >= since else { return nil }
			return message.id
		})
	}

	// MARK: The foot

	@ViewBuilder private func foot(kind: ConversationKind, pod: Pod?) -> some View {
		if let details = model.details, let pod {
			VStack(alignment: .leading, spacing: 0) {
				if let agent = kind.agent, agent.model == nil {
					AgentNotSetUp(agent: agent, pod: pod)
				} else {
					Composer(
						label: composerLabel(kind: kind, pod: pod, details: details),
						text: $draft,
						mentionable: composerMentionable(kind: kind),
						replyingTo: replyingTo,
						cancelReply: { replyingTo = nil },
						attachments: attachments,
						sending: sending,
						error: sendError,
						submit: submit,
						focused: $composing
					)
				}
				let typers = typersAfter()
				Group {
					if !typers.isEmpty {
						TypingIndicator(names: typers).padding(.horizontal, 4)
					} else if let hint = hint(kind: kind) {
						Text(hint)
							.font(Typeface.rubik(12.5))
							.foregroundStyle(Palette.mutedForeground)
							.padding(.horizontal, 4)
							.padding(.vertical, 4)
					}
				}
				.frame(minHeight: 8, alignment: .leading)
			}
			.padding(.horizontal, barSideInset)
			.padding(.top, 4)
			.background(Palette.background)
		}
	}

	private func composerLabel(kind: ConversationKind, pod: Pod, details: ThreadDetails) -> String {
		let mentioned = Mentions.mentioned(in: draft, among: model.mentionable)
		if botStaysOut(mentioned: mentioned), !mentioned.isEmpty {
			return "Message \(Names.list(mentioned.map(\.name)))"
		}
		if details.routine != nil, let agent = kind.agent { return "Message \(agent.name) about this routine" }
		if let agent = kind.agent { return "Message \(agent.name)" }
		if case let .podChat(name) = kind { return "Message \(name)" }
		return "Message \(pod.name)"
	}

	private func composerMentionable(kind: ConversationKind) -> [ThreadParticipant] {
		let isPodChat: Bool = if case .podChat = kind { true } else { false }
		return model.mentionable.filter { member in
			member.id != store.user.id && (member.agent == nil || isPodChat || member.id == host?.id)
		}
	}

	/// The bot a pod channel's draft mentions first, whom sending starts a thread with.
	private var threadWith: AgentParticipant? {
		guard model.isPodChat, let crew = model.details?.crew else { return nil }
		return Mentions.firstBot(in: draft, among: crew)
	}

	/// Whether a bot's thread's draft leaves the bot out: it mentions somebody, and only people.
	private func botStaysOut(mentioned: [ThreadParticipant]) -> Bool {
		host != nil && !Mentions.handles(in: draft).isEmpty && !mentioned.contains { $0.agent != nil }
	}

	private func hint(kind: ConversationKind) -> String? {
		if case .podChat = kind {
			return threadWith.map { "Sending starts a thread with \($0.name)." } ?? "Mention a bot to start a thread."
		}
		if let host, botStaysOut(mentioned: Mentions.mentioned(in: draft, among: model.mentionable)) {
			return "\(host.name) won't reply."
		}
		return nil
	}

	private func typersAfter() -> [String] {
		let last = model.items.last?.message
		if let last, last.author.agentParticipant != nil, Self.isTyping(last) {
			return [last.author.name] + model.peopleTyping.map(\.name)
		}
		return model.peopleTyping.map(\.name)
	}

	// MARK: Doing things

	private func submit() {
		guard !sending else { return }
		sendError = nil
		let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
		let answering = replyingTo
		let bot = threadWith
		let files = attachments?.takeForSending() ?? []
		let submitted = draft
		draft = ""
		replyingTo = nil
		sending = true
		Task {
			do {
				if let bot {
					try await model.startThread(text, with: bot, replyTo: answering, files: files)
				} else {
					try await model.send(text, replyTo: answering, files: files)
				}
			} catch {
				if draft.isEmpty { draft = submitted }
				if replyingTo == nil { replyingTo = answering }
				if bot != nil {
					sendError = "The thread was not started. Your message is still here."
				} else if let failure = error as? APIFailure, failure.status == 400 {
					sendError = "Message not sent. \(failure.message)."
				} else {
					sendError = "Message not sent. Your draft is still here."
				}
			}
			sending = false
		}
	}

	private func startThread(from message: Message) {
		if let run = message.routineResultOf {
			openSideThread(run.threadId)
			return
		}
		Task {
			do {
				let thread = try await model.thread(from: message)
				opened = .conversation(threadId: thread.id, title: thread.title)
			} catch {
				sendError = "The thread was not started. Try again."
			}
		}
	}

	/// Jumps to the message the page opened at, loading older pages to find it, up to ten.
	private func jumpToFocus(_ scroller: ScrollViewProxy) {
		guard let focusMessageId, !focused, model.pagesLoaded > 0 else { return }
		let shown = model.items.contains { $0.message?.id == focusMessageId }
		guard shown else {
			if model.olderCursor != nil, model.pagesLoaded < 10, !model.loadingOlder {
				Task { await model.loadOlder() }
			} else if model.olderCursor == nil || model.pagesLoaded >= 10 {
				focused = true
				focusNotFound = true
			}
			return
		}
		focused = true
		Task {
			try? await Task.sleep(for: .milliseconds(100))
			scroller.scrollTo(focusMessageId, anchor: .center)
			await pointOut(focusMessageId)
		}
	}

	/// Highlights a message jumped to for a moment, unless another is jumped to meanwhile.
	private func pointOut(_ messageId: String) async {
		highlighted = messageId
		try? await Task.sleep(for: Self.pointedOutFor)
		if highlighted == messageId { highlighted = nil }
	}

	private func openThread(_ thread: ChatMessageItem.Thread) {
		opened = .conversation(threadId: thread.threadId, title: thread.title)
	}

	/// A collaboration or a run, which opens in a sheet over the conversation.
	private func openSideThread(_ threadId: String) {
		sideThread = SideThread(id: threadId)
	}

	private func signalTyping(_ text: String) {
		guard !text.isEmpty, Date.now.timeIntervalSince(lastTypingSignal) > Self.typingSignalInterval else { return }
		lastTypingSignal = .now
		Task { await model.signalTyping() }
	}

	private func markRead() {
		Task { await model.markRead() }
	}

	// MARK: Helpers

	/// Where a draft is kept, as the web's `useChatDraft` keys it.
	private func draftKey(_ kind: String) -> String {
		"sugabots-\(kind):\(store.user.id):\(model.thread?.podId ?? ""):\(model.conversationId)"
	}

	static func isTyping(_ message: Message) -> Bool {
		if case .collaboration? = message.parts.last { return false }
		let awaiting = message.parts.contains { if case let .toolCall(call) = $0 { call.awaitsApproval } else { false } }
		return message.status == .streaming && !awaiting
	}

	/// The threads started from each message, by the message's id.
	static func threadsByMessage(_ items: [ChatMessageItem]) -> [String: [ChatMessageItem.Thread]] {
		let messageIds = Set(items.compactMap(\.message?.id))
		var byMessage: [String: [ChatMessageItem.Thread]] = [:]
		for case let .thread(thread) in items {
			guard let origin = thread.originMessageId, messageIds.contains(origin) else { continue }
			byMessage[origin, default: []].append(thread)
		}
		return byMessage
	}

	static func latestRunId(_ items: [ChatMessageItem]) -> String? {
		for item in items.reversed() {
			if case let .routine(run) = item { return run.id }
		}
		return nil
	}

	/// `Run today`, `Run yesterday`, `Run on Mar 3`.
	static func runWords(_ at: Date) -> String {
		switch Times.daysAgo(at) {
		case 0: return "Run today"
		case 1: return "Run yesterday"
		default: return "Run on \(Times.day(at))"
		}
	}
}

/// A side thread open over a conversation, by its thread's id.
private struct SideThread: Identifiable {
	let id: String
}

extension MessageAuthor {
	var agentParticipant: AgentParticipant? {
		if case let .agent(agent) = self { agent } else { nil }
	}
}

extension AgentParticipant {
	init(_ agent: Agent) {
		self.init(id: agent.id, name: agent.name, handle: agent.handle, color: agent.color, face: agent.face, shape: agent.shape)
	}
}

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

	static func startsNewDay(_ previous: Date?, _ at: Date) -> Bool {
		guard let previous else { return true }
		return !Calendar.current.isDate(previous, inSameDayAs: at)
	}

	private static func startsRun(_ item: ChatMessageItem) -> Bool {
		switch item {
		case .routine: true
		case let .message(item): item.message.routineResultOf != nil
		default: false
		}
	}

	/// Whether `message` starts a group under its author's face and name.
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

/// A thread started from a message, under it: the faces in it, how many replies, its title and whether its bot is working.
private struct ThreadLine: View {
	let item: ChatMessageItem.Thread
	let startedBy: MessageAuthor?
	let open: () -> Void

	var body: some View {
		var faces: [ThreadParticipant] = []
		if let starter = startedBy?.participant, starter.id != item.agent?.id { faces.append(starter) }
		if let agent = item.agent { faces.append(.agent(agent)) }
		let replied = item.replies > 0
		return SideThreadLine(
			faces: faces,
			label: replied ? Names.count(item.replies, "reply", "replies") : item.title,
			detail: replied ? item.title : nil,
			description: "Open thread: \(item.title)",
			lastActivityAt: item.lastReplyAt,
			status: item.working ? .working : nil,
			open: open
		)
	}
}

/// A routine pausing itself, in its thread.
private struct PausedLine: View {
	let at: Date

	var body: some View {
		HStack(spacing: 8) {
			Icon(.pause, size: 14, strokeWidth: 2)
			Text("Paused after two failed runs in a row.").font(Typeface.rubik(13.5, .medium))
			Text(Times.list(at)).font(Typeface.rubik(12)).foregroundStyle(Palette.subtleForeground)
		}
		.foregroundStyle(Palette.mutedForeground)
		.padding(.leading, 70)
		.padding(.trailing, 20)
		.padding(.vertical, 8)
	}
}

/// A routine's run in the channel it posts to: its trigger's mark, what it did, and the time, or dots while it runs.
private struct ActivityRow: View {
	let run: ChatMessageItem.Routine
	let entry: ChatHistoryEntry?
	let open: () -> Void

	var body: some View {
		let state = ActivityState(entry)
		Button(action: open) {
			HStack(spacing: 14) {
				Group {
					if state == .failed {
						Text("!")
							.font(Typeface.rubik(10, .bold))
							.foregroundStyle(.white)
							.frame(width: 15, height: 15)
							.background(Palette.destructive, in: Circle())
					} else {
						Icon(TriggerIcons.of(run.triggerKind), size: 15, strokeWidth: 2.2)
					}
				}
				.foregroundStyle(Palette.mutedForeground)
				.frame(width: 36)
				Text(state.routineText(run.routineName))
					.font(Typeface.rubik(13.5, .medium))
					.foregroundStyle(Palette.mutedForeground)
					.lineLimit(1)
				if state == .running {
					TypingDots(small: true).foregroundStyle(Palette.mutedForeground)
				} else {
					Text(Times.clock(run.createdAt)).font(Typeface.rubik(12)).foregroundStyle(Palette.subtleForeground)
				}
				Spacer(minLength: 0)
			}
			.padding(.horizontal, 20)
			.padding(.vertical, 6)
			.contentShape(Rectangle())
		}
		.buttonStyle(.plain)
		.accessibilityLabel("Open Routine run: \(state.routineText(run.routineName))")
	}
}

/// How a side thread stands, as `activityStateOf` reads its history entry.
enum ActivityState {
	case running, waitingOnYou, done, failed

	init(_ entry: ChatHistoryEntry?) {
		switch entry?.status {
		case .failed, .cancelled: self = .failed
		case .completed: self = .done
		default: self = .running
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

/// A bot with no model yet, in place of the composer: it can't answer, and who can fix it.
private struct AgentNotSetUp: View {
	let agent: Agent
	let pod: Pod
	@Environment(\.openUnderYou) private var openUnderYou

	var body: some View {
		Group {
			if pod.permissions.updateAgents {
				Button { openUnderYou(.settings(.agent(pod, agent))) } label: {
					(Text("\(agent.name) has no model yet, so it cannot answer. ")
						+ Text("Choose a model").foregroundStyle(Palette.foreground).fontWeight(.medium)
						+ Text(" to start chatting."))
						.multilineTextAlignment(.leading)
				}
				.buttonStyle(.plain)
			} else {
				Text("\(agent.name) has no model yet, so it cannot answer. Somebody who can edit this agent chooses its model.")
			}
		}
		.font(Typeface.rubik(15))
		.lineSpacing(4)
		.foregroundStyle(Palette.mutedForeground)
		.padding(.horizontal, 16)
		.padding(.vertical, 14)
		.frame(maxWidth: .infinity, alignment: .leading)
		.overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(Palette.borderStrong))
	}
}

/// Drafts kept on the device, by conversation, as the web keeps them in the browser.
enum Drafts {
	static func load(_ key: String) -> String {
		UserDefaults.standard.string(forKey: key) ?? ""
	}

	/// Keeps `value`, or forgets the draft when it's blank.
	static func save(_ value: String, key: String) {
		if value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
			UserDefaults.standard.removeObject(forKey: key)
		} else {
			UserDefaults.standard.set(value, forKey: key)
		}
	}
}

/// Keeps a short conversation at the foot of its scroll view, just over the
/// composer. iOS 18 does this itself with the scroll view's bottom anchor. Before
/// it, the list is given at least the scroll view's height, aligned to its foot.
/// Not from iOS 18 on: there that frame leaves a long conversation blank when it
/// arrives all at once, until something lays the list out again.
private struct FootOfShortConversation: ViewModifier {
	let height: CGFloat

	func body(content: Content) -> some View {
		if #available(iOS 18, *) {
			content
		} else {
			content.frame(minHeight: height, alignment: .bottom)
		}
	}
}
