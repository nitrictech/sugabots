import SwiftUI

/// A computer provider's settings as its form edits them: either preset's
/// fields in one place, written as the API's `SandboxProviderSettings` to save.
struct SandboxProviderFields {
	var preset: String
	var serverUrl: String?
	var image: String?
	var apiUrl: String?
	var sandboxUrl: String?
	var template: String?
	var cpuCount: Int?
	var memoryGiB: Int?
	var networkMode: SandboxNetworkMode?

	init(preset: String) {
		self.preset = preset
	}

	init(_ settings: SandboxProviderSettings) {
		switch settings {
		case let .opensandbox(fields):
			preset = "opensandbox"
			serverUrl = fields.serverUrl
			image = fields.image
			networkMode = fields.networkMode
		case let .e2b(fields):
			preset = "e2b"
			apiUrl = fields.apiUrl
			sandboxUrl = fields.sandboxUrl
			template = fields.template
			cpuCount = fields.cpuCount
			memoryGiB = fields.memoryGiB
			networkMode = fields.networkMode
		case let .unknown(preset):
			self.preset = preset
		}
	}

	/// As the API takes it: the preset's own fields.
	var apiValue: SandboxProviderSettings {
		if preset == "e2b" {
			return .e2b(.init(apiUrl: apiUrl, sandboxUrl: sandboxUrl, template: template, cpuCount: cpuCount, memoryGiB: memoryGiB, networkMode: networkMode))
		}
		return .opensandbox(.init(serverUrl: serverUrl, image: image, networkMode: networkMode))
	}
}

/// A change to a computer provider: what is left nil stays as it is.
private struct SandboxProviderChange {
	var enabled: Bool?
	/// A new key, or with `.some(nil)`, none.
	var apiKey: String??
	var settings: SandboxProviderFields?
}

/// A computer provider in the catalog, as `sandboxProviderCatalog`.
private struct SandboxPreset {
	let id: String
	let name: String
	let baseUrl: String?
	let imageLabel: String
	let defaultImage: String
	let description: String

	static let catalog = [
		SandboxPreset(id: "opensandbox", name: "OpenSandbox", baseUrl: "http://localhost:8090", imageLabel: "Image", defaultImage: "ghcr.io/nitrictech/sugabots-sandbox:latest", description: "Runs on your own Docker or Kubernetes"),
		SandboxPreset(id: "e2b", name: "E2B", baseUrl: nil, imageLabel: "Template", defaultImage: "sugabots-sandbox", description: "Hosted microVMs, or E2B Embed on your own server"),
	]

	/// As `SANDBOX_E2B_DEFAULT_SIZE`.
	static let defaultSize = (cpuCount: 2, memoryGiB: 4)

	static func named(_ id: String) -> SandboxPreset { catalog.first { $0.id == id } ?? catalog[0] }
}

/// Computers, as the web's `SandboxSettings`: the switch, the provider and its
/// settings, the network the computers reach, and the bots using one.
@MainActor
struct SandboxSettingsScreen: View {
	@Environment(WorkspaceStore.self) private var store
	@State private var providers: [SandboxProvider]?
	@State private var failure: String?
	@State private var chosen: String?
	@State private var pending = false
	@State private var error: String?
	@State private var tested: (reachable: Bool, latencyMs: Int, error: String?)?
	@State private var removingKey = false
	@State private var removing = false

	var body: some View {
		SettingsPage(title: "Computers", description: "Give bots their own computer to run commands, browse and edit files.") {
			if let may = store.permissions, !may.manageProviders {
				FormAlert(text: "Only workspace administrators can manage computers.")
			} else if let failure {
				FormAlert(text: failure)
			} else if let providers {
				groups(providers)
			}
		}
		.task { await load() }
	}

	@ViewBuilder
	private func groups(_ providers: [SandboxProvider]) -> some View {
		let enabled = providers.first(where: \.enabled)
		let chosen = chosen ?? enabled?.preset.rawValue ?? providers.first?.preset.rawValue ?? "opensandbox"
		let configured = providers.first { $0.preset.rawValue == chosen }
		let preset = SandboxPreset.named(chosen)
		let ready = configured?.hasApiKey == true
		let settings = configured.map { SandboxProviderFields($0.settings) } ?? SandboxProviderFields(preset: chosen)
		HStack(alignment: .top, spacing: 10) {
			Icon(.info, size: 15).foregroundStyle(Palette.subtleForeground).padding(.top, 1)
			Text("Computers are experimental. How they work, and what they keep, may change between releases.")
		}
			.font(Typeface.rubik(13))
			.foregroundStyle(Palette.mutedForeground)
			.padding(.horizontal, 16)
			.padding(.vertical, 12)
			.frame(maxWidth: .infinity, alignment: .leading)
			.settingsCard()
			.padding(.top, -24)
		SettingsGroup(
			note: ready && enabled != nil && enabled?.preset.rawValue != chosen
				? "Turning this on moves computers from \(enabled!.name) to \(preset.name). Each pod gets a new one, without the old one's files."
				: nil
		) {
			HStack(spacing: 14) {
				VStack(alignment: .leading, spacing: 2) {
					Text("Bots can use a computer").font(Typeface.rubik(16, .medium)).foregroundStyle(Palette.foreground)
					Text(ready ? "Each pod gets its own private computer" : "\(preset.name) needs an API key first. Add it below.")
						.font(Typeface.rubik(13))
						.foregroundStyle(Palette.subtleForeground)
				}
				.frame(maxWidth: .infinity, alignment: .leading)
				WebToggle(label: "Bots can use a computer", isOn: enabled?.preset.rawValue == chosen) { on in switchTo(on, chosen: chosen, configured: configured, enabled: enabled) }
					.disabled(!ready || pending)
			}
			.padding(.horizontal, 16)
			.padding(.vertical, 12)
			.frame(minHeight: 56)
		}
		providerChoice(chosen: chosen, enabled: enabled?.preset.rawValue)
		providerSettings(preset: preset, configured: configured, settings: settings)
		if let error { FormAlert(text: error) }
		SandboxNetworkGroups(modeRow: AnyView(modeRow(settings: settings, configured: configured, chosen: chosen)))
		botsUsingAComputer
	}

	private func providerChoice(chosen: String, enabled: String?) -> some View {
		SettingsGroup(label: "Provider") {
			DividedRows(data: SandboxPreset.catalog, id: \.id) { candidate in
				SettingsRadioRow(name: candidate.name, description: candidate.description, badge: candidate.id == enabled ? "In use" : nil, checked: candidate.id == chosen) {
					error = nil
					tested = nil
					self.chosen = candidate.id
				}
				.disabled(pending)
			}
		}
	}

	private func providerSettings(preset: SandboxPreset, configured: SandboxProvider?, settings: SandboxProviderFields) -> some View {
		let hasKey = configured?.hasApiKey == true
		let note = tested.map { $0.reachable ? "Connected in \($0.latencyMs) ms." : $0.error ?? "The provider didn't answer." }
			?? (configured?.status == .connected ? "The last test connected." : configured?.status == .error ? configured?.lastTestError ?? "The last test failed." : nil)
			?? (preset.id == "opensandbox"
				? "The server's own API key, from its configuration. Leave the image empty to use the default."
				: "Leave the URLs empty for E2B Cloud. For E2B Embed, give both. A new size takes effect once the template is prepared again and a pod's computer is reset.")
		return SettingsGroup(label: preset.name, note: note) {
			VStack(spacing: 0) {
				if settings.preset == "opensandbox" {
					TextEntryRow(label: "Server URL", saved: settings.serverUrl ?? preset.baseUrl, placeholder: preset.baseUrl ?? "", disabled: pending) { value in
						var next = settings
						next.serverUrl = value
						await act { try await configure(SandboxProviderChange(settings: next), configured: configured, chosen: preset.id) }
					}
					SettingsDivider()
				}
				TextEntryRow(label: "API key", saved: hasKey ? "" : nil, placeholder: "Paste your key", secret: true, disabled: pending, onRemove: hasKey ? { removingKey = true } : nil) { value in
					await act { try await configure(SandboxProviderChange(apiKey: value), configured: configured, chosen: preset.id) }
				}
				if settings.preset == "opensandbox" {
					SettingsDivider()
					clearableRow(preset.imageLabel, saved: settings.image, placeholder: preset.defaultImage, configured: configured, preset: preset) { next, value in next.image = value }
				}
				if settings.preset == "e2b" {
					SettingsDivider()
					clearableRow(preset.imageLabel, saved: settings.template, placeholder: preset.defaultImage, configured: configured, preset: preset) { next, value in next.template = value }
					SettingsDivider()
					clearableRow("API URL", saved: settings.apiUrl, placeholder: "E2B Cloud", configured: configured, preset: preset) { next, value in next.apiUrl = value }
					SettingsDivider()
					clearableRow("Computer URL", saved: settings.sandboxUrl, placeholder: "E2B Cloud", configured: configured, preset: preset) { next, value in next.sandboxUrl = value }
					SettingsDivider()
					sizeRow("vCPUs", saved: settings.cpuCount.map(String.init), placeholder: "\(SandboxPreset.defaultSize.cpuCount)", unit: "vCPUs", configured: configured, preset: preset) { next, value in next.cpuCount = value }
					SettingsDivider()
					sizeRow("Memory", saved: settings.memoryGiB.map { "\($0) GiB" }, placeholder: "\(SandboxPreset.defaultSize.memoryGiB) GiB", unit: "GiB", configured: configured, preset: preset) { next, value in next.memoryGiB = value }
				}
				if preset.id == "e2b", let configured, hasKey {
					SettingsDivider()
					TemplateRow(providerId: configured.id)
				}
				if let configured, hasKey {
					SettingsDivider()
					Button { test(configured) } label: {
						SettingsRow(label: "Test connection", sub: "Checks the provider answers and accepts the key.")
					}
					.buttonStyle(SettingsRowPressStyle())
					.disabled(pending)
				}
				if configured != nil {
					SettingsDivider()
					Button { removing = true } label: {
						SettingsRow(label: "Remove \(preset.name)", sub: "Removes its computers and settings.")
					}
					.buttonStyle(SettingsRowPressStyle())
					.disabled(pending)
				}
			}
			.confirmDelete(
				isPresented: $removingKey,
				title: "Remove the \(preset.name) key?",
				description: "Bots stop getting computers from this provider until another key is added.",
				confirmLabel: "Remove"
			) {
				try await configure(SandboxProviderChange(apiKey: .some(nil)), configured: configured, chosen: preset.id)
			}
			.confirmDelete(
				isPresented: $removing,
				title: "Remove \(preset.name)?",
				description: "Every pod's computer at this provider is destroyed, with its files, including work that wasn't pushed.",
				confirmLabel: "Remove"
			) {
				guard let configured else { return }
				try await store.client.sandboxProviders.remove(workspace: store.workspace.id, providerId: configured.id)
				await load()
			}
		}
	}

	/// A setting that may be left empty for its default.
	private func clearableRow(
		_ label: String, saved: String?, placeholder: String, configured: SandboxProvider?, preset: SandboxPreset,
		set: @escaping (inout SandboxProviderFields, String?) -> Void
	) -> some View {
		TextEntryRow(label: label, saved: saved, placeholder: placeholder, clearable: true, disabled: pending) { value in
			var next = configured.map { SandboxProviderFields($0.settings) } ?? SandboxProviderFields(preset: preset.id)
			set(&next, value.isEmpty ? nil : value)
			await act { try await configure(SandboxProviderChange(settings: next), configured: configured, chosen: preset.id) }
		}
	}

	/// An E2B computer's size: a whole number from 1 to 64.
	private func sizeRow(
		_ label: String, saved: String?, placeholder: String, unit: String, configured: SandboxProvider?, preset: SandboxPreset,
		set: @escaping (inout SandboxProviderFields, Int?) -> Void
	) -> some View {
		TextEntryRow(label: label, saved: saved, placeholder: placeholder, clearable: true, disabled: pending) { typed in
			let number = Int(typed.replacingOccurrences(of: "\\s*GiB$", with: "", options: [.regularExpression, .caseInsensitive]))
			if !typed.isEmpty, !(1...64).contains(number ?? 0) {
				error = "Enter a whole number of \(unit), from 1 to 64."
				return
			}
			var next = configured.map { SandboxProviderFields($0.settings) } ?? SandboxProviderFields(preset: preset.id)
			set(&next, typed.isEmpty ? nil : number)
			await act { try await configure(SandboxProviderChange(settings: next), configured: configured, chosen: preset.id) }
		}
	}

	private func modeRow(settings: SandboxProviderFields, configured: SandboxProvider?, chosen: String) -> some View {
		let mode = settings.networkMode?.rawValue ?? "open"
		let summary = mode == "allowlist" ? "Only the hosts allowed" : settings.preset == "e2b" ? "Any host. E2B can't block hosts" : "Any host but the blocked ones"
		return SettingsRow(label: mode == "allowlist" ? "Allowlist" : "Open", sub: summary, leading: { EmptyView() }, trailing: {
			SegmentedChoice(label: "Network", options: [("open", "Open"), ("allowlist", "Allowlist")], value: mode) { networkMode in
				var next = settings
				next.networkMode = SandboxNetworkMode(rawValue: networkMode)
				Task { await act { try await configure(SandboxProviderChange(settings: next), configured: configured, chosen: chosen) } }
			}
			.disabled(pending)
		})
	}

	@ViewBuilder
	private var botsUsingAComputer: some View {
		let using = store.agents.compactMap { agent in
			agent.usesSandbox && agent.systemAgentKey == nil ? store.pod(id: agent.podId).map { (agent, $0) } : nil
		}
		SettingsGroup(label: "Bots using a computer", note: "Switch a computer on or off in each bot's settings.") {
			if using.isEmpty { SettingsEmptyRow(text: "None yet") }
			DividedRows(data: using, id: \.0.id) { item in
				NavigationLink(value: Route.settings(.agent(item.1, item.0))) {
					SettingsRow.icon(label: item.0.name, sub: item.1.name, chevron: true) { BotFace(look: item.0.look, size: 24) }
				}
				.buttonStyle(SettingsRowPressStyle())
			}
		}
	}

	// MARK: Doing

	private func load() async {
		await store.refreshAccess()
		do {
			providers = try await store.client.sandboxProviders.list(workspace: store.workspace.id)
			failure = nil
		} catch {
			failure = error.localizedDescription
		}
	}

	/// Saves a change to the chosen provider, making it first if it has never been set up, then reloads them.
	private func configure(_ change: SandboxProviderChange, configured: SandboxProvider?, chosen: String) async throws {
		let routes = store.client.sandboxProviders
		if let configured {
			_ = try await routes.update(
				workspace: store.workspace.id, providerId: configured.id, enabled: change.enabled, apiKey: change.apiKey, settings: change.settings?.apiValue
			)
		} else {
			_ = try await routes.create(
				workspace: store.workspace.id,
				settings: (change.settings ?? SandboxProviderFields(preset: chosen)).apiValue,
				enabled: change.enabled,
				apiKey: change.apiKey ?? nil
			)
		}
		await load()
	}

	private func switchTo(_ on: Bool, chosen: String, configured: SandboxProvider?, enabled: SandboxProvider?) {
		Task {
			await act {
				if on {
					try await configure(SandboxProviderChange(enabled: true), configured: configured, chosen: chosen)
				} else if let enabled {
					try await configure(SandboxProviderChange(enabled: false), configured: enabled, chosen: enabled.preset.rawValue)
				}
			}
		}
	}

	private func test(_ provider: SandboxProvider) {
		Task {
			await act {
				let result = try await store.client.sandboxProviders.test(workspace: store.workspace.id, providerId: provider.id)
				tested = (result.reachable, result.latencyMs, result.error)
				await load()
			}
		}
	}

	/// Runs a change with the page's controls held, showing a failure under the provider's settings.
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

/// E2B's template: preparing or rebuilding Sugabots' image in the account, as `TemplateRow`.
@MainActor
private struct TemplateRow: View {
	let providerId: String
	@Environment(WorkspaceStore.self) private var store
	@State private var state: String?
	@State private var failure: String?
	@State private var preparing = false

	var body: some View {
		let canPrepare = state == "missing" || state == "failed" || state == "ready"
		let label = state == "ready" ? "Rebuild template" : canPrepare ? "Prepare template" : "Sugabots template"
		let sub = failure ?? {
			switch state {
			case "ready": "Ready. Rebuilding takes Sugabots' latest image, which pods' computers move to when upgraded."
			case "building": "Building in your E2B account. This takes a few minutes."
			case "failed": "The last build failed. Try again."
			default: "Builds Sugabots' computer image into a template in your E2B account."
			}
		}()
		Button(action: prepare) {
			SettingsRow.trailing(label: label, sub: sub) {
				if state == "ready" || state == "building" { SettingsValue(text: state == "ready" ? "Ready" : "Building") }
			}
		}
		.buttonStyle(SettingsRowPressStyle())
		.disabled(!canPrepare || preparing)
		.task { await load() }
	}

	private func load() async {
		do {
			state = try await store.client.sandboxProviders.template(workspace: store.workspace.id, providerId: providerId).state?.rawValue
		} catch {
			failure = error.localizedDescription
		}
	}

	private func prepare() {
		preparing = true
		Task {
			do {
				_ = try await store.client.sandboxProviders.prepareTemplate(workspace: store.workspace.id, providerId: providerId)
				failure = nil
				await load()
			} catch {
				failure = error.localizedDescription
			}
			preparing = false
		}
	}
}

/// A setting typed where it stands and saved when the field is left, as the
/// web's `TextEntryRow`; a secret shows dots until Replace.
struct TextEntryRow: View {
	let label: String
	let saved: String?
	let placeholder: String
	var secret = false
	var clearable = false
	let disabled: Bool
	var onRemove: (() -> Void)?
	let save: (String) async -> Void
	@State private var draft = ""
	@State private var replacing = false
	@FocusState private var focused: Bool

	init(label: String, saved: String?, placeholder: String, secret: Bool = false, clearable: Bool = false, disabled: Bool, onRemove: (() -> Void)? = nil, save: @escaping (String) async -> Void) {
		self.label = label
		self.saved = saved
		self.placeholder = placeholder
		self.secret = secret
		self.clearable = clearable
		self.disabled = disabled
		self.onRemove = onRemove
		self.save = save
	}

	var body: some View {
		let showingSecret = secret && saved != nil && !replacing
		HStack(spacing: 12) {
			Text(label).font(Typeface.rubik(13)).foregroundStyle(Palette.foreground).frame(width: 82, alignment: .leading)
			if showingSecret {
				Text("••••••••").font(Typeface.mono(13)).foregroundStyle(Palette.mutedForeground).frame(maxWidth: .infinity, alignment: .leading)
				Button("Replace") { replacing = true }
					.font(Typeface.rubik(12.5, .medium))
					.foregroundStyle(Palette.foreground)
					.disabled(disabled)
				if let onRemove {
					Button("Remove", action: onRemove)
						.font(Typeface.rubik(12.5, .medium))
						.foregroundStyle(Palette.destructiveText)
						.disabled(disabled)
				}
			} else {
				Group {
					if secret {
						SecureField("", text: $draft, prompt: Text(placeholder).foregroundStyle(Palette.subtleForeground))
					} else {
						TextField("", text: $draft, prompt: Text(placeholder).foregroundStyle(Palette.subtleForeground))
					}
				}
				.font(Typeface.mono(16))
				.foregroundStyle(Palette.foreground)
				.textInputAutocapitalization(.never)
				.autocorrectionDisabled()
				.focused($focused)
				.submitLabel(.done)
				.onSubmit { focused = false }
				.disabled(disabled)
				.accessibilityLabel(label)
			}
		}
		.padding(.horizontal, 16)
		.padding(.vertical, 10)
		.frame(minHeight: 48)
		.onAppear { if !secret { draft = saved ?? "" } }
		.onChange(of: saved) { _, value in if !secret && !focused { draft = value ?? "" } }
		.onChange(of: focused) { _, isFocused in if !isFocused { commit() } }
	}

	private func commit() {
		let value = draft.trimmingCharacters(in: .whitespaces)
		if clearable, value.isEmpty, saved != nil {
			Task { await save("") }
			return
		}
		if value.isEmpty || value == saved {
			if !secret { draft = saved ?? "" }
			return
		}
		Task {
			await save(value)
			if secret {
				draft = ""
				replacing = false
			}
		}
	}
}

/// The workspace's network for computers, as the web's `SandboxNetworkSection`:
/// open, or an allowlist with its hosts and the trusted ones, then the blocked hosts.
@MainActor
private struct SandboxNetworkGroups: View {
	let modeRow: AnyView
	@Environment(WorkspaceStore.self) private var store
	@State private var settings: SandboxNetworkSettings?
	@State private var failure: String?
	@State private var pending = false
	@State private var allowDraft = ""
	@State private var blockDraft = ""

	var body: some View {
		Group {
			if let settings {
				let open = settings.mode == .open
				if open {
					SettingsGroup(
						label: "Network",
						note: settings.blocking
							? "Switching to an allowlist keeps your blocked hosts, and the hosts allowed apply again."
							: "This provider can't block hosts, so the blocked hosts don't apply while it's open. They're kept, with the allowed hosts, for if it goes back to the allowlist."
					) { modeRow }
				} else {
					SettingsGroup(
						label: "Network",
						note: "Every pod's computer connects to these hosts, and each pod adds its own under Computer in its settings. Blocked hosts still apply. When a bot needs another, it asks in its thread."
					) {
						modeRow
						ForEach(settings.addedHosts) { added in
							SettingsDivider()
							RemovableRow(name: added.host, sub: "Added by \(added.addedByName ?? "someone who has left")") {
								change { try await $0.removeHost(workspace: store.workspace.id, host: added.host) }
							}
							.disabled(pending)
						}
						SettingsDivider()
						AddHostRow(label: "Allow host", action: "Allow", draft: $allowDraft, pending: pending) { host in
							change(then: { allowDraft = "" }) { try await $0.addHost(workspace: store.workspace.id, host: host) }
						}
						SettingsDivider()
						HostListRow(
							label: "Trusted hosts",
							hosts: settings.trustedHosts,
							summary: "\(settings.trustedHosts.count) hosts every workspace reaches: GitHub, package registries and Linux mirrors"
						)
					}
				}
				if settings.blocking {
					SettingsGroup(
						label: "Blocked hosts",
						note: open
							? "No pod's computer connects to these, or to their subdomains."
							: "No pod's computer connects to these, whatever it allows, and bots' requests for them are refused. Blocking a host also keeps out any wildcard that covers it."
					) {
						ForEach(settings.blockedHosts) { blocked in
							RemovableRow(name: blocked.host, sub: "Blocked by \(blocked.blockedByName ?? "someone who has left")", removeLabel: "Unblock \(blocked.host)") {
								change { try await $0.unblockHost(workspace: store.workspace.id, host: blocked.host) }
							}
							.disabled(pending)
							SettingsDivider()
						}
						AddHostRow(label: "Block host", action: "Block", draft: $blockDraft, pending: pending) { host in
							change(then: { blockDraft = "" }) { try await $0.blockHost(workspace: store.workspace.id, host: host) }
						}
					}
				}
			}
			if let failure { FormAlert(text: failure) }
		}
		.task { await load() }
	}

	private func load() async {
		do {
			settings = try await store.client.sandboxProviders.network(workspace: store.workspace.id)
		} catch {
			failure = error.localizedDescription
		}
	}

	/// Makes a change to the network, which answers with it as it now stands.
	private func change(then done: @escaping () -> Void = {}, _ write: @escaping (APIClient.SandboxProvidersRoutes) async throws -> SandboxNetworkSettings) {
		pending = true
		Task {
			do {
				settings = try await write(store.client.sandboxProviders)
				failure = nil
				done()
			} catch {
				failure = error.localizedDescription
			}
			pending = false
		}
	}
}
