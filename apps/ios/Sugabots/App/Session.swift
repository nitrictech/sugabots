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
		/// The workspace could not be opened for a reason other than the server
		/// refusing the token, such as being offline. The token is kept, so
		/// trying again needs no password; `client` holds it, for signing out.
		case openFailed(reason: String, client: APIClient)
		/// The workspace, and the bot's channel to open on Home as it loads, if any.
		case signedIn(WorkspaceStore, openingChannel: ChannelToOpen?)
		/// Making a workspace, or finishing one's setup, as the web's `/onboarding`.
		case settingUp(WorkspaceSetup)
	}

	/// A bot's channel to open on Home when a workspace opens, as setup's Start chatting opens the first bot's.
	struct ChannelToOpen {
		let pod: Pod
		let bot: Agent
	}

	private static let serverKey = "serverURL"
	private static let workspaceKey = "workspaceSlug"

	/// Where a development build looks first: the API under `bun run dev`.
	#if DEBUG
	static let defaultServer: String? = "https://sugabots.local"
	#else
	static let defaultServer: String? = nil
	#endif

	private(set) var state: State = .restoring

	/// How many changes of state have begun. A change records the count as it
	/// begins, and is dropped if the count has moved on by the time it
	/// finishes: a later change, such as signing out while a workspace opens, wins.
	private var transitionsBegun = 0
	/// Opening the workspace `switchWorkspace` chose; cancelled when another change of state begins.
	private var switching: Task<Void, Never>?

	/// The server as the person last typed it, without the API's path; nil when there is none.
	var server: String? {
		UserDefaults.standard.string(forKey: Self.serverKey) ?? Self.defaultServer
	}

	/// Opens the workspace with the token kept from last time, or shows sign-in when there is none.
	func restore() async {
		#if DEBUG
		if await signInFromLaunchEnvironment() { return }
		#endif
		guard let server, let client = try? requireClient(for: server), client.tokens.token != nil else {
			await transition { .signedOut }
			return
		}
		await transition { await openingStateOrFailure(with: client) }
	}

	/// Whether a Sugabots server answers at `server`, so a mistyped workspace is caught before the password is.
	func checkServer(_ server: String) async throws {
		let client = try requireClient(for: server)
		do {
			_ = try await client.health()
		} catch let failure as APIFailure {
			throw APIFailure(status: failure.status, message: "There's no Sugabots workspace at \(client.baseURL.host() ?? server).")
		} catch {
			throw APIFailure(status: 0, message: "Couldn't reach \(client.baseURL.host() ?? server). \(error.localizedDescription)")
		}
	}

	/// Signs in and opens the person's workspace, throwing when either fails.
	func signIn(server: String, email: String, password: String) async throws {
		let client = try requireClient(for: server)
		try await client.signIn(email: email, password: password)
		UserDefaults.standard.set(server, forKey: Self.serverKey)
		try await transition { try await openingState(with: client) }
	}

	/// Makes an account and opens it. Answers false when the installation waits
	/// on the emailed link before signing anyone in.
	func signUp(server: String, name: String, email: String, password: String) async throws -> Bool {
		let client = try requireClient(for: server)
		guard try await client.signUp(name: name, email: email, password: password) else { return false }
		UserDefaults.standard.set(server, forKey: Self.serverKey)
		try await transition { try await openingState(with: client) }
		return true
	}

	/// Emails `email` a link to choose a new password, if it has an account. The link opens the web app.
	func requestPasswordReset(server: String, email: String) async throws {
		let client = try requireClient(for: server)
		try await client.requestPasswordReset(email: email, redirectTo: client.webRoot.appending(path: "reset-password").absoluteString)
	}

	/// Signs out on the server, forgets the token and what this device remembers about the person's workspaces, and shows sign-in.
	func signOut() async {
		await transition {
			switch state {
			case let .signedIn(store, _):
				WorkspacePreferences.forget(workspaceIds: store.workspaces.map(\.id))
				await store.client.signOut()
			case let .openFailed(_, client):
				await client.signOut()
			case .restoring, .signedOut, .settingUp:
				break
			}
			return .signedOut
		}
	}

	func switchWorkspace(to workspace: Workspace) {
		guard case let .signedIn(store, _) = state else { return }
		UserDefaults.standard.set(workspace.slug, forKey: Self.workspaceKey)
		let begun = beginTransition()
		switching = Task {
			let next = await WorkspaceSetup.stateOpening(workspace, client: store.client, user: store.user, workspaces: store.workspaces)
			guard !Task.isCancelled else { return }
			complete(begun, with: next)
		}
	}

	/// Leaves setup for `workspace`: the one it set up, the one it was opened
	/// from, or with nil, whatever the person has. With `channel`, Home opens
	/// that bot's channel once the workspace does.
	func finishWorkspaceSetup(opening workspace: Workspace?, showing channel: ChannelToOpen? = nil) async {
		guard case let .settingUp(setup) = state else { return }
		if let workspace { UserDefaults.standard.set(workspace.slug, forKey: Self.workspaceKey) }
		await transition { await openingStateOrFailure(with: setup.client, showing: channel) }
	}

	// MARK: Changing state

	/// Moves to the state `next` returns, unless another change of state begins while `next` runs.
	private func transition(_ next: () async throws -> State) async rethrows {
		let begun = beginTransition()
		let state = try await next()
		complete(begun, with: state)
	}

	/// Starts a change of state, cancelling a workspace `switchWorkspace` is still opening. Returns the count `complete` checks.
	private func beginTransition() -> Int {
		switching?.cancel()
		transitionsBegun += 1
		return transitionsBegun
	}

	/// Moves to `next` if no change of state has begun since the one `begun` counts, stopping the workspace that was open.
	private func complete(_ begun: Int, with next: State) {
		guard begun == transitionsBegun else { return }
		if case let .signedIn(open, _) = state { open.stop() }
		state = next
	}

	/// Asks the server who the token belongs to, and returns what opening
	/// their workspace shows: the one last open, or their first. Forgets the
	/// token when the server refuses it, and throws every failure.
	private func openingState(with client: APIClient, showing channel: ChannelToOpen? = nil) async throws -> State {
		let me: Me
		do {
			me = try await client.me()
		} catch let failure as APIFailure where failure.isUnauthorized {
			client.tokens.clear()
			throw failure
		}
		let remembered = UserDefaults.standard.string(forKey: Self.workspaceKey)
		guard let workspace = me.workspaces.first(where: { $0.slug == remembered }) ?? me.workspaces.first else {
			// Somebody in no workspace makes their first.
			return .settingUp(WorkspaceSetup(client: client, user: me.user, workspaces: me.workspaces))
		}
		return await WorkspaceSetup.stateOpening(workspace, client: client, user: me.user, workspaces: me.workspaces, showing: channel)
	}

	/// As `openingState`, for when there is no form to show a failure on: a
	/// refused token shows sign-in, and any other failure `.openFailed`.
	private func openingStateOrFailure(with client: APIClient, showing channel: ChannelToOpen? = nil) async -> State {
		do {
			return try await openingState(with: client, showing: channel)
		} catch let failure as APIFailure where failure.isUnauthorized {
			return .signedOut
		} catch {
			return .openFailed(reason: error.localizedDescription, client: client)
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

	/// The API under `server`, which may be typed without its scheme. Throws `InvalidServerAddress` when `server` is empty or not an address.
	private func requireClient(for server: String) throws -> APIClient {
		let trimmed = server.trimmingCharacters(in: .whitespacesAndNewlines).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
		let withScheme = trimmed.contains("://") ? trimmed : "https://\(trimmed)"
		guard !trimmed.isEmpty, let root = URL(string: withScheme), root.host() != nil else { throw InvalidServerAddress() }
		let api = root.appending(path: "api")
		return APIClient(baseURL: api, tokens: TokenStore(server: api))
	}
}

/// A server address that is empty, or isn't an address.
struct InvalidServerAddress: LocalizedError {
	var errorDescription: String? { "Enter the address you open Sugabots at, such as https://sugabots.example.com." }
}
