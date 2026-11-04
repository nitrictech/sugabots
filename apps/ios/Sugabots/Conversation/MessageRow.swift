import SwiftUI
import UIKit

/// What a message row needs from the conversation around it.
struct MessageContext {
	let podId: String
	let mentionable: [ThreadParticipant]
	/// What the person may decide in the conversation.
	let capabilities: ThreadDetails.Capabilities?
	var looks: [String: ConnectionLook] = [:]
	/// Every file named in the conversation, by id, for steps that name one.
	var fileNames: [String: String] = [:]
	/// The latest activity in each side thread, by its thread id.
	var threadActivityAt: [String: Date] = [:]
	/// Messages waiting behind a reply.
	var queued: Set<String> = []
	var sending: Set<String> = []
	var inRoutineThread = false
	/// The person reading, whose reactions are theirs.
	let userId: String
	let conversationId: String
}

/// What a message row can do, each absent where the conversation doesn't offer it.
struct MessageActions {
	var reply: ((Message) -> Void)?
	var startThread: ((Message) -> Void)?
	var react: ((Message, String) -> Void)?
	var openThread: (String) -> Void
	var openArtifact: ((String) -> Void)?
	var openDesktop: (() -> Void)?
	var jumpTo: ((String) -> Void)?
}

/// One message, as the web's `MessageRow` draws it on a phone: its author's
/// face and name with Bot and the time when it starts a group, else its time
/// on a tap; then what it quotes, its steps, its words, approvals, files,
/// artifacts, the threads started from it, its reactions, and how it ended.
/// Held, it offers React, Reply, Start a thread and Copy text.
@MainActor
struct MessageRow: View {
	let message: Message
	let startsGroup: Bool
	let context: MessageContext
	let actions: MessageActions
	var highlighted = false
	/// Cards of the threads started from it, under its words.
	var threadLines: AnyView?
	/// Smaller, as a side thread's sheet shows its messages.
	var compact = false
	@State private var timeTapped = false
	@State private var pickingReaction = false
	/// Whether the message is held, with what can be done with it slid up from the foot.
	@State private var holding = false
	/// Whether the emoji picker opens once the held message's sheet has gone.
	@State private var pickAfterHolding = false
	@Environment(Toaster.self) private var toaster

	private var faceSize: CGFloat { compact ? 32 : 36 }

	var body: some View {
		let agent: AgentParticipant? = if case let .agent(agent) = message.author { agent } else { nil }
		let segments = Segments.of(message)
		let files = message.files
		let held = heldActions(words: segments.compactMap(\.text).joined(separator: "\n\n"))
		if !Segments.showsNothingYet(message) {
			HStack(alignment: .top, spacing: compact ? 12 : 14) {
				face
				VStack(alignment: .leading, spacing: 0) {
					if let replyTo = message.replyTo {
						ReplyQuote(replyTo: replyTo, jump: actions.jumpTo)
					}
					if startsGroup {
						AuthorLine(name: message.author.name, isBot: agent != nil, at: message.createdAt)
							.padding(.bottom, 1)
					}
					if agent != nil {
						ToolLine(parts: message.parts, looks: context.looks, fileNames: context.fileNames)
					}
					ForEach(segments) { segment in
						segmentView(segment, agent: agent)
					}
					if !files.isEmpty {
						MessageFiles(files: files, conversationId: context.conversationId, sent: !context.sending.contains(message.id))
					}
					if let agent, let openArtifact = actions.openArtifact {
						ArtifactCards(parts: message.parts, podId: context.podId, botName: agent.name, onOpen: openArtifact)
							.padding(.top, 8)
					}
					threadLines
					MessageReactionsView(message: message, userId: context.userId, addable: finished && actions.react != nil) { emoji in
						actions.react?(message, emoji)
					} add: {
						pickingReaction = true
					}
					notes
				}
				.frame(maxWidth: .infinity, alignment: .leading)
			}
			.padding(.horizontal, compact ? 18 : 20)
			.padding(.top, startsGroup ? 14 : 2)
			.padding(.bottom, 2)
			.background(highlighted ? Palette.chip : .clear)
			.animation(.easeOut(duration: 0.7), value: highlighted)
			.contentShape(Rectangle())
			.onTapGesture {
				guard !startsGroup else { return }
				timeTapped.toggle()
			}
			.onLongPressGesture(minimumDuration: 0.35) {
				guard held != nil else { return }
				UIImpactFeedbackGenerator(style: .medium).impactOccurred()
				holding = true
			}
			#if DEBUG
			.task {
				guard finished, DebugLaunch.once("SUGABOTS_HOLD") else { return }
				try? await Task.sleep(for: .seconds(2))
				holding = true
			}
			#endif
			.sheet(isPresented: $holding, onDismiss: {
				// One sheet at a time: the picker waits for the actions to slide away.
				if pickAfterHolding {
					pickAfterHolding = false
					pickingReaction = true
				}
			}) {
				if let held { held }
			}
			.sheet(isPresented: $pickingReaction) {
				EmojiPicker(full: reactionEmoji.count >= EmojiPicker.maxReactionEmojiPerMessage, used: reactionEmoji) { emoji in
					pickingReaction = false
					addReaction(emoji)
				}
			}
			.accessibilityElement(children: .contain)
			.accessibilityLabel("\(message.author.name), \(statusWords)")
		}
	}

	private var finished: Bool { message.status == .complete && !context.sending.contains(message.id) }

	private var statusWords: String {
		if context.queued.contains(message.id) { return "queued" }
		if message.status == .failed { return "failed" }
		if message.status == .cancelled { return "stopped" }
		return Times.clock(message.createdAt)
	}

	@ViewBuilder private var face: some View {
		Group {
			if startsGroup {
				ParticipantFace(participant: message.author.participant, size: faceSize)
					.padding(.top, 2)
			} else {
				Text(Times.clock(message.createdAt))
					.font(Typeface.rubik(11))
					.monospacedDigit()
					.foregroundStyle(Palette.subtleForeground)
					.frame(height: 22)
					.opacity(timeTapped ? 1 : 0)
			}
		}
		.frame(width: faceSize)
		// A reply's face lines up with its author's name, under the quote.
		.padding(.top, message.replyTo != nil ? 21 : 0)
		.accessibilityHidden(true)
	}

	@ViewBuilder private func segmentView(_ segment: Segments.Segment, agent: AgentParticipant?) -> some View {
		switch segment.kind {
		case let .collaboration(collaboration):
			if let agent, let recipient = context.mentionable.compactMap(\.agent).first(where: { $0.id == collaboration.agentId }) {
				SideThreadLine(
					faces: [.agent(agent), .agent(recipient)],
					label: "Asked \(recipient.name)",
					description: "Open Collaboration: \(agent.name) and \(recipient.name)",
					lastActivityAt: context.threadActivityAt[collaboration.threadId],
					status: SideThreadStatus.of(collaboration: collaboration.status)
				) { actions.openThread(collaboration.threadId) }
			}
		case let .toolCall(call):
			if let agent {
				ApprovalCard(call: call, agent: agent, podId: context.podId, capabilities: context.capabilities, looks: context.looks)
					.padding(.top, 6)
					.padding(.bottom, 4)
			}
		case let .text(text):
			if !text.isEmpty {
				if let agent {
					MessageMarkdown(text: text, mentionable: context.mentionable, palette: BotLooks.palettes[agent.color.rawValue], size: compact ? 14.5 : 15)
				} else {
					Text(MarkdownInline.plainWithMentions(text, by: message.author, mentionable: context.mentionable, size: compact ? 14.5 : 15))
						.lineSpacing(3.5)
						.foregroundStyle(Palette.bodyForeground)
						// Not selectable: holding a message brings up its actions, Copy among them.
						.fixedSize(horizontal: false, vertical: true)
				}
			}
		}
	}

	@ViewBuilder private var notes: some View {
		if let run = message.routineResultOf, !context.inRoutineThread {
			Button { actions.openThread(run.threadId) } label: {
				HStack(spacing: 2) {
					Text("From \(run.routineName)")
					Icon(.chevronRight, size: 12, strokeWidth: 2.4)
				}
				.font(Typeface.rubik(12, .medium))
				.foregroundStyle(Palette.subtleForeground)
			}
			.buttonStyle(.plain)
			.padding(.top, 4)
		}
		if message.status == .failed {
			(Text("Reply failed.").fontWeight(.semibold) + Text(message.error.map { " \($0)" } ?? ""))
				.font(Typeface.rubik(12))
				.foregroundStyle(Palette.destructiveText)
				.padding(.top, 4)
		}
		if message.status == .cancelled {
			Text("Reply stopped").font(Typeface.rubik(12, .semibold)).foregroundStyle(Palette.subtleForeground).padding(.top, 4)
		}
		if context.queued.contains(message.id) {
			Text("Queued").font(Typeface.rubik(12)).foregroundStyle(Palette.subtleForeground).padding(.top, 4)
		}
	}

	/// The different emoji the message has been reacted with.
	private var reactionEmoji: Set<String> { Set((message.reactions ?? []).map(\.emoji)) }

	/// Adds the person's `emoji` to the message as the picker chooses one: a
	/// message with the most different emoji takes only one of those, and
	/// `emoji` becomes the one chosen last on this device.
	private func addReaction(_ emoji: String) {
		guard EmojiPicker.admits(emoji, besides: reactionEmoji) else { return }
		RecentEmoji.remember(emoji)
		actions.react?(message, emoji)
	}

	/// What holding the message offers, given its `words`; nil when it offers nothing.
	private func heldActions(words: String) -> MessageActionsSheet? {
		let sheet = MessageActionsSheet(
			react: finished && actions.react != nil ? { emoji in
				holding = false
				addReaction(emoji)
			} : nil,
			pickReaction: {
				pickAfterHolding = true
				holding = false
			},
			reply: finished && message.author.isReplyable ? actions.reply.map { reply in { holding = false; reply(message) } } : nil,
			startThread: finished ? actions.startThread.map { start in { holding = false; start(message) } } : nil,
			copy: words.isEmpty ? nil : {
				holding = false
				UIPasteboard.general.string = words
				toaster.show("Copied")
			}
		)
		return sheet.isEmpty ? nil : sheet
	}
}

/// What can be done with a held message, slid up from the foot as Slack's is:
/// a row of quick reactions, then its actions as tiles.
private struct MessageActionsSheet: View {
	/// Reacts with an emoji; nil when the message can't take reactions.
	let react: ((String) -> Void)?
	let pickReaction: () -> Void
	let reply: (() -> Void)?
	let startThread: (() -> Void)?
	let copy: (() -> Void)?
	@State private var height: CGFloat = 240

	var isEmpty: Bool { react == nil && reply == nil && startThread == nil && copy == nil }

	/// How many emoji the quick row offers before the picker's button.
	private static let quickCount = NativeConstants.quickReactionCount
	/// What fills the quick row after the emoji chosen lately on this device.
	private static let usualReactions = NativeConstants.usualReactions

	private var quick: [String] {
		var seen = Set<String>()
		return (RecentEmoji.all + Self.usualReactions).filter { seen.insert($0).inserted }.prefix(Self.quickCount).map { $0 }
	}

	var body: some View {
		VStack(spacing: 18) {
			SheetGrabber()
			if let react {
				HStack(spacing: 10) {
					ForEach(quick, id: \.self) { emoji in
						Button { react(emoji) } label: {
							Text(emoji).font(.system(size: 26)).frame(maxWidth: .infinity).frame(height: 52)
								.background(Palette.chip, in: Circle())
						}
						.buttonStyle(.plain)
						.accessibilityLabel("React with \(emoji)")
					}
					Button(action: pickReaction) {
						Image(systemName: "face.smiling").font(.system(size: 22, weight: .medium))
							.foregroundStyle(Palette.foreground)
							.frame(maxWidth: .infinity).frame(height: 52)
							.background(Palette.chip, in: Circle())
					}
					.buttonStyle(.plain)
					.accessibilityLabel("Add reaction")
				}
			}
			HStack(spacing: 10) {
				if let reply { tile("Reply", systemImage: "arrowshape.turn.up.left", action: reply) }
				if let startThread { tile("Thread", systemImage: "text.bubble", action: startThread) }
				if let copy { tile("Copy", systemImage: "doc.on.doc", action: copy) }
			}
		}
		.padding(.horizontal, 16)
		.padding(.bottom, 12)
		.fixedSize(horizontal: false, vertical: true)
		.onGeometryChange(for: CGFloat.self) { $0.size.height } action: { height = $0 }
		.phoneSheet(detents: [.height(height)])
	}

	private func tile(_ title: String, systemImage: String, action: @escaping () -> Void) -> some View {
		Button(action: action) {
			VStack(spacing: 8) {
				Image(systemName: systemImage).font(.system(size: 21, weight: .medium))
				Text(title).font(Typeface.rubik(14, .medium))
			}
			.foregroundStyle(Palette.foreground)
			.frame(maxWidth: .infinity)
			.frame(height: 84)
			.background(Palette.chip, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
		}
		.buttonStyle(.plain)
	}
}

extension MessageAuthor {
	/// Whether a reply can quote it: anything but a routine's trigger.
	var isReplyable: Bool {
		if case .routineTrigger = self { false } else { true }
	}

	var participant: ThreadParticipant? {
		switch self {
		case let .person(person): .person(person)
		case let .agent(agent): .agent(agent)
		default: nil
		}
	}
}

/// Who wrote a group of messages: their name, Bot for a bot, and the time.
private struct AuthorLine: View {
	let name: String
	let isBot: Bool
	let at: Date

	var body: some View {
		HStack(spacing: 8) {
			Text(name).font(Typeface.rubik(15, .semibold)).foregroundStyle(Palette.foreground).lineLimit(1)
			if isBot { BotTag() }
			Text(Times.clock(at)).font(Typeface.rubik(12)).foregroundStyle(Palette.subtleForeground)
		}
	}
}

/// The message a reply answers, in a line over it, which jumps to it.
private struct ReplyQuote: View {
	let replyTo: MessageReplyTo
	let jump: ((String) -> Void)?

	var body: some View {
		Button { jump?(replyTo.id) } label: {
			HStack(spacing: 4) {
				Icon(.cornerUpLeft, size: 13, strokeWidth: 2.2)
				Text("Replying to").fixedSize()
				Text(replyTo.author.name).fontWeight(.semibold).foregroundStyle(Palette.softForeground).fixedSize()
				Text(replyTo.preview).lineLimit(1).padding(.leading, 2)
			}
			.font(Typeface.rubik(13))
			.foregroundStyle(Palette.mutedForeground)
			.frame(height: 21)
			.padding(.horizontal, 4)
			.padding(.leading, -4)
		}
		.buttonStyle(.plain)
		.disabled(jump == nil)
		.accessibilityLabel("Replying to \(replyTo.author.name): \(replyTo.preview)")
	}
}

/// A routine's trigger, as a card over the run it started.
struct RoutineTriggerCard: View {
	let message: Message

	var body: some View {
		if case let .routineTrigger(trigger) = message.author {
			let source = switch trigger.triggerKind {
			case .cron: "Scheduled trigger"
			case .webhook: "Webhook trigger"
			case .github: "Repository trigger"
			case .manual, .unknown: "Manual run"
			}
			VStack(alignment: .leading, spacing: 4) {
				(Text(trigger.routineName).fontWeight(.semibold) + Text(" \(source)"))
					.font(Typeface.rubik(12))
					.foregroundStyle(Palette.mutedForeground)
				Text(message.content)
					.font(Typeface.rubik(13))
					.lineSpacing(4)
					.foregroundStyle(Palette.bodyForeground)
					.textSelection(.enabled)
			}
			.padding(.horizontal, 16)
			.padding(.vertical, 12)
			.frame(maxWidth: .infinity, alignment: .leading)
			.background(Palette.list, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
			.overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Palette.border))
			.padding(.horizontal, 20)
			.padding(.top, 14)
			.accessibilityElement(children: .combine)
		}
	}
}

/// How a side thread stands, at the end of its line.
enum SideThreadStatus: Equatable {
	case working
	case words(String, done: Bool = false, urgent: Bool = false)

	static func of(collaboration status: CollaborationStatus) -> SideThreadStatus {
		switch status {
		case .pending: .words("Needs approval", urgent: true)
		case .answered: .words("Done", done: true)
		case .failed: .words("Stopped")
		case .waiting, .unknown: .working
		}
	}
}

/// A thread hanging off a message, as the web's `SideThreadLine` on a phone:
/// a hooked rule, the faces in it, its label with what it is and when it last
/// moved, and a chevron.
struct SideThreadLine: View {
	let faces: [ThreadParticipant]
	let label: String
	var detail: String?
	let description: String
	var lastActivityAt: Date?
	var status: SideThreadStatus?
	let open: () -> Void

	var body: some View {
		Button(action: open) {
			HStack(spacing: 10) {
				UnevenRoundedRectangle(bottomLeadingRadius: 7)
					.stroke(Palette.borderDashed, lineWidth: 1)
					.mask(alignment: .bottomLeading) { Rectangle().padding(.top, -1).padding(.trailing, 1) }
					.frame(width: 10, height: 20)
					.padding(.top, -4)
					.frame(maxHeight: .infinity, alignment: .top)
				HStack(spacing: -6) {
					ForEach(Array(faces.enumerated()), id: \.offset) { _, face in
						ParticipantFace(participant: face, size: 22)
							.padding(1.5)
						.background(Palette.background, in: Circle())
					}
				}
				.padding(.vertical, 4)
				VStack(alignment: .leading, spacing: 2) {
					Text(label)
						.font(Typeface.rubik(14, .semibold))
						.foregroundStyle(Palette.foreground)
						.lineLimit(1)
					HStack(spacing: 6) {
						if let detail {
							Text(detail).font(Typeface.rubik(12)).foregroundStyle(Palette.subtleForeground).lineLimit(1)
						}
						statusView
						if let lastActivityAt {
							Text(Times.clock(lastActivityAt)).font(Typeface.rubik(12)).foregroundStyle(Palette.subtleForeground)
						}
					}
				}
				.frame(maxWidth: .infinity, alignment: .leading)
				Icon(.chevronRight, size: 16, strokeWidth: 2).foregroundStyle(Palette.disabledForeground)
			}
			.padding(.trailing, 6)
			.frame(minHeight: 44)
			.contentShape(Rectangle())
		}
		.buttonStyle(PressableRowStyle(cornerRadius: 10))
		.padding(.top, 4)
		.padding(.leading, 8)
		.accessibilityLabel([description, statusText, lastActivityAt.map { "Last reply \(Times.clock($0))" }].compactMap { $0 }.joined(separator: ", "))
	}

	private var statusText: String? {
		switch status {
		case .working: "Working"
		case let .words(text, _, _): text
		case nil: nil
		}
	}

	@ViewBuilder private var statusView: some View {
		switch status {
		case .working:
			TypingDots(small: true).foregroundStyle(Palette.mutedForeground)
		case let .words(text, done, urgent):
			if urgent {
				Text(text)
					.font(Typeface.rubik(11.5, .semibold))
					.foregroundStyle(Palette.primaryForeground)
					.padding(.horizontal, 6)
					.padding(.vertical, 1)
					.background(Palette.primary, in: RoundedRectangle(cornerRadius: 5, style: .continuous))
			} else {
				HStack(spacing: 4) {
					if done { Icon(.check, size: 12, strokeWidth: 2.25) }
					Text(text)
				}
				.font(Typeface.rubik(12))
				.foregroundStyle(Palette.mutedForeground)
			}
		case nil:
			EmptyView()
		}
	}
}

/// Who is typing, with the dots, as the web's `TypingIndicator`.
struct TypingIndicator: View {
	let names: [String]

	var body: some View {
		let label = "\(Names.list(names)) \(names.count == 1 ? "is" : "are") typing"
		HStack(spacing: 8) {
			TypingDots(small: true)
			Text(label)
		}
		.font(Typeface.rubik(12.5, .medium))
		.foregroundStyle(Palette.mutedForeground)
		.frame(height: 26)
		.accessibilityElement(children: .ignore)
		.accessibilityLabel(label)
	}
}

/// The emoji people reacted with, each with how many, which the person taps
/// to add theirs or take it back, then a button to add another.
struct MessageReactionsView: View {
	let message: Message
	let userId: String
	let addable: Bool
	let toggle: (String) -> Void
	let add: () -> Void

	/// A chip's height: a fingertip's, as Slack's on a phone, larger than the web's.
	private static let chipHeight = NativeConstants.reactionChipHeight

	var body: some View {
		let reactions = message.reactions ?? []
		if !reactions.isEmpty {
			FlowLayout(spacing: 6) {
				ForEach(reactions, id: \.emoji) { reaction in
					let mine = reaction.people.contains { $0.id == userId }
					Button { toggle(reaction.emoji) } label: {
						HStack(spacing: 5) {
							Text(reaction.emoji).font(.system(size: 18))
							Text("\(reaction.people.count)").font(Typeface.rubik(14, .semibold)).monospacedDigit()
						}
						.foregroundStyle(mine ? Palette.foreground : Palette.softForeground)
						.padding(.horizontal, 11)
						.frame(height: Self.chipHeight)
						.background(mine ? Palette.reactionMine : Palette.card, in: Capsule())
						.overlay(Capsule().strokeBorder(mine ? Palette.primary : Palette.chipStrong))
					}
					.buttonStyle(.plain)
					.accessibilityLabel("\(reaction.emoji) \(reaction.people.count): \(Names.list(reaction.people.map { $0.id == userId ? "You" : $0.name }))")
					.accessibilityAddTraits(mine ? .isSelected : [])
				}
				if addable {
					Button(action: add) {
						Icon(.smilePlus, size: 18, strokeWidth: 2)
							.foregroundStyle(Palette.mutedForeground)
							.frame(width: 52, height: Self.chipHeight)
							.overlay(Capsule().strokeBorder(Palette.chipStrong))
					}
					.buttonStyle(.plain)
					.accessibilityLabel("Add reaction")
				}
			}
			.padding(.top, 6)
		}
	}
}

extension MarkdownInline {
	/// Words as written, with mentions as chips. Only a person's can mention
	/// everyone, with `@here` or `@channel`: a bot's or a routine's notify nobody.
	static func plainWithMentions(_ text: String, by author: MessageAuthor, mentionable: [ThreadParticipant], size: CGFloat = 15) -> AttributedString {
		var attributed = AttributedString(text)
		attributed.font = Typeface.rubik(size)
		var targets = mentionable.map(MentionTarget.participant)
		if case .person = author { targets += Mentions.groupHandles.map { .group(handle: $0) } }
		Mentions.chip(in: &attributed, size: size, mentionable: targets)
		return attributed
	}
}
