import Foundation
import Observation

/// One workspace as the signed-in person sees it: its pods and bots, each
/// pod's channels, threads and routines, Inbox and Approvals. Kept fresh by
/// the workspace's event stream, which says what changed but not how, so
/// each event refreshes what it may have touched.
@MainActor
@Observable
final class WorkspaceStore {
	let client: APIClient
	let user: SessionUser
	let workspaces: [Workspace]
	let workspace: Workspace

	private(set) var pods: [Pod] = []
	private(set) var agents: [Agent] = []
	private(set) var markers: [String: PodChatMarkers.Pod] = [:]
	private(set) var chatLists: [String: ChatList] = [:]
	private(set) var activity: [ActivityItem] = []
	/// Whether the Inbox has loaded once, and whether its latest load failed.
	private(set) var activityLoaded = false
	private(set) var activityFailed = false
	private(set) var approvalsLoaded = false
	private(set) var approvalsFailed = false
	private(set) var approvals = ApprovalInbox(waiting: [], answered: [])
	private(set) var notificationSettings: NotificationSettings?
	/// What you may do in the workspace, and your role there.
	private(set) var permissions: WorkspacePermissions?
	private(set) var role: WorkspaceRole?
	/// Conversations as they were when last left, so one opened again shows at once while it refreshes.
	/// Not observed: nothing redraws when one is kept.
	@ObservationIgnored var leftConversations: [String: ConversationModel.Snapshot] = [:]
	/// The models the workspace's bots may run on, for naming a bot's.
	private(set) var enabledModels: WorkspaceModelsResponse?
	private(set) var loadError: String?

	private var listening: Task<Void, Never>?
	private var pendingRefresh: Task<Void, Never>?

	/// How long events gather before one refresh answers them all: a reply streaming in sends many.
	private static let refreshDelay: Duration = .milliseconds(400)

	init(client: APIClient, user: SessionUser, workspaces: [Workspace], workspace: Workspace) {
		self.client = client
		self.user = user
		self.workspaces = workspaces
		self.workspace = workspace
	}

	var unreadInInbox: Int { activity.filter(\.unread).count }
	var waitingApprovals: Int { approvals.waiting.count }

	/// Shared pods first, then the person's own, as the web's rail orders them.
	var podsInRailOrder: [Pod] {
		pods.filter { $0.kind == .shared } + pods.filter { $0.kind == .personal }
	}

	func pod(id: String) -> Pod? { pods.first { $0.id == id } }

	func agent(id: String) -> Agent? { agents.first { $0.id == id } }

	/// The pod's own bots, by name, leaving out the system bots every pod has.
	func bots(in pod: Pod) -> [Agent] {
		agents.filter { $0.podId == pod.id && $0.systemAgentKey == nil }.sorted { $0.name.localizedCompare($1.name) == .orderedAscending }
	}

	/// The pod's open threads, or those with `agent`: unread first, each part newest first.
	func openThreads(in pod: Pod, with agent: Agent? = nil) -> [ChatListItem] {
		let open = (chatLists[pod.id]?.threads ?? []).filter { item in
			item.conversation.doneAt == nil && (agent == nil || item.agent?.id == agent?.id)
		}
		return open.filter(\.isNew) + open.filter { !$0.isNew }
	}

	/// Whether anything with the bot is new: its channel, or one of its threads.
	func hasNews(with agent: Agent, in pod: Pod) -> Bool {
		let list = chatLists[pod.id]
		let channelIsNew = list?.channels.first { $0.agent.id == agent.id }?.isNew ?? false
		return channelIsNew || openThreads(in: pod, with: agent).contains(where: \.isNew)
	}

	/// Where a thread was started: a pod's channel, a bot's channel, or with the bot directly.
	func origin(of thread: ConversationThread) -> ThreadOrigin {
		if let chatId = thread.startedInChatId, let channel = channel(chatId, in: thread.podId) {
			return channel
		}
		if let agent = thread.hostAgentId.flatMap(agent(id:)) {
			return .bot(agent)
		}
		return .people
	}

	/// The pod's channel or bot's channel `conversationId`, as a thread's origin names it, once the pod's list has it.
	func channel(_ conversationId: String, in podId: String) -> ThreadOrigin? {
		if let chat = podChat(conversationId, in: podId) {
			return .channel(chat.title)
		}
		if let channel = chatLists[podId]?.channels.first(where: { $0.id == conversationId }) {
			return .bot(channel.agent)
		}
		return nil
	}

	/// Whether the person has yet to read something in the thread.
	func isNew(threadId: String, in podId: String) -> Bool {
		chatLists[podId]?.threads.first { $0.id == threadId }?.isNew ?? false
	}

	/// The routine whose runs post in the thread `threadId`.
	func routine(postingIn threadId: String, podId: String) -> ListedRoutine? {
		chatLists[podId]?.routines.first { $0.conversation?.id == threadId }
	}

	func hasNews(in pod: Pod) -> Bool {
		guard let marker = markers[pod.id] else { return false }
		return marker.unreadMessages > 0 || marker.needsApproval || marker.failedRoutines > 0
	}

	// MARK: Loading

	func start() async {
		await refreshAll()
		guard listening == nil else { return }
		listening = Task { [weak self, client, workspace] in
			for await _ in EventStream.workspace(workspace.id, client: client) {
				self?.scheduleRefresh()
			}
			// Refused, so the next `start` listens again.
			self?.listening = nil
		}
	}

	func stop() {
		listening?.cancel()
		listening = nil
		pendingRefresh?.cancel()
	}

	func refreshAll() async {
		do {
			async let pods = client.pods.list(workspace: workspace.id)
			async let agents = client.agents.list(workspace: workspace.id)
			(self.pods, self.agents) = try await (pods, agents)
			loadError = nil
		} catch {
			loadError = error.localizedDescription
		}
		async let settings = try? client.notifications.settings()
		async let accessRefreshed: Void = refreshAccess()
		if let settings = await settings { notificationSettings = settings }
		await accessRefreshed
		enabledModels = try? await workspaceModels()
		await refreshAttention()
		await refreshLoadedChatLists()
	}

	/// Reloads what you may do and your role, keeping what was known if the
	/// request fails. The settings pages call it as they open, so a role
	/// changed since the last full refresh shows there.
	func refreshAccess() async {
		guard let access = try? await client.workspaceAccess(workspace: workspace.id) else { return }
		permissions = access.permissions
		role = access.role
	}

	/// The rail's markers, Inbox and Approvals: what the tab bar counts.
	func refreshAttention() async {
		async let markers = try? client.chats.podMarkers(workspace: workspace.id)
		async let activity = try? client.chats.activity(workspace: workspace.id)
		async let approvals = try? client.chats.approvals(workspace: workspace.id)
		if let markers = await markers { self.markers = markers.pods }
		if let activity = await activity {
			self.activity = activity.items
			activityLoaded = true
			activityFailed = false
		} else {
			activityFailed = true
		}
		if let approvals = await approvals {
			self.approvals = approvals
			approvalsLoaded = true
			approvalsFailed = false
		} else {
			approvalsFailed = true
		}
	}

	func refreshChatList(_ pod: Pod) async {
		if let list = try? await client.chats.list(workspace: workspace.id, pod: pod.id) {
			chatLists[pod.id] = list
		}
	}

	/// Every pod's list that has been loaded, so what's on screen catches up.
	private func refreshLoadedChatLists() async {
		for podId in chatLists.keys {
			if let pod = pod(id: podId) { await refreshChatList(pod) }
		}
	}

	private func scheduleRefresh() {
		pendingRefresh?.cancel()
		pendingRefresh = Task {
			try? await Task.sleep(for: Self.refreshDelay)
			guard !Task.isCancelled else { return }
			await refreshAttention()
			await refreshLoadedChatLists()
		}
	}

	// MARK: Doing things

	/// The pod's first channel, General, opened first if nobody has.
	func openPodChat(in pod: Pod) async throws -> PodChat {
		if let main = chatLists[pod.id]?.chats.first(where: \.conversation.main) { return main.conversation }
		let chat = try await client.chats.openPodChat(workspace: workspace.id, podId: pod.id)
		await refreshChatList(pod)
		return chat
	}

	/// A new shared pod, named `name`, in `color`.
	func createPod(named name: String, color: PodColor) async throws -> Pod {
		let pod = try await client.pods.create(workspace: workspace.id, name: name, color: color)
		pods.append(pod)
		return pod
	}

	/// A new channel in a shared pod, named `name`.
	func startChat(in pod: Pod, named name: String) async throws -> PodChat {
		let chat = try await client.chats.startChat(podId: pod.id, name: name)
		await refreshChatList(pod)
		return chat
	}

	/// Chooses `level` for `place`, or with nil, follows the level above it, which also ends a mute.
	func setNotificationLevel(_ level: NotificationLevel?, for place: NotificationPlace) async throws {
		try await client.notifications.setLevel(kind: place.kind, id: place.id, level: level)
		notificationSettings = try await client.notifications.settings()
	}

	/// Mutes `place` until `until`, or with nil, unmutes it.
	func mute(_ place: NotificationPlace, until: Date?) async throws {
		try await client.notifications.mute(kind: place.kind, id: place.id, until: until)
		notificationSettings = try await client.notifications.settings()
	}

	/// Records that the person has read the conversation to its newest message.
	func markRead(conversationId: String) async {
		try? await client.chats.markRead(conversationId: conversationId)
		await refreshAttention()
	}

	func markAllRead() async {
		let conversations = Set(activity.filter(\.unread).compactMap(\.conversationId))
		await withTaskGroup(of: Void.self) { group in
			for conversationId in conversations {
				group.addTask { [client] in
					try? await client.chats.markRead(conversationId: conversationId)
				}
			}
		}
		await refreshAttention()
	}

	typealias Decision = ToolApprovalDecision.Decision

	func decide(_ decision: Decision, toolCallId: String, podId: String) async throws {
		try await client.toolApprovals.decide(podId: podId, toolCallId: toolCallId, decision: decision)
		await refreshAttention()
	}

	/// The bot's channel in the pod: the one listed, or opened now on first use.
	func botChannel(in pod: Pod, with agent: Agent) async throws -> BotChannel {
		if let listed = chatLists[pod.id]?.channels.first(where: { $0.agent.id == agent.id }) {
			return listed.conversation
		}
		let channel = try await client.chats.openBotChannel(workspace: workspace.id, podId: pod.id, hostAgentId: agent.id)
		await refreshChatList(pod)
		return channel
	}

	/// The thread started from a message in a channel, started now if it has none:
	/// with the bot in a bot's channel, between people in a pod's.
	func thread(from message: Message, podId: String) async throws -> ConversationThread {
		let thread = try await client.chats.threadFrom(messageId: message.id)
		if let pod = pod(id: podId) { await refreshChatList(pod) }
		return thread
	}

	/// Makes a bot in `pod` and adds it to the pod's bots.
	func createBot(in pod: Pod, name: String, look: BotLook, model: String) async throws -> Agent {
		let agent = try await client.agents.create(
			podId: pod.id,
			name: name,
			color: AgentColor(rawValue: look.color),
			face: AgentFace(rawValue: look.face),
			shape: AgentShape(rawValue: look.shape),
			model: model
		)
		agents.append(agent)
		return agent
	}

	func workspaceModels() async throws -> WorkspaceModelsResponse {
		try await client.modelProviders.listEnabledModels(workspace: workspace.id)
	}

	/// Whether the workspace has computers set up for its bots.
	func computersEnabled() async throws -> Bool {
		try await client.sandboxProviders.access(workspace: workspace.id).enabled
	}

	/// Gives the bot a computer in its pod's sandbox.
	func giveComputer(to agent: Agent) async throws {
		let updated = try await client.agents.update(agentId: agent.id, usesSandbox: true)
		if let index = agents.firstIndex(where: { $0.id == updated.id }) { agents[index] = updated }
	}

	/// A routine's thread, opened the first time somebody looks at it.
	func routineFeed(for routine: ListedRoutine) async throws -> RoutineFeed {
		if let feed = routine.conversation { return feed }
		return try await client.chats.openRoutineFeed(workspace: workspace.id, routineId: routine.routine.id)
	}
}

/// Where a thread was started, as its rows and header name it.
enum ThreadOrigin {
	case channel(String)
	case bot(Agent)
	case people

	var name: String {
		switch self {
		case let .channel(name): "#\(name)"
		case let .bot(agent): agent.name
		case .people: "People"
		}
	}
}
