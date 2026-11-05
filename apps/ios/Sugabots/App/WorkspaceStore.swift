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
	private(set) var user: SessionUser
	private(set) var workspaces: [Workspace]
	private(set) var workspace: Workspace
	/// What this device remembers about the workspace, such as the pod Home shows.
	let preferences: WorkspacePreferences

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

	private var pendingRefresh: Task<Void, Never>?
	/// How many loads of each kind have begun, so `loadLatest` can tell a load overtaken by a later one.
	@ObservationIgnored private var loadsBegun: [LoadKind: Int] = [:]

	/// How long events gather before one refresh answers them all: a reply streaming in sends many.
	private static let refreshDelay: Duration = .milliseconds(400)

	init(client: APIClient, user: SessionUser, workspaces: [Workspace], workspace: Workspace) {
		self.client = client
		self.user = user
		self.workspaces = workspaces
		self.workspace = workspace
		preferences = WorkspacePreferences(workspaceId: workspace.id)
	}

	/// Renames the signed-in person, everywhere the app shows their name.
	func rename(to name: String) async throws {
		try await client.updateName(name)
		user.name = name
	}

	/// Renames the workspace, keeping its slug, which every link to it holds.
	func renameWorkspace(to name: String) async throws {
		let renamed = try await client.workspaces.update(workspace: workspace.id, name: name, slug: workspace.slug)
		workspace.name = renamed.name
		workspaces = workspaces.map { $0.id == renamed.id ? renamed : $0 }
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

	/// Loads the workspace, then keeps it fresh from its event stream until the
	/// task running this is cancelled. Throws the server's refusal of the
	/// stream, such as a 401 `APIFailure` for a token that has expired.
	func run() async throws {
		await refreshAll()
		for try await _ in EventStream.workspace(workspace.id, client: client) {
			scheduleRefresh()
		}
	}

	func stop() {
		pendingRefresh?.cancel()
	}

	/// Reloads everything the workspace's pages show. A failure to load the pods
	/// and bots shows in `loadError`. The rest keeps what was last loaded when
	/// its request fails: Inbox and Approvals say so themselves, and each page
	/// that needs the settings, your access or the models reloads them as it
	/// opens and shows its own failure.
	func refreshAll() async {
		await loadLatest(.podsAndAgents) { [client, workspace] in
			async let pods = client.pods.list(workspace: workspace.id)
			async let agents = client.agents.list(workspace: workspace.id)
			return try await (pods, agents)
		} apply: { result in
			switch result {
			case let .success((pods, agents)):
				(self.pods, self.agents) = (pods, agents)
				loadError = nil
			case let .failure(error):
				loadError = error.localizedDescription
			}
		}
		async let settingsRefreshed: Void = refreshNotificationSettings()
		async let accessRefreshed: Void = refreshAccess()
		_ = await (settingsRefreshed, accessRefreshed)
		_ = try? await refreshModels()
		await refreshAttention()
		await refreshLoadedChatLists()
	}

	/// Reloads what the person is notified about, keeping what was known if the request fails.
	private func refreshNotificationSettings() async {
		await loadLatest(.notificationSettings) { [client] in
			try await client.notifications.settings()
		} apply: { result in
			if case let .success(settings) = result { notificationSettings = settings }
		}
	}

	/// Reloads what you may do and your role, keeping what was known if the
	/// request fails. The settings pages call it as they open, so a role
	/// changed since the last full refresh shows there.
	func refreshAccess() async {
		await loadLatest(.access) { [client, workspace] in
			try await client.workspaceAccess(workspace: workspace.id)
		} apply: { result in
			guard case let .success(access) = result else { return }
			permissions = access.permissions
			role = access.role
		}
	}

	/// Reloads the models the workspace's bots may run on into `enabledModels`, and returns them.
	@discardableResult
	func refreshModels() async throws -> WorkspaceModelsResponse {
		try await loadLatest(.models) { [client, workspace] in
			try await client.modelProviders.listEnabledModels(workspace: workspace.id)
		} apply: { result in
			if case let .success(models) = result { enabledModels = models }
		}
		.get()
	}

	/// The rail's markers, Inbox and Approvals: what the tab bar counts.
	func refreshAttention() async {
		await loadLatest(.attention) { [client, workspace] in
			async let markers = try? client.chats.podMarkers(workspace: workspace.id)
			async let activity = try? client.chats.activity(workspace: workspace.id)
			async let approvals = try? client.chats.approvals(workspace: workspace.id)
			return await (markers, activity, approvals)
		} apply: { result in
			guard case let .success((markers, activity, approvals)) = result else { return }
			// The rail keeps its last markers when they fail to load; Inbox and Approvals say theirs failed.
			if let markers { self.markers = markers.pods }
			if let activity {
				self.activity = activity.items
				activityLoaded = true
				activityFailed = false
			} else {
				activityFailed = true
			}
			if let approvals {
				self.approvals = approvals
				approvalsLoaded = true
				approvalsFailed = false
			} else {
				approvalsFailed = true
			}
		}
	}

	/// Reloads the pod's list, keeping the one last loaded if the request fails.
	func refreshChatList(_ pod: Pod) async {
		await loadLatest(.chatList(podId: pod.id)) { [client, workspace] in
			try await client.chats.list(workspace: workspace.id, pod: pod.id)
		} apply: { result in
			if case let .success(list) = result { chatLists[pod.id] = list }
		}
	}

	/// What a load fetches, for telling whether a later load of the same overtook it.
	private enum LoadKind: Hashable {
		case podsAndAgents
		case notificationSettings
		case access
		case models
		case attention
		case chatList(podId: String)
	}

	/// Runs `load` and hands its result to `apply`, unless another load of
	/// `kind` began while `load` ran. That later load's result is at least as
	/// fresh, so the overtaken one is not applied, to keep it from overwriting
	/// the later one. Returns `load`'s result either way.
	@discardableResult
	private func loadLatest<Value>(
		_ kind: LoadKind,
		_ load: () async throws -> Value,
		apply: (Result<Value, any Error>) -> Void
	) async -> Result<Value, any Error> {
		let begun = (loadsBegun[kind] ?? 0) + 1
		loadsBegun[kind] = begun
		let result: Result<Value, any Error>
		do { result = .success(try await load()) } catch { result = .failure(error) }
		if loadsBegun[kind] == begun { apply(result) }
		return result
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
	/// Sets `place`'s level, or with nil, has it follow the level above it, and returns the settings as they now stand.
	@discardableResult
	func setNotificationLevel(_ level: NotificationLevel?, for place: NotificationPlace) async throws -> NotificationSettings {
		try await client.notifications.setLevel(kind: place.kind, id: place.id, level: level)
		let settings = try await client.notifications.settings()
		notificationSettings = settings
		return settings
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
			color: look.color,
			face: look.face,
			shape: look.shape,
			model: model
		)
		agents.append(agent)
		return agent
	}

	/// Whether the workspace has computers set up for its bots.
	func computersEnabled() async throws -> Bool {
		try await client.sandboxProviders.access(workspace: workspace.id).enabled
	}

	/// Gives the bot a computer in its pod's sandbox.
	func giveComputer(to agent: Agent) async throws {
		let updated = try await client.agents.update(agentId: agent.id, usesSandbox: .present(true))
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
