import SwiftUI

extension SandboxProviderSettings {
	/// A provider's settings with nothing chosen but `preset`, or nil for a preset this app doesn't know.
	static func empty(for preset: SandboxProviderPresetId) -> SandboxProviderSettings? {
		switch preset {
		case .opensandbox: .opensandbox(Opensandbox())
		case .e2b: .e2b(E2b())
		case .unknown: nil
		}
	}

	/// Which hosts the provider's computers reach; nil until chosen, which means open.
	var networkMode: SandboxNetworkMode? {
		get {
			switch self {
			case let .opensandbox(fields): fields.networkMode
			case let .e2b(fields): fields.networkMode
			case .unknown: nil
			}
		}
		set {
			switch self {
			case var .opensandbox(fields):
				fields.networkMode = newValue
				self = .opensandbox(fields)
			case var .e2b(fields):
				fields.networkMode = newValue
				self = .e2b(fields)
			case .unknown:
				break
			}
		}
	}
}

/// A change to a computer provider: what is left nil, or kept, stays as it is.
private struct SandboxProviderChange {
	var enabled: Bool?
	var apiKey = FieldChange<String>.keep
	var settings: SandboxProviderSettings?
}

extension SandboxPreset {
	static func named(_ id: SandboxProviderPresetId) -> SandboxPreset { catalog.first { $0.id == id.rawValue } ?? catalog[0] }
}

/// A size an E2B computer can't have.
private struct SizeOutOfRange: LocalizedError {
	let unit: String
	var errorDescription: String? { "Enter a whole number of \(unit), from 1 to 64." }
}

/// Computers, as the web's `SandboxSettings`: the switch, the provider and its
/// settings, the network the computers reach, and the bots using one.
@MainActor
struct SandboxSettingsScreen: View {
	@Environment(WorkspaceStore.self) private var store
	@State private var providers: Loadable<[SandboxProvider]> = .loading
	@State private var chosen: SandboxProviderPresetId?
	@State private var action = SettingsAction()
	@State private var tested: TestResult?
	@State private var removingKey = false
	@State private var removing = false

	/// The sizes an E2B computer can have, in vCPUs or GiB.
	private static let sizeRange = 1...64

	var body: some View {
		SettingsPage(title: "Computers", description: "Give bots their own computer to run commands, browse and edit files.") {
			switch providers {
			case .loading: EmptyView()
			case let .failed(failure): FormAlert(text: failure)
			case let .loaded(providers): groups(providers)
			}
		}
		.task { await load() }
	}

	@ViewBuilder
	private func groups(_ providers: [SandboxProvider]) -> some View {
		let enabled = providers.first(where: \.enabled)
		let chosen = chosen ?? enabled?.preset ?? providers.first?.preset ?? .opensandbox
		let configured = providers.first { $0.preset == chosen }
		let preset = SandboxPreset.named(chosen)
		let ready = configured?.hasApiKey == true
		let settings = configured?.settings ?? SandboxProviderSettings.empty(for: chosen)
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
		SettingsGroup(note: Self.movingNote(from: enabled, to: preset, chosen: chosen, ready: ready)) {
			HStack(spacing: 14) {
				VStack(alignment: .leading, spacing: 2) {
					Text("Bots can use a computer").font(Typeface.rubik(16, .medium)).foregroundStyle(Palette.foreground)
					Text(ready ? "Each pod gets its own private computer" : "\(preset.name) needs an API key first. Add it below.")
						.font(Typeface.rubik(13))
						.foregroundStyle(Palette.subtleForeground)
				}
				.frame(maxWidth: .infinity, alignment: .leading)
				WebToggle(label: "Bots can use a computer", isOn: enabled?.preset == chosen) { on in switchTo(on, chosen: chosen, configured: configured, enabled: enabled) }
					.disabled(!ready || action.pending)
			}
			.padding(.horizontal, 16)
			.padding(.vertical, 12)
			.frame(minHeight: 56)
		}
		providerChoice(chosen: chosen, enabled: enabled?.preset)
		providerSettings(preset: preset, chosen: chosen, configured: configured, settings: settings)
		if let failure = action.failure { FormAlert(text: failure) }
		if let settings {
			SandboxNetworkGroups(mode: settings.networkMode ?? .open, preset: chosen) { mode in
				var next = settings
				next.networkMode = mode
				action.run { try await configure(SandboxProviderChange(settings: next), configured: configured, chosen: chosen) }
			}
			.disabled(action.pending)
		}
		botsUsingAComputer
	}

	/// What the switch's group says when turning it on would move computers from the provider in use to `preset`.
	private static func movingNote(from enabled: SandboxProvider?, to preset: SandboxPreset, chosen: SandboxProviderPresetId, ready: Bool) -> String? {
		guard ready, let enabled, enabled.preset != chosen else { return nil }
		return "Turning this on moves computers from \(enabled.name) to \(preset.name). Each pod gets a new one, without the old one's files."
	}

	private func providerChoice(chosen: SandboxProviderPresetId, enabled: SandboxProviderPresetId?) -> some View {
		SettingsGroup(label: "Provider") {
			DividedRows(data: SandboxPreset.catalog, id: \.id) { candidate in
				let candidateId = SandboxProviderPresetId(rawValue: candidate.id)
				SettingsRadioRow(name: candidate.name, description: candidate.description, badge: candidateId == enabled ? "In use" : nil, checked: candidateId == chosen) {
					action.failure = nil
					tested = nil
					self.chosen = candidateId
				}
				.disabled(action.pending)
			}
		}
	}

	/// What the provider's group says under it: how its last test went, or what its settings are for.
	private func providerNote(_ preset: SandboxProviderPresetId, configured: SandboxProvider?) -> String {
		if let tested { return tested.text }
		switch configured?.status {
		case .connected: return "The last test connected."
		case .error: return configured?.lastTestError ?? "The last test failed."
		default: break
		}
		if preset == .e2b {
			return "Leave the URLs empty for E2B Cloud. For E2B Embed, give both. A new size takes effect once the template is prepared again and a pod's computer is reset."
		}
		return "The server's own API key, from its configuration. Leave the image empty to use the default."
	}

	private func providerSettings(preset: SandboxPreset, chosen: SandboxProviderPresetId, configured: SandboxProvider?, settings: SandboxProviderSettings?) -> some View {
		let hasKey = configured?.hasApiKey == true
		let save = { (next: SandboxProviderSettings) in
			try await action.perform { try await configure(SandboxProviderChange(settings: next), configured: configured, chosen: chosen) }
		}
		return SettingsGroup(label: preset.name, note: providerNote(chosen, configured: configured)) {
			VStack(spacing: 0) {
				if case let .opensandbox(fields) = settings {
					TextEntryRow(label: "Server URL", value: .text(saved: fields.serverUrl ?? preset.baseUrl), placeholder: preset.baseUrl ?? "") { url in
						var next = fields
						next.serverUrl = url
						try await save(.opensandbox(next))
					}
					SettingsDivider()
				}
				TextEntryRow(
					label: "API key",
					value: .secret(isSaved: hasKey),
					placeholder: "Paste your key",
					save: { key in try await action.perform { try await configure(SandboxProviderChange(apiKey: .set(key)), configured: configured, chosen: chosen) } },
					remove: hasKey ? { removingKey = true } : nil
				)
				switch settings {
				case let .opensandbox(fields):
					SettingsDivider()
					clearableRow(preset.imageLabel, saved: fields.image, placeholder: preset.defaultImage) { image in
						var next = fields
						next.image = image
						try await save(.opensandbox(next))
					}
				case let .e2b(fields):
					SettingsDivider()
					clearableRow(preset.imageLabel, saved: fields.template, placeholder: preset.defaultImage) { template in
						var next = fields
						next.template = template
						try await save(.e2b(next))
					}
					SettingsDivider()
					clearableRow("API URL", saved: fields.apiUrl, placeholder: "E2B Cloud") { url in
						var next = fields
						next.apiUrl = url
						try await save(.e2b(next))
					}
					SettingsDivider()
					clearableRow("Computer URL", saved: fields.sandboxUrl, placeholder: "E2B Cloud") { url in
						var next = fields
						next.sandboxUrl = url
						try await save(.e2b(next))
					}
					SettingsDivider()
					sizeRow("vCPUs", saved: fields.cpuCount.map(String.init), placeholder: "\(SandboxPreset.defaultSize.cpuCount)", unit: "vCPUs") { count in
						var next = fields
						next.cpuCount = count
						try await save(.e2b(next))
					}
					SettingsDivider()
					sizeRow("Memory", saved: fields.memoryGiB.map { "\($0) GiB" }, placeholder: "\(SandboxPreset.defaultSize.memoryGiB) GiB", unit: "GiB") { memory in
						var next = fields
						next.memoryGiB = memory
						try await save(.e2b(next))
					}
					if let configured, hasKey {
						SettingsDivider()
						TemplateRow(providerId: configured.id)
					}
				case .unknown, nil:
					EmptyView()
				}
				if let configured, hasKey {
					SettingsDivider()
					Button { test(configured) } label: {
						SettingsRow(label: "Test connection", sub: "Checks the provider answers and accepts the key.")
					}
					.buttonStyle(SettingsRowPressStyle())
				}
				if configured != nil {
					SettingsDivider()
					Button { removing = true } label: {
						SettingsRow(label: "Remove \(preset.name)", sub: "Removes its computers and settings.")
					}
					.buttonStyle(SettingsRowPressStyle())
				}
			}
			.disabled(action.pending)
			.confirmDelete(
				isPresented: $removingKey,
				title: "Remove the \(preset.name) key?",
				description: "Bots stop getting computers from this provider until another key is added.",
				confirmLabel: "Remove"
			) {
				try await configure(SandboxProviderChange(apiKey: .clear), configured: configured, chosen: chosen)
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

	/// A setting that may be emptied for its default, which `set` is given as nil.
	private func clearableRow(_ label: String, saved: String?, placeholder: String, set: @escaping (String?) async throws -> Void) -> some View {
		TextEntryRow(label: label, value: .text(saved: saved), placeholder: placeholder, save: { try await set($0) }, clear: { try await set(nil) })
	}

	/// An E2B computer's size: a whole number in `sizeRange`, which may be emptied for the default.
	private func sizeRow(_ label: String, saved: String?, placeholder: String, unit: String, set: @escaping (Int?) async throws -> Void) -> some View {
		TextEntryRow(
			label: label,
			value: .text(saved: saved),
			placeholder: placeholder,
			save: { typed in
				let number = Int(typed.replacingOccurrences(of: "\\s*GiB$", with: "", options: [.regularExpression, .caseInsensitive]))
				guard let number, Self.sizeRange.contains(number) else {
					try await action.perform { throw SizeOutOfRange(unit: unit) }
					return
				}
				try await set(number)
			},
			clear: { try await set(nil) }
		)
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
					SettingsRow(label: item.0.name, sub: item.1.name, chevron: true, leading: { BotFace(look: item.0.look, size: 24) })
				}
				.buttonStyle(SettingsRowPressStyle())
			}
		}
	}

	// MARK: Doing

	private func load() async {
		providers = await .of { try await store.client.sandboxProviders.list(workspace: store.workspace.id) }
	}

	/// Saves a change to the chosen provider, making it first if it has never been set up, then reloads them.
	private func configure(_ change: SandboxProviderChange, configured: SandboxProvider?, chosen: SandboxProviderPresetId) async throws {
		let routes = store.client.sandboxProviders
		if let configured {
			_ = try await routes.update(
				workspace: store.workspace.id, providerId: configured.id, enabled: change.enabled, apiKey: change.apiKey.apiValue, settings: change.settings
			)
		} else if let settings = change.settings ?? .empty(for: chosen) {
			let apiKey: String? = if case let .set(key) = change.apiKey { key } else { nil }
			_ = try await routes.create(workspace: store.workspace.id, settings: settings, enabled: change.enabled, apiKey: apiKey)
		}
		await load()
	}

	private func switchTo(_ on: Bool, chosen: SandboxProviderPresetId, configured: SandboxProvider?, enabled: SandboxProvider?) {
		action.run {
			if on {
				try await configure(SandboxProviderChange(enabled: true), configured: configured, chosen: chosen)
			} else if let enabled {
				try await configure(SandboxProviderChange(enabled: false), configured: enabled, chosen: enabled.preset)
			}
		}
	}

	private func test(_ provider: SandboxProvider) {
		action.run {
			let result = try await store.client.sandboxProviders.test(workspace: store.workspace.id, providerId: provider.id)
			tested = TestResult(passed: result.reachable, text: result.reachable ? "Connected in \(result.latencyMs) ms." : result.error ?? "The provider didn't answer.")
			await load()
		}
	}
}

/// E2B's template: preparing or rebuilding Sugabots' image in the account, as `TemplateRow`.
@MainActor
private struct TemplateRow: View {
	let providerId: String
	@Environment(WorkspaceStore.self) private var store
	@State private var state: SandboxTemplate.State?
	@State private var loadFailure: String?
	@State private var preparing = SettingsAction()

	var body: some View {
		let canPrepare = state == .missing || state == .failed || state == .ready
		Button(action: prepare) {
			SettingsRow(label: Self.label(state, canPrepare: canPrepare), sub: preparing.failure ?? loadFailure ?? Self.description(state), trailing: {
				if let badge = Self.badge(state) { SettingsValue(text: badge) }
			})
		}
		.buttonStyle(SettingsRowPressStyle())
		.disabled(!canPrepare || preparing.pending)
		.task { await load() }
	}

	private static func label(_ state: SandboxTemplate.State?, canPrepare: Bool) -> String {
		if state == .ready { return "Rebuild template" }
		return canPrepare ? "Prepare template" : "Sugabots template"
	}

	private static func description(_ state: SandboxTemplate.State?) -> String {
		switch state {
		case .ready: "Ready. Rebuilding takes Sugabots' latest image, which pods' computers move to when upgraded."
		case .building: "Building in your E2B account. This takes a few minutes."
		case .failed: "The last build failed. Try again."
		default: "Builds Sugabots' computer image into a template in your E2B account."
		}
	}

	private static func badge(_ state: SandboxTemplate.State?) -> String? {
		switch state {
		case .ready: "Ready"
		case .building: "Building"
		default: nil
		}
	}

	private func load() async {
		do {
			state = try await store.client.sandboxProviders.template(workspace: store.workspace.id, providerId: providerId).state
			loadFailure = nil
		} catch {
			loadFailure = error.localizedDescription
		}
	}

	private func prepare() {
		preparing.run {
			_ = try await store.client.sandboxProviders.prepareTemplate(workspace: store.workspace.id, providerId: providerId)
			await load()
		}
	}
}

/// The workspace's network for computers, as the web's `SandboxNetworkSection`:
/// open, or an allowlist with its hosts and the trusted ones, then the blocked
/// hosts. The network is fetched again whenever `mode` changes.
@MainActor
private struct SandboxNetworkGroups: View {
	/// Which hosts the chosen provider's computers reach.
	let mode: SandboxNetworkMode
	/// The chosen provider, which says whether the open network can block hosts.
	let preset: SandboxProviderPresetId
	let setMode: (SandboxNetworkMode) -> Void
	@Environment(WorkspaceStore.self) private var store
	@State private var settings: Loadable<SandboxNetworkSettings> = .loading
	@State private var action = SettingsAction()
	@State private var allowDraft = ""
	@State private var blockDraft = ""

	var body: some View {
		Group {
			if let settings = settings.value {
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
							RemovableRow(
								name: added.host,
								sub: "Added by \(added.addedByName ?? "someone who has left")",
								removal: .init(label: "Remove \(added.host)") {
									change { try await $0.removeHost(workspace: store.workspace.id, host: added.host) }
								}
							)
						}
						SettingsDivider()
						AddHostRow(label: "Allow host", buttonTitle: "Allow", draft: $allowDraft) { host in
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
							RemovableRow(
								name: blocked.host,
								sub: "Blocked by \(blocked.blockedByName ?? "someone who has left")",
								removal: .init(label: "Unblock \(blocked.host)") {
									change { try await $0.unblockHost(workspace: store.workspace.id, host: blocked.host) }
								}
							)
							SettingsDivider()
						}
						AddHostRow(label: "Block host", buttonTitle: "Block", draft: $blockDraft) { host in
							change(then: { blockDraft = "" }) { try await $0.blockHost(workspace: store.workspace.id, host: host) }
						}
					}
				}
			}
			if let failure = action.failure ?? settings.failure { FormAlert(text: failure) }
		}
		.disabled(action.pending)
		.task(id: mode) { await load() }
	}

	/// Open or Allowlist, with what the chosen one lets through.
	private var modeRow: some View {
		SettingsRow(label: mode == .allowlist ? "Allowlist" : "Open", sub: Self.modeSummary(mode, preset: preset), trailing: {
			SegmentedChoice(label: "Network", options: [(SandboxNetworkMode.open, "Open"), (.allowlist, "Allowlist")], value: mode, choose: setMode)
		})
	}

	private static func modeSummary(_ mode: SandboxNetworkMode, preset: SandboxProviderPresetId) -> String {
		if mode == .allowlist { return "Only the hosts allowed" }
		return preset == .e2b ? "Any host. E2B can't block hosts" : "Any host but the blocked ones"
	}

	private func load() async {
		let loaded: Loadable<SandboxNetworkSettings> = await .of { try await store.client.sandboxProviders.network(workspace: store.workspace.id) }
		// A failed reload keeps the network shown, with what failed under it.
		if case let .failed(failure) = loaded, settings.value != nil {
			action.failure = failure
		} else {
			settings = loaded
		}
	}

	/// Makes a change to the network, which answers with it as it now stands, then runs `done`.
	private func change(then done: @escaping () -> Void = {}, _ write: @escaping (APIClient.SandboxProvidersRoutes) async throws -> SandboxNetworkSettings) {
		action.run {
			settings = .loaded(try await write(store.client.sandboxProviders))
			done()
		}
	}
}
