import SwiftUI

/// The popular providers Models offers to connect, in their order, as `POPULAR_PRESETS`.
private let popularPresets = [("openrouter", "OpenRouter"), ("anthropic", "Anthropic"), ("openai", "OpenAI"), ("gemini", "Google Gemini")]

/// Models, as the web's `ModelsSettings`: the defaults, then the providers,
/// connected first, the popular ones still to connect, and Add a provider.
@MainActor
struct ModelsSettingsScreen: View {
	@Environment(WorkspaceStore.self) private var store
	@State private var providers: [ModelProvider]?
	@State private var defaultModel: String?
	@State private var summaries: String?
	@State private var failure: String?
	/// The provider to start adding with, or `""` for the whole list.
	@State private var adding: String?
	@State private var opened: Route?

	var body: some View {
		let all = providers ?? []
		let byPreset = Dictionary(all.compactMap { provider in provider.preset.map { ($0.rawValue, provider) } }, uniquingKeysWith: { first, _ in first })
		let popular = popularPresets.map(\.0)
		let withCredential = { (preset: String) in byPreset[preset].flatMap { $0.lacksCredential ? nil : $0 } }
		let others = all.filter { ($0.preset == nil || !popular.contains($0.preset!.rawValue)) && ($0.connected || $0.preset == nil) }
		let connected = popular.compactMap(withCredential) + others
		// Nothing until the list arrives: a popular provider would read Not connected whether it is or not.
		let toConnect = providers == nil ? [] : popularPresets.filter { withCredential($0.0) == nil }
		SettingsPage(title: "Models", description: "Which models bots can think with. Each bot picks one of these.") {
			if store.permissions == nil || store.permissions?.manageProviders == true {
				SettingsGroup(label: "Defaults") {
					defaultRow("Default for new bots", model: name(of: defaultModel, in: all), place: .defaultModel)
					if store.permissions?.configureBuiltInAgents == true {
						SettingsDivider()
						defaultRow("Summaries", model: name(of: summaries, in: all), place: .systemModel)
					}
				}
				SettingsGroup(label: "Providers") {
					if let failure { FormAlert(text: failure).padding(.horizontal, 16).padding(.vertical, 12) }
					ForEach(connected) { provider in
						NavigationLink(value: Route.settings(.provider(id: provider.id))) {
							SettingsRow(
								label: provider.name,
								sub: provider.active ? provider.credentialLine : "Turned off",
								chevron: true,
								leading: { ProviderTile(name: provider.name, preset: provider.preset?.rawValue) },
								trailing: { if provider.active { SettingsStatusBadge(text: "Connected") } }
							)
						}
						.buttonStyle(SettingsRowPressStyle())
						SettingsDivider()
					}
					ForEach(toConnect, id: \.0) { preset, name in
						SettingsRow(label: name, sub: "Not connected", leading: { ProviderTile(name: name, preset: preset) }, trailing: {
							Button("Connect") { adding = preset }.buttonStyle(SettingsRowButtonStyle())
						})
						SettingsDivider()
					}
					Button { adding = "" } label: {
						SettingsRow(label: "Add a provider", sub: "Any OpenAI-compatible endpoint, or one on your own machine", chevron: true, leading: {
							SettingsRowIcon { Icon(.plus, size: 14, strokeWidth: 2) }
						}, trailing: { EmptyView() })
						.foregroundStyle(Palette.mutedForeground)
					}
					.buttonStyle(SettingsRowPressStyle())
				}
			} else {
				FormAlert(text: "Only workspace administrators can manage models.")
			}
		}
		.fullScreenCover(item: Binding(get: { adding.map(AddingItem.init) }, set: { adding = $0?.preset })) { item in
			AddProviderSheet(providers: providers ?? [], startWith: item.preset.isEmpty ? nil : item.preset) { provider in
				adding = nil
				opened = .settings(.provider(id: provider.id))
			}
		}
		.navigationDestination(item: $opened) { RouteDestination(route: $0) }
		.task { await load() }
	}

	private struct AddingItem: Identifiable {
		let preset: String
		var id: String { preset }
	}

	/// A default's row: on a phone, the model it's set to under its name.
	private func defaultRow(_ label: String, model: String, place: SettingsPlace) -> some View {
		NavigationLink(value: Route.settings(place)) {
			HStack(spacing: 14) {
				VStack(alignment: .leading, spacing: 2) {
					Text(label).font(Typeface.rubik(16)).foregroundStyle(Palette.foreground)
					Text(model).font(Typeface.rubik(13)).foregroundStyle(Palette.softForeground).lineLimit(1)
				}
				.frame(maxWidth: .infinity, alignment: .leading)
				Icon(.chevronRight, size: 14).foregroundStyle(Palette.subtleForeground)
			}
			.padding(.horizontal, 16)
			.padding(.vertical, 12)
			.frame(minHeight: 56)
			.contentShape(Rectangle())
		}
		.buttonStyle(SettingsRowPressStyle())
	}

	private func name(of modelId: String?, in providers: [ModelProvider]) -> String {
		guard let modelId else { return "Not set" }
		return providers.flatMap(\.models).first { $0.modelId == modelId }?.name ?? modelId
	}

	private func load() async {
		await store.refreshAccess()
		do {
			providers = try await store.client.modelProviders.list(workspace: store.workspace.id)
			failure = nil
		} catch {
			failure = error.localizedDescription
		}
		defaultModel = (try? await store.workspaceModels())?.defaultModel
		let agents = try? await store.client.systemAgents.list(workspace: store.workspace.id)
		summaries = agents?.first { $0.key == .summarise }?.model
	}
}

/// Choosing a model from those switched on, as the web's `ModelChoicePage`.
@MainActor
private struct ModelChoicePage: View {
	let title: String
	let description: String
	let current: () async -> String?
	let choose: (String) async throws -> Void
	@Environment(WorkspaceStore.self) private var store
	@State private var providers: [ModelProvider]?
	@State private var chosen: String?
	@State private var pending = false
	@State private var failure: String?

	var body: some View {
		let groups = (providers ?? []).filter(\.connected).map { ($0, $0.models.filter(\.choosable)) }.filter { !$0.1.isEmpty }
		SettingsPage(title: title, description: description) {
			if let failure { FormAlert(text: failure) }
			if groups.isEmpty, providers != nil {
				SettingsGroup { SettingsRow(label: "No models are switched on yet.") }
			}
			VStack(alignment: .leading, spacing: 12) {
				VStack(alignment: .leading, spacing: 32) {
					ForEach(groups, id: \.0.id) { provider, models in
						SettingsGroup(label: provider.name) {
							DividedRows(data: models) { model in
								Button { pick(model.modelId) } label: {
									SettingsRow.trailing(label: model.name) {
										if model.modelId == chosen { Icon(.check, size: 16, strokeWidth: 2.6).foregroundStyle(Palette.foreground) }
									}
								}
								.buttonStyle(SettingsRowPressStyle())
								.disabled(pending || model.modelId == chosen)
							}
						}
					}
				}
				Text("Only models that are switched on appear here.")
					.font(Typeface.rubik(12))
					.foregroundStyle(Palette.subtleForeground)
					.padding(.horizontal, 2)
			}
		}
		.task {
			providers = try? await store.client.modelProviders.list(workspace: store.workspace.id)
			chosen = await current()
		}
	}

	private func pick(_ modelId: String) {
		pending = true
		failure = nil
		Task {
			do {
				try await choose(modelId)
				chosen = modelId
			} catch {
				failure = error.localizedDescription
			}
			pending = false
		}
	}
}

/// The model new bots start on, as `DefaultModelSettings`.
@MainActor
struct DefaultModelSettingsScreen: View {
	@Environment(WorkspaceStore.self) private var store

	var body: some View {
		ModelChoicePage(
			title: "Default for new bots",
			description: "The model a new bot starts on. Each bot can move to another model in its own settings.",
			current: { (try? await store.workspaceModels())?.defaultModel }
		) { modelId in
			_ = try await store.client.modelProviders.setDefaultModel(workspace: store.workspace.id, model: modelId)
		}
	}
}

/// The model the built-in bots summarise and compact with, as `SystemModelSettings`.
@MainActor
struct SystemModelSettingsScreen: View {
	@Environment(WorkspaceStore.self) private var store

	/// As `BUILT_IN_AGENT_KEYS`: both are set to the one model.
	private static let builtInKeys: [SystemAgentKey] = [.summarise, .compact]

	var body: some View {
		ModelChoicePage(
			title: "Summaries",
			description: "The model Sugabots uses behind the scenes: summaries, chat titles and compacting long chats. A fast, cheap model works best.",
			current: {
				let agents = try? await store.client.systemAgents.list(workspace: store.workspace.id)
				return agents?.first { $0.key == .summarise }?.model
			}
		) { modelId in
			for key in Self.builtInKeys {
				_ = try await store.client.systemAgents.update(workspace: store.workspace.id, key: key.rawValue, model: modelId)
			}
		}
	}
}
