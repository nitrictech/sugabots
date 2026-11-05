import SwiftUI

/// One connection, as the web's `ConnectionPage`: who it's signed in as, its
/// address and secret, a test, GitHub's repositories, how its tools may run,
/// and Disconnect. Individual tools opens in its place.
@MainActor
struct ConnectionSettingsScreen: View {
	let pod: Pod
	/// The connection as the list that opened this page had it.
	let listedConnection: Connection
	@Environment(WorkspaceStore.self) private var store
	@Environment(\.openURL) private var openURL
	@Environment(\.dismiss) private var dismiss
	@Environment(\.scenePhase) private var scenePhase
	@State private var fetchedConnection: Connection?
	@State private var canManage = false
	@State private var tools = ConnectionTools()
	@State private var action = SettingsAction()
	@State private var replacingSecret = false
	@State private var newSecret = ""
	@State private var removing = false
	@State private var testing = false
	@State private var tested: ConnectionTestResult?
	@State private var openingTools = false

	/// The connection as last fetched, or until then, as it was listed.
	private var connection: Connection { fetchedConnection ?? listedConnection }

	/// `projectLinks.documentation`'s troubleshooting section for connections.
	private static let troubleshooting = URL(string: "https://sugabots.ai/docs/connections#troubleshooting")!

	var body: some View {
		let isServer = connection.kind != .github
		let preset = ConnectionPreset.matching(url: connection.url)
		SettingsPage(
			title: connection.name,
			description: connection.connectedBy.map { "Connected by \($0)" } ?? "In \(pod.name)",
			hero: AnyView(ConnectionMark(presetId: connection.presetId, name: connection.name, size: .lg))
		) {
			if let failure = action.failure ?? tools.accessFailure { FormAlert(text: failure) }
			VStack(alignment: .leading, spacing: 0) {
				SettingsGroup(label: connection.auth == .oauth || !isServer ? "Account" : "Connection") {
					if connection.auth == .oauth || !isServer {
						account(connection, isServer: isServer)
					}
					// A catalog app is known by its name; only a server added by URL is told apart by it.
					if preset == nil && isServer {
						if connection.auth == .oauth { SettingsDivider() }
						SettingsRow(label: "Address", trailing: {
							Text(connection.url).font(Typeface.mono(13)).foregroundStyle(Palette.mutedForeground).lineLimit(1).truncationMode(.middle)
						})
					}
					if isServer && connection.auth == .header {
						SettingsDivider()
						SettingsRow(
							label: connection.secretHeader == nil ? "Access token" : "Secret",
							sub: connection.secretHeader.map { "Sent in the \($0) header" } ?? "None yet",
							trailing: {
								if canManage {
									Button(Self.secretAction(connection)) { replacingSecret = true }.buttonStyle(SettingsRowButtonStyle())
								}
							}
						)
					}
					if replacingSecret { secretForm(connection) }
				}
				if isServer { testConnection(connection).padding(.horizontal, 2).padding(.top, 10) }
			}
			if connection.kind == .github {
				RepositoriesGroup(connection: connection, canManage: canManage)
			}
			toolSettings(connection)
			if canManage {
				SettingsDanger(label: "Disconnect \(connection.name)", description: "Bots in this pod lose access straight away.", actionTitle: "Disconnect") { removing = true }
			}
		}
		.confirmDelete(
			isPresented: $removing,
			title: "Disconnect \(connection.name)?",
			description: connection.kind == .github
				? "Bots in this pod can no longer use its tools or its repositories. The pod's app stays on GitHub until you delete it there: Delete GitHub App in its advanced settings."
				: "Bots in this pod can no longer use its tools. Connecting it again means signing in or entering its details again.",
			confirmLabel: "Disconnect"
		) {
			try await store.removeConnection(connection)
			dismiss()
		}
		.navigationDestination(isPresented: $openingTools) {
			IndividualToolsScreen(connection: connection, tools: tools, canManage: canManage)
		}
		.task { await load() }
		.onChange(of: scenePhase) { _, phase in if phase == .active { Task { await load() } } }
	}

	// MARK: Parts

	/// What the account row says under its label while nobody is signed in.
	private static func notSignedInNote(_ connection: Connection, isServer: Bool) -> String? {
		if connection.signedIn { return nil }
		if isServer { return "Bots can't use \(connection.name) until someone signs in." }
		return "Bots can't use GitHub until the pod's app is installed on the account it works on."
	}

	private func account(_ connection: Connection, isServer: Bool) -> some View {
		SettingsRow(label: isServer ? "Signed in as" : "Installed by", sub: Self.notSignedInNote(connection, isServer: isServer), trailing: {
			HStack(spacing: 12) {
				if connection.signedIn {
					if let name = connection.connectedBy {
						HStack(spacing: 8) {
							PersonAvatar(name: name, size: 20)
							SettingsValue(text: name)
						}
					} else {
						SettingsValue(text: "Someone no longer here")
					}
				}
				if canManage {
					if isServer {
						if connection.auth == .oauth || !connection.signedIn {
							Button(connection.signedIn ? "Reconnect" : "Sign in") { signIn(connection) }
								.buttonStyle(SettingsRowButtonStyle())
								.disabled(action.pending)
						}
					} else {
						Button(connection.signedIn ? "Manage access" : "Install on GitHub") { install(connection) }
							.buttonStyle(SettingsRowButtonStyle())
							.disabled(action.pending)
					}
				}
			}
		})
	}

	private func secretForm(_ connection: Connection) -> some View {
		let needsToken = connection.secretHeader == nil
		return VStack(spacing: 0) {
			SettingsDivider()
			HStack(spacing: 12) {
				SecureField("", text: $newSecret, prompt: Text(needsToken ? "Paste the access token" : "Paste the new secret").foregroundStyle(Palette.subtleForeground))
					.font(Typeface.mono(16))
					.accessibilityLabel("\(connection.name) secret")
				Button("Cancel") {
					replacingSecret = false
					newSecret = ""
				}
				.buttonStyle(WebButtonStyle(variant: .ghost, size: .small))
				Button("Save") { saveSecret(connection) }
					.buttonStyle(WebButtonStyle(size: .small))
					.disabled(newSecret.isEmpty || action.pending)
			}
			.padding(.horizontal, 16)
			.padding(.vertical, 10)
			.frame(minHeight: 56)
		}
	}

	private func testConnection(_ connection: Connection) -> some View {
		let reachable: Bool? = tested?.reachable ?? (connection.status == .error ? false : nil)
		let failureText = tested.map { $0.error ?? "The server did not answer." } ?? connection.lastTestError ?? "The last check failed."
		return HStack(spacing: 12) {
			Button("Test connection") { test(connection) }
				.buttonStyle(WebButtonStyle(variant: .secondary, size: .small))
				.disabled(testing)
			if testing {
				Text("Checking…").font(Typeface.rubik(13)).foregroundStyle(Palette.subtleForeground)
			} else if reachable == true {
				SettingsTestOutcome(good: true, text: connection.kind == .http ? "The address is allowed. A check sends no request to it." : "Connection successful")
			} else if reachable == false {
				SettingsTestOutcome(good: false, text: failureText)
				Button("How to fix this") { openURL(Self.troubleshooting) }
					.font(Typeface.rubik(12, .medium))
					.foregroundStyle(Palette.foreground)
			}
		}
	}

	@ViewBuilder
	private func toolSettings(_ connection: Connection) -> some View {
		switch tools.list {
		case let .failed(failure):
			FormAlert(text: failure)
		case let .loaded(list):
			let kinds = ToolKind.of(list)
			if kinds.isEmpty {
				SettingsGroup(label: "Tools") { SettingsEmptyRow(text: "No actions found yet") }
			} else {
				ForEach(kinds, id: \.kind) { kind in
					SettingsGroup(label: kind.heading, note: kind.kind == .change ? "Ask first sends the action to Approvals before it runs." : nil) {
						SettingsRow(label: kind.all, sub: kind.sub, trailing: {
							AccessToggle(label: kind.heading, value: kind.setting, canManage: canManage) { access in
								let following = kind.tools.filter { $0.access == kind.setting }
								Task { await tools.setAccess(Dictionary(uniqueKeysWithValues: following.map { ($0.name, access) }), of: connection, store: store) }
							}
						})
					}
				}
				let apart = ToolKind.setApart(kinds).count
				SettingsGroup {
					Button { openingTools = true } label: {
						SettingsRow(
							label: "Individual tools",
							sub: canManage ? "Set one tool differently from its group" : "Tools set apart from their group",
							chevron: true,
							trailing: { if apart > 0 { SettingsValue(text: "\(apart) changed") } }
						)
					}
					.buttonStyle(SettingsRowPressStyle())
				}
			}
		case .loading:
			VStack(spacing: 12) {
				ForEach(0..<2, id: \.self) { _ in
					Color.clear
						.frame(height: 92)
						.settingsCard()
				}
			}
			.accessibilityLabel("Loading tools")
		}
	}

	// MARK: Doing

	private static func secretAction(_ connection: Connection) -> String {
		if connection.secretHeader == nil { return "Add access token" }
		return connection.hasSecret ? "Replace secret" : "Add secret"
	}

	private func load() async {
		if let all = try? await store.connections(in: pod.id), let fresh = all.first(where: { $0.id == listedConnection.id }) {
			fetchedConnection = fresh
		}
		canManage = (try? await store.podRecord(pod.id))?.permissions.manageConnections ?? false
		await tools.load(connection, store: store)
	}

	private func signIn(_ connection: Connection) {
		action.run {
			if let url = try await store.startSignIn(connection) { openURL(url) } else { await load() }
		}
	}

	private func install(_ connection: Connection) {
		action.run {
			let install = try await store.client.gitHubConnections.installUrl(podId: pod.id, connectionId: connection.id)
			if let url = URL(string: install.url) { openURL(url) }
		}
	}

	private func saveSecret(_ connection: Connection) {
		action.run {
			try await store.saveSecret(newSecret, of: connection)
			replacingSecret = false
			newSecret = ""
			await load()
		}
	}

	private func test(_ connection: Connection) {
		testing = true
		Task {
			do {
				tested = try await store.testConnection(connection)
				action.failure = nil
			} catch {
				action.failure = error.localizedDescription
			}
			testing = false
			await load()
		}
	}
}

/// A connection's tools and how each may run, shared by its page and its
/// Individual tools, so a change made on either shows on both.
@MainActor
@Observable
final class ConnectionTools {
	private(set) var list: Loadable<[ConnectionToolSetting]> = .loading
	/// What the last change of access failed with, until the next succeeds.
	private(set) var accessFailure: String?

	func load(_ connection: Connection, store: WorkspaceStore) async {
		list = await .of { try await store.connectionTools(connection) }
	}

	/// Shows `access` straight away and saves it. If the server refuses, the
	/// tools it names go back to what they were; any other tool keeps what it has.
	func setAccess(_ access: [String: ConnectionAccess], of connection: Connection, store: WorkspaceStore) async {
		guard let tools = list.value else { return }
		let before = Dictionary(uniqueKeysWithValues: tools.filter { access[$0.name] != nil }.map { ($0.name, $0.access) })
		list = .loaded(tools.applying(access))
		do {
			try await store.setToolAccess(access, of: connection)
			accessFailure = nil
		} catch {
			if let now = list.value { list = .loaded(now.applying(before)) }
			accessFailure = error.localizedDescription
		}
	}
}

/// How a tool may run: a choice for those who may change it, or its word.
struct AccessToggle: View {
	let label: String
	let value: ConnectionAccess
	let canManage: Bool
	let change: (ConnectionAccess) -> Void

	var body: some View {
		if canManage {
			SegmentedChoice(label: label, options: [ConnectionAccess.allow, .ask, .off].map { ($0, $0.words) }, value: value, choose: change)
		} else {
			Text(value.words).font(Typeface.rubik(13)).foregroundStyle(Palette.mutedForeground)
		}
	}
}

/// Individual tools, as the web's `IndividualTools`: a search, then the tools
/// set apart from their group, then each group's others.
@MainActor
private struct IndividualToolsScreen: View {
	let connection: Connection
	let tools: ConnectionTools
	let canManage: Bool
	@Environment(WorkspaceStore.self) private var store
	@State private var query = ""

	var body: some View {
		let needle = query.trimmingCharacters(in: .whitespaces).lowercased()
		let matches = { (tool: ConnectionToolSetting) in
			needle.isEmpty || tool.name.lowercased().contains(needle) || tool.name.replacingOccurrences(of: "_", with: " ").lowercased().contains(needle)
		}
		let list = tools.list.value ?? []
		let kinds = ToolKind.of(list)
		let apart = ToolKind.setApart(kinds)
		let shownApart = apart.filter { matches($0.tool) }
		let anyShown = !shownApart.isEmpty || kinds.contains { $0.tools.contains(where: matches) }
		SettingsPage(
			title: "Individual tools",
			description: "Set a tool of \(connection.name) differently from its group.",
			hero: AnyView(ConnectionMark(presetId: connection.presetId, name: connection.name, size: .lg))
		) {
			if let failure = tools.accessFailure { FormAlert(text: failure) }
			VStack(spacing: 0) {
				SearchField(placeholder: "Search \(list.count) \(connection.name) tools", text: $query, style: .inCard)
					.padding(10)
				SettingsDivider()
				if !shownApart.isEmpty {
					section(heading: "Changed (\(shownApart.count))", description: "Set apart from their group.") {
						if canManage {
							Button("Reset all") { change(Dictionary(uniqueKeysWithValues: apart.map { ($0.tool.name, $0.setting) })) }
								.buttonStyle(SettingsRowButtonStyle())
						}
					} rows: {
						ForEach(shownApart, id: \.tool.name) { item in row(item.tool, setting: item.setting, changed: true) }
					}
				}
				ForEach(kinds, id: \.kind) { kind in
					let shown = kind.tools.filter { $0.access == kind.setting && matches($0) }
					if !shown.isEmpty {
						section(heading: kind.heading, description: "Follow the group's setting, \(kind.setting.words), until one is set differently.") {
							EmptyView()
						} rows: {
							ForEach(shown) { tool in row(tool, setting: kind.setting, changed: false) }
						}
					}
				}
				if !anyShown {
					Text("No tools match.").font(Typeface.rubik(13)).foregroundStyle(Palette.subtleForeground).padding(.vertical, 32)
				}
			}
			.settingsCard()
		}
	}

	private func section(heading: String, description: String, @ViewBuilder action: () -> some View, @ViewBuilder rows: () -> some View) -> some View {
		VStack(spacing: 0) {
			HStack(spacing: 12) {
				VStack(alignment: .leading, spacing: 2) {
					Text(heading).font(Typeface.rubik(13, .medium)).foregroundStyle(Palette.foreground)
					Text(description).font(Typeface.rubik(12)).foregroundStyle(Palette.subtleForeground)
				}
				.frame(maxWidth: .infinity, alignment: .leading)
				action()
			}
			.padding(.horizontal, 16)
			.padding(.vertical, 10)
			.background(Palette.chip)
			SettingsDivider()
			rows()
		}
	}

	private func row(_ tool: ConnectionToolSetting, setting: ConnectionAccess, changed: Bool) -> some View {
		VStack(spacing: 0) {
			HStack(spacing: 14) {
				VStack(alignment: .leading, spacing: 2) {
					// Off fades to a quieter colour, not by opacity, which would take it below a readable contrast.
					Text(tool.name).font(Typeface.mono(14)).foregroundStyle(tool.access == .off ? Palette.mutedForeground : Palette.foreground).lineLimit(1)
					if changed {
						Text("Default: \(setting.words.lowercased())").font(Typeface.rubik(13)).foregroundStyle(Palette.subtleForeground)
					}
				}
				.frame(maxWidth: .infinity, alignment: .leading)
				AccessToggle(label: tool.name, value: tool.access, canManage: canManage) { change([tool.name: $0]) }
			}
			.padding(.leading, 36)
			.padding(.trailing, 16)
			.padding(.vertical, 12)
			.frame(minHeight: 56)
			SettingsDivider()
		}
	}

	private func change(_ access: [String: ConnectionAccess]) {
		Task { await tools.setAccess(access, of: connection, store: store) }
	}
}

private extension [ConnectionToolSetting] {
	/// The tools with `access` given to those it names, as they'll be once the server agrees.
	func applying(_ access: [String: ConnectionAccess]) -> [ConnectionToolSetting] {
		map { tool in
			access[tool.name].map { ConnectionToolSetting(name: tool.name, readOnly: tool.readOnly, destructive: tool.destructive, access: $0) } ?? tool
		}
	}
}

/// A GitHub connection's repositories, as `GitHubRepositoriesGroup`: each with
/// who added it, Remove, and Add repository from what the pod's app reaches.
@MainActor
private struct RepositoriesGroup: View {
	let connection: Connection
	let canManage: Bool
	@Environment(WorkspaceStore.self) private var store
	@Environment(\.openURL) private var openURL
	@State private var listed: ConnectionRepositories?
	@State private var loadFailure: String?
	@State private var action = SettingsAction()
	@State private var choosing = false

	var body: some View {
		Group {
			if let listed, let account = listed.account {
				VStack(alignment: .leading, spacing: 0) {
					SettingsGroup(label: "Repositories") {
						if listed.repositories.isEmpty { SettingsRow(label: "None yet") }
						DividedRows(data: listed.repositories) { item in
							RemovableRow(
								name: item.repository,
								nameSize: 13.5,
								sub: "Added by \(item.addedByName ?? "someone who has left")",
								removal: canManage ? .init(label: "Remove \(item.repository)") { remove(item.repository) } : nil
							)
							.disabled(action.pending)
						}
						if canManage {
							if !listed.repositories.isEmpty { SettingsDivider() }
							SettingsAddRow(label: "Add repository") { choosing = true }
								.disabled(action.pending)
						}
					}
					HStack(spacing: 0) {
						Text("Bots in this pod read these from its sandbox, and work on them with the tools below. They come from \(account) on GitHub, through ")
						+ Text("the pod's app").foregroundColor(Palette.foreground).fontWeight(.medium)
						+ Text(".")
					}
					.font(Typeface.rubik(13))
					.foregroundStyle(Palette.subtleForeground)
					.padding(.horizontal, 2)
					.padding(.top, 10)
					.onTapGesture { if let url = URL(string: connection.appSettingsUrl ?? connection.url) { openURL(url) } }
				}
			}
			if let failure = action.failure ?? loadFailure { FormAlert(text: failure) }
		}
		.sheet(isPresented: $choosing) {
			ChooseRepository(connection: connection, taken: Set(listed?.repositories.map { $0.repository.lowercased() } ?? [])) { repository in
				choosing = false
				add(repository)
			}
		}
		.task { await load() }
	}

	private func load() async {
		do {
			listed = try await store.repositories(in: connection.podId, connectionId: connection.id)
			loadFailure = nil
		} catch {
			loadFailure = error.localizedDescription
		}
	}

	private func add(_ repository: String) {
		action.run {
			listed = try await store.client.gitHubConnections.addRepository(podId: connection.podId, connectionId: connection.id, repository: repository)
		}
	}

	private func remove(_ repository: String) {
		action.run {
			listed = try await store.client.gitHubConnections.removeRepository(podId: connection.podId, connectionId: connection.id, repository: repository)
		}
	}

	/// The repositories the pod's app reaches that aren't added yet, to search and pick one of.
	private struct ChooseRepository: View {
		let connection: Connection
		let taken: Set<String>
		let choose: (String) -> Void
		@Environment(WorkspaceStore.self) private var store
		@State private var reachable: [AccountRepository]?
		@State private var query = ""

		var body: some View {
			let needle = query.trimmingCharacters(in: .whitespaces).lowercased()
			let shown = (reachable ?? []).filter { !taken.contains($0.repository.lowercased()) && (needle.isEmpty || $0.repository.lowercased().contains(needle)) }
			DialogForm(title: "Add repository") {
				SearchField(placeholder: "Search repositories", text: $query)
				SettingsGroup {
					if reachable == nil { SettingsEmptyRow(text: "Loading…") }
					DividedRows(data: shown) { repository in
						Button { choose(repository.repository) } label: {
							SettingsRow(label: repository.repository, trailing: {
								if repository.private { SettingsValue(text: "Private") }
							})
						}
						.buttonStyle(SettingsRowPressStyle())
					}
				}
			}
			.task { reachable = try? await store.client.gitHubConnections.reachableRepositories(podId: connection.podId, connectionId: connection.id) }
		}
	}
}
