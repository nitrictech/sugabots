import SwiftUI

/// A bot's threads, as the web's `ThreadsStage` on a phone: those still going,
/// or those done, newest first, each with when it last moved and its latest
/// message. Each opens its thread, and Back returns here for the next.
@MainActor
struct ThreadsScreen: View {
	let pod: Pod
	let agent: Agent
	@Environment(WorkspaceStore.self) private var store
	@State private var tab: Tab = .open

	enum Tab: Hashable {
		case open
		case done
	}

	var body: some View {
		let list = store.chatLists[pod.id]
		let all = (list?.threads ?? []).filter { $0.agent?.id == agent.id }
		let going = all.filter { $0.conversation.doneAt == nil }
		let done = all.filter { $0.conversation.doneAt != nil }
		let shown = tab == .done ? done : going
		VStack(alignment: .leading, spacing: 0) {
			PodPageHeader(title: "\(agent.name)'s threads") {}
			SegmentedChoice(
				label: "Which threads",
				options: [(.open, "Open · \(going.count)"), (.done, "Done · \(done.count)")],
				value: tab,
				fill: true,
				size: .large
			) { tab = $0 }
			// Filling the row, its choices would also grow as tall as the page offers.
			.fixedSize(horizontal: false, vertical: true)
			.padding(.horizontal, 16)
			.padding(.bottom, 8)
			if list != nil, shown.isEmpty {
				EmptyState(
					title: tab == .done ? "No done threads" : "No open threads",
					text: tab == .done
						? "Threads with \(agent.name) you mark done show here."
						: "Start one with the + beside \(agent.name) on Home."
				)
				.padding(.bottom, 60)
			} else {
				ScrollView {
					LazyVStack(spacing: 1) {
						ForEach(shown) { row in
							ThreadListRow(row: row)
						}
					}
					.padding(.horizontal, 8)
					.padding(.bottom, 8)
				}
			}
		}
		.background(Palette.background.ignoresSafeArea())
		.task { await store.refreshChatList(pod) }
	}
}

/// A thread in the list: its title, ticked when done, and when it last moved;
/// under it, the faces of who is in it and its latest message. Bright while it
/// has unread messages and isn't done.
@MainActor
private struct ThreadListRow: View {
	let row: ChatListItem

	var body: some View {
		let done = row.conversation.doneAt != nil
		let lit = !done && row.unreadMessages > 0
		NavigationLink(value: Route.conversation(threadId: row.conversation.id, title: row.conversation.title)) {
			VStack(alignment: .leading, spacing: 3) {
				HStack(spacing: 8) {
					if done {
						Icon(.check, size: 12, strokeWidth: 2.25).foregroundStyle(Palette.subtleForeground)
					}
					Text(row.conversation.title)
						.font(Typeface.rubik(15, lit ? .semibold : .regular))
						.foregroundStyle(lit ? Palette.foreground : Palette.softForeground)
						.lineLimit(1)
					Spacer(minLength: 0)
					if let last = row.lastMessage {
						Text(TimeAgo.words(since: last.at))
							.font(Typeface.rubik(12))
							.foregroundStyle(Palette.subtleForeground)
					}
				}
				if !row.participants.isEmpty || row.lastMessage != nil {
					HStack(spacing: 8) {
						ParticipantFaces(participants: row.participants, size: 16)
						if let last = row.lastMessage {
							Text(last.preview)
								.font(Typeface.rubik(12))
								.foregroundStyle(Palette.subtleForeground)
								.lineLimit(1)
						}
					}
				}
			}
			.padding(.horizontal, 10)
			.padding(.vertical, 8)
			.frame(maxWidth: .infinity, alignment: .leading)
			.contentShape(Rectangle())
		}
		.buttonStyle(PressableRowStyle(cornerRadius: 8))
	}
}

/// How long ago a time was, in words, as the web's `formatDistanceToNowStrict`
/// writes it: "4 minutes ago", "18 days ago", "6 months ago".
enum TimeAgo {
	static func words(since date: Date, now: Date = .now) -> String {
		formatter.localizedString(for: date, relativeTo: now)
	}

	private static let formatter: RelativeDateTimeFormatter = {
		let formatter = RelativeDateTimeFormatter()
		formatter.unitsStyle = .full
		// "1 day ago", not "yesterday", as the web writes it.
		formatter.dateTimeStyle = .numeric
		return formatter
	}()
}

/// The faces of who is in a thread, overlapping in a row, as the web's
/// `ParticipantFaces`: people first, then bots, each in the order given, the
/// first `shown` of them and then how many more. Each is ringed in `surface`,
/// the colour of what the row is on, so it reads apart from the one under it.
/// For decoration only: whatever holds it names who is in the thread.
struct ParticipantFaces: View {
	let participants: [ThreadParticipant]
	var shown = 4
	var size: CGFloat = 20
	var surface: Color = Palette.background

	/// How far each face sits over the one before it, as a share of its size.
	private static let overlap: CGFloat = 0.3
	private static let ringWidth: CGFloat = 2

	var body: some View {
		let people = participants.filter { if case .person = $0 { true } else { false } }
		let bots = participants.filter { if case .agent = $0 { true } else { false } }
		let faces = Array((people + bots).prefix(shown))
		let hidden = people.count + bots.count - faces.count
		HStack(spacing: -(size * Self.overlap).rounded()) {
			ForEach(Array(faces.enumerated()), id: \.offset) { _, participant in
				ringed(ParticipantFace(participant: participant, size: size))
			}
			if hidden > 0 {
				ringed(
					Text("+\(hidden)")
						.font(Typeface.rubik(max(9, (size * 0.45).rounded()), .semibold))
						.foregroundStyle(Palette.mutedForeground)
						.frame(width: size, height: size)
						.background(Palette.chip, in: Circle())
				)
			}
		}
		.accessibilityHidden(true)
	}

	private func ringed(_ face: some View) -> some View {
		face.background(Circle().fill(surface).padding(-Self.ringWidth))
	}
}
