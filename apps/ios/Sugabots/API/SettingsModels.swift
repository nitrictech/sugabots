import Foundation

// What the settings pages add to the API's types: the words the web shows for them.

extension WorkspaceRole: Identifiable {
	var id: String { rawValue }

	/// The roles somebody may be given, as `ASSIGNABLE_WORKSPACE_ROLES`.
	static let assignable: [WorkspaceRole] = AssignableWorkspaceRole.known.map { WorkspaceRole(rawValue: $0.rawValue) }

	/// The role as an invitation or a change of role gives it.
	var asAssignable: AssignableWorkspaceRole { AssignableWorkspaceRole(rawValue: rawValue) }

	/// As `administersWorkspace`.
	var administers: Bool { self == .owner || self == .admin }

	static func label(_ role: WorkspaceRole?) -> String { role?.label ?? "No access" }
}

extension WorkspaceInvitation {
	/// The role as the workspace's roles name it.
	var workspaceRole: WorkspaceRole { WorkspaceRole(rawValue: role.rawValue) }
}

extension PodMember: Identifiable {
	var id: String { userId }
}

// MARK: Connections

extension ConnectionAccess: Identifiable {
	var id: String { rawValue }

	/// Allowed, Ask first and Off, in the order the web offers them.
	static let offered: [ConnectionAccess] = [.allow, .ask, .off]
}

extension ToolAccessCounts {
	/// As `accessSummaryText`: how the tools stand, or nil with none.
	var summary: String? {
		let total = allow + ask + off
		guard total > 0 else { return nil }
		if allow == total { return "Every tool runs without asking" }
		if ask == total { return "Every tool asks first" }
		if off == total { return "Off for every bot" }
		let parts = [(allow, "allowed"), (ask, "ask first"), (off, "off")].filter { $0.0 > 0 }.map { "\($0.0) \($0.1)" }
		return "Custom: \(parts.joined(separator: ", "))"
	}
}

extension Connection {
	var presetId: String? { ConnectionMark.presetId(kind: kind.rawValue, url: url) }
}

extension ConnectionWithTools {
	var presetId: String? { ConnectionMark.presetId(kind: kind.rawValue, url: url) }
}

extension ConnectionRepositories.Repository: Identifiable {
	var id: String { repository }
}

extension PodSandboxState {
	/// The pod's computer, when it has one.
	var present: Present? {
		if case let .present(sandbox) = self { sandbox } else { nil }
	}
}

extension PodSandboxNetwork.AddedHost: Identifiable {
	var id: String { host }
}

extension SandboxAddedHost: Identifiable {
	var id: String { host }
}

extension SandboxBlockedHost: Identifiable {
	var id: String { host }
}

extension AccountRepository: Identifiable {
	var id: String { repository }
}

extension ConnectionToolSetting: Identifiable {
	var id: String { name }
}
