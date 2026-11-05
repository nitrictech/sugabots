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
			// The model outlives a page pushed over the conversation, such as its
			// Details, which listens to the same model while it shows.
			if model?.threadId != threadId { model = ConversationModel(threadId: threadId, store: store) }
			await model?.listen()
		}
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
	/// Whether the page has jumped to `focusMessageId`, or given up looking for it.
	@State private var jumpedToFocus = false
	@State private var focusNotFound = false
	@Environment(WorkspaceStore.self) private var store
	@State private var draft = ""
	@State private var replyingTo: MessageReplyTo?
	@State private var attachments: ComposerAttachments?
	@State private var sending = false
	@State private var sendError: String?
	@Environment(\.openPage) private var openPage
	@State private var sideThread: SideThread?
	@State private var showingComputer = false
	@State private var highlighted: String?
	/// The message whose actions are up without a touch, as a screenshot at launch asks.
	@State private var heldMessageId: String?
	@State private var latestInView = true
	/// The pod's connections, by handle, for naming and marking a bot's steps.
	@State private var looks: [String: ConnectionLook] = [:]
	/// Whether the composer has the keyboard, as `Composer.focused` says.
	@State private var composing = false

	private static let foot = "foot"

	/// The space between the composer and the keyboard, over the hint row's own.
	private static let keyboardGap = NativeConstants.keyboardGap
	/// How long a message jumped to stays highlighted.
	private static let pointedOutFor: Duration = .seconds(2)
	/// The space over the first message, under the floating header.
	private static let headerRoom: CGFloat = 64
	/// How many pages are loaded, at most, looking for the message the page opened at.
	private static let focusSearchPages = 10
	/// How long a jump waits for the pages just loaded to be laid out before scrolling to its message.
	private static let jumpAfterLayout: Duration = .milliseconds(100)

	private func openDetails() {
		openPage(.details(model))
	}

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
				.task(id: model.isLoaded) { await jumpToFocus(scroller) }
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
				openDetails: openDetails,
				openComputer: { showingComputer = true },
				openRoutines: {
					if let pod, let agent = kind.agent { openPage(.routines(pod, agent: agent)) }
				},
				openThreads: {
					if let pod, let agent = kind.agent { openPage(.threads(pod, agent: agent)) }
				}
			)
		}
		.safeAreaInset(edge: .bottom, spacing: 0) { foot(kind: kind, pod: pod) }
		.toolbar(.hidden, for: .navigationBar)
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
		}
		#if DEBUG
		.task { await poseForScreenshot() }
		#endif
		.onChange(of: draft) { _, text in drafts?.save(text: text) }
		.onChange(of: replyingTo) { _, reply in drafts?.save(reply: reply) }
		.task(id: model.thread?.podId) {
			// What was being written here last, kept on the device as the web keeps it in the browser.
			guard let drafts, draft.isEmpty else { return }
			draft = drafts.text()
			replyingTo = drafts.reply()
		}
		.task(id: model.thread?.podId) {
			guard let podId = model.thread?.podId else { return }
			looks = await store.connectionLooks(podId: podId)
		}
	}

	private var kind: ConversationKind { store.kind(of: model) }

	/// Where this conversation's drafts are kept, once its thread has loaded.
	private var drafts: Drafts? {
		guard let podId = model.thread?.podId else { return nil }
		return Drafts(userId: store.user.id, podId: podId, conversationId: model.conversationId)
	}

	private var host: AgentParticipant? {
		guard let agent = kind.agent else { return nil }
		return model.details?.participants.compactMap(\.agent).first { $0.id == agent.id } ?? AgentParticipant(agent)
	}

	// MARK: The log

	@ViewBuilder private func log(kind: ConversationKind, pod: Pod?, scroller: ScrollViewProxy) -> some View {
		if let details = model.details, let pod, let context = model.messageContext(looks: looks, filesConversationId: model.conversationId) {
			let items = model.items
			let routineFeed = model.isRoutineFeed
			let byMessage = Self.threadsByMessage(items)
			let groups = ChatGroups.of(items, byRun: routineFeed, under: Set(byMessage.values.flatMap { $0 }.map(\.id)))
			// Found across all the messages, not in each group they're shown in, or each group would bring a face of its own alive.
			let answering = ChatGroups.answeringFace(in: items.compactMap(\.message), dividers: false)
			let viewerWriting = !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
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
								heldOpen: heldMessageId == message.id,
								startedThreads: byMessage[message.id] ?? [],
								liveFace: answering?.messageId == message.id ? LiveFace(botTyping: answering?.botTyping ?? false, viewerWriting: viewerWriting) : nil
							)
							.id(message.id)
						}
					}
				case let .thread(thread):
					ThreadLine(item: thread, startedBy: nil) { openThread(thread) }
						.padding(.leading, MessageRow.wordsInset)
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
			openStartedThread: { openThread($0) },
			openArtifact: { artifact in openPage(.artifact(podId: pod.id, artifactId: artifact.artifactId, version: artifact.version)) },
			openDesktop: { showingComputer = true },
			jumpTo: { messageId in
				withAnimation { scroller.scrollTo(messageId, anchor: .center) }
				Task { await pointOut(messageId) }
			}
		)
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
						edited: {
							if !draft.isEmpty { model.noteTyping() }
						},
						focused: $composing
					)
				}
				let typers = typingNames()
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
			// Clear of the keyboard while typing, as the tab bar keeps it clear of the foot otherwise,
			// on frost that runs into the keyboard's glass rather than a band of the page's colour over it.
			.padding(.bottom, composing ? Self.keyboardGap : 0)
			.background {
				if composing {
					Rectangle().fill(.regularMaterial).ignoresSafeArea(edges: .bottom)
				} else {
					Palette.background
				}
			}
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

	/// The people here and this chat's own bot, not yourself, then `@here` and `@channel` where they notify somebody;
	/// the pod's other bots are offered only in the pod's chat, where naming one starts a thread with it.
	private func composerMentionable(kind: ConversationKind) -> [MentionTarget] {
		let isPodChat: Bool = if case .podChat = kind { true } else { false }
		let offered = model.mentionable.filter { member in
			member.id != store.user.id && (member.agent == nil || isPodChat || member.id == host?.id)
		}
		let groups = Mentions.groupMentions(
			writtenBy: store.user.id,
			members: model.details?.members ?? [],
			threadType: model.details?.thread.type
		)
		return offered.map(MentionTarget.participant) + groups.map(\.target)
	}

	/// Whether a bot's thread's draft leaves the bot out: it mentions somebody, and only people.
	private func botStaysOut(mentioned: [ThreadParticipant]) -> Bool {
		host != nil && !Mentions.handles(in: draft).isEmpty && !mentioned.contains { $0.agent != nil }
	}

	private func hint(kind: ConversationKind) -> String? {
		if case .podChat = kind {
			return model.threadBot(for: draft).map { "Sending starts a thread with \($0.name)." } ?? "Mention a bot to start a thread."
		}
		if let host, botStaysOut(mentioned: Mentions.mentioned(in: draft, among: model.mentionable)) {
			return "\(host.name) won't reply."
		}
		return nil
	}

	/// Who is typing, by name: a bot whose newest message is still coming, then people.
	private func typingNames() -> [String] {
		let people = model.peopleTyping.map(\.name)
		guard let last = model.items.last?.message, last.author.agentParticipant != nil, ChatGroups.isTyping(last) else { return people }
		return [last.author.name] + people
	}

	// MARK: Doing things

	private func submit() {
		guard !sending else { return }
		sendError = nil
		let submitted = draft
		let answering = replyingTo
		draft = ""
		replyingTo = nil
		sending = true
		Task {
			if case let .failed(reason) = await model.submit(submitted, replyTo: answering, attachments: attachments) {
				// What was sent goes back, unless the person has started writing something else meanwhile.
				if draft.isEmpty { draft = submitted }
				if replyingTo == nil { replyingTo = answering }
				sendError = reason
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
				openPage(.conversation(threadId: thread.id, title: thread.title))
			} catch {
				sendError = "The thread was not started. Try again."
			}
		}
	}

	/// Jumps to the message the page opened at, once the conversation has
	/// loaded, loading older pages to find it, up to `focusSearchPages`.
	private func jumpToFocus(_ scroller: ScrollViewProxy) async {
		guard let focusMessageId, !jumpedToFocus, model.isLoaded else { return }
		jumpedToFocus = true
		guard await model.loadUntilShown(messageId: focusMessageId, maxPages: Self.focusSearchPages) else {
			focusNotFound = true
			return
		}
		try? await Task.sleep(for: Self.jumpAfterLayout)
		scroller.scrollTo(focusMessageId, anchor: .center)
		await pointOut(focusMessageId)
	}

	/// Highlights a message jumped to for a moment, unless another is jumped to meanwhile.
	private func pointOut(_ messageId: String) async {
		highlighted = messageId
		try? await Task.sleep(for: Self.pointedOutFor)
		if highlighted == messageId { highlighted = nil }
	}

	private func openThread(_ thread: ChatMessageItem.Thread) {
		openPage(.conversation(threadId: thread.threadId, title: thread.title))
	}

	/// A collaboration or a run, which opens in a sheet over the conversation.
	private func openSideThread(_ threadId: String) {
		sideThread = SideThread(id: threadId)
	}

	private func markRead() {
		Task { await model.markRead() }
	}

	#if DEBUG
	/// Poses the conversation for a screenshot, once it has settled, as the
	/// launch environment asks (see `DebugLaunch.once`): the composer with the
	/// keyboard, Details open over it, or its newest finished message held.
	private func poseForScreenshot() async {
		let typing = DebugLaunch.once("SUGABOTS_TYPING")
		let openingDetails = DebugLaunch.once("SUGABOTS_DETAILS")
		let holding = DebugLaunch.once("SUGABOTS_HOLD")
		guard typing || openingDetails || holding else { return }
		try? await Task.sleep(for: .seconds(1.5))
		if typing { composing = true }
		if openingDetails { openDetails() }
		if holding { heldMessageId = model.items.last { $0.message?.status == .complete }?.message?.id }
	}
	#endif

	// MARK: Helpers

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
		.padding(.leading, MessageRow.wordsInset)
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
		let state = ActivityState(historyEntry: entry)
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

/// A bot with no model yet, in place of the composer: it can't answer, and who can fix it.
private struct AgentNotSetUp: View {
	let agent: Agent
	let pod: Pod
	@Environment(\.openPage) private var openPage

	var body: some View {
		Group {
			if pod.permissions.updateAgents {
				Button { openPage(.settings(.agent(pod, agent))) } label: {
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

/// What the person was writing in one conversation, kept on the device as
/// the web's `useChatDraft` keeps it in the browser: the text, and the message
/// it replies to.
struct Drafts {
	let userId: String
	let podId: String
	let conversationId: String

	/// What is kept, each under a key of its own, as the web names them.
	private enum Slot: String {
		case text = "draft"
		case reply = "draft-reply"
	}

	private func key(_ slot: Slot) -> String {
		"sugabots-\(slot.rawValue):\(userId):\(podId):\(conversationId)"
	}

	func text() -> String {
		UserDefaults.standard.string(forKey: key(.text)) ?? ""
	}

	/// Keeps `text`, or forgets it when it's blank.
	func save(text: String) {
		let blank = text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
		store(blank ? nil : text, in: .text)
	}

	func reply() -> MessageReplyTo? {
		guard let json = UserDefaults.standard.string(forKey: key(.reply)), let data = json.data(using: .utf8) else { return nil }
		return try? JSONDecoder().decode(MessageReplyTo.self, from: data)
	}

	/// Keeps `reply`, or forgets it when there's none.
	func save(reply: MessageReplyTo?) {
		let json = reply.flatMap { try? JSONEncoder().encode($0) }.flatMap { String(data: $0, encoding: .utf8) }
		store(json, in: .reply)
	}

	private func store(_ value: String?, in slot: Slot) {
		if let value {
			UserDefaults.standard.set(value, forKey: key(slot))
		} else {
			UserDefaults.standard.removeObject(forKey: key(slot))
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
