import SwiftUI

/// Where adding a provider starts: the whole list, or one popular provider's Connect.
enum AddProviderStart: Identifiable, Hashable {
	case anyProvider
	case preset(ProviderPresetId)

	var id: Self { self }

	/// The provider to go straight to, or nil for the list.
	var preset: ProviderPresetId? {
		guard case let .preset(preset) = self else { return nil }
		return preset
	}
}

/// Models, as the web's `ModelsSettings`: the defaults, then the providers,
/// connected first, the popular ones still to connect, and Add a provider.
@MainActor
struct ModelsSettingsScreen: View {
	@Environment(WorkspaceStore.self) private var store
	@State private var providers: Loadable<[ModelProvider]> = .loading
	/// The model new bots start on, which may be none.
	@State private var defaultModel: Loadable<String?> = .loading
	/// The model the system bots summarise with, which may be none.
	@State private var summaries: Loadable<String?> = .loading
	@State private var adding: AddProviderStart?
	@Environment(\.openPage) private var openPage

	var body: some View {
		let all = providers.value ?? []
		let listing = ProviderListing(providers.value)
		SettingsPage(title: "Models", description: "Which models bots can think with. Each bot picks one of these.") {
			SettingsGroup(label: "Defaults") {
				defaultRow("Default for new bots", model: name(of: defaultModel, in: all), place: .defaultModel)
				if store.permissions?.configureBuiltInAgents == true {
					SettingsDivider()
					defaultRow("Summaries", model: name(of: summaries, in: all), place: .systemModel)
				}
			}
			SettingsGroup(label: "Providers") {
				if let failure = providers.failure { FormAlert(text: failure).padding(.horizontal, 16).padding(.vertical, 12) }
				ForEach(listing.connected) { provider in
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
				ForEach(listing.toConnect, id: \.self) { preset in
					let name = ProviderPreset.named(preset.rawValue)?.name ?? preset.rawValue
					SettingsRow(label: name, sub: "Not connected", leading: { ProviderTile(name: name, preset: preset.rawValue) }, trailing: {
						Button("Connect") { adding = .preset(preset) }.buttonStyle(SettingsRowButtonStyle())
					})
					SettingsDivider()
				}
				Button { adding = .anyProvider } label: {
					SettingsRow(label: "Add a provider", sub: "Any OpenAI-compatible endpoint, or one on your own machine", chevron: true, leading: {
						SettingsRowIcon { Icon(.plus, size: 14, strokeWidth: 2) }
					}, trailing: { EmptyView() })
					.foregroundStyle(Palette.mutedForeground)
				}
				.buttonStyle(SettingsRowPressStyle())
			}
		}
		.fullScreenCover(item: $adding) { start in
			AddProviderSheet(providers: all, startWith: start.preset) { provider in
				adding = nil
				openPage(.settings(.provider(id: provider.id)))
			}
		}
		.task { await load() }
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

	/// The name of the model `chosen` holds, as `chosenModelName`: nothing while it loads, and what failed if it couldn't.
	private func name(of chosen: Loadable<String?>, in providers: [ModelProvider]) -> String {
		switch chosen {
		case .loading: return ""
		case let .failed(failure): return failure
		case let .loaded(modelId):
			guard let modelId else { return "Not set" }
			return providers.flatMap(\.models).first { $0.modelId == modelId }?.name ?? modelId
		}
	}

	private func load() async {
		providers = await .of { try await store.client.modelProviders.list(workspace: store.workspace.id) }
		defaultModel = await .of { try await store.refreshModels().defaultModel }
		summaries = await .of {
			try await store.client.systemAgents.list(workspace: store.workspace.id).first { $0.key == .summarise }?.model
		}
	}
}

/// Choosing a model from those switched on, as the web's `ModelChoicePage`.
@MainActor
private struct ModelChoicePage: View {
	let title: String
	let description: String
	let current: () async throws -> String?
	let choose: (String) async throws -> Void
	@Environment(WorkspaceStore.self) private var store
	@State private var providers: Loadable<[ModelProvider]> = .loading
	@State private var chosen: String?
	@State private var picking = SettingsAction()

	var body: some View {
		let groups = (providers.value ?? []).filter(\.connected).map { ($0, $0.models.filter(\.choosable)) }.filter { !$0.1.isEmpty }
		SettingsPage(title: title, description: description) {
			if let failure = picking.failure ?? providers.failure { FormAlert(text: failure) }
			if groups.isEmpty, providers.value != nil {
				SettingsGroup { SettingsRow(label: "No models are switched on yet.") }
			}
			VStack(alignment: .leading, spacing: 12) {
				VStack(alignment: .leading, spacing: 32) {
					ForEach(groups, id: \.0.id) { provider, models in
						SettingsGroup(label: provider.name) {
							DividedRows(data: models) { model in
								Button { pick(model.modelId) } label: {
									SettingsRow(label: model.name, trailing: {
										if model.modelId == chosen { Icon(.check, size: 16, strokeWidth: 2.6).foregroundStyle(Palette.foreground) }
									})
								}
								.buttonStyle(SettingsRowPressStyle())
								.disabled(picking.pending || model.modelId == chosen)
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
			providers = await .of { try await store.client.modelProviders.list(workspace: store.workspace.id) }
			do {
				chosen = try await current()
			} catch {
				picking.failure = error.localizedDescription
			}
		}
	}

	private func pick(_ modelId: String) {
		picking.run {
			try await choose(modelId)
			chosen = modelId
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
			current: { try await store.refreshModels().defaultModel }
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
				try await store.client.systemAgents.list(workspace: store.workspace.id).first { $0.key == .summarise }?.model
			}
		) { modelId in
			for key in Self.builtInKeys {
				_ = try await store.client.systemAgents.update(workspace: store.workspace.id, key: key.rawValue, model: modelId)
			}
		}
	}
}
