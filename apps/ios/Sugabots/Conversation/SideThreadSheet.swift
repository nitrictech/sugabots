import SwiftUI

/// A collaboration or a routine's run, over the conversation it came from,
/// as the web's `ChatThreadPanel` in a phone's sheet: what it is in the
/// sheet's head, then its messages, smaller.
@MainActor
struct SideThreadSheet: View {
	let threadId: String
	let conversationId: String
	let entry: ChatHistoryEntry?
	/// The bot whose channel this opened from, which is "mine" in a collaboration.
	let chatAgentId: String?
	/// On its own page, as the Inbox opens it, rather than in a sheet over its conversation.
	var asPage = false
	let openThread: (String) -> Void
	@Environment(WorkspaceStore.self) private var store
	@Environment(\.dismiss) private var dismiss
	@State private var model: ConversationModel?
	@State private var looks: [String: ConnectionLook] = [:]

	var body: some View {
		VStack(spacing: 0) {
			if !asPage {
				SheetGrabber().padding(.bottom, 14)
			}
			header
			Rectangle().fill(Palette.border).frame(height: 1)
			content
		}
		.background((asPage ? Palette.background : Palette.list).ignoresSafeArea())
		.phoneSheet(detents: [.fraction(0.82), .large])
		.task(id: threadId) {
			// Kept while a page is pushed over this one, as it is when it opens as a page.
			if model?.threadId != threadId { model = ConversationModel(threadId: threadId, store: store, source: .threadMessages) }
			await model?.listen()
		}
		.task(id: model?.thread?.podId) {
			guard let podId = model?.thread?.podId else { return }
			looks = await store.connectionLooks(podId: podId)
		}
	}

	/// Whether it's a collaboration or a routine's run, as its history entry or its thread says.
	private var type: ThreadType? { entry.map { ThreadType(rawValue: $0.type.rawValue) } ?? model?.thread?.type }

	private var host: AgentParticipant? {
		model?.details?.participants.compactMap(\.agent).first { $0.id == model?.thread?.hostAgentId }
	}

	private var mine: AgentParticipant? {
		model?.details?.participants.compactMap(\.agent).first { $0.id == chatAgentId } ?? host
	}

	private var other: AgentParticipant? {
		model?.details?.participants.compactMap(\.agent).first { $0.id != mine?.id }
	}

	private var header: some View {
		let title = model?.thread?.title ?? entry?.title ?? "Thread"
		let heading = type == .collaboration ? "Collaboration" : title
		let subheading = type == .collaboration ? other.map { "\(mine?.name ?? "") and \($0.name)" } : nil
		return HStack(alignment: .center, spacing: 12) {
			if asPage { HeaderBack() }
			Text(heading).font(Typeface.rubik(15, .semibold)).foregroundStyle(Palette.foreground).lineLimit(1)
				.accessibilityAddTraits(.isHeader)
			if let subheading {
				Text(subheading).font(Typeface.rubik(13)).foregroundStyle(Palette.subtleForeground).lineLimit(1)
			}
			Spacer(minLength: 0)
			if !asPage {
				SmallIconButton(icon: .x, label: "Close") { dismiss() }.frame(width: 30, height: 30)
			}
		}
		.padding(.leading, asPage ? 16 : 18)
		.padding(.trailing, 12)
		.frame(minHeight: 52)
		.padding(.top, asPage ? 12 : 0)
		.padding(.bottom, asPage ? 8 : 0)
	}

	@ViewBuilder private var content: some View {
		if let model, let details = model.details, let host, let context = model.messageContext(looks: looks, filesConversationId: conversationId) {
			let messages: [Message] = model.items.compactMap { item in
				guard let message = item.message else { return nil }
				if type == .routine, case .routineTrigger = message.author { return nil }
				return message
			}
			ScrollView {
				LazyVStack(alignment: .leading, spacing: 0) {
					ForEach(Array(messages.enumerated()), id: \.element.id) { index, message in
						MessageRow(
							message: message,
							startsGroup: ChatGroups.startsGroup(index > 0 ? messages[index - 1] : nil, message),
							context: context,
							actions: MessageActions(openThread: openThread),
							compact: true
						)
					}
					if details.thread.status == .running, model.notices.isEmpty, messages.last?.author.personId != nil {
						TypingIndicator(names: [host.name]).padding(.horizontal, 18)
					}
					ForEach(Array(model.notices.enumerated()), id: \.offset) { _, notice in
						Text(notice).font(Typeface.rubik(12)).foregroundStyle(Palette.destructiveText).frame(maxWidth: .infinity).padding(.top, 8)
					}
				}
				.padding(.vertical, 8)
			}
			.defaultScrollAnchor(.bottom)
		} else if model?.loadError != nil {
			EmptyState(title: "Could not load this thread", text: "Go back and open it again.")
		} else {
			Text("Loading thread…").font(Typeface.rubik(14)).foregroundStyle(Palette.mutedForeground).frame(maxHeight: .infinity)
		}
	}
}
