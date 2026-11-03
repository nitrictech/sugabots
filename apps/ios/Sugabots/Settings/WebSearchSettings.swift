import SwiftUI

/// A search provider in the catalog, as `searchProviderCatalog`.
private struct SearchPreset {
	let id: String
	let name: String
	let baseUrl: String
	let local: Bool
	let requiresApiKey: Bool
	let description: String

	static let catalog = [
		SearchPreset(id: "exa", name: "Exa", baseUrl: "https://api.exa.ai", local: false, requiresApiKey: false, description: "Works out of the box"),
		SearchPreset(id: "brave", name: "Brave Search", baseUrl: "https://api.search.brave.com/res/v1", local: false, requiresApiKey: true, description: "Independent index, simple pricing"),
		SearchPreset(id: "tavily", name: "Tavily", baseUrl: "https://api.tavily.com", local: false, requiresApiKey: true, description: "Made for AI agents"),
		SearchPreset(id: "searxng", name: "SearXNG", baseUrl: "http://127.0.0.1:8080", local: true, requiresApiKey: false, description: "Runs on your own server"),
	]

	/// As `DEFAULT_SEARCH_PRESET`.
	static let defaultId = "exa"

	static func named(_ id: String) -> SearchPreset { catalog.first { $0.id == id } ?? catalog[0] }

	/// As `keyHint`.
	var keyHint: String {
		if id == "exa" { return "A key is optional. Without one, searches use Exa's free tier, which is rate limited." }
		return requiresApiKey ? "A key is required." : "A key is optional."
	}
}

/// A change to the search provider: what is left nil stays as it is.
private struct SearchProviderChange {
	var enabled: Bool?
	var baseUrl: String?
	/// A new key, or with `.some(nil)`, none.
	var apiKey: String??
}

/// Web search, as the web's `WebSearchSettings`: the switch, then under
/// Show advanced, the provider and its key or address, and a test search.
@MainActor
struct WebSearchSettingsScreen: View {
	@Environment(WorkspaceStore.self) private var store
	@State private var provider: SearchProvider?
	@State private var loaded = false
	@State private var failure: String?
	@State private var advancedOpen: Bool?
	@State private var pending = false
	@State private var error: String?
	@State private var tested: (reachable: Bool, error: String?)?
	@State private var removingKey = false

	var body: some View {
		SettingsPage(title: "Web search", description: "Lets bots look things up and cite the pages they used.") {
			if let may = store.permissions, !may.manageProviders {
				FormAlert(text: "Only workspace administrators can manage web search.")
			} else if let failure {
				FormAlert(text: failure)
			} else if loaded {
				groups
			}
		}
		.task { await load() }
	}

	@ViewBuilder
	private var groups: some View {
		let chosen = provider?.preset.rawValue ?? SearchPreset.defaultId
		let preset = SearchPreset.named(chosen)
		let needsKey = preset.requiresApiKey && provider?.hasApiKey != true
		let enabled = provider?.enabled ?? false
		// Opened for you when the switch is held off by a missing key, so the reason is in view.
		let open = advancedOpen ?? needsKey
		SettingsGroup(note: needsKey ? "\(preset.name) needs an API key first. Add it below." : nil) {
			SettingsRow.trailing(label: "Bots can use the web", sub: "Search the web and read web pages") {
				WebToggle(label: "Bots can use the web", isOn: enabled) { on in
					Task { await act { try await configure(SearchProviderChange(enabled: on), chosen: chosen) } }
				}
					.disabled(needsKey || pending)
			}
		}
		VStack(alignment: .leading, spacing: 28) {
			Button(open ? "Hide advanced" : "Show advanced") { advancedOpen = !open }
				.buttonStyle(WebButtonStyle(variant: .secondary, size: .small))
			if open {
				providerChoice(chosen: chosen, enabled: enabled)
				providerSettings(preset)
			}
		}
		.padding(.top, -12)
		if let error { FormAlert(text: error) }
	}

	private func providerChoice(chosen: String, enabled: Bool) -> some View {
		SettingsGroup(label: "Provider") {
			DividedRows(data: SearchPreset.catalog, id: \.id) { candidate in
				SettingsRadioRow(name: candidate.name, description: candidate.description, checked: candidate.id == chosen) {
					choose(candidate, chosen: chosen, enabled: enabled)
				}
				.disabled(pending)
			}
		}
	}

	@ViewBuilder
	private func providerSettings(_ preset: SearchPreset) -> some View {
		let hasKey = provider?.hasApiKey == true
		VStack(alignment: .leading, spacing: 0) {
			SettingsGroup(label: preset.name) {
				if preset.local {
					TextEntryRow(label: "Server URL", saved: provider?.baseUrl ?? preset.baseUrl, placeholder: preset.baseUrl, disabled: pending) { value in
						await act { try await configure(SearchProviderChange(baseUrl: value), chosen: preset.id) }
					}
					SettingsDivider()
				}
				TextEntryRow(label: "API key", saved: hasKey ? "" : nil, placeholder: "Paste your key", secret: true, disabled: pending, onRemove: hasKey ? { removingKey = true } : nil) { value in
					await act { try await configure(SearchProviderChange(apiKey: value), chosen: preset.id) }
				}
				if provider != nil, hasKey || !preset.requiresApiKey {
					SettingsDivider()
					Button(action: test) { SettingsRow(label: "Test search", sub: "Runs one search with these settings.") }
						.buttonStyle(SettingsRowPressStyle())
						.disabled(pending)
				}
			}
			standing(preset).padding(.horizontal, 2).padding(.top, 10)
		}
		.confirmDelete(
			isPresented: $removingKey,
			title: "Remove the \(preset.name) key?",
			description: preset.requiresApiKey ? "Bots stop using the web until another key is added." : "Searches carry on without a key, within the provider's free limits.",
			confirmLabel: "Remove"
		) {
			try await configure(SearchProviderChange(apiKey: .some(nil)), chosen: preset.id)
		}
	}

	/// How the last test went, or what a key is for, as `testStanding` and `keyHint`.
	@ViewBuilder
	private func standing(_ preset: SearchPreset) -> some View {
		if let tested {
			if tested.reachable {
				HStack(spacing: 6) {
					Icon(.circleCheck, size: 16)
					Text("Search works")
				}
				.font(Typeface.rubik(13, .medium))
				.foregroundStyle(Palette.successText)
			} else {
				FormAlert(text: tested.error ?? "The search did not work.")
			}
		} else if provider?.status == .connected {
			note("The last test search worked.")
		} else if provider?.status == .error {
			FormAlert(text: provider?.lastTestError ?? "The last test search failed.")
		} else {
			note(preset.keyHint)
		}
	}

	private func note(_ text: String) -> some View {
		Text(text).font(Typeface.rubik(13)).lineSpacing(3).foregroundStyle(Palette.subtleForeground)
	}

	// MARK: Doing

	private func load() async {
		await store.refreshAccess()
		do {
			provider = try await store.client.searchProviders.get(workspace: store.workspace.id).provider
			failure = nil
		} catch {
			failure = error.localizedDescription
		}
		loaded = true
	}

	private func choose(_ next: SearchPreset, chosen: String, enabled: Bool) {
		guard next.id != chosen else { return }
		tested = nil
		Task {
			await act {
				_ = try await store.client.searchProviders.replace(
					workspace: store.workspace.id, preset: SearchProviderPresetId(rawValue: next.id), enabled: enabled && !next.requiresApiKey
				)
				await load()
			}
		}
	}

	/// Changes the provider, setting one up first if there's none yet, then reloads it.
	private func configure(_ change: SearchProviderChange, chosen: String) async throws {
		let routes = store.client.searchProviders
		if provider != nil {
			_ = try await routes.update(workspace: store.workspace.id, enabled: change.enabled, baseUrl: change.baseUrl, apiKey: change.apiKey)
		} else {
			_ = try await routes.replace(
				workspace: store.workspace.id,
				preset: SearchProviderPresetId(rawValue: chosen),
				enabled: change.enabled ?? false,
				apiKey: change.apiKey ?? nil,
				baseUrl: change.baseUrl
			)
		}
		await load()
	}

	private func test() {
		Task {
			await act {
				let result = try await store.client.searchProviders.test(workspace: store.workspace.id)
				tested = (result.reachable, result.error)
				await load()
			}
		}
	}

	/// Runs a change with the page's controls held, showing a failure under them.
	private func act(_ work: () async throws -> Void) async {
		pending = true
		error = nil
		do {
			try await work()
		} catch {
			self.error = error.localizedDescription
		}
		pending = false
	}
}
