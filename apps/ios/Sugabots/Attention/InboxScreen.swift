import SwiftUI

/// Inbox, as the web's `Inbox` on a phone: its large title with Unread only,
/// a filter by kind and Mark all as read at the right, then what happened in
/// the person's conversations, newest first, each opening where it happened.
@MainActor
struct InboxScreen: View {
	@Environment(WorkspaceStore.self) private var store
	@State private var unreadOnly = true
	@State private var kinds: Set<InboxKind> = []
	@State private var marking = false

	var body: some View {
		let inView = store.activity.filter { !unreadOnly || $0.unread }
		let items = inView.filter { kinds.isEmpty || kinds.contains(InboxKind($0)) }
		let unreadConversations = Set(store.activity.filter(\.unread).compactMap(\.conversationId))
		VStack(spacing: 0) {
			TabPageHeader(title: "Inbox") {
				HeaderIconToggle(on: unreadOnly, label: "Unread only") { unreadOnly.toggle() } icon: {
					UnreadOnlyIcon()
				}
				Menu {
					ForEach(InboxKind.allCases) { kind in
						let count = inView.filter { InboxKind($0) == kind }.count
						Button {
							if kinds.contains(kind) { kinds.remove(kind) } else { kinds.insert(kind) }
						} label: {
							if kinds.contains(kind) {
								Label(count > 0 ? "\(kind.label)  \(count)" : kind.label, systemImage: "checkmark")
							} else {
								Text(count > 0 ? "\(kind.label)  \(count)" : kind.label)
							}
						}
					}
				} label: {
					Icon(.listFilter, size: 20, strokeWidth: 1.75)
						.foregroundStyle(kinds.isEmpty ? Palette.mutedForeground : Palette.foreground)
						.frame(width: 40, height: 40)
						.background(kinds.isEmpty ? .clear : Palette.chip, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
				}
				.accessibilityLabel("Filter")
				if !unreadConversations.isEmpty {
					HeaderIconToggle(on: false, label: "Mark all as read") {
						marking = true
						Task {
							await store.markAllRead()
							marking = false
						}
					} icon: {
						Icon(.checkCheck, size: 20, strokeWidth: 1.75)
					}
					.disabled(marking)
				}
			}
			ScrollView {
				LazyVStack(spacing: 2) {
					if store.activityFailed {
						Text("Inbox could not be loaded.")
							.font(Typeface.rubik(13))
							.foregroundStyle(Palette.mutedForeground)
							.frame(maxWidth: .infinity, alignment: .leading)
							.padding(12)
					}
					ForEach(items) { item in
						InboxRow(item: item, pod: item.podId.flatMap(store.pod(id:)))
					}
				}
				.padding(8)
			}
			.overlay {
				if store.activityLoaded && items.isEmpty {
					VStack(spacing: 8) {
						Icon(.inbox, size: 40, strokeWidth: 1.25)
							.foregroundStyle(Palette.subtleForeground)
							.padding(.bottom, 8)
						Text(unreadOnly ? "Nothing unread" : "Nothing here yet")
							.font(Typeface.rubik(15))
							.foregroundStyle(Palette.mutedForeground)
						if unreadOnly {
							Button("Show everything") { unreadOnly = false }
								.font(Typeface.rubik(15, .medium))
								.foregroundStyle(Palette.foreground)
						}
					}
					.multilineTextAlignment(.center)
					.padding(.horizontal, 24)
				}
			}
			.refreshable { await store.refreshAttention() }
		}
		.background(Palette.background.ignoresSafeArea())
	}
}

/// What kind of thing an Inbox item is, as its filter names it.
enum InboxKind: String, CaseIterable, Identifiable {
	case mention, message, routine, collaboration

	var id: String { rawValue }

	init(_ item: ActivityItem) {
		switch item {
		case let .mentionOrMessage(message): self = message.kind == .mention ? .mention : .message
		case .routine: self = .routine
		case .collaboration, .unknown: self = .collaboration
		}
	}

	var label: String {
		switch self {
		case .mention: "Mentions"
		case .message: "Messages"
		case .routine: "Routines"
		case .collaboration: "Collaborations"
		}
	}
}

/// A tab's page header on a phone, as the web's `PageHeader` for a tab: its
/// large title at the left, and its controls at the right.
struct TabPageHeader<Actions: View>: View {
	let title: String
	@ViewBuilder var actions: Actions

	var body: some View {
		HStack(spacing: 2) {
			Text(title)
				.font(Typeface.rubik(28, .semibold))
				.tracking(-0.56)
				.foregroundStyle(Palette.foreground)
				.lineLimit(1)
				.frame(maxWidth: .infinity, alignment: .leading)
				.accessibilityAddTraits(.isHeader)
			actions
		}
		.pageHeaderInsets(trailing: 8)
	}
}

/// A header's quiet icon button, as the web's `bar` icon buttons roomy on a phone: filled while it's on.
struct HeaderIconToggle<Icon: View>: View {
	let on: Bool
	let label: String
	let action: () -> Void
	@ViewBuilder var icon: Icon

	var body: some View {
		Button(action: action) {
			icon
				.foregroundStyle(on ? Palette.foreground : Palette.softForeground)
				.frame(width: 40, height: 40)
				.background(on ? Palette.chip : .clear, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
				.contentShape(Rectangle())
		}
		.buttonStyle(.plain)
		.accessibilityLabel(label)
		.accessibilityAddTraits(on ? .isSelected : [])
	}
}

/// The web's Unread only mark: an inbox tray with a dot at its corner.
private struct UnreadOnlyIcon: View {
	var body: some View {
		ZStack(alignment: .topTrailing) {
			UnreadTray()
				.stroke(style: StrokeStyle(lineWidth: 1.75 * 20 / 24, lineCap: .round, lineJoin: .round))
			Circle().frame(width: 5 * 20 / 24, height: 5 * 20 / 24).offset(x: -2 * 20 / 24, y: 2 * 20 / 24)
		}
		.frame(width: 20, height: 20)
	}

	private struct UnreadTray: Shape {
		func path(in rect: CGRect) -> Path {
			var path = SVGPath.path("M22 12h-6l-2 3h-4l-2-3H2")
			path.addPath(SVGPath.path("M14 4H7.24a2 2 0 0 0-1.79 1.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-1.4-2.8"))
			return path.applying(CGAffineTransform(scaleX: rect.width / 24, y: rect.height / 24))
		}
	}
}

/// One thing in the Inbox: a dot while unread, its face, what happened with its pod's mark, and what was said and when.
@MainActor
private struct InboxRow: View {
	let item: ActivityItem
	let pod: Pod?

	var body: some View {
		let (title, detail) = words
		let content = HStack(alignment: .top, spacing: 12) {
			Circle()
				.fill(item.unread ? Palette.foreground : .clear)
				.frame(width: 6, height: 6)
				.padding(.top, 7)
				.accessibilityLabel(item.unread ? "Unread" : "")
			face
			VStack(alignment: .leading, spacing: 2) {
				HStack(spacing: 8) {
					Text(title)
						.font(Typeface.rubik(13, item.unread ? .semibold : .regular))
						.foregroundStyle(item.unread ? Palette.foreground : Palette.mutedForeground)
						.lineLimit(1)
						.frame(maxWidth: .infinity, alignment: .leading)
					if let pod {
						PodInitial(kind: pod.kind, name: pod.name, color: pod.color?.rawValue, size: .small).accessibilityElement().accessibilityLabel("in \(pod.name)")
					}
				}
				HStack(alignment: .firstTextBaseline, spacing: 8) {
					Text(detail)
						.font(Typeface.rubik(13))
						.foregroundStyle(Palette.mutedForeground)
						.lineLimit(1)
						.frame(maxWidth: .infinity, alignment: .leading)
					Text(Times.age(item.at)).font(Typeface.rubik(12)).foregroundStyle(Palette.subtleForeground)
				}
			}
		}
		.padding(10)
		.contentShape(Rectangle())
		if let route {
			NavigationLink(value: route) { content }
				.buttonStyle(PressableRowStyle(cornerRadius: 8))
		} else {
			content
		}
	}

	/// Where it opens: the conversation at its message, or a run's or collaboration's own page.
	private var route: Route? {
		guard pod != nil else { return nil }
		switch item {
		case let .mentionOrMessage(message):
			return .conversationAt(threadId: message.conversationId, messageId: message.messageId)
		case let .routine(run):
			return .sideThreadPage(conversationId: run.conversationId, threadId: run.threadId)
		case let .collaboration(collaboration):
			return .sideThreadPage(conversationId: collaboration.conversationId, threadId: collaboration.threadId)
		case .unknown:
			return nil
		}
	}

	private var words: (String, String) {
		switch item {
		case let .mentionOrMessage(message):
			let author = message.author
			if message.kind == .mention { return ("\(author.name) mentioned you", message.preview) }
			return (author.agent != nil ? "\(author.name) replied" : "\(author.name) wrote", message.preview)
		case let .routine(run):
			let activity: ActivityState = switch run.state {
			case .completed: .done
			case .failed, .cancelled: .failed
			case .queued, .running, .unknown: .running
			}
			return (activity.routineText(run.routineName), run.preview ?? run.agent.name)
		case let .collaboration(collaboration):
			let activity: ActivityState = switch collaboration.status {
			case .waiting: .running
			case .pending: .waitingOnYou
			case .answered: .done
			case .failed, .unknown: .failed
			}
			return (activity.collaborationText(host: collaboration.initiator.name, other: collaboration.recipient.name), collaboration.brief)
		case .unknown:
			return ("", "")
		}
	}

	@ViewBuilder private var face: some View {
		switch item {
		case let .routine(run):
			BotFace(look: run.agent.look, size: 24)
				.overlay(alignment: .bottomTrailing) {
					Icon(TriggerIcons.of(run.triggerKind), size: 11, strokeWidth: 2.4)
						.foregroundStyle(Palette.foreground)
						.frame(width: 16, height: 16)
						.background(Palette.chipStrong, in: Circle())
						.padding(2)
						.background(Palette.background, in: Circle())
						.offset(x: 8, y: 8)
				}
		case let .collaboration(collaboration):
			ZStack(alignment: .leading) {
				BotFace(look: collaboration.initiator.look, size: 24)
				BotFace(look: collaboration.recipient.look, size: 24)
					.padding(2)
					.background(Palette.background, in: Circle())
					.offset(x: 10)
			}
			.frame(width: 36, height: 24, alignment: .leading)
		case let .mentionOrMessage(message):
			ParticipantFace(participant: message.author, size: 24)
		case .unknown:
			Color.clear.frame(width: 24, height: 24)
		}
	}
}

/// A routine trigger's mark: a clock, a webhook, a branch, or a run by hand.
enum TriggerIcons {
	static func of(_ kind: RoutineExecutionTriggerKind) -> Lucide {
		switch kind {
		case .cron: .clock
		case .webhook: .webhook
		case .github: .gitBranch
		case .manual, .unknown: .refreshCw
		}
	}
}
