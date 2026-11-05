import SwiftUI

/// A pod's conversations, as the web's `ConversationList` lays them out on a
/// phone: a shared pod's channels, each with the threads between people
/// started from it, then each of its bots, which opens its channel, with its
/// routines and threads under it.
@MainActor
struct ConversationList: View {
	let pod: Pod
	@Environment(WorkspaceStore.self) private var store
	@State private var namingChannel = false
	@State private var makingBot = false
	/// The channel held for renaming, or for archiving once confirmed.
	@State private var channelChange: ChannelChange?
	@Environment(\.openPage) private var openPage

	var body: some View {
		let list = store.chatLists[pod.id]
		let bots = store.bots(in: pod)
		// Done threads are kept for the counts of what is open; the tree under each leaves them out.
		let threads = list?.threads ?? []
		let chats = list?.chats ?? []
		let byChat = Self.threadsByChat(chats, threads)
		let groups = Self.groupByBot(
			bots: bots,
			threads: threads.filter { !Self.hangsUnderChat($0, byChat) },
			channels: list?.channels ?? []
		)
		VStack(alignment: .leading, spacing: 1) {
			if pod.kind == .shared {
				let chatsOpen = isOpen("chats")
				SectionHeading(
					label: "Channels",
					open: chatsOpen,
					news: .of(chats.map { ($0.unreadMessages, false) } + byChat.values.flatMap(Self.open).map { ($0.unreadMessages, $0.needsYou) }),
					toggle: { toggle("chats") },
					actionLabel: "New channel in \(pod.name)",
					action: { namingChannel = true }
				)
				if chatsOpen {
					VStack(spacing: 1) {
						// The first channel is listed before anyone opens it, which opens it.
						if !chats.contains(where: \.conversation.main) {
							channelRow(name: "General", unread: 0, route: .podChat(pod))
						}
						ForEach(chats) { chat in
							channelRow(
								name: chat.conversation.title,
								unread: chat.unreadMessages,
								route: .conversation(threadId: chat.conversation.id, title: chat.conversation.title)
							)
							.contextMenu { channelMenu(chat.conversation) }
							if let under = byChat[chat.conversation.id] {
								ThreadTree(pod: pod, threads: under)
							}
						}
					}
					.padding(.leading, Self.nestedIndent)
				}
			}

			let botsOpen = isOpen("bots")
			SectionHeading(
				label: "Bots",
				open: botsOpen,
				news: .of(groups.flatMap { group in
					Self.open(group.threads).map { ($0.unreadMessages, $0.needsYou) }
						+ (group.channel.map { [($0.unreadMessages, $0.needsYou)] } ?? [])
				}),
				toggle: { toggle("bots") },
				actionLabel: pod.permissions.createAgents ? "New bot in \(pod.name)" : nil,
				action: { makingBot = true }
			)
			if botsOpen {
				VStack(spacing: 1) {
					if list != nil, groups.isEmpty {
						NoBots(onNewBot: pod.permissions.createAgents ? { makingBot = true } : nil)
					}
					ForEach(groups) { group in
						BotItem(
							pod: pod,
							group: group,
							routines: (list?.routines ?? []).filter { $0.agent.id == group.agent?.id }
						)
					}
				}
				.padding(.leading, Self.nestedIndent)
			}
		}
		.sheet(isPresented: $namingChannel) {
			NameSheet.channel(title: "New channel", action: "Create") { name in
				let chat = try await store.startChat(in: pod, named: name)
				namingChannel = false
				openPage(.conversation(threadId: chat.id, title: chat.title))
			}
		}
		.channelChange($channelChange, in: pod)
		.fullScreenCover(isPresented: $makingBot) {
			NewBotScreen(pod: pod) { made in
				makingBot = false
				openPage(.botChannel(pod, made))
			}
		}
	}

	/// How far the rows sit in from their section's name, on a phone's width.
	static let nestedIndent: CGFloat = 12

	/// What holding a channel offers, as its Details does: Rename, and Archive for any but the first.
	@ViewBuilder private func channelMenu(_ channel: PodChat) -> some View {
		if ChannelChange.mayRename(in: pod) {
			Button { channelChange = .rename(channel) } label: { Label("Rename", systemImage: "pencil") }
		}
		if ChannelChange.mayArchive(channel, in: pod) {
			Button(role: .destructive) { channelChange = .archive(channel) } label: { Label("Archive", systemImage: "archivebox") }
		}
	}

	private func channelRow(name: String, unread: Int, route: Route) -> some View {
		NavigationLink(value: route) {
			HStack(spacing: 12) {
				Icon(.hash, size: 16, strokeWidth: 1.75).padding(.horizontal, 1)
				Text(name)
					.font(Typeface.rubik(16, unread > 0 ? .semibold : .regular))
					.foregroundStyle(unread > 0 ? Palette.foreground : Palette.mutedForeground)
					.lineLimit(1)
				Spacer(minLength: 0)
				UnreadMarker(unreadMessages: unread, needsYou: false).frame(width: 22)
			}
			.foregroundStyle(Palette.mutedForeground)
			.padding(.leading, 8)
			.padding(.trailing, 6)
			.frame(height: 44)
			.contentShape(Rectangle())
		}
		.buttonStyle(.sidebarRow)
	}

	private func isOpen(_ section: String) -> Bool {
		!store.preferences.isFolded(section, in: pod.id)
	}

	private func toggle(_ section: String) {
		store.preferences.toggleFolded(section, in: pod.id)
	}

	/// The threads in `rows` not yet marked done.
	static func open(_ rows: [ChatListItem]) -> [ChatListItem] {
		rows.filter { $0.conversation.doneAt == nil }
	}

	/// The threads between people started from each of `chats`, newest first, by the chat's id; only chats with one.
	private static func threadsByChat(_ chats: [ChatList.Chat], _ threads: [ChatListItem]) -> [String: [ChatListItem]] {
		let chatIds = Set(chats.map(\.conversation.id))
		var byChat: [String: [ChatListItem]] = [:]
		for row in threads where row.agent == nil {
			guard let chat = row.conversation.startedInChatId, chatIds.contains(chat) else { continue }
			byChat[chat, default: []].append(row)
		}
		return byChat
	}

	private static func hangsUnderChat(_ row: ChatListItem, _ byChat: [String: [ChatListItem]]) -> Bool {
		guard row.agent == nil, let chat = row.conversation.startedInChatId else { return false }
		return byChat[chat] != nil
	}

	/// A group for each of the pod's bots, and any other bot with a thread
	/// here, by name, then the threads between people.
	private static func groupByBot(bots: [Agent], threads: [ChatListItem], channels: [ChatList.Channel]) -> [BotGroup] {
		var groups: [String: BotGroup] = [:]
		func key(_ agent: Agent?) -> String { agent?.id ?? BotGroup.peopleKey }
		for bot in bots { groups[bot.id] = BotGroup(agent: bot) }
		for channel in channels { groups[channel.agent.id, default: BotGroup(agent: channel.agent)].channel = channel }
		for row in threads { groups[key(row.agent), default: BotGroup(agent: row.agent)].threads.append(row) }
		return groups.values.sorted { a, b in
			guard let first = a.agent else { return false }
			guard let second = b.agent else { return true }
			return first.name.localizedCompare(second.name) == .orderedAscending
		}
	}
}

/// A bot with its channel, once somebody opened it, and its threads, done ones
/// included, newest first; or the threads between people, when `agent` is nil.
struct BotGroup: Identifiable {
	static let peopleKey = "people"

	let agent: Agent?
	var channel: ChatList.Channel?
	var threads: [ChatListItem] = []

	var id: String { agent?.id ?? Self.peopleKey }
}

/// What is new across some rows, as a folded section says it.
private struct News {
	let unreadMessages: Int
	let needsYou: Bool

	var any: Bool { unreadMessages > 0 || needsYou }

	static func of(_ rows: [(unread: Int, needsYou: Bool)]) -> News {
		News(unreadMessages: rows.reduce(0) { $0 + $1.unread }, needsYou: rows.contains { $0.needsYou })
	}
}

/// A section's name in small grey type, which folds it away or opens it,
/// with its one action at the end. Folded, it says what is new in it.
private struct SectionHeading: View {
	let label: String
	let open: Bool
	let news: News
	let toggle: () -> Void
	/// Absent when the person may not take the action.
	let actionLabel: String?
	let action: () -> Void

	var body: some View {
		let lit = !open && news.any
		HStack(spacing: 0) {
			Button(action: toggle) {
				HStack(spacing: 10) {
					Icon(.chevronRight, size: 14, strokeWidth: 2.25)
						.rotationEffect(.degrees(open ? 90 : 0))
						.frame(width: 18, height: 18)
					Text(label).font(Typeface.rubik(14, lit ? .semibold : .medium))
					Spacer(minLength: 0)
				}
				.foregroundStyle(lit ? Palette.foreground : Palette.subtleForeground)
				.padding(.leading, 8)
				.frame(maxHeight: .infinity)
				.contentShape(Rectangle())
			}
			.buttonStyle(.plain)
			.accessibilityAddTraits(.isHeader)
			.accessibilityValue(open ? "Expanded" : "Collapsed")
			if !open {
				UnreadMarker(unreadMessages: news.unreadMessages, needsYou: news.needsYou).frame(width: 22)
			}
			if let actionLabel {
				SmallIconButton(icon: .plus, label: actionLabel, action: action).frame(width: 22)
			}
		}
		.padding(.trailing, 6)
		.frame(height: 36)
		.padding(.top, 8)
		.animation(.easeOut(duration: 0.15), value: open)
	}
}

/// The Bots section while the pod has none: a row that adds the first, its
/// face a dashed circle, or a line saying there are none.
private struct NoBots: View {
	let onNewBot: (() -> Void)?

	var body: some View {
		let row = HStack(spacing: 12) {
			Circle()
				.strokeBorder(Palette.borderStrong, style: StrokeStyle(lineWidth: 1, dash: [2, 2]))
				.frame(width: 18, height: 18)
				.overlay { if onNewBot != nil { Icon(.plus, size: 10, strokeWidth: 2.4) } }
			Text(onNewBot == nil ? "No bots yet" : "Add a bot").font(Typeface.rubik(16))
			Spacer(minLength: 0)
		}
		.foregroundStyle(Palette.mutedForeground)
		.padding(.leading, 8)
		.padding(.trailing, 6)
		.frame(height: 44)
		.contentShape(Rectangle())
		if let onNewBot {
			Button(action: onNewBot) { row }.buttonStyle(.sidebarRow)
		} else {
			row
		}
	}
}

/// A bot on one line, which opens its channel, with its threads under it; or
/// the threads between people. At its end what is new in its channel, a red
/// dot when one of its routines' latest run failed, and a + that starts a
/// thread with it. Held, a bot offers its notifications. Its routines are under
/// ⋯ in its channel, the app's own place for them; the web lists them here.
@MainActor
private struct BotItem: View {
	let pod: Pod
	let group: BotGroup
	let routines: [ListedRoutine]
	@Environment(WorkspaceStore.self) private var store

	var body: some View {
		let channel = group.channel
		let unread = channel?.unreadMessages ?? 0
		let waiting = (channel?.needsYou ?? false) || routines.contains(where: \.mentionsYou)
		let attention = unread > 0 || waiting
		let routineFailed = routines.contains(where: \.routine.failed)
		VStack(alignment: .leading, spacing: 0) {
			HStack(spacing: 0) {
				NavigationLink(value: destination) {
					HStack(spacing: 12) {
						if let agent = group.agent {
							BotFace(look: agent.look, size: 18)
						} else {
							Icon(.users, size: 16, strokeWidth: 1.75).padding(.horizontal, 1)
						}
						Text(group.agent?.name ?? "People")
							.font(Typeface.rubik(16, attention ? .semibold : .regular))
							.lineLimit(1)
						if let place, store.notificationSettings?.isMuted(place) ?? false {
							Icon(.bellOff, size: 13, strokeWidth: 1.75)
								.foregroundStyle(Palette.subtleForeground)
								.accessibilityLabel("Muted")
						}
						Spacer(minLength: 0)
					}
					.foregroundStyle(attention ? Palette.foreground : Palette.mutedForeground)
					.padding(.leading, 8)
					.frame(maxHeight: .infinity)
					.contentShape(Rectangle())
				}
				// Darkens while pressed, as a channel's row does, so a tap shows it landed.
				.buttonStyle(.sidebarRow)
				if routineFailed {
					FailedRoutineDot().frame(width: 22).accessibilityLabel("A routine's latest run failed")
				}
				if attention {
					UnreadMarker(unreadMessages: unread, needsYou: waiting).frame(width: 22)
				}
				NavigationLink(value: Route.newThread(pod, agent: group.agent)) {
					Icon(.plus, size: 14, strokeWidth: 2.2)
						.foregroundStyle(Palette.mutedForeground)
						.frame(width: 22, height: 22)
						.contentShape(Rectangle())
				}
				.buttonStyle(IconPressStyle())
				.accessibilityLabel(group.agent.map { "New thread with \($0.name)" } ?? "New thread with people")
			}
			.padding(.trailing, 6)
			.frame(height: 44)
			.contextMenu {
				if let place { NotificationMenu(place: place) }
			}
			ThreadTree(pod: pod, threads: group.threads, allThreadsOf: group.agent)
		}

	}

	/// The bot's channel once opened, or opening it; the threads between people have none.
	private var destination: Route? {
		guard let agent = group.agent else { return nil }
		if let channel = group.channel {
			return .conversation(threadId: channel.conversation.id, title: channel.conversation.title)
		}
		return .botChannel(pod, agent)
	}

	/// Only a pod's own bots have notifications of their own; the rest follow the pod.
	private var place: NotificationPlace? {
		group.agent.map { .bot(id: $0.id, podId: $0.podId) }
	}
}

/// Threads hanging under a bot or a channel that aren't done. Under a bot,
/// given as `allThreadsOf`, only the newest few show, then All threads, which
/// leads to the rest, done ones included. Nothing while none is open: a bot's
/// done threads are then reached from its channel's ⋯ and its Details.
@MainActor
private struct ThreadTree: View {
	let pod: Pod
	/// Newest first, done ones included.
	let threads: [ChatListItem]
	var allThreadsOf: Agent?

	var body: some View {
		let open = ConversationList.open(threads)
		let shown = allThreadsOf == nil ? open : Array(open.prefix(Limits.threadsShown))
		if !shown.isEmpty {
			VStack(alignment: .leading, spacing: 1) {
				ForEach(shown) { row in
					NavigationLink(value: Route.conversation(threadId: row.conversation.id, title: row.conversation.title)) {
						threadRow(lit: row.unreadMessages > 0 || row.needsYou) {
							// In a Personal pod a conversation is with the bot, so goes by its name.
							Text(pod.kind == .personal ? row.agent?.name ?? row.conversation.title : row.conversation.title)
								.lineLimit(1)
							Spacer(minLength: 0)
							UnreadMarker(unreadMessages: row.unreadMessages, needsYou: row.needsYou).frame(width: 22)
						}
					}
					.buttonStyle(PressableRowStyle(cornerRadius: 6))
				}
				if let agent = allThreadsOf {
					NavigationLink(value: Route.threads(pod, agent: agent)) {
						threadRow(lit: false, quiet: true) {
							Text("All threads").lineLimit(1)
							Spacer(minLength: 0)
							Icon(.chevronRight, size: 14, strokeWidth: 2).frame(width: 22)
						}
					}
					.buttonStyle(PressableRowStyle(cornerRadius: 6))
				}
			}
			.padding(.leading, ConversationList.nestedIndent)
			.overlay(alignment: .leading) { Rectangle().fill(Palette.border).frame(width: 1) }
			.padding(.leading, 17)
			.padding(.top, 1)
		}
	}

	/// `lit` while it has something new; `quiet`, greyer still, for the way to all of a bot's threads.
	private func threadRow(lit: Bool, quiet: Bool = false, @ViewBuilder content: () -> some View) -> some View {
		HStack(spacing: 8) { content() }
			.font(Typeface.rubik(15, lit ? .semibold : .regular))
			.foregroundStyle(lit ? Palette.foreground : quiet ? Palette.subtleForeground : Palette.mutedForeground)
			.padding(.leading, 8)
			.padding(.trailing, 6)
			.frame(height: 40)
			.contentShape(Rectangle())
	}
}

/// The red dot for a routine whose latest run failed.
struct FailedRoutineDot: View {
	var body: some View {
		Circle().fill(Palette.destructiveText).frame(width: 6, height: 6)
	}
}

/// At a row's end: a dot while it waits on the person, as a decision or a
/// mention does. Unread messages show in the row's bold name, so they are
/// only counted for VoiceOver.
struct UnreadMarker: View {
	let unreadMessages: Int
	let needsYou: Bool

	var body: some View {
		if needsYou {
			Circle()
				.fill(Palette.foreground)
				.frame(width: 6, height: 6)
				.accessibilityLabel(unreadMessages > 0 ? "\(unreadMessages) unread, needs you" : "Needs you")
		} else if unreadMessages > 0 {
			Color.clear.frame(width: 0, height: 0).accessibilityLabel("\(unreadMessages) unread")
		}
	}
}
