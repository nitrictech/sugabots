import SwiftUI

/// The top of a conversation on a phone: Back in glass with Inbox's unread
/// count; then what the conversation is, as one glass row (its face, its name,
/// and a quieter line under it), which opens Details; and at the right one
/// control: a bot's channel's ⋯ (Computer, Routines), a thread's ⋯ (Computer,
/// Mark done), or Mark done for a thread between people.
///
/// The row, its place up against the Dynamic Island, and the channel's ⋯ are
/// the app's own, after Slack's: the web has a face over its name in the
/// middle, Computer at the right, and Routines under the bot on Home.
@MainActor
struct ConversationHeader: View {
	let model: ConversationModel
	let kind: ConversationKind
	let pod: Pod?
	let fallbackTitle: String
	let openDetails: () -> Void
	let openComputer: () -> Void
	let openRoutines: () -> Void
	@Environment(WorkspaceStore.self) private var store
	@Environment(Toaster.self) private var toaster
	@Environment(\.dismiss) private var dismiss

	/// A face in the title pill: 6 points inside its rounded end, and 6 over and under in its 44.
	private static let faceSize = NativeConstants.headerFaceSize

	var body: some View {
		HStack(spacing: 8) {
			HeaderBack()
			badge.frame(maxWidth: .infinity, alignment: .leading)
			controls
		}
		.padding(.horizontal, 16)
		// Placed from the top of the screen: up into the safe area as far as it gives,
		// and 12 points down where it has none, as a page's header.
		.padding(.top, max(12, WindowInsets.current.top - WindowInsets.headerRise))
		.padding(.bottom, 8)
		.ignoresSafeArea(edges: .top)
	}

	private var title: String { model.thread?.title ?? fallbackTitle }

	@ViewBuilder private var badge: some View {
		switch kind {
		case let .botChannel(agent):
			TitleRow(name: agent.name, line: store.modelName(agent.model) ?? "No model chosen", open: openDetails) {
				BotFace(look: agent.look, size: Self.faceSize)
			}
		case let .botThread(agent):
			if model.details?.routine != nil {
				TitleRow(name: title, line: "Runs as \(agent.name)", open: openDetails) {
					bareFace(.refreshCcw)
				}
			} else {
				TitleRow(name: title, line: "With \(agent.name)", open: openDetails) {
					BotFace(look: agent.look, size: Self.faceSize)
				}
			}
		case let .podChat(name):
			TitleRow(name: name, line: podChatCounts ?? pod?.name, open: openDetails) {
				bareFace(.hash)
			}
		case .peopleThread:
			TitleRow(name: title, line: (startedIn.map { "#\($0)" } ?? pod?.name).map { "In \($0)" }, open: openDetails)
		}
	}

	/// A bare mark in a face's place: a tile's square corners would sit oddly in the round pill.
	private func bareFace(_ icon: Lucide) -> some View {
		Icon(icon, size: 24, strokeWidth: 2.25)
			.foregroundStyle(Palette.foreground)
			.frame(width: Self.faceSize, height: Self.faceSize)
	}

	@ViewBuilder private var controls: some View {
		switch kind {
		case let .botChannel(agent):
			let failed = routinesFailed(agent)
			GlassMenuButton(
				label: failed ? "More for \(agent.name), a routine's latest run failed" : "More for \(agent.name)",
				items: [
					.init(title: "Computer", systemImage: "desktopcomputer", action: openComputer),
					.init(title: "Routines", systemImage: "arrow.triangle.2.circlepath", action: openRoutines),
				]
			)
			.overlay(alignment: .topTrailing) {
				if failed { FailedRoutineDot().offset(x: -6, y: 6).allowsHitTesting(false) }
			}
		case .botThread:
			if model.details?.routine == nil {
				GlassMenuButton(
					label: "More for this thread",
					items: [
						.init(title: "Computer", systemImage: "desktopcomputer", action: openComputer),
						.init(
							title: isDone ? "Reopen" : "Mark done",
							systemImage: isDone ? "arrow.counterclockwise" : "checkmark.circle",
							action: toggleDone
						),
					]
				)
			}
		case .peopleThread:
			GlassRoundButton(icon: isDone ? .rotateCcw : .circleCheck, label: isDone ? "Reopen" : "Mark done", iconSize: 20, strokeWidth: 1.75, action: toggleDone)
		case .podChat:
			EmptyView()
		}
	}

	private var isDone: Bool { model.thread?.doneAt != nil }

	/// Whether the latest run of one of the bot's routines failed.
	private func routinesFailed(_ agent: Agent) -> Bool {
		guard let pod else { return false }
		return (store.chatLists[pod.id]?.routines ?? []).contains { $0.agent.id == agent.id && $0.routine.failed }
	}

	/// Who is in a pod's channel: `1 person · 1 bot`.
	private var podChatCounts: String? {
		guard let (people, bots) = model.details?.headCount else { return nil }
		return "\(people) · \(bots)"
	}

	/// The channel a thread between people was started from, by its name.
	private var startedIn: String? {
		guard let parent = model.thread?.parentThreadId, let pod else { return nil }
		return store.podChat(parent, in: pod.id)?.title
	}

	private func toggleDone() {
		let marking = !isDone
		Task {
			do {
				try await model.setDone(marking)
				// Done with, it is left, as Back leaves it.
				if marking { dismiss() }
			} catch {
				toaster.show("This thread was not marked done or reopened. Try again.")
			}
		}
	}
}

/// Back on a phone's conversation: the glass chevron, with Inbox's unread count beside it.
struct HeaderBack: View {
	@Environment(WorkspaceStore.self) private var store
	@Environment(\.dismiss) private var dismiss

	var body: some View {
		let unread = store.unreadInInbox
		Button { dismiss() } label: {
			HStack(spacing: 6) {
				Icon(.chevronLeft, size: 22, strokeWidth: 2.25)
				if unread > 0 {
					CountBadge(count: unread, size: .large)
				}
			}
			.foregroundStyle(Palette.foreground)
			.padding(.horizontal, unread > 0 ? 8 : 0)
			.frame(minWidth: 44, minHeight: 44)
			.contentShape(Capsule())
		}
		.buttonStyle(CapsuleGlassPressStyle())
		.accessibilityLabel(unread > 0 ? "Back, \(unread) unread in Inbox" : "Back")
	}
}

/// What a conversation is, in a glass row 44 points tall: its face, its name,
/// and a quieter line under it, after Slack's. Opens Details.
private struct TitleRow<Face: View>: View {
	let name: String
	let line: String?
	let open: () -> Void
	/// How far the row starts inside the pill's round end: close beside a face,
	/// and for text alone, as far as the row ends from the other end.
	private let leadingInset: CGFloat
	private let face: Face

	/// The inset at either end of the pill, for text.
	private static var textInset: CGFloat { 16 }
	/// The inset beside a face, which sits close to the pill's round end.
	private static var faceInset: CGFloat { 6 }

	init(name: String, line: String?, open: @escaping () -> Void, @ViewBuilder face: () -> Face) {
		self.init(name: name, line: line, open: open, leadingInset: Self.faceInset, face: face())
	}

	private init(name: String, line: String?, open: @escaping () -> Void, leadingInset: CGFloat, face: Face) {
		self.name = name
		self.line = line
		self.open = open
		self.leadingInset = leadingInset
		self.face = face
	}

	var body: some View {
		Button(action: open) {
			HStack(spacing: 10) {
				face
				VStack(alignment: .leading, spacing: 0) {
					Text(name).font(Typeface.rubik(16, .semibold)).foregroundStyle(Palette.foreground)
					if let line {
						Text(line).font(Typeface.rubik(13)).foregroundStyle(Palette.mutedForeground)
					}
				}
				.lineLimit(1)
				Spacer(minLength: 0)
			}
			.padding(.leading, leadingInset)
			.padding(.trailing, Self.textInset)
			.frame(height: NativeConstants.headerPillHeight)
			.contentShape(Capsule())
		}
		// Glass that fills a step darker while pressed, as Back does; the plain style would fade
		// the whole pill, glass and all, and fade it back only after Details has opened.
		.buttonStyle(CapsuleGlassPressStyle())
		.accessibilityLabel([name, line].compactMap { $0 }.joined(separator: ", ") + ", details")
	}
}

extension TitleRow where Face == EmptyView {
	/// A title with nothing beside it, for a thread among people, which has no face of its own.
	init(name: String, line: String?, open: @escaping () -> Void) {
		self.init(name: name, line: line, open: open, leadingInset: Self.textInset, face: EmptyView())
	}
}

/// The start of a conversation, over its first message, as the web's intros:
/// a thread's title with who started it and from what; a channel's tile and
/// what it is for; a routine's title; a bot's face and what it does.
struct Intro: View {
	let details: ThreadDetails
	let kind: ConversationKind
	let pod: Pod

	var body: some View {
		let thread = details.thread
		Group {
			if thread.parentThreadId != nil {
				threadIntro
			} else {
				switch kind {
				case let .podChat(name): podChatIntro(name)
				case let .botChannel(agent): botChannelIntro(agent)
				case let .botThread(agent):
					if thread.type == .routineFeed {
						titled(thread.title, "Runs as \(agent.name). Each run posts here.")
					} else {
						botThreadIntro(agent, title: thread.title)
					}
				case .peopleThread: threadIntro
				}
			}
		}
		.padding(.horizontal, 20)
	}

	private var threadIntro: some View {
		let thread = details.thread
		let starter = details.members.first { $0.id == thread.initiatorUserId }
		return VStack(alignment: .leading, spacing: 6) {
			Text(thread.title).font(Typeface.rubik(22, .bold)).foregroundStyle(Palette.foreground)
			Text("\(starter.map { "Started by \($0.name) in \(pod.name)" } ?? "Started in \(pod.name)"), \(Times.list(thread.createdAt))")
				.font(Typeface.rubik(13.5))
				.foregroundStyle(Palette.mutedForeground)
			if let startedFrom = details.startedFrom {
				StartedFrom(message: startedFrom, mentionable: details.participants)
			}
		}
		.padding(.top, 24)
		.padding(.bottom, 16)
	}

	private func titled(_ title: String, _ line: String) -> some View {
		VStack(alignment: .leading, spacing: 6) {
			Text(title).font(Typeface.rubik(22, .bold)).foregroundStyle(Palette.foreground)
			Text(line).font(Typeface.rubik(13.5)).foregroundStyle(Palette.mutedForeground)
		}
		.padding(.top, 24)
		.padding(.bottom, 16)
	}

	private func podChatIntro(_ name: String) -> some View {
		let (people, bots) = details.headCount
		return VStack(alignment: .leading, spacing: 8) {
			PodChatTile(color: pod.color?.rawValue, size: 64)
			Text(name).font(Typeface.rubik(24, .bold)).tracking(-0.24).foregroundStyle(Palette.foreground).padding(.top, 4)
			Text("This is the start of \(name), with \(people) and \(bots). Talk here, or mention a bot to start a thread with it.")
				.font(Typeface.rubik(14.5))
				.lineSpacing(4)
				.foregroundStyle(Palette.mutedForeground)
		}
		.padding(.top, 8)
		.padding(.bottom, 14)
	}

	/// A bot's thread: its title, and the bot it's with.
	private func botThreadIntro(_ agent: Agent, title: String) -> some View {
		VStack(alignment: .leading, spacing: 8) {
			Text(title).font(Typeface.rubik(20, .bold)).tracking(-0.2).foregroundStyle(Palette.foreground)
			HStack(spacing: 8) {
				BotFace(look: agent.look, size: 20)
				Text("With \(agent.name)")
			}
			.font(Typeface.rubik(14.5))
			.foregroundStyle(Palette.mutedForeground)
		}
		.padding(.top, 8)
		.padding(.bottom, 14)
	}

	/// A bot's channel: its face large, its name, and whose it is.
	private func botChannelIntro(_ agent: Agent) -> some View {
		let line = pod.kind == .personal
			? "Your own bot. It works for you only and nobody else in the workspace can see this conversation."
			: "This is the start of \(agent.name)'s channel."
		return VStack(alignment: .leading, spacing: 8) {
			BotFace(look: agent.look, size: 64)
			Text(agent.name).font(Typeface.rubik(24, .bold)).tracking(-0.24).foregroundStyle(Palette.foreground).padding(.top, 4)
			Text(line)
				.font(Typeface.rubik(14.5))
				.lineSpacing(4)
				.foregroundStyle(Palette.mutedForeground)
		}
		.padding(.top, 8)
		.padding(.bottom, 14)
	}
}

/// The message a thread was started from, under its title: who said it and what, behind a rule.
private struct StartedFrom: View {
	let message: Message
	let mentionable: [ThreadParticipant]

	var body: some View {
		let files = message.files.map(\.name)
		VStack(alignment: .leading, spacing: 4) {
			Text(message.author.name).font(Typeface.rubik(14, .semibold)).foregroundStyle(Palette.foreground)
			if !message.content.isEmpty {
				Text(MarkdownInline.plainWithMentions(message.content, by: message.author, mentionable: mentionable))
					.font(Typeface.rubik(15))
					.lineSpacing(4)
					.foregroundStyle(Palette.softForeground)
			}
			if !files.isEmpty {
				Text(files.joined(separator: ", ")).font(Typeface.rubik(13)).foregroundStyle(Palette.mutedForeground).lineLimit(1)
			}
		}
		.padding(.leading, 12)
		.overlay(alignment: .leading) { Rectangle().fill(Palette.borderStrong).frame(width: 2) }
		.padding(.top, 4)
	}
}

/// A pod's channel as a tile: a # in the foreground on the pod's tint, as the web's `PodChatTile`.
struct PodChatTile: View {
	let color: String?
	let size: CGFloat

	var body: some View {
		let palette = color.flatMap { BotLooks.pods[$0] }
		// The web's sizes: 26, 28 and 64, each with its own corner and icon.
		let (radius, icon): (CGFloat, CGFloat) = size >= 64 ? (18, 30) : size >= 28 ? (8, 15) : (7, 14)
		Icon(.hash, size: icon, strokeWidth: 2)
			.foregroundStyle(Palette.foreground)
			.frame(width: size, height: size)
			.background(palette?.tile.resolved ?? Palette.tile, in: RoundedRectangle(cornerRadius: radius, style: .continuous))
			.accessibilityHidden(true)
	}
}
