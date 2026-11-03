import SwiftUI

/// One connection, as the web's `ConnectionPage`: who it's signed in as, its
/// address and secret, a test, GitHub's repositories, how its tools may run,
/// and Disconnect. Individual tools opens in its place.
@MainActor
struct ConnectionSettingsScreen: View {
	let pod: Pod
	let connection: Connection
	@Environment(WorkspaceStore.self) private var store
	@Environment(\.openURL) private var openURL
	@Environment(\.dismiss) private var dismiss
	@Environment(\.scenePhase) private var scenePhase
	@State private var shown: Connection?
	@State private var canManage = false
	@State private var tools: [ConnectionToolSetting]?
	@State private var toolsFailure: String?
	@State private var failure: String?
	@State private var replacingSecret = false
	@State private var newSecret = ""
	@State private var removing = false
	@State private var pending = false
	@State private var testing = false
	@State private var tested: ConnectionTestResult?
	@State private var openingTools = false

	/// `projectLinks.documentation`'s troubleshooting section for connections.
	private static let troubleshooting = URL(string: "https://sugabots.ai/docs/connections#troubleshooting")!

	var body: some View {
		let connection = shown ?? connection
		let isServer = connection.kind != .github
		let preset = ConnectionPreset.matching(url: connection.url)
		SettingsPage(
			title: connection.name,
			description: connection.connectedBy.map { "Connected by \($0)" } ?? "In \(pod.name)",
			hero: AnyView(ConnectionMark(presetId: connection.presetId, name: connection.name, size: .lg))
		) {
			if let failure { FormAlert(text: failure) }
			VStack(alignment: .leading, spacing: 0) {
				SettingsGroup(label: connection.auth == .oauth || !isServer ? "Account" : "Connection") {
					if connection.auth == .oauth || !isServer {
						account(connection, isServer: isServer)
					}
					// A catalog app is known by its name; only a server added by URL is told apart by it.
					if preset == nil && isServer {
						if connection.auth == .oauth { SettingsDivider() }
						SettingsRow.trailing(label: "Address") {
							Text(connection.url).font(Typeface.mono(13)).foregroundStyle(Palette.mutedForeground).lineLimit(1).truncationMode(.middle)
						}
					}
					if isServer && connection.auth == .header {
						SettingsDivider()
						SettingsRow.trailing(
							label: connection.secretHeader == nil ? "Access token" : "Secret",
							sub: connection.secretHeader.map { "Sent in the \($0) header" } ?? "None yet"
						) {
							if canManage {
								Button(Self.secretAction(connection)) { replacingSecret = true }.buttonStyle(SettingsRowButtonStyle())
							}
						}
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
				SettingsDanger(label: "Disconnect \(connection.name)", description: "Bots in this pod lose access straight away.", action: "Disconnect") { removing = true }
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
			try await store.removeConnection(shown ?? connection)
			dismiss()
		}
		.navigationDestination(isPresented: $openingTools) {
			IndividualToolsScreen(connection: connection, tools: tools ?? [], canManage: canManage) { access in
				await setToolAccess(access, of: connection)
			}
		}
		.task { await load() }
		.onChange(of: scenePhase) { _, phase in if phase == .active { Task { await load() } } }
	}

	// MARK: Parts

	private func account(_ connection: Connection, isServer: Bool) -> some View {
		SettingsRow.trailing(
			label: isServer ? "Signed in as" : "Installed by",
			sub: connection.signedIn
				? nil
				: isServer
					? "Bots can't use \(connection.name) until someone signs in."
					: "Bots can't use GitHub until the pod's app is installed on the account it works on."
		) {
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
								.disabled(pending)
						}
					} else {
						Button(connection.signedIn ? "Manage access" : "Install on GitHub") { install(connection) }
							.buttonStyle(SettingsRowButtonStyle())
							.disabled(pending)
					}
				}
			}
		}
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
					.disabled(newSecret.isEmpty || pending)
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
		if let toolsFailure {
			FormAlert(text: toolsFailure)
		} else if let tools {
			let kinds = ToolKind.of(tools)
			if kinds.isEmpty {
				SettingsGroup(label: "Tools") { SettingsEmptyRow(text: "No actions found yet") }
			} else {
				ForEach(kinds, id: \.kind) { kind in
					SettingsGroup(label: kind.heading, note: kind.kind == .change ? "Ask first sends the action to Approvals before it runs." : nil) {
						SettingsRow.trailing(label: kind.all, sub: kind.sub) {
							AccessToggle(label: kind.heading, value: kind.setting, canManage: canManage) { access in
								Task {
									await setToolAccess(
										Dictionary(uniqueKeysWithValues: kind.tools.filter { $0.access == kind.setting }.map { ($0.name, access) }),
										of: connection
									)
								}
							}
						}
					}
				}
				let apart = ToolKind.setApart(kinds).count
				SettingsGroup {
					Button { openingTools = true } label: {
						SettingsRow.trailing(
							label: "Individual tools",
							sub: canManage ? "Set one tool differently from its group" : "Tools set apart from their group",
							chevron: true
						) {
							if apart > 0 { SettingsValue(text: "\(apart) changed") }
						}
					}
					.buttonStyle(SettingsRowPressStyle())
				}
			}
		} else {
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
		if let all = try? await store.connections(in: pod.id) {
			if let fresh = all.first(where: { $0.id == connection.id }) { shown = fresh }
		}
		canManage = (try? await store.podRecord(pod.id))?.permissions.manageConnections ?? false
		do {
			tools = try await store.connectionTools(shown ?? connection)
			toolsFailure = nil
		} catch {
			toolsFailure = error.localizedDescription
		}
	}

	private func setToolAccess(_ access: [String: ConnectionAccess], of connection: Connection) async {
		// Shown straight away, and put back if the server refuses.
		let before = tools
		tools = tools?.applying(access)
		do {
			try await store.setToolAccess(access, of: connection)
			failure = nil
		} catch {
			tools = before
			failure = error.localizedDescription
		}
	}

	private func signIn(_ connection: Connection) {
		run {
			if let url = try await store.startSignIn(connection) { openURL(url) } else { await load() }
		}
	}

	private func install(_ connection: Connection) {
		run {
			let install = try await store.client.gitHubConnections.installUrl(podId: pod.id, connectionId: connection.id)
			if let url = URL(string: install.url) { openURL(url) }
		}
	}

	private func saveSecret(_ connection: Connection) {
		run {
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
				failure = nil
			} catch {
				failure = error.localizedDescription
			}
			testing = false
			await load()
		}
	}

	private func run(_ work: @escaping () async throws -> Void) {
		pending = true
		Task {
			do {
				try await work()
				failure = nil
			} catch {
				failure = error.localizedDescription
			}
			pending = false
		}
	}
}

/// A connection's tools of one kind, those that read or those that make changes,
/// with the access most of them have, as `toolKinds`.
struct ToolKind {
	enum Kind {
		case read, change
	}

	let kind: Kind
	let tools: [ConnectionToolSetting]
	let setting: ConnectionAccess

	var heading: String { kind == .read ? "Tools that read" : "Tools that make changes" }
	var sub: String { kind == .read ? "Look things up without changing anything" : "Create, edit, delete or send things" }
	var all: String {
		let count = tools.count
		return kind == .read ? "All \(count) read \(count == 1 ? "tool" : "tools")" : "All \(count) change \(count == 1 ? "tool" : "tools")"
	}

	static func of(_ tools: [ConnectionToolSetting]) -> [ToolKind] {
		[(Kind.read, tools.filter { !$0.mutating }), (.change, tools.filter(\.mutating))].compactMap { kind, ofKind in
			ofKind.isEmpty ? nil : ToolKind(kind: kind, tools: ofKind, setting: settingOf(ofKind, kind))
		}
	}

	/// The access most of the tools have, leaning to allow for reading and ask for changing, as `settingOf`.
	private static func settingOf(_ tools: [ConnectionToolSetting], _ kind: Kind) -> ConnectionAccess {
		let count = { (access: ConnectionAccess) in tools.filter { $0.access == access }.count }
		return [ConnectionAccess.allow, .ask, .off].reduce(kind == .read ? .allow : .ask) { best, access in count(access) > count(best) ? access : best }
	}

	/// Each tool set apart from its group, with its group's setting.
	static func setApart(_ kinds: [ToolKind]) -> [(tool: ConnectionToolSetting, setting: ConnectionAccess)] {
		kinds.flatMap { kind in kind.tools.filter { $0.access != kind.setting }.map { ($0, kind.setting) } }
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
	@State var tools: [ConnectionToolSetting]
	let canManage: Bool
	let setAccess: ([String: ConnectionAccess]) async -> Void
	@State private var query = ""

	init(connection: Connection, tools: [ConnectionToolSetting], canManage: Bool, setAccess: @escaping ([String: ConnectionAccess]) async -> Void) {
		self.connection = connection
		_tools = State(initialValue: tools)
		self.canManage = canManage
		self.setAccess = setAccess
	}

	var body: some View {
		let needle = query.trimmingCharacters(in: .whitespaces).lowercased()
		let matches = { (tool: ConnectionToolSetting) in
			needle.isEmpty || tool.name.lowercased().contains(needle) || tool.name.replacingOccurrences(of: "_", with: " ").lowercased().contains(needle)
		}
		let kinds = ToolKind.of(tools)
		let apart = ToolKind.setApart(kinds)
		let shownApart = apart.filter { matches($0.tool) }
		let anyShown = !shownApart.isEmpty || kinds.contains { $0.tools.contains(where: matches) }
		SettingsPage(
			title: "Individual tools",
			description: "Set a tool of \(connection.name) differently from its group.",
			hero: AnyView(ConnectionMark(presetId: connection.presetId, name: connection.name, size: .lg))
		) {
			VStack(spacing: 0) {
				SearchField(placeholder: "Search \(tools.count) \(connection.name) tools", text: $query, style: .inCard)
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
		tools = tools.applying(access)
		Task { await setAccess(access) }
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
	@State private var failure: String?
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
								remove: canManage ? { change(adding: false, item.repository) } : nil
							)
						}
						if canManage {
							if !listed.repositories.isEmpty { SettingsDivider() }
							SettingsAddRow(label: "Add repository") { choosing = true }
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
			if let failure { FormAlert(text: failure) }
		}
		.sheet(isPresented: $choosing) {
			ChooseRepository(connection: connection, taken: Set(listed?.repositories.map { $0.repository.lowercased() } ?? [])) { repository in
				choosing = false
				change(adding: true, repository)
			}
		}
		.task { await load() }
	}

	private func load() async {
		do {
			listed = try await store.repositories(in: connection.podId, connectionId: connection.id)
			failure = nil
		} catch {
			failure = error.localizedDescription
		}
	}

	private func change(adding: Bool, _ repository: String) {
		Task {
			do {
				let routes = store.client.gitHubConnections
				listed =
					adding
					? try await routes.addRepository(podId: connection.podId, connectionId: connection.id, repository: repository)
					: try await routes.removeRepository(podId: connection.podId, connectionId: connection.id, repository: repository)
				failure = nil
			} catch {
				failure = error.localizedDescription
			}
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
							SettingsRow.trailing(label: repository.repository) {
								if repository.private { SettingsValue(text: "Private") }
							}
						}
						.buttonStyle(SettingsRowPressStyle())
					}
				}
			}
			.task { reachable = try? await store.client.gitHubConnections.reachableRepositories(podId: connection.podId, connectionId: connection.id) }
		}
	}
}
