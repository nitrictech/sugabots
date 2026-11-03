import Foundation
import Observation

/// Which server the app talks to, who is signed in to it, and their workspace.
@MainActor
@Observable
final class Session {
	enum State {
		/// Reading the token kept from last time, and asking the server who it belongs to.
		case restoring
		case signedOut
		case signedIn(WorkspaceStore)
		/// Making a workspace, or finishing one's setup, as the web's `/onboarding`.
		case settingUp(WorkspaceSetup)
	}

	private static let serverKey = "serverURL"
	private static let workspaceKey = "workspaceSlug"

	/// Where a development build looks first: the API under `bun run dev`.
	#if DEBUG
	static let defaultServer = "https://sugabots.local"
	#else
	static let defaultServer = ""
	#endif

	private(set) var state: State = .restoring

	/// The server as the person typed it, without the API's path.
	var server: String {
		UserDefaults.standard.string(forKey: Self.serverKey) ?? Self.defaultServer
	}

	func restore() async {
		#if DEBUG
		if await signInFromLaunchEnvironment() { return }
		#endif
		guard let client = client(for: server), client.tokens.token != nil else {
			state = .signedOut
			return
		}
		await open(with: client)
	}

	/// Whether a Sugabots server answers at `server`, so a mistyped address is caught before the password is.
	func checkServer(_ server: String) async throws {
		guard let client = client(for: server) else {
			throw APIFailure(status: 0, message: "Enter an address like sugabots.yourcompany.com")
		}
		do {
			_ = try await client.health()
		} catch let failure as APIFailure {
			throw APIFailure(status: failure.status, message: "There's no Sugabots server at \(client.baseURL.host() ?? server).")
		} catch {
			throw APIFailure(status: 0, message: "Couldn't reach \(client.baseURL.host() ?? server). \(error.localizedDescription)")
		}
	}

	func signIn(server: String, email: String, password: String) async throws {
		guard let client = client(for: server) else {
			throw APIFailure(status: 0, message: "Enter the address you open Sugabots at, such as https://sugabots.example.com.")
		}
		try await client.signIn(email: email, password: password)
		UserDefaults.standard.set(server, forKey: Self.serverKey)
		await open(with: client)
	}

	/// Makes an account and opens it. Answers false when the installation waits
	/// on the emailed link before signing anyone in.
	func signUp(server: String, name: String, email: String, password: String) async throws -> Bool {
		guard let client = client(for: server) else {
			throw APIFailure(status: 0, message: "Enter the address you open Sugabots at, such as https://sugabots.example.com.")
		}
		guard try await client.signUp(name: name, email: email, password: password) else { return false }
		UserDefaults.standard.set(server, forKey: Self.serverKey)
		await open(with: client)
		return true
	}

	/// Emails `email` a link to choose a new password, if it has an account. The link opens the web app.
	func requestPasswordReset(server: String, email: String) async throws {
		guard let client = client(for: server) else {
			throw APIFailure(status: 0, message: "Enter the address you open Sugabots at, such as https://sugabots.example.com.")
		}
		try await client.requestPasswordReset(email: email, redirectTo: client.webRoot.appending(path: "reset-password").absoluteString)
	}

	func signOut() async {
		if case let .signedIn(store) = state {
			store.stop()
			await store.client.signOut()
		}
		state = .signedOut
	}

	func switchWorkspace(to workspace: Workspace) {
		guard case let .signedIn(store) = state else { return }
		UserDefaults.standard.set(workspace.slug, forKey: Self.workspaceKey)
		store.stop()
		Task { state = await WorkspaceSetup.stateOpening(workspace, client: store.client, user: store.user, workspaces: store.workspaces) }
	}

	/// Starts making another workspace, from You, coming back to this one if it's cancelled.
	func startWorkspaceSetup() {
		guard case let .signedIn(store) = state else { return }
		store.stop()
		state = .settingUp(WorkspaceSetup(client: store.client, user: store.user, workspaces: store.workspaces, returnTo: store.workspace))
	}

	/// Leaves setup for a workspace: the one it set up, the one it was opened from, or whatever the person has.
	/// The bot whose channel opens once the workspace does, as setup's Start chatting opens it.
	var botToOpen: (podId: String, agentId: String)?

	func finishWorkspaceSetup(opening workspace: Workspace?) async {
		guard case let .settingUp(setup) = state else { return }
		if let workspace { UserDefaults.standard.set(workspace.slug, forKey: Self.workspaceKey) }
		await open(with: setup.client)
	}

	/// Asks the server who the token belongs to, and opens their workspace: the one last open, or their first.
	private func open(with client: APIClient) async {
		do {
			let me = try await client.me()
			let remembered = UserDefaults.standard.string(forKey: Self.workspaceKey)
			guard let workspace = me.workspaces.first(where: { $0.slug == remembered }) ?? me.workspaces.first else {
				// Somebody in no workspace makes their first.
				state = .settingUp(WorkspaceSetup(client: client, user: me.user, workspaces: me.workspaces))
				return
			}
			state = await WorkspaceSetup.stateOpening(workspace, client: client, user: me.user, workspaces: me.workspaces)
		} catch {
			if (error as? APIFailure)?.isUnauthorized == true {
				client.tokens.token = nil
			}
			state = .signedOut
		}
	}

	#if DEBUG
	/// Signs in with `SUGABOTS_SERVER`, `SUGABOTS_EMAIL` and `SUGABOTS_PASSWORD`
	/// from the launch environment, when all three are set, so a development
	/// account opens without typing: `SIMCTL_CHILD_SUGABOTS_SERVER=… xcrun simctl launch`.
	private func signInFromLaunchEnvironment() async -> Bool {
		let environment = ProcessInfo.processInfo.environment
		guard let server = environment["SUGABOTS_SERVER"],
			let email = environment["SUGABOTS_EMAIL"],
			let password = environment["SUGABOTS_PASSWORD"]
		else { return false }
		do {
			try await signIn(server: server, email: email, password: password)
			return true
		} catch {
			print("Launch sign-in failed: \(error)")
			return false
		}
	}
	#endif

	/// The API under `server`, which may be typed without its scheme.
	private func client(for server: String) -> APIClient? {
		let trimmed = server.trimmingCharacters(in: .whitespacesAndNewlines).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
		guard !trimmed.isEmpty else { return nil }
		let withScheme = trimmed.contains("://") ? trimmed : "https://\(trimmed)"
		guard let root = URL(string: withScheme), root.host() != nil else { return nil }
		let api = root.appending(path: "api")
		return APIClient(baseURL: api, tokens: TokenStore(server: api))
	}
}
