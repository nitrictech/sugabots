import SwiftUI

extension WorkspaceStore {
	/// Changes a model provider; what `change` leaves nil stays as it is.
	fileprivate func updateProvider(_ providerId: String, _ change: ModelProviderUpdate) async throws -> ModelProvider {
		try await client.modelProviders.update(
			workspace: workspace.id,
			providerId: providerId,
			active: change.active,
			baseUrl: change.baseUrl,
			apiFormat: change.apiFormat,
			apiKey: change.apiKey,
			customHeaders: change.customHeaders
		)
	}
}

// MARK: The provider's page

/// A provider's page, as the web's `ProviderSettings`: on or off, how it's
/// reached and signed in to, its models, and Disconnect.
@MainActor
struct ProviderSettingsScreen: View {
	let providerId: String
	@Environment(WorkspaceStore.self) private var store
	@Environment(\.dismiss) private var dismiss
	@State private var provider: ModelProvider?
	@State private var missing: String?
	@State private var defaultModel: String?
	@State private var systemModels: [String?] = []
	@State private var switching = SettingsAction()
	@State private var disconnecting = false

	var body: some View {
		Group {
			if let provider {
				page(provider)
			} else if let missing {
				SettingsPage { EmptyState(title: missing, text: "It may have been disconnected. Its models are no longer offered.").frame(minHeight: 320) }
			} else {
				SettingsPage { EmptyView() }
			}
		}
		.task { await load() }
	}

	private func holders(_ models: [ProviderModel]) -> ModelHolders? {
		ModelHolders.of(models.map(\.modelId), defaultModel: defaultModel, systemModels: systemModels)
	}

	/// What the On switch's group says: why it can't be turned off, what its last change failed with, or what On means.
	private func switchNote(_ provider: ModelProvider, heldOn: ModelHolders?) -> String {
		if provider.active, let heldOn { return "\(provider.name) can't be turned off while it's in use. \(heldOn.reason("one of its models"))" }
		if let failure = switching.failure { return failure }
		return provider.active ? "Bots can use the models you switch on below." : "Bots can't use its models while it's off."
	}

	private func page(_ provider: ModelProvider) -> some View {
		let heldOn = holders(provider.offeredModels)
		// Switching a seeded provider off only stops what it offers; removing another deletes every model it lists.
		let held = holders(provider.seeded ? provider.offeredModels : provider.models)
		let cannotTurnOff = provider.active && heldOn != nil
		return SettingsPage(title: provider.name, hero: AnyView(ProviderTile(name: provider.name, preset: provider.preset?.rawValue, large: true))) {
			SettingsGroup(note: switchNote(provider, heldOn: heldOn)) {
				SettingsRow(label: provider.active ? "On" : "Off", trailing: {
					WebToggle(label: "Use \(provider.name)", isOn: provider.active) { active in
						switching.run { self.provider = try await store.updateProvider(providerId, ModelProviderUpdate(active: active)) }
					}
					.disabled(cannotTurnOff || switching.pending)
				})
			}
			ProviderConnectionGroup(provider: provider, held: heldOn) { await load() }
			ProviderModelsGroup(provider: provider, holdersOf: { holders([$0]) }) { await load() }
			SettingsDanger(
				label: "Disconnect \(provider.name)",
				description: "Bots using these models stop working until you pick another.",
				actionTitle: "Disconnect",
				disabledReason: held?.reason("one of its models")
			) { disconnecting = true }
		}
		.confirmDelete(
			isPresented: $disconnecting,
			title: "Disconnect \(provider.name)?",
			description: provider.seeded
				? "\(provider.signInService != nil ? "It is signed out" : "Its key is removed") and bots can no longer use its models. You can connect it again at any time."
				: "Bots can no longer use its models. Adding it again means entering its details again.",
			confirmLabel: "Disconnect"
		) {
			try await disconnect(provider)
			// Back to Models, so Back never returns to a provider no longer connected.
			dismiss()
		}
	}

	private func load() async {
		do {
			provider = try await store.client.modelProviders.get(workspace: store.workspace.id, providerId: providerId)
		} catch {
			if provider == nil { missing = (error as? APIFailure)?.status == 404 ? "No such provider" : "Could not load this provider" }
		}
		defaultModel = (try? await store.refreshModels())?.defaultModel
		systemModels = (try? await store.client.systemAgents.list(workspace: store.workspace.id))?.map(\.model) ?? []
	}

	/// Takes a provider away: a seeded one is signed out, its key removed and switched off; one added by hand is removed.
	private func disconnect(_ provider: ModelProvider) async throws {
		if provider.seeded {
			if provider.signedIn { _ = try await store.client.modelProviders.signOut(workspace: store.workspace.id, providerId: provider.id) }
			var change = ModelProviderUpdate(active: false)
			if provider.hasApiKey { change.apiKey = .present(nil) }
			_ = try await store.updateProvider(provider.id, change)
		} else {
			try await store.client.modelProviders.remove(workspace: store.workspace.id, providerId: provider.id)
		}
	}
}

/// A row of the Connection group, as the web's `ConnectionRow`: a grey label
/// in a column, what it holds, and its actions at the end.
struct ConnectionValueRow<Content: View, Action: View>: View {
	let label: String
	@ViewBuilder var content: Content
	@ViewBuilder var action: Action

	var body: some View {
		HStack(spacing: 12) {
			Text(label).font(Typeface.rubik(14)).foregroundStyle(Palette.mutedForeground).frame(width: 110, alignment: .leading)
			content.frame(maxWidth: .infinity, alignment: .leading)
			action
		}
		.padding(.horizontal, 16)
		.padding(.vertical, 10)
		.frame(minHeight: 56)
	}
}

/// A link-styled action in a row, such as Change or Save.
private struct RowLink: View {
	let title: String
	var quiet = false
	let action: () -> Void

	var body: some View {
		Button(title, action: action)
			.font(Typeface.rubik(12.5, .medium))
			.foregroundStyle(quiet ? Palette.mutedForeground : Palette.foreground)
	}
}

/// How a provider is reached and signed in to, as the web's `Connection`:
/// its address and format for a custom or local one, its key or account, and a test.
@MainActor
private struct ProviderConnectionGroup: View {
	let provider: ModelProvider
	let held: ModelHolders?
	let changed: () async -> Void
	@Environment(WorkspaceStore.self) private var store
	@State private var editingURL: String?
	@State private var urlProblem: String?
	@State private var replacingKey: Bool?
	@State private var apiKey = ""
	@State private var action = SettingsAction()
	@State private var testing = false
	@State private var tested: TestResult?

	var body: some View {
		let optionalKey = provider.local || provider.custom
		let outcome = tested ?? provider.lastTestError.map { TestResult(passed: false, text: $0) }
		VStack(alignment: .leading, spacing: 0) {
			SettingsGroup(label: "Connection") {
				if provider.local || provider.custom {
					serverURLRow
					SettingsDivider()
				}
				if provider.custom {
					ConnectionValueRow(label: "Format") { EmptyView() } action: {
						SegmentedChoice(label: "API format", options: [(ProviderApiFormat.openai, "OpenAI"), (.anthropic, "Anthropic")], value: provider.apiFormat) { save(ModelProviderUpdate(apiFormat: $0)) }
							.disabled(action.pending)
					}
					SettingsDivider()
				}
				if let service = provider.signInService {
					ProviderSignInRow(provider: provider, service: service, signOutBlocked: held?.reason("one of its models"), changed: changed)
				} else {
					keyRow(optional: optionalKey)
				}
				if let failure = action.failure {
					SettingsDivider()
					FormAlert(text: failure).padding(.horizontal, 16).padding(.vertical, 12)
				}
			}
			// The result sits beside the button, so a test never moves what is below it.
			HStack(spacing: 10) {
				Button { test() } label: {
					HStack(spacing: 6) {
						if testing { ProgressView().controlSize(.mini) }
						Text("Test connection")
					}
				}
				.buttonStyle(WebButtonStyle(variant: .secondary, size: .small))
				.disabled(testing)
				if !testing, let outcome {
					SettingsTestOutcome(good: outcome.passed, text: outcome.text)
				}
			}
			.padding(.horizontal, 2)
			.padding(.top, 10)
		}
	}

	@ViewBuilder
	private var serverURLRow: some View {
		if let editingURL {
			ConnectionValueRow(label: "Server URL") {
				VStack(alignment: .leading, spacing: 4) {
					TextField("", text: Binding(get: { editingURL }, set: { self.editingURL = $0 }), prompt: Text(provider.local ? "http://localhost:11434" : "https://llm.example.com/v1").foregroundStyle(Palette.mutedForeground))
						.font(Typeface.mono(16))
						.textInputAutocapitalization(.never)
						.autocorrectionDisabled()
						.keyboardType(.URL)
					if let urlProblem { Text(urlProblem).font(Typeface.rubik(12.5)).foregroundStyle(Palette.destructiveText) }
				}
			} action: {
				HStack(spacing: 12) {
					RowLink(title: "Save") {
						guard let parsed = parseProviderBaseURL(editingURL) else {
							urlProblem = notAServerAddress
							return
						}
						urlProblem = nil
						save(ModelProviderUpdate(baseUrl: parsed)) { self.editingURL = nil }
					}
					.disabled(action.pending)
					RowLink(title: "Cancel", quiet: true) { self.editingURL = nil }
				}
			}
		} else {
			ConnectionValueRow(label: "Server URL") {
				Text(provider.baseUrl).font(Typeface.mono(13)).foregroundStyle(Palette.foreground).lineLimit(1).truncationMode(.middle)
			} action: {
				RowLink(title: "Change") { editingURL = provider.baseUrl }
			}
		}
	}

	@ViewBuilder
	private func keyRow(optional: Bool) -> some View {
		let replacing = replacingKey ?? (!provider.hasApiKey && !optional)
		if replacing {
			ConnectionValueRow(label: "API key") {
				SecureField("", text: $apiKey, prompt: Text("Paste your key").foregroundStyle(Palette.mutedForeground))
					.font(Typeface.mono(16))
					.accessibilityLabel("\(provider.name) API key")
			} action: {
				HStack(spacing: 12) {
					RowLink(title: "Save") {
						// A key is what connects a provider that was disconnected.
						var change = ModelProviderUpdate(apiKey: .present(apiKey))
						if !provider.active { change.active = true }
						save(change) {
							apiKey = ""
							replacingKey = false
						}
					}
					.disabled(apiKey.isEmpty || action.pending)
					if provider.hasApiKey || optional {
						RowLink(title: "Cancel", quiet: true) {
							apiKey = ""
							replacingKey = false
						}
					}
				}
			}
		} else {
			ConnectionValueRow(label: "API key") {
				Text(provider.hasApiKey ? "••••••••" : "None").font(Typeface.mono(13)).foregroundStyle(Palette.foreground)
			} action: {
				HStack(spacing: 12) {
					if optional && provider.hasApiKey {
						RowLink(title: "Remove", quiet: true) { save(ModelProviderUpdate(apiKey: .present(nil))) }.disabled(action.pending || held != nil)
					}
					RowLink(title: provider.hasApiKey ? "Replace" : "Add") { replacingKey = true }
				}
			}
		}
	}

	private func save(_ change: ModelProviderUpdate, then done: @escaping () -> Void = {}) {
		action.run {
			_ = try await store.updateProvider(provider.id, change)
			done()
			await changed()
		}
	}

	private func test() {
		testing = true
		Task {
			do {
				let result = try await store.client.modelProviders.test(workspace: store.workspace.id, providerId: provider.id)
				tested = TestResult(passed: result.reachable, text: result.reachable ? "Connection successful" : result.error ?? "It did not answer.")
				action.failure = nil
			} catch {
				action.failure = error.localizedDescription
			}
			testing = false
		}
	}
}

/// Signing a plan-paid provider in with a code, as the web's `ProviderSignInRow`:
/// a warning that a plan is for one person, then the code to enter on the
/// service's page, while the app asks whether it's done.
@MainActor
struct ProviderSignInRow: View {
	let provider: ModelProvider
	let service: String
	let signOutBlocked: String?
	let changed: () async -> Void
	@Environment(WorkspaceStore.self) private var store
	@Environment(\.openURL) private var openURL
	@State private var started: ProviderSignInStarted?
	@State private var warning = false
	@State private var action = SettingsAction()

	/// As `ACCOUNT_SHARING_TERMS`.
	private static let terms = [
		"chatgpt": ("OpenAI", "https://openai.com/policies/terms-of-use/#registration-and-access"),
		"xai": ("xAI", "https://x.ai/legal/terms-of-service"),
	]

	var body: some View {
		let serviceName = ProviderPreset.signInServiceNames[service] ?? service
		VStack(spacing: 0) {
			if let started {
				code(started, serviceName: serviceName)
			} else {
				ConnectionValueRow(label: "Account") {
					Text(provider.signedIn ? "Signed in" : "Not signed in").font(Typeface.mono(13)).foregroundStyle(Palette.foreground)
				} action: {
					if provider.signedIn {
						RowLink(title: "Sign out", quiet: true) { signOut() }.disabled(action.pending || signOutBlocked != nil)
					} else {
						RowLink(title: "Sign in with \(serviceName)") { warning = true }.disabled(action.pending)
					}
				}
			}
			if let failure = action.failure {
				SettingsDivider()
				FormAlert(text: failure).padding(.horizontal, 16).padding(.vertical, 12)
			}
		}
		.fullScreenCover(isPresented: $warning) {
			let plan = ProviderPreset.named(provider.preset?.rawValue)?.name ?? provider.name
			let terms = Self.terms[service]
			DialogForm(title: "Single-user installs only", action: (title: "Sign in", run: start)) {
				HStack(alignment: .top, spacing: 10) {
					Icon(.triangleAlert, size: 16).foregroundStyle(Palette.warning).padding(.top, 2)
					(Text("A \(plan) plan is for one person. Only connect yours if nobody else uses this Sugabots install. See ")
						+ Text("\(terms?.0 ?? serviceName)'s terms").foregroundColor(Palette.foreground)
						+ Text("."))
						.font(Typeface.rubik(13))
						.foregroundStyle(Palette.mutedForeground)
						.onTapGesture { if let url = terms.flatMap({ URL(string: $0.1) }) { openURL(url) } }
				}
			}
		}
	}

	private func code(_ started: ProviderSignInStarted, serviceName: String) -> some View {
		VStack(alignment: .leading, spacing: 12) {
			Text("Open \(serviceName)'s sign-in page and enter this code. This page carries on once you have.")
				.font(Typeface.rubik(14))
				.foregroundStyle(Palette.mutedForeground)
			HStack(spacing: 12) {
				HStack(spacing: 4) {
					Text(started.userCode).font(Typeface.mono(20)).tracking(2).foregroundStyle(Palette.foreground)
					CopyButton(text: started.userCode) { copied in
						Icon(copied ? .check : .copy, size: 14).frame(width: 28, height: 28)
					}
					.buttonStyle(IconPressStyle())
					.accessibilityLabel("Copy code")
				}
				.padding(.leading, 12)
				.padding(.vertical, 4)
				.padding(.trailing, 4)
				.background(Palette.chip, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
				Button { if let url = URL(string: started.verificationUrl) { openURL(url) } } label: {
					HStack(spacing: 6) {
						Icon(.externalLink, size: 14)
						Text("Open sign-in page")
					}
				}
				.buttonStyle(WebButtonStyle(variant: .secondary, size: .small))
			}
			HStack {
				ProgressView().controlSize(.small)
				Spacer()
				Button("Cancel") { self.started = nil }.buttonStyle(WebButtonStyle(variant: .ghost, size: .small))
			}
		}
		.padding(.horizontal, 16)
		.padding(.vertical, 12)
		.task(id: started.attempt) { await poll(started) }
	}

	private func start() {
		warning = false
		action.run { started = try await store.client.modelProviders.startSignIn(workspace: store.workspace.id, providerId: provider.id) }
	}

	/// Asks whether the sign-in is done every poll interval, until it is or fails.
	private func poll(_ started: ProviderSignInStarted) async {
		while !Task.isCancelled, self.started?.attempt == started.attempt {
			try? await Task.sleep(for: .milliseconds(started.pollIntervalMs))
			guard !Task.isCancelled else { return }
			do {
				let outcome = try await store.client.modelProviders.completeSignIn(
					workspace: store.workspace.id, providerId: provider.id, attempt: started.attempt
				)
				if case .signedIn = outcome {
					self.started = nil
					await changed()
					return
				}
			} catch {
				self.started = nil
				action.failure = error.localizedDescription
				return
			}
		}
	}

	private func signOut() {
		action.run {
			_ = try await store.client.modelProviders.signOut(workspace: store.workspace.id, providerId: provider.id)
			await changed()
		}
	}
}

/// A provider's models, as the web's `Models`: Refresh list, a search when
/// there are many, each with what it can do, the bots on it and its switch,
/// and for a custom provider, Add model and what each can do.
@MainActor
private struct ProviderModelsGroup: View {
	let provider: ModelProvider
	let holdersOf: (ProviderModel) -> ModelHolders?
	let changed: () async -> Void
	@Environment(WorkspaceStore.self) private var store
	@State private var search = ""
	@State private var adding = false
	@State private var newModelId = ""
	@State private var refreshing = false
	@State private var modelChange = SettingsAction()
	@State private var editing: ProviderModel?
	/// Switched-on models lead, as they were when the page opened, so a row never moves under the switch just used.
	@State private var onWhenOpened: Set<String>?

	var body: some View {
		let large = provider.models.count > Limits.modelSearchThreshold
		let needle = search.trimmingCharacters(in: .whitespaces).lowercased()
		let on = onWhenOpened ?? Set(provider.models.filter(\.enabled).map(\.id))
		let shown = provider.models
			.filter { needle.isEmpty || $0.modelId.lowercased().contains(needle) || $0.name.lowercased().contains(needle) }
			.sorted { on.contains($0.id) && !on.contains($1.id) }
		SettingsGroup(label: "Models", note: "Only switched-on models show up when choosing a bot's model.") {
			Button(refreshing ? "Refreshing…" : "Refresh list", action: refresh)
				.font(Typeface.rubik(12.5, .medium))
				.foregroundStyle(Palette.foreground)
				.disabled(refreshing || provider.lacksCredential)
		} content: {
			if large {
				SearchField(placeholder: "Search \(provider.models.count) models", text: $search, style: .inCard)
					.padding(10)
				SettingsDivider()
			}
			if shown.isEmpty {
				SettingsRow(label: needle.isEmpty ? "No models yet. Refresh the list once it is connected." : "No models match.")
			}
			DividedRows(data: shown) { model in
				row(model, large: large)
			}
			if provider.custom {
				SettingsDivider()
				if adding {
					ConnectionValueRow(label: "Model ID") {
						TextField("", text: $newModelId, prompt: Text("e.g. llama-3.3-70b").foregroundStyle(Palette.mutedForeground))
							.font(Typeface.mono(16))
							.textInputAutocapitalization(.never)
							.autocorrectionDisabled()
					} action: {
						HStack(spacing: 12) {
							RowLink(title: "Add") { addModel() }.disabled(newModelId.trimmingCharacters(in: .whitespaces).isEmpty || modelChange.pending)
							RowLink(title: "Cancel", quiet: true) { adding = false }
						}
					}
				} else {
					SettingsAddRow(label: "Add model") { adding = true }
				}
			}
			if let failure = modelChange.failure {
				SettingsDivider()
				FormAlert(text: failure).padding(.horizontal, 16).padding(.vertical, 12)
			}
		}
		.sheet(item: $editing) { model in
			CapabilitiesSheet(model: model, providerId: provider.id) { await changed() }
		}
		.onAppear { if onWhenOpened == nil { onWhenOpened = on } }
	}

	private func row(_ model: ProviderModel, large: Bool) -> some View {
		let bots = store.agents.filter { $0.systemAgentKey == nil && $0.model == model.modelId }
		let used = bots.isEmpty ? "Not used yet" : "\(bots.count) \(bots.count == 1 ? "bot" : "bots")"
		let maker = model.maker.map { ProviderModel.makerNames[$0] ?? $0.prefix(1).uppercased() + $0.dropFirst() } ?? provider.name
		let who = large ? maker : used
		let held = model.enabled ? holdersOf(model) : nil
		return HStack(spacing: 14) {
			VStack(alignment: .leading, spacing: 2) {
				Text(model.name).font(Typeface.rubik(16)).foregroundStyle(Palette.foreground).lineLimit(1)
				HStack(spacing: 6) {
					Text(held.map { "\($0.newBots ? "Default" : "Summaries") · \(who)" } ?? who)
					CapabilityIcons(model: model)
				}
				.font(Typeface.rubik(13))
				.foregroundStyle(Palette.subtleForeground)
			}
			.frame(maxWidth: .infinity, alignment: .leading)
			BotFaces(bots: bots)
			if provider.custom {
				Button { editing = model } label: { Icon(.pencil, size: 14).frame(width: 24, height: 24) }
					.buttonStyle(IconPressStyle())
					.accessibilityLabel("What \(model.name) can do")
			}
			WebToggle(label: "Bots can use \(model.name)", isOn: model.enabled) { setEnabled(model, $0) }
				.disabled(!provider.active || held != nil || modelChange.pending)
		}
		.padding(.horizontal, 16)
		.padding(.vertical, 12)
		.frame(minHeight: 56)
	}

	private func refresh() {
		refreshing = true
		Task {
			do {
				_ = try await store.client.modelProviders.fetchModels(workspace: store.workspace.id, providerId: provider.id)
				modelChange.failure = nil
				await changed()
			} catch {
				modelChange.failure = error.localizedDescription
			}
			refreshing = false
		}
	}

	private func setEnabled(_ model: ProviderModel, _ enabled: Bool) {
		modelChange.run {
			_ = try await store.client.modelProviders.updateModel(
				workspace: store.workspace.id, providerId: provider.id, modelId: model.id, enabled: enabled
			)
			await changed()
		}
	}

	private func addModel() {
		modelChange.run {
			_ = try await store.client.modelProviders.addModel(
				workspace: store.workspace.id, providerId: provider.id, modelId: newModelId.trimmingCharacters(in: .whitespaces)
			)
			newModelId = ""
			adding = false
			await changed()
		}
	}
}

/// What a model can do, as small icons after its line, as `CapabilityIcons`.
private struct CapabilityIcons: View {
	let model: ProviderModel

	static let icons: [ProviderModelCapability: Lucide] = [.tools: .wrench, .vision: .eye, .images: .image, .audio: .mic, .reasoning: .brain, .embeddings: .grid2X2]

	var body: some View {
		let on = model.effectiveCapabilities
		ForEach(ModelCapability.catalog.filter { on.contains($0.capability) }, id: \.key) { capability in
			if let icon = Self.icons[capability.capability] {
				Icon(icon, size: 13).accessibilityLabel(capability.name)
			}
		}
	}
}

extension ModelCapability {
	/// The capability the catalog's `key` names, as the API's models list it.
	var capability: ProviderModelCapability { ProviderModelCapability(rawValue: key) }
}

/// Up to three faces of the bots on a model, overlapping, then how many more, as `BotFaces`.
private struct BotFaces: View {
	let bots: [Agent]

	var body: some View {
		let shown = Array(bots.prefix(bots.count > 3 ? 2 : 3))
		let more = bots.count - shown.count
		if !bots.isEmpty {
			HStack(spacing: -6) {
				ForEach(shown) { bot in
					BotFace(look: bot.look, size: 22)
						.padding(2)
						.background(Palette.settingsCard, in: Circle())
				}
				if more > 0 {
					Text("+\(more)")
						.font(Typeface.rubik(10.5, .semibold))
						.foregroundStyle(Palette.softForeground)
						.padding(.horizontal, 4)
						.frame(minWidth: 22, minHeight: 22)
						.background(Palette.chip, in: Capsule())
						.padding(2)
						.background(Palette.settingsCard, in: Capsule())
				}
			}
			.accessibilityHidden(true)
		}
	}
}

/// What a custom provider's model can do, as the web's `CapabilitiesDialog`:
/// a hand-added one has whatever you say; a listed one can only have its own switched off.
@MainActor
private struct CapabilitiesSheet: View {
	let model: ProviderModel
	let providerId: String
	let saved: () async -> Void
	@Environment(WorkspaceStore.self) private var store
	@Environment(\.dismiss) private var dismiss
	@State private var chosen: [ProviderModelCapability] = []
	@State private var saving = SettingsAction()

	var body: some View {
		let byHand = model.source == .manual
		let offered = ModelCapability.catalog.filter { byHand || model.capabilities.contains($0.capability) }
		DialogForm(title: "What it can do", action: (title: "Save", run: save), actionDisabled: saving.pending) {
			Text(model.modelId).font(Typeface.mono(13)).foregroundStyle(Palette.mutedForeground)
			if offered.isEmpty {
				Text("The server lists nothing this model can do, so there is nothing to switch.")
					.font(Typeface.rubik(13))
					.foregroundStyle(Palette.mutedForeground)
			} else {
				SettingsGroup {
					DividedRows(data: offered, id: \.key) { capability in
						SettingsRow(label: capability.name, sub: capability.description, leading: {
							Icon(CapabilityIcons.icons[capability.capability] ?? .wrench, size: 16).foregroundStyle(Palette.mutedForeground)
						}, trailing: {
							WebToggle(label: capability.name, isOn: chosen.contains(capability.capability)) { on in
								chosen = on ? chosen + [capability.capability] : chosen.filter { $0 != capability.capability }
							}
						})
					}
				}
			}
			if let failure = saving.failure { FormAlert(text: failure) }
		}
		.onAppear { chosen = model.effectiveCapabilities }
	}

	private func save() {
		saving.run {
			let routes = store.client.modelProviders
			if model.source == .manual {
				_ = try await routes.updateModel(workspace: store.workspace.id, providerId: providerId, modelId: model.id, capabilities: chosen)
			} else {
				_ = try await routes.updateModel(
					workspace: store.workspace.id,
					providerId: providerId,
					modelId: model.id,
					disabledCapabilities: model.capabilities.filter { !chosen.contains($0) }
				)
			}
			await saved()
			dismiss()
		}
	}
}

// MARK: Adding a provider

/// Adding a provider, as the web's `AddProviderDialog`: the catalog's
/// providers not connected yet, popular then local, and a custom one; then its key or address.
@MainActor
struct AddProviderSheet: View {
	enum Choice: Hashable {
		case preset(ProviderPreset)
		case custom
	}

	let providers: [ModelProvider]
	/// The provider to go straight to, or nil for the list.
	let startWith: ProviderPresetId?
	let added: (ModelProvider) -> Void
	@State private var choice: Choice?

	var body: some View {
		let byPreset = Dictionary(providers.compactMap { provider in provider.preset.map { ($0.rawValue, provider) } }, uniquingKeysWith: { first, _ in first })
		Group {
			switch choice {
			case .custom: CustomProviderStep(back: { choice = nil }, added: added)
			case let .preset(preset): PresetStep(preset: preset, existing: byPreset[preset.id], back: { choice = nil }, added: added)
			case nil: list(byPreset)
			}
		}
		.onAppear {
			if choice == nil, let startWith, let preset = ProviderPreset.named(startWith.rawValue) { choice = .preset(preset) }
		}
	}

	private func list(_ byPreset: [String: ModelProvider]) -> some View {
		// Ollama is on in every workspace from the start, so being reachable is not enough to leave it out: it has to have listed models.
		let available = ProviderPreset.catalog.filter { preset in
			guard let existing = byPreset[preset.id] else { return true }
			return !existing.connected || existing.models.isEmpty
		}
		let groups = [("Popular", available.filter { $0.hostingKind == .remote }), ("On your own machine", available.filter { $0.hostingKind == .local })].filter { !$0.1.isEmpty }
		return DialogForm(title: "Add provider") {
			VStack(spacing: 20) {
				ForEach(groups, id: \.0) { label, presets in
					SettingsGroup(label: label) {
						DividedRows(data: presets) { preset in
							Button { choice = .preset(preset) } label: {
								SettingsRow(label: preset.name, sub: Self.firstSentence(preset.hint), chevron: true, leading: {
									ProviderTile(name: preset.name, preset: preset.id)
								})
							}
							.buttonStyle(SettingsRowPressStyle())
						}
					}
				}
				SettingsGroup(label: "Something else") {
					Button { choice = .custom } label: {
						SettingsRow(label: "Custom provider", sub: "Any service using the OpenAI or Anthropic format", chevron: true, leading: {
							SettingsRowIcon { Icon(.code, size: 15, strokeWidth: 2.2) }
						})
					}
					.buttonStyle(SettingsRowPressStyle())
				}
			}
		}
	}

	/// As `firstSentence`.
	static func firstSentence(_ text: String) -> String {
		if let stop = text.range(of: ". ") { return String(text[..<stop.lowerBound]) }
		return text.hasSuffix(".") ? String(text.dropLast()) : text
	}
}

/// A catalog provider's key, or address for one on your own machine, as `PresetStep`.
@MainActor
private struct PresetStep: View {
	let preset: ProviderPreset
	let existing: ModelProvider?
	let back: () -> Void
	let added: (ModelProvider) -> Void
	@Environment(WorkspaceStore.self) private var store
	@State private var apiKey = ""
	@State private var baseUrl = ""
	@State private var adding = SettingsAction()

	var body: some View {
		let local = preset.hostingKind == .local
		let requiresKey = preset.credentialKind == .apiKey
		let signsIn = preset.credentialKind == .signIn
		let typed = parseProviderBaseURL(baseUrl)
		let ready = (!requiresKey || !apiKey.isEmpty) && (!local || typed != nil)
		DialogForm(title: preset.name, action: (title: signsIn ? "Continue" : "Add", run: submit), actionDisabled: !ready || adding.pending, onBack: adding.pending ? nil : back) {
			SettingsGroup(note: preset.hint) {
				if let service = preset.signIn {
					SettingsRow(label: "\(ProviderPreset.signInServiceNames[service] ?? service) account", sub: "Sign in after you continue")
				}
				if local {
					SettingsFieldRow(label: "Server URL", value: $baseUrl, placeholder: preset.baseUrl, mono: true)
				}
				if !signsIn {
					if local { SettingsDivider() }
					SettingsFieldRow(label: "API key", value: $apiKey, placeholder: requiresKey ? "Paste your key" : "Optional", mono: true, secret: true)
				}
			}
			if local, !baseUrl.trimmingCharacters(in: .whitespaces).isEmpty, typed == nil {
				FormAlert(text: notAServerAddress)
			}
			if let failure = adding.failure { FormAlert(text: failure) }
		}
		.onAppear { if baseUrl.isEmpty { baseUrl = existing?.baseUrl ?? preset.baseUrl } }
	}

	private func submit() {
		let local = preset.hostingKind == .local
		let typed = parseProviderBaseURL(baseUrl)
		adding.run {
			// A seeded subscription provider, like ChatGPT, already exists; its page is where the person signs in.
			if preset.credentialKind == .signIn, let existing {
				added(existing)
				return
			}
			let made: ModelProvider
			if let existing {
				var change = ModelProviderUpdate(active: true)
				if !apiKey.isEmpty { change.apiKey = .present(apiKey) }
				if local, let typed, typed != existing.baseUrl { change.baseUrl = typed }
				made = try await store.updateProvider(existing.id, change)
			} else {
				var body = NewProviderFromPreset(preset: ProviderPresetId(rawValue: preset.id))
				if !apiKey.isEmpty { body.apiKey = apiKey }
				if local, let typed, typed != preset.baseUrl { body.baseUrl = typed }
				made = try await store.client.modelProviders.create(workspace: store.workspace.id, body: .newProviderFromPreset(body))
			}
			added(made)
		}
	}
}

/// A custom provider by its address and format, as `CustomProviderStep`.
@MainActor
private struct CustomProviderStep: View {
	let back: () -> Void
	let added: (ModelProvider) -> Void
	@Environment(WorkspaceStore.self) private var store
	@State private var name = ""
	@State private var baseUrl = ""
	@State private var apiFormat = ProviderApiFormat.openai
	@State private var apiKey = ""
	@State private var adding = SettingsAction()

	var body: some View {
		let ready = !name.trimmingCharacters(in: .whitespaces).isEmpty && parseProviderBaseURL(baseUrl) != nil
		DialogForm(title: "Custom provider", action: (title: "Add", run: submit), actionDisabled: !ready || adding.pending, onBack: adding.pending ? nil : back) {
			SettingsGroup {
				SettingsFieldRow(label: "Name", value: $name, placeholder: "e.g. Company gateway")
				SettingsDivider()
				SettingsFieldRow(label: "Server URL", value: $baseUrl, placeholder: "https://llm.example.com/v1", mono: true)
				SettingsDivider()
				HStack(spacing: 14) {
					Text("Format").font(Typeface.rubik(13)).foregroundStyle(Palette.foreground).frame(maxWidth: .infinity, alignment: .leading)
					SegmentedChoice(label: "API format", options: [(ProviderApiFormat.openai, "OpenAI"), (.anthropic, "Anthropic")], value: apiFormat) { apiFormat = $0 }
				}
				.padding(.horizontal, 16)
				.padding(.vertical, 10)
				.frame(minHeight: 56)
				SettingsDivider()
				SettingsFieldRow(label: "API key", value: $apiKey, placeholder: "Optional", mono: true, secret: true)
			}
			if let failure = adding.failure { FormAlert(text: failure) }
		}
	}

	private func submit() {
		guard let typed = parseProviderBaseURL(baseUrl) else { return }
		adding.run {
			let body = NewCustomProvider(
				name: name.trimmingCharacters(in: .whitespaces),
				baseUrl: typed,
				apiFormat: apiFormat,
				apiKey: apiKey.isEmpty ? nil : apiKey,
				customHeaders: []
			)
			let made = try await store.client.modelProviders.create(workspace: store.workspace.id, body: .newCustomProvider(body))
			added(made)
		}
	}
}
