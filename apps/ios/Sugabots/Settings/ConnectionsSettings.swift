import SwiftUI

/// A pod's Connections, as the web's `ConnectionsSettings`: each with its mark
/// and how it stands, Sign in or Fix where it needs it, and Add connection.
/// Signing in to a server goes through the browser, where its sign-in returns
/// to the web; the list is fetched again when the app comes back.
@MainActor
struct PodConnectionsPage: View {
	let pod: Pod
	let record: Pod
	@Environment(WorkspaceStore.self) private var store
	@Environment(\.openURL) private var openURL
	@Environment(\.scenePhase) private var scenePhase
	@State private var connections: [Connection]?
	@State private var failure: String?
	@State private var adding = false
	@State private var rowFailures: [String: String] = [:]

	var body: some View {
		let canManage = record.permissions.manageConnections
		SettingsPage(title: "Connections", description: "Shared by every bot in \(record.name).") {
			if canManage { SettingsAddButton(label: "Add connection") { adding = true } }
		} content: {
			if let failure {
				FormAlert(text: failure)
			} else if let connections {
				SettingsGroup(note: "Bots act as whoever connected each one. Open one to choose for each tool.") {
					DividedRows(data: connections) { connection in row(connection, canManage: canManage) }
					if connections.isEmpty { SettingsEmptyRow(text: "No connections in this pod yet") }
				}
			}
		}
		.fullScreenCover(isPresented: $adding) {
			AddConnectionSheet(
				pod: pod,
				podName: record.name,
				taken: Set((connections ?? []).compactMap { ConnectionPreset.matching(url: $0.url)?.id }),
				offersGitHub: !(connections ?? []).contains { $0.kind == .github }
			) { await load() }
		}
		.task {
			await load()
			if DebugSheet.wants("addconnection") { adding = true }
		}
		.onChange(of: scenePhase) { _, phase in if phase == .active { Task { await load() } } }
	}

	private func line(for connection: Connection) -> String {
		if !connection.signedIn { return "Not signed in yet" }
		if connection.status == .error { return connection.lastTestError ?? "The last check failed" }
		return connection.toolCounts.summary ?? "No actions found yet"
	}

	private func row(_ connection: Connection, canManage: Bool) -> some View {
		let needsSignIn = !connection.signedIn
		let failing = connection.signedIn && connection.status == .error
		let failure = rowFailures[connection.id]
		let text = failure ?? line(for: connection)
		return NavigationLink(value: Route.settings(.connection(pod, connection))) {
			HStack(spacing: 14) {
				ConnectionMark(presetId: connection.presetId, name: connection.name, size: .tile)
				VStack(alignment: .leading, spacing: 2) {
					Text(connection.name).font(Typeface.rubik(16)).foregroundStyle(Palette.foreground).lineLimit(1)
					Text(text)
						.font(Typeface.rubik(13))
						.foregroundStyle(failing || failure != nil ? Palette.destructiveText : Palette.subtleForeground)
						.lineLimit(failing || failure != nil ? 2 : nil)
				}
				.frame(maxWidth: .infinity, alignment: .leading)
				if canManage && (needsSignIn || failing) {
					Button(needsSignIn ? "Sign in" : connection.auth == .oauth ? "Reconnect" : "Fix") { reconnect(connection) }
						.buttonStyle(WebButtonStyle(variant: .secondary, size: .small))
				}
				Icon(.chevronRight, size: 14).foregroundStyle(Palette.subtleForeground)
			}
			.padding(.horizontal, 16)
			.padding(.vertical, 12)
			.frame(minHeight: 56)
			.contentShape(Rectangle())
		}
		.buttonStyle(SettingsRowPressStyle())
		.accessibilityLabel("\(connection.name), \(text). Open tools")
	}

	/// Signs a server that signs in back in through the browser; any other is fixed on its own page.
	private func reconnect(_ connection: Connection) {
		guard connection.auth == .oauth else {
			openURL(store.webURL("settings/pods/\(pod.slug)/connections/\(connection.id)"))
			return
		}
		Task {
			do {
				if let url = try await store.startSignIn(connection) { openURL(url) } else { await load() }
				rowFailures[connection.id] = nil
			} catch {
				rowFailures[connection.id] = error.localizedDescription
			}
		}
	}

	private func load() async {
		do {
			connections = try await store.connections(in: pod.id)
			failure = nil
		} catch {
			failure = error.localizedDescription
		}
	}
}

/// Adding a connection, as the web's `AddConnectionDialog`: a searchable list
/// of apps and GitHub, then an app's sign-in, or a server or endpoint by its address.
@MainActor
private struct AddConnectionSheet: View {
	enum Choice: Hashable {
		case preset(ConnectionPreset)
		case byURL(endpoint: Bool)
	}

	let pod: Pod
	let podName: String
	let taken: Set<String>
	let offersGitHub: Bool
	let added: () async -> Void
	@Environment(WorkspaceStore.self) private var store
	@Environment(\.openURL) private var openURL
	@Environment(\.dismiss) private var dismiss
	@State private var choice: Choice?
	@State private var query = ""

	var body: some View {
		switch choice {
		case let .preset(preset): AppStep(pod: pod, preset: preset) { choice = nil }
		case let .byURL(endpoint): ByURLStep(pod: pod, endpoint: endpoint, back: { choice = nil }, done: added)
		case nil: appList
		}
	}

	private var appList: some View {
		let needle = query.trimmingCharacters(in: .whitespaces).lowercased()
		let matches = { (name: String, description: String) in
			needle.isEmpty || name.lowercased().contains(needle) || description.lowercased().contains(needle)
		}
		let shown = ConnectionPreset.catalog.filter { !taken.contains($0.id) && matches($0.name, $0.description) }
		let gitHubShown = offersGitHub && matches("GitHub", "Repositories, issues and pull requests")
		return DialogForm(title: "Add to \(podName)", gap: 14) {
			SearchField(placeholder: "Search apps", text: $query)
			VStack(spacing: 20) {
				if gitHubShown || !shown.isEmpty {
					SettingsGroup {
						if gitHubShown {
							// GitHub's app is made on GitHub from a form the web posts, so it's set up on the web.
							Button { openURL(store.webURL("settings/pods/\(pod.slug)/connections")) } label: {
								SettingsRow.icon(label: "GitHub", sub: "Repositories, issues and pull requests", chevron: true) {
									ConnectionMark(presetId: "github", name: "GitHub", size: .tile)
								}
							}
							.buttonStyle(SettingsRowPressStyle())
							if !shown.isEmpty { SettingsDivider() }
						}
						DividedRows(data: shown) { preset in
							Button { choice = .preset(preset) } label: {
								SettingsRow.icon(label: preset.name, sub: preset.description, chevron: true) {
									ConnectionMark(presetId: preset.id, name: preset.name, size: .tile)
								}
							}
							.buttonStyle(SettingsRowPressStyle())
						}
					}
				}
				if !gitHubShown, shown.isEmpty, !needle.isEmpty {
					Text("No app matches “\(query.trimmingCharacters(in: .whitespaces))”.")
						.font(Typeface.rubik(12.5))
						.foregroundStyle(Palette.mutedForeground)
						.frame(maxWidth: .infinity, alignment: .leading)
						.padding(.horizontal, 4)
				}
				SettingsGroup(label: "Something else") {
					somethingElse(icon: .code, label: "Connect by URL", sub: "Any MCP server, by its address") { choice = .byURL(endpoint: false) }
					SettingsDivider()
					somethingElse(icon: .globe, label: "HTTP endpoint", sub: "Any web API, by its base address") { choice = .byURL(endpoint: true) }
				}
			}
		}
	}

	private func somethingElse(icon: Lucide, label: String, sub: String, action: @escaping () -> Void) -> some View {
		Button(action: action) {
			SettingsRow.icon(label: label, sub: sub, chevron: true) {
				Icon(icon, size: 15, strokeWidth: 2.2)
					.foregroundStyle(Palette.softForeground)
					.frame(width: 34, height: 34)
					.overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(Palette.borderStrong))
			}
		}
		.buttonStyle(SettingsRowPressStyle())
	}
}

/// Connecting a catalog app: its mark, and Connect, which signs in to it in the browser.
@MainActor
private struct AppStep: View {
	let pod: Pod
	let preset: ConnectionPreset
	let back: () -> Void
	@Environment(WorkspaceStore.self) private var store
	@Environment(\.openURL) private var openURL
	@Environment(\.dismiss) private var dismiss
	@State private var connecting = false
	@State private var failure: String?

	var body: some View {
		DialogForm(title: preset.name, onBack: connecting ? nil : back) {
			VStack(spacing: 6) {
				ConnectionMark(presetId: preset.id, name: preset.name)
				Text(preset.description).font(Typeface.rubik(13.5)).foregroundStyle(Palette.mutedForeground)
			}
			.frame(maxWidth: .infinity)
			.padding(.bottom, 4)
			if let failure { FormAlert(text: failure) }
			Button(action: connect) {
				HStack(spacing: 6) {
					Text("Connect \(preset.name)")
					Icon(.arrowUpRight, size: 14)
				}
			}
			.buttonStyle(WebButtonStyle(size: .large))
			.frame(maxWidth: .infinity)
			.disabled(connecting)
			.padding(.top, 8)
			Text("You'll sign in to \(preset.name) next.")
				.font(Typeface.rubik(12.5))
				.foregroundStyle(Palette.subtleForeground)
				.frame(maxWidth: .infinity)
		}
	}

	private func connect() {
		connecting = true
		failure = nil
		Task {
			do {
				if let url = try await store.connectSigningIn(in: pod.id, name: preset.name, url: preset.url) {
					openURL(url)
					dismiss()
				}
			} catch {
				failure = error.localizedDescription
			}
			connecting = false
		}
	}
}

/// A server or HTTP endpoint by its address, as `ByUrlStep`: its name and
/// address, how it signs in, Test and Add.
@MainActor
private struct ByURLStep: View {
	enum Method: String, Hashable {
		case token, oauth, header

		var note: String {
			switch self {
			case .token: "Paste the access token or API key the server gave you."
			case .oauth: "You'll sign in to the server next."
			case .header: "The secret is sent in this header exactly as you type it."
			}
		}
	}

	let pod: Pod
	let endpoint: Bool
	let back: () -> Void
	let done: () async -> Void
	@Environment(WorkspaceStore.self) private var store
	@Environment(\.openURL) private var openURL
	@Environment(\.dismiss) private var dismiss
	@State private var name = ""
	@State private var url = ""
	@State private var method = Method.token
	@State private var secretHeader = ""
	@State private var secret = ""
	@State private var outcome: (ok: Bool, message: String)?
	@State private var pending = false
	@State private var testing = false

	var body: some View {
		let ready = !name.trimmingCharacters(in: .whitespaces).isEmpty && !url.trimmingCharacters(in: .whitespaces).isEmpty
		let methods: [(Method, String)] = endpoint ? [(.token, "Token"), (.header, "Header")] : [(.token, "Token"), (.oauth, "Sign in"), (.header, "Header")]
		DialogForm(
			title: endpoint ? "HTTP endpoint" : "Connect by URL",
			action: method == .oauth ? "Sign in" : "Add",
			actionDisabled: !ready || pending,
			onBack: pending ? nil : back,
			submit: submit
		) {
			SettingsGroup(note: endpoint ? "Bots can send GET, POST, PUT, PATCH and DELETE requests to paths under this address. They never see the secret." : nil) {
				SettingsFieldRow(label: "Name", value: $name, placeholder: "e.g. Team wiki")
				SettingsDivider()
				SettingsFieldRow(label: "Server URL", value: clearing($url), placeholder: endpoint ? "https://api.example.com/v1" : "https://mcp.example.com/mcp", mono: true)
			}
			SettingsGroup(note: method.note) {
				SettingsRow.trailing(label: "Sign in with") {
					SegmentedChoice(label: "How to sign in to the server", options: methods.map { ($0.0, $0.1) }, value: method) {
						method = $0
						outcome = nil
					}
				}
				if method == .token {
					SettingsDivider()
					SettingsFieldRow(label: "Access token", value: clearing($secret), placeholder: "Optional", mono: true, secret: true)
				}
				if method == .header {
					SettingsDivider()
					SettingsFieldRow(label: "Header name", value: clearing($secretHeader), placeholder: "X-API-Key", mono: true)
					SettingsDivider()
					SettingsFieldRow(label: "Secret", value: clearing($secret), placeholder: "Optional", mono: true, secret: true)
				}
			}
			if let outcome {
				if outcome.ok {
					HStack(spacing: 6) {
						Icon(.circleCheck, size: 16)
						Text(outcome.message)
					}
					.font(Typeface.rubik(13, .medium))
					.foregroundStyle(Palette.successText)
				} else {
					FormAlert(text: outcome.message)
				}
			}
			if method != .oauth, !endpoint {
				Button(testing ? "Testing…" : "Test", action: test)
					.buttonStyle(WebButtonStyle(variant: .secondary, size: .phone))
					.disabled(url.trimmingCharacters(in: .whitespaces).isEmpty || testing)
			}
		}
	}

	/// A binding that also clears what the last Test found, which a change makes out of date.
	private func clearing(_ binding: Binding<String>) -> Binding<String> {
		Binding(get: { binding.wrappedValue }, set: {
			binding.wrappedValue = $0
			outcome = nil
		})
	}

	/// The secret and the header it's sent in, as the chosen method sends them.
	private var credentials: (header: String?, secret: String?) {
		switch method {
		case .token:
			let token = secret.trimmingCharacters(in: .whitespaces)
			return token.isEmpty ? (nil, nil) : ("Authorization", WorkspaceStore.bearerAuthorization(token))
		case .header, .oauth:
			return (secretHeader.isEmpty ? nil : secretHeader, secret.isEmpty ? nil : secret)
		}
	}

	private func test() {
		testing = true
		Task {
			do {
				let tested = try await store.testUnsavedConnection(in: pod.id, url: url, secretHeader: credentials.header, secret: credentials.secret)
				outcome = tested.reachable ? (true, "Connection successful") : (false, tested.error ?? "The server did not answer.")
			} catch {
				outcome = (false, error.localizedDescription)
			}
			testing = false
		}
	}

	private func submit() {
		pending = true
		Task {
			do {
				if method == .oauth {
					if let signIn = try await store.connectSigningIn(in: pod.id, name: name, url: url) { openURL(signIn) }
				} else {
					let (secretHeader, secret) = credentials
					let connection: NewConnection =
						endpoint
						? .http(.init(name: name, url: url, secretHeader: secretHeader, secret: secret))
						: .mcp(.init(kind: "mcp", name: name, url: url, secretHeader: secretHeader, secret: secret))
					try await store.createConnection(in: pod.id, connection: connection)
				}
				await done()
				dismiss()
			} catch {
				outcome = (false, error.localizedDescription)
			}
			pending = false
		}
	}
}
