import Foundation

// What the settings pages read and change, as the web's `lib/workspace.ts`,
// `lib/pods.ts`, `lib/connections.ts` and `lib/notifications.ts` do.
extension WorkspaceStore {
	// MARK: Workspace

	/// This workspace with its clock, which `me` leaves out.
	func workspaceRecord() async throws -> Workspace {
		guard let found = try await client.workspaces.list().first(where: { $0.id == workspace.id }) else {
			throw APIFailure(status: 404, message: "This workspace could not be found.")
		}
		return found
	}

	func workspaceTimeZone() async throws -> WorkspaceTimeZone {
		try await client.workspaces.timeZone(workspace: workspace.id)
	}

	func changeTimeZone(to timeZone: String) async throws {
		try await client.workspaces.changeTimeZone(workspace: workspace.id, timeZone: timeZone)
	}

	func deleteWorkspace() async throws {
		try await client.workspaces.delete(workspace: workspace.id)
	}

	// MARK: People

	func workspaceMembers() async throws -> [WorkspaceMember] {
		try await client.workspaces.members(workspace: workspace.id)
	}

	func setRole(_ role: AssignableWorkspaceRole, of member: WorkspaceMember) async throws {
		try await client.workspaces.updateMember(workspace: workspace.id, memberId: member.id, role: role)
	}

	func removeMember(_ member: WorkspaceMember) async throws {
		try await client.workspaces.removeMember(workspace: workspace.id, memberId: member.id)
	}

	func leaveWorkspace() async throws {
		try await client.workspaces.leave(workspace: workspace.id)
	}

	func transferOwnership(to member: WorkspaceMember) async throws {
		try await client.workspaces.transferOwnership(workspace: workspace.id, memberId: member.id)
	}

	func invitations() async throws -> [WorkspaceInvitation] {
		try await client.workspaces.invitations(workspace: workspace.id)
	}

	func invite(_ email: String, as role: AssignableWorkspaceRole, resend: Bool = false) async throws {
		_ = try await client.workspaces.invite(workspace: workspace.id, email: email, role: role, resend: resend)
	}

	/// Invites each address in turn, carrying on past failures, and returns those that failed.
	func invite(_ emails: [String], as role: AssignableWorkspaceRole) async -> [InviteFailure] {
		var failures: [InviteFailure] = []
		for email in emails {
			do { try await invite(email, as: role) } catch { failures.append(InviteFailure(email: email, reason: error.localizedDescription)) }
		}
		return failures
	}

	func cancelInvitation(_ invitation: WorkspaceInvitation) async throws {
		try await client.workspaces.cancelInvitation(invitationId: invitation.id)
	}

	// MARK: Pods

	/// Every pod, freshly, with all it lets the person do.
	func podRecords() async throws -> [Pod] {
		try await client.pods.list(workspace: workspace.id)
	}

	func podRecord(_ podId: String) async throws -> Pod {
		guard let found = try await podRecords().first(where: { $0.id == podId }) else {
			throw APIFailure(status: 404, message: "No such pod here")
		}
		return found
	}

	func updatePod(_ podId: String, name: String? = nil, color: PodColor? = nil) async throws {
		_ = try await client.pods.update(podId: podId, name: name, color: color.map { .present($0) } ?? .omitted)
		await refreshAll()
	}

	func deletePod(_ podId: String) async throws {
		try await client.pods.remove(podId: podId)
		await refreshAll()
	}

	func podMembers(_ podId: String) async throws -> [PodMember] {
		try await client.pods.listMembers(podId: podId)
	}

	func addToPod(_ podId: String, userId: String) async throws {
		try await client.pods.addMember(podId: podId, userId: userId)
	}

	func removeFromPod(_ podId: String, userId: String) async throws {
		try await client.pods.removeMember(podId: podId, userId: userId)
	}

	func leavePod(_ podId: String) async throws {
		try await client.pods.leave(podId: podId)
		await refreshAll()
	}

	// MARK: You

	func referralLink() async throws -> String? {
		try await client.referrals.link().url
	}

	func resetReferralLink() async throws -> String? {
		try await client.referrals.resetLink().url
	}

	/// Saves what the person is notified about, as Notifications' controls change it.
	func updateNotificationPreferences(
		level: NotificationLevel,
		pausedUntil: Date?,
		quietHours: QuietHours?,
		turnFailures: Bool,
		routineRuns: RoutineRunNotifications
	) async throws -> NotificationSettings {
		try await client.notifications.updatePreferences(
			level: level, pausedUntil: pausedUntil, quietHours: quietHours, turnFailures: turnFailures, routineRuns: routineRuns
		)
	}

	// MARK: Connections

	func connections(in podId: String) async throws -> [Connection] {
		try await client.connections.list(podId: podId)
	}

	/// The pod's connections by handle, with the name and mark each is shown with, as `useConnectionLooks`.
	/// Whether the system agent that writes summaries has a model; nil when it can't be told.
	func summariesHaveModel() async -> Bool? {
		let agents = try? await client.systemAgents.list(workspace: workspace.id)
		return agents?.first { $0.key == .summarise }.map { $0.model != nil }
	}

	func connectionLooks(podId: String) async -> [String: ConnectionLook] {
		let found = (try? await connections(in: podId)) ?? []
		return Dictionary(found.map { ($0.handle, ConnectionLook(name: $0.name, presetId: $0.presetId)) }, uniquingKeysWith: { first, _ in first })
	}

	func connectionTools(_ connection: Connection) async throws -> [ConnectionToolSetting] {
		try await client.connections.get(podId: connection.podId, connectionId: connection.id).tools
	}

	func setToolAccess(_ toolAccess: [String: ConnectionAccess], of connection: Connection) async throws {
		_ = try await client.connections.update(podId: connection.podId, connectionId: connection.id, toolAccess: toolAccess)
	}

	/// Saves a new secret, or for a server with none yet, an access token sent as a bearer.
	func saveSecret(_ secret: String, of connection: Connection) async throws {
		if connection.secretHeader == nil {
			_ = try await client.connections.update(
				podId: connection.podId, connectionId: connection.id, secretHeader: .present("Authorization"), secret: .present(Self.bearerAuthorization(secret))
			)
		} else {
			_ = try await client.connections.update(podId: connection.podId, connectionId: connection.id, secret: .present(secret))
		}
	}

	func removeConnection(_ connection: Connection) async throws {
		try await client.connections.remove(podId: connection.podId, connectionId: connection.id)
	}

	func testConnection(_ connection: Connection) async throws -> ConnectionTestResult {
		try await client.connections.test(podId: connection.podId, connectionId: connection.id)
	}

	func testUnsavedConnection(in podId: String, url: String, secretHeader: String?, secret: String?) async throws -> ConnectionTestResult {
		try await client.connections.testUnsaved(podId: podId, url: url, secretHeader: secretHeader, secret: secret)
	}

	func createConnection(in podId: String, connection: NewConnection) async throws {
		_ = try await client.connections.create(podId: podId, body: connection)
	}

	/// Starts connecting a catalog app or a server that signs in, and gives the address to sign in at.
	func connectSigningIn(in podId: String, name: String, url: String) async throws -> URL? {
		let started = try await client.connections.connectFromCatalog(podId: podId, name: name, url: url)
		return URL(string: started.authorizationUrl)
	}

	/// Signs a connection in again, giving the address to sign in at, or nil when it needs none.
	func startSignIn(_ connection: Connection) async throws -> URL? {
		let started = try await client.connections.startOAuth(podId: connection.podId, connectionId: connection.id)
		return started.authorizationUrl.flatMap(URL.init(string:))
	}

	/// As `bearerAuthorization`: a token as an Authorization header's value.
	static func bearerAuthorization(_ token: String) -> String {
		let trimmed = token.trimmingCharacters(in: .whitespacesAndNewlines)
		return "Bearer " + trimmed.replacingOccurrences(of: "^bearer\\s+", with: "", options: [.regularExpression, .caseInsensitive])
	}

	// MARK: The web

	/// The web app's address for a path in this workspace, for what the app sends there: `settings/pods/support/connections`.
	func webURL(_ path: String) -> URL {
		client.webRoot.appending(path: workspace.slug).appending(path: path)
	}
}
