import SwiftUI

extension SearchPreset {
	static func named(_ id: SearchProviderPresetId) -> SearchPreset { catalog.first { $0.id == id.rawValue } ?? catalog[0] }

	/// The provider this preset makes, as the API names it.
	var presetId: SearchProviderPresetId { SearchProviderPresetId(rawValue: id) }

	/// As `keyHint`.
	var keyHint: String {
		if presetId == .exa { return "A key is optional. Without one, searches use Exa's free tier, which is rate limited." }
		return requiresApiKey ? "A key is required." : "A key is optional."
	}
}

/// A change to the search provider: what is left nil, or kept, stays as it is.
private struct SearchProviderChange {
	var enabled: Bool?
	var baseUrl: String?
	var apiKey = FieldChange<String>.keep
}

/// Web search, as the web's `WebSearchSettings`: the switch, then under
/// Show advanced, the provider and its key or address, and a test search.
@MainActor
struct WebSearchSettingsScreen: View {
	@Environment(WorkspaceStore.self) private var store
	/// The workspace's search provider, which is none until one is set up.
	@State private var provider: Loadable<SearchProvider?> = .loading
	@State private var advancedOpen: Bool?
	@State private var action = SettingsAction()
	@State private var tested: TestResult?
	@State private var removingKey = false

	var body: some View {
		SettingsPage(title: "Web search", description: "Lets bots look things up and cite the pages they used.") {
			switch provider {
			case .loading: EmptyView()
			case let .failed(failure): FormAlert(text: failure)
			case let .loaded(provider): groups(provider)
			}
		}
		.task { await load() }
	}

	@ViewBuilder
	private func groups(_ provider: SearchProvider?) -> some View {
		let chosen = provider?.preset ?? SearchProviderPresetId(rawValue: SearchPreset.defaultId)
		let preset = SearchPreset.named(chosen)
		let needsKey = preset.requiresApiKey && provider?.hasApiKey != true
		let enabled = provider?.enabled ?? false
		// Opened for you when the switch is held off by a missing key, so the reason is in view.
		let open = advancedOpen ?? needsKey
		SettingsGroup(note: needsKey ? "\(preset.name) needs an API key first. Add it below." : nil) {
			SettingsRow(label: "Bots can use the web", sub: "Search the web and read web pages", trailing: {
				WebToggle(label: "Bots can use the web", isOn: enabled) { on in
					action.run { try await configure(SearchProviderChange(enabled: on), provider: provider, chosen: chosen) }
				}
				.disabled(needsKey || action.pending)
			})
		}
		VStack(alignment: .leading, spacing: 28) {
			Button(open ? "Hide advanced" : "Show advanced") { advancedOpen = !open }
				.buttonStyle(WebButtonStyle(variant: .secondary, size: .small))
			if open {
				providerChoice(chosen: chosen, enabled: enabled)
				providerSettings(preset, provider: provider)
			}
		}
		.padding(.top, -12)
		if let failure = action.failure { FormAlert(text: failure) }
	}

	private func providerChoice(chosen: SearchProviderPresetId, enabled: Bool) -> some View {
		SettingsGroup(label: "Provider") {
			DividedRows(data: SearchPreset.catalog, id: \.id) { candidate in
				SettingsRadioRow(name: candidate.name, description: candidate.description, checked: candidate.presetId == chosen) {
					choose(candidate, chosen: chosen, enabled: enabled)
				}
				.disabled(action.pending)
			}
		}
	}

	@ViewBuilder
	private func providerSettings(_ preset: SearchPreset, provider: SearchProvider?) -> some View {
		let hasKey = provider?.hasApiKey == true
		let save = { (change: SearchProviderChange) in
			try await action.perform { try await configure(change, provider: provider, chosen: preset.presetId) }
		}
		VStack(alignment: .leading, spacing: 0) {
			SettingsGroup(label: preset.name) {
				if preset.local {
					TextEntryRow(label: "Server URL", value: .text(saved: provider?.baseUrl ?? preset.baseUrl), placeholder: preset.baseUrl) { url in
						try await save(SearchProviderChange(baseUrl: url))
					}
					SettingsDivider()
				}
				TextEntryRow(
					label: "API key",
					value: .secret(isSaved: hasKey),
					placeholder: "Paste your key",
					save: { key in try await save(SearchProviderChange(apiKey: .set(key))) },
					remove: hasKey ? { removingKey = true } : nil
				)
				if provider != nil, hasKey || !preset.requiresApiKey {
					SettingsDivider()
					Button(action: test) { SettingsRow(label: "Test search", sub: "Runs one search with these settings.") }
						.buttonStyle(SettingsRowPressStyle())
				}
			}
			.disabled(action.pending)
			standing(preset, provider: provider).padding(.horizontal, 2).padding(.top, 10)
		}
		.confirmDelete(
			isPresented: $removingKey,
			title: "Remove the \(preset.name) key?",
			description: preset.requiresApiKey ? "Bots stop using the web until another key is added." : "Searches carry on without a key, within the provider's free limits.",
			confirmLabel: "Remove"
		) {
			try await configure(SearchProviderChange(apiKey: .clear), provider: provider, chosen: preset.presetId)
		}
	}

	/// How the last test went, or what a key is for, as `testStanding` and `keyHint`.
	@ViewBuilder
	private func standing(_ preset: SearchPreset, provider: SearchProvider?) -> some View {
		if let tested {
			TestResultLine(result: tested)
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
		let loaded: Loadable<SearchProvider?> = await .of { try await store.client.searchProviders.get(workspace: store.workspace.id).provider }
		// A failed reload keeps the settings shown, with what failed under them.
		if case let .failed(failure) = loaded, provider.value != nil {
			action.failure = failure
		} else {
			provider = loaded
		}
	}

	private func choose(_ next: SearchPreset, chosen: SearchProviderPresetId, enabled: Bool) {
		guard next.presetId != chosen else { return }
		tested = nil
		action.run {
			_ = try await store.client.searchProviders.replace(
				workspace: store.workspace.id, preset: next.presetId, enabled: enabled && !next.requiresApiKey
			)
			await load()
		}
	}

	/// Changes the provider, setting one up first if there's none yet, then
	/// reloads it. What a test found no longer holds after a change, so it goes.
	private func configure(_ change: SearchProviderChange, provider: SearchProvider?, chosen: SearchProviderPresetId) async throws {
		let routes = store.client.searchProviders
		if provider != nil {
			_ = try await routes.update(workspace: store.workspace.id, enabled: change.enabled, baseUrl: change.baseUrl, apiKey: change.apiKey.apiValue)
		} else {
			let apiKey: String? = if case let .set(key) = change.apiKey { key } else { nil }
			_ = try await routes.replace(
				workspace: store.workspace.id,
				preset: chosen,
				enabled: change.enabled ?? false,
				apiKey: apiKey,
				baseUrl: change.baseUrl
			)
		}
		tested = nil
		await load()
	}

	private func test() {
		action.run {
			let result = try await store.client.searchProviders.test(workspace: store.workspace.id)
			tested = TestResult(passed: result.reachable, text: result.reachable ? "Search works" : result.error ?? "The search did not work.")
			await load()
		}
	}
}
