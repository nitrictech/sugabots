import Foundation

/// Setting a workspace up, as the web's `/onboarding`: the person, the
/// workspaces they have, the one being set up once it's made, and the one to
/// go back to if they cancel.
struct WorkspaceSetup {
	let client: APIClient
	let user: SessionUser
	let workspaces: [Workspace]
	/// The workspace being set up; nil until its name is given.
	var made: Workspace?
	/// Where Cancel goes; nil for somebody making their first, who can't cancel.
	var returnTo: Workspace?

	/// What opening `workspace` shows: its setup, while it isn't set up and the
	/// person may finish it, as the web sends them to `/onboarding`; else the workspace.
	@MainActor
	static func stateOpening(_ workspace: Workspace, client: APIClient, user: SessionUser, workspaces: [Workspace]) async -> Session.State {
		if workspace.setupCompletedAt == nil {
			let access = try? await client.workspaceAccess(workspace: workspace.id)
			if access?.permissions.manageProviders == true {
				return .settingUp(WorkspaceSetup(
					client: client,
					user: user,
					workspaces: workspaces,
					made: workspace,
					returnTo: workspaces.first { $0.id != workspace.id }
				))
			}
		}
		return .signedIn(WorkspaceStore(client: client, user: user, workspaces: workspaces, workspace: workspace))
	}
}
