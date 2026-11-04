import SwiftUI

/// A conversation's Details on a phone, the whole screen with a glass Back,
/// as the web's `DetailsSidebar`, `ChannelDetails`, `PeopleDetails` and,
/// for a routine's thread, `RoutinePanel`.
@MainActor
struct ConversationDetails: View {
	let model: ConversationModel
	@Environment(WorkspaceStore.self) private var store

	var body: some View {
		let kind = store.kind(of: model)
		if let details = model.details, let pod = store.pod(id: details.thread.podId) {
			if let routine = details.routine, let agent = kind.agent {
				RoutinePanel(agent: agent, pod: pod, conversationId: model.conversationId, standing: routine)
			} else {
				DetailsPage {
					switch kind {
					case let .botChannel(agent), let .botThread(agent):
						BotDetails(agent: agent, pod: pod, threadId: details.thread.id)
					case let .podChat(name):
						ChannelHeading(model: model, pod: pod, details: details, name: name)
					case .peopleThread:
						EmptyView()
					}
					InThisThread(participants: details.participants)
					SharedFiles(files: sharedFiles, conversationId: model.conversationId)
				}
			}
		}
	}

	/// The files posted here, newest first.
	private var sharedFiles: [FilePart] {
		model.items.reversed().flatMap { $0.message?.files ?? [] }
	}
}

/// A Details page: Back floating at the top left, then its sections.
private struct DetailsPage<Content: View>: View {
	@ViewBuilder var content: Content

	var body: some View {
		ScrollView {
			VStack(alignment: .leading, spacing: 0) { content }
				.padding(.bottom, 24)
		}
		.safeAreaInset(edge: .top, spacing: 0) {
			HStack { PhoneBackButton(); Spacer() }
				.pageHeaderInsets()
		}
		.background(Palette.aside.ignoresSafeArea())
	}
}

/// The top of a Details page: a large face or mark, the name under it, a line under that, and round actions.
private struct DetailsHeading<Mark: View, Actions: View>: View {
	let name: String
	let line: String
	@ViewBuilder var mark: Mark
	@ViewBuilder var actions: Actions

	var body: some View {
		VStack(spacing: 10) {
			mark
			VStack(spacing: 2) {
				Text(name).font(Typeface.rubik(22, .semibold)).foregroundStyle(Palette.foreground).lineLimit(1)
				Text(line).font(Typeface.rubik(14)).foregroundStyle(Palette.subtleForeground).lineLimit(1)
			}
			HStack(spacing: 28) { actions }.padding(.top, 8)
		}
		.multilineTextAlignment(.center)
		.frame(maxWidth: .infinity)
		.padding(.horizontal, 16)
		.padding(.top, 4)
		.padding(.bottom, 16)
	}
}

/// A round action under a Details heading: an icon on a chip, its name under it.
private struct RoundAction<Label: View>: View {
	let icon: Lucide
	let label: String
	@ViewBuilder var wrap: (AnyView) -> Label

	var body: some View {
		wrap(AnyView(
			VStack(spacing: 6) {
				Icon(icon, size: 20, strokeWidth: 1.75)
					.foregroundStyle(Palette.foreground)
					.frame(width: 48, height: 48)
					.background(Palette.chip, in: Circle())
				Text(label).font(Typeface.rubik(13)).foregroundStyle(Palette.softForeground)
			}
			.frame(width: 64)
		))
	}
}

/// A section of Details on a phone: its title in small grey type over a card.
struct DetailsSection<End: View, Content: View>: View {
	let title: String
	@ViewBuilder var end: End
	@ViewBuilder var content: Content

	var body: some View {
		VStack(alignment: .leading, spacing: 8) {
			HStack(spacing: 8) {
				Text(title).font(Typeface.rubik(13, .medium)).foregroundStyle(Palette.subtleForeground).frame(maxWidth: .infinity, alignment: .leading)
				end
			}
			.padding(.horizontal, 4)
			VStack(alignment: .leading, spacing: 10) { content }
				.padding(.horizontal, 16)
				.padding(.vertical, 8)
				.frame(maxWidth: .infinity, alignment: .leading)
				.background(Palette.card, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
				.overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Palette.border))
		}
		.padding(.horizontal, 16)
		.padding(.vertical, 10)
	}
}

extension DetailsSection where End == EmptyView {
	init(title: String, @ViewBuilder content: () -> Content) {
		self.init(title: title, end: { EmptyView() }, content: content)
	}
}

/// A bot's Details: its face large, its model, Settings and Routines, then its summary, memory and routines.
@MainActor
private struct BotDetails: View {
	let agent: Agent
	let pod: Pod
	let threadId: String
	@Environment(WorkspaceStore.self) private var store
	@Environment(\.openPage) private var openPage
	@State private var activity: ThreadActivity?
	@State private var summaryOpen = false
	/// Whether the system agent that writes summaries has a model; nil until known.
	@State private var scribeHasModel: Bool?

	/// How long a summary runs before it folds.
	private static let summaryFoldedOver = 240

	var body: some View {
		DetailsHeading(name: agent.name, line: store.modelName(agent.model) ?? "No model chosen") {
			BotFace(look: agent.look, size: 88)
		} actions: {
			RoundAction(icon: .settings, label: "Settings") { label in
				Button { openPage(.settings(.agent(pod, agent))) } label: { label }.buttonStyle(.plain)
			}
			RoundAction(icon: .refreshCcw, label: "Routines") { label in
				NavigationLink(value: Route.routines(pod, agent: agent)) { label }.buttonStyle(.plain)
			}
		}
		DetailsSection(title: "Summary") {
			if scribeHasModel == false {
				SystemAgentsNotSetUp()
			} else {
				summary
			}
		}
		if let context = activity?.context {
			DetailsSection(title: "Memory") {
				Text("\(Self.usedPercent(context))%").font(Typeface.mono(12)).foregroundStyle(Palette.mutedForeground)
			} content: {
				MemoryMeter(context: context).padding(.vertical, 6)
			}
		}
		BotRoutinesSection(pod: pod, agent: agent)
		BotToolsSection(pod: pod, agent: agent)
			.task {
				activity = try? await store.client.threads.activity(threadId: threadId)
				scribeHasModel = await store.summariesHaveModel()
			}
	}

	@ViewBuilder private var summary: some View {
		let text = activity?.summary?.content
		let folds = (text?.count ?? 0) > Self.summaryFoldedOver
		Text(text ?? "A summary will appear after the first reply.")
			.font(Typeface.rubik(13))
			.lineSpacing(4)
			.foregroundStyle(text == nil ? Palette.mutedForeground : Palette.softForeground)
			.lineLimit(folds && !summaryOpen ? 3 : nil)
		if folds {
			ShowMoreButton(open: $summaryOpen)
		}
	}

	static func usedPercent(_ context: ThreadContext) -> Int {
		Int((min(Double(context.usedTokens) / Double(max(context.windowTokens, 1)), 1) * 100).rounded())
	}
}

/// How much of the bot's short-term memory the thread fills, with a tick where it starts compacting.
private struct MemoryMeter: View {
	let context: ThreadContext

	var body: some View {
		let used = Double(BotDetails.usedPercent(context)) / 100
		let line = Double(context.compactionLineTokens) / Double(max(context.windowTokens, 1))
		let compactedSince = context.compactedAt.map { $0 > context.measuredAt } ?? false
		GeometryReader { geometry in
			ZStack(alignment: .leading) {
				Capsule().fill(Palette.chipStrong)
				Capsule().fill(Palette.primary).frame(width: geometry.size.width * used)
				Rectangle().fill(Palette.mutedForeground).frame(width: 1, height: 9).offset(x: geometry.size.width * line)
			}
		}
		.frame(height: 3)
		.opacity(compactedSince ? 0.4 : 1)
		.accessibilityElement()
		.accessibilityLabel("Short-term memory used")
		.accessibilityValue("\(Int(used * 100)) percent")
	}
}

/// A pod channel's Details: its mark, how many people and bots, and Rename and Archive.
@MainActor
private struct ChannelHeading: View {
	let model: ConversationModel
	let pod: Pod
	let details: ThreadDetails
	let name: String
	@Environment(WorkspaceStore.self) private var store
	@Environment(\.dismiss) private var dismiss
	@State private var renaming = false
	@State private var archiving = false
	@State private var archiveFailed = false

	var body: some View {
		let listed = store.podChat(model.conversationId, in: pod.id)
		let (people, bots) = details.headCount
		DetailsHeading(name: name, line: "\(people), \(bots)") {
			ChannelFace(size: 88)
		} actions: {
			if listed != nil, pod.permissions.rename {
				RoundAction(icon: .pencil, label: "Rename") { label in
					Button { renaming = true } label: { label }.buttonStyle(.plain)
				}
				if listed?.main == false {
					RoundAction(icon: .archive, label: "Archive") { label in
						Button { archiving = true } label: { label }.buttonStyle(.plain)
					}
				}
			}
		}
		.sheet(isPresented: $renaming) {
			NameSheet.channel(title: "Rename channel", name: name, action: "Save") { renamed in
				try await store.renameChat(model.conversationId, to: renamed, in: pod)
				renaming = false
			}
		}
		.confirmationDialog("Archive \(name)?", isPresented: $archiving, titleVisibility: .visible) {
			Button("Archive", role: .destructive) {
				Task {
					do {
						try await store.archiveChat(model.conversationId, in: pod)
						dismiss()
					} catch {
						archiveFailed = true
					}
				}
			}
		} message: {
			Text("It leaves the pod's list for everyone. Threads started from it stay.")
		}
		.alert("The channel was not archived. Try again.", isPresented: $archiveFailed) {}
	}
}

/// Who is in the thread: each face, name, and whether a bot, you, or a member.
@MainActor
private struct InThisThread: View {
	let participants: [ThreadParticipant]
	@Environment(WorkspaceStore.self) private var store

	var body: some View {
		if !participants.isEmpty {
			DetailsSection(title: "In this thread") {
				VStack(spacing: 0) {
					ForEach(participants, id: \.id) { participant in
						HStack(spacing: 12) {
							ParticipantFace(participant: participant, size: 22)
							Text(participant.name).font(Typeface.rubik(15)).foregroundStyle(Palette.foreground).lineLimit(1)
							Spacer(minLength: 0)
							Text(participant.agent != nil ? "Bot" : participant.id == store.user.id ? "You" : "Member")
								.font(Typeface.rubik(12))
								.foregroundStyle(Palette.subtleForeground)
						}
						.frame(height: 44)
					}
				}
			}
		}
	}
}

/// The files posted in the thread, the first few with Show more.
@MainActor
private struct SharedFiles: View {
	let files: [FilePart]
	let conversationId: String
	@Environment(WorkspaceStore.self) private var store
	@Environment(Toaster.self) private var toaster
	@State private var open = false
	@State private var sharing: SavedFile?

	/// How many files show before Show more.
	private static let shown = 3

	var body: some View {
		if !files.isEmpty {
			DetailsSection(title: "Files") {
				VStack(alignment: .leading, spacing: 0) {
					ForEach(open ? files : Array(files.prefix(Self.shown))) { file in
						Button { fetch(file) } label: {
							HStack(spacing: 12) {
								Icon(.fileText, size: 12, strokeWidth: 2)
									.foregroundStyle(Palette.mutedForeground)
									.frame(width: 22, height: 22)
									.overlay(RoundedRectangle(cornerRadius: 6, style: .continuous).strokeBorder(Palette.borderStrong))
								Text(file.name).font(Typeface.rubik(15)).foregroundStyle(Palette.foreground).lineLimit(1)
								Spacer(minLength: 0)
							}
							.frame(height: 44)
							.contentShape(Rectangle())
						}
						.buttonStyle(PressableRowStyle(pressed: Palette.rowSelected, cornerRadius: 6))
					}
					if files.count > Self.shown {
						ShowMoreButton(open: $open).padding(.vertical, 4)
					}
				}
			}
			.sheet(item: $sharing) { ShareSheet(items: [$0.url]) }
		}
	}

	private func fetch(_ file: FilePart) {
		Task {
			do {
				sharing = SavedFile(url: try await ChatFiles.local(file, in: conversationId, client: store.client))
			} catch {
				toaster.show(error.localizedDescription)
			}
		}
	}
}

/// Why there's no summary yet: the system agents that write them have no model, and who chooses it.
@MainActor
private struct SystemAgentsNotSetUp: View {
	@Environment(WorkspaceStore.self) private var store
	@Environment(\.openPage) private var openPage

	var body: some View {
		let may = store.permissions?.configureBuiltInAgents ?? false
		Group {
			if may {
				Button { openPage(.settings(.systemModel)) } label: {
					(Text("The system agents write these, and they have no model yet. ") + Text("Choose their model").foregroundStyle(Palette.foreground).fontWeight(.medium) + Text("."))
						.multilineTextAlignment(.leading)
				}
				.buttonStyle(.plain)
			} else {
				Text("The system agents write these, and they have no model yet. A workspace administrator chooses their model.")
			}
		}
		.font(Typeface.rubik(15))
		.lineSpacing(5)
		.foregroundStyle(Palette.mutedForeground)
		.padding(.top, 12)
	}
}

extension WorkspaceStore {
	/// Whether the system agent that writes summaries has a model; nil when it can't be told.
	func summariesHaveModel() async -> Bool? {
		let agents = try? await client.systemAgents.list(workspace: workspace.id)
		return agents?.first { $0.key == .summarise }.map { $0.model != nil }
	}
}
