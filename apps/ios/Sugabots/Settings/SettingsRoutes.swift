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

	func allowed(by may: WorkspacePermissions) -> Bool {
		switch self {
		case .general, .members: true
		case .providers, .sandboxes, .search: may.manageProviders
		case .usage: may.manageUsage
		}
	}
}

/// A pod's settings pages, as `podSettingsPages`.
enum PodSettingsPage: String, CaseIterable, Hashable {
	case general, connections, people, bots, computer

	var label: String {
		switch self {
		case .general: "General"
		case .connections: "Connections"
		case .people: "People"
		case .bots: "Bots"
		case .computer: "Computer"
		}
	}

	/// As `podSettingsPagesOf`: a Personal pod has no General or People, and Computer needs computers set up.
	static func of(_ kind: Pod.Kind, computers: Bool) -> [PodSettingsPage] {
		allCases.filter { page in
			!(kind == .personal && (page == .general || page == .people)) && (computers || page != .computer)
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
		case let .connection(pod, connection): ConnectionSettingsScreen(pod: pod, connection: connection)
		case let .agent(pod, agent): AgentSettingsScreen(pod: pod, agent: agent)
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

/// A workspace section's page, or why it can't be seen, as `WorkspaceSettings` decides.
struct WorkspaceSectionScreen: View {
	let section: WorkspaceSection

	var body: some View {
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
