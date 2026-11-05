import SwiftUI

/// A settings page, as the web's `/settings/…` and `/you/…` paths name them.
enum SettingsPlace: Hashable {
	/// `/settings/profile`: your name, theme, invite link and Sign out.
	case profile
	/// `/settings/notifications`.
	case notifications
	/// `/settings/$section` for one of the workspace's sections.
	case workspace(WorkspaceSection)
	/// `/settings/members/$member`, by the membership's id.
	case member(id: String)
	/// `/settings/providers/$provider`.
	case provider(id: String)
	/// `/settings/providers/default`: the model new bots start on.
	case defaultModel
	/// `/settings/providers/system`: the model summaries are written with.
	case systemModel
	/// `/you/pods/$pod`: a pod's parts, as You lists them.
	case pod(Pod)
	/// `/settings/pods/$pod/$page`.
	case podPage(Pod, PodSettingsPage)
	/// `/settings/pods/$pod/connections/$connection`.
	case connection(Pod, Connection)
	/// `/settings/pods/$pod/agents/$agent`.
	case agent(Pod, Agent)
}

/// The workspace's sections, as `workspaceSettingSections`, with what each needs.
enum WorkspaceSection: String, CaseIterable, Hashable {
	case general, members, providers, sandboxes, search, usage

	var label: String {
		switch self {
		case .general: "General"
		case .members: "People"
		case .providers: "Models"
		case .sandboxes: "Computers"
		case .search: "Web search"
		case .usage: "Usage"
		}
	}

	func allowed(by permissions: WorkspacePermissions) -> Bool {
		switch self {
		case .general, .members: true
		case .providers, .sandboxes, .search: permissions.manageProviders
		case .usage: permissions.manageUsage
		}
	}

	/// What the section says to somebody it isn't `allowed(by:)`.
	var barredNotice: String {
		switch self {
		case .general, .members: ""
		case .providers: "Only workspace administrators can manage models."
		case .sandboxes: "Only workspace administrators can manage computers."
		case .search: "Only workspace administrators can manage web search."
		case .usage: "Only workspace administrators can see what the workspace spends."
		}
	}
}

/// The page a `SettingsPlace` opens.
struct SettingsDestination: View {
	let place: SettingsPlace

	var body: some View {
		switch place {
		case .profile: ProfileSettingsScreen()
		case .notifications: NotificationsSettingsScreen()
		case let .workspace(section): WorkspaceSectionScreen(section: section)
		case let .member(id): MemberSettingsScreen(memberId: id)
		case let .provider(id): ProviderSettingsScreen(providerId: id)
		case .defaultModel: DefaultModelSettingsScreen()
		case .systemModel: SystemModelSettingsScreen()
		case let .pod(pod): YouPodScreen(pod: pod)
		case let .podPage(pod, page): PodPageScreen(pod: pod, page: page)
		case let .connection(pod, connection): ConnectionSettingsScreen(pod: pod, listedConnection: connection)
		case let .agent(pod, agent): AgentSettingsScreen(pod: pod, listedAgent: agent)
		}
	}
}

/// A pod's settings as its name on Home opens them, as `/settings/pods/$pod`:
/// its General, or a Personal pod's Connections, which has none.
struct PodSettingsScreen: View {
	let pod: Pod

	var body: some View {
		PodPageScreen(pod: pod, page: pod.kind == .personal ? .connections : .general)
	}
}

/// A workspace section's page, or, once your permissions are known and don't
/// allow it, why it can't be seen, as `WorkspaceSettings` decides.
@MainActor
struct WorkspaceSectionScreen: View {
	let section: WorkspaceSection
	@Environment(WorkspaceStore.self) private var store

	var body: some View {
		Group {
			if let permissions = store.permissions, !section.allowed(by: permissions) {
				SettingsPage(title: section.label) { FormAlert(text: section.barredNotice) }
			} else {
				page
			}
		}
		.task { await store.refreshAccess() }
	}

	@ViewBuilder
	private var page: some View {
		switch section {
		case .general: GeneralSettingsScreen()
		case .members: MembersSettingsScreen()
		case .providers: ModelsSettingsScreen()
		case .sandboxes: SandboxSettingsScreen()
		case .search: WebSearchSettingsScreen()
		case .usage: UsageSettingsScreen()
		}
	}
}
