import Foundation

// The settings pages' rules, copied from the web's model-provider, connection,
// member, usage and pod-settings helpers.

// MARK: Model providers

/// What a provider from the catalog needs before bots can use it, as the catalog's `credential` names it.
enum ProviderCredential: String {
	/// A key, required.
	case apiKey = "api-key"
	/// A key only if its server was started with one.
	case optional
	/// A sign-in to somebody's plan, such as ChatGPT's.
	case signIn = "sign-in"
}

/// Where a provider from the catalog runs, as the catalog's `hosting` names it.
enum ProviderHosting: String {
	/// On the provider's own servers.
	case remote
	/// On a machine of the workspace's own.
	case local
}

extension ProviderPreset {
	/// What `credential` names, or nil for a kind this app doesn't know.
	var credentialKind: ProviderCredential? { ProviderCredential(rawValue: credential) }
	/// What `hosting` names, or nil for a kind this app doesn't know.
	var hostingKind: ProviderHosting? { ProviderHosting(rawValue: hosting) }
	/// The service a provider made from it signs in to, when it is paid for by a plan rather than a key.
	var signInService: String? { credentialKind == .signIn ? signIn : nil }
}

extension ProviderModel: Identifiable {
	var name: String { displayName ?? modelId }
	/// As `effectiveCapabilities`: what it can do, less what has been switched off.
	var effectiveCapabilities: [ProviderModelCapability] { capabilities.filter { !disabledCapabilities.contains($0) } }
	/// Whether a bot can think with it: on, and not only for embeddings.
	var choosable: Bool { enabled && !effectiveCapabilities.contains(.embeddings) }
	/// As `makerOf`: `meta-llama` of `meta-llama/llama-3`.
	var maker: String? {
		guard let slash = modelId.firstIndex(of: "/"), slash != modelId.startIndex else { return nil }
		return String(modelId[..<slash])
	}
}

extension ModelProvider: Identifiable {
	private var catalogPreset: ProviderPreset? { ProviderPreset.named(preset?.rawValue) }
	/// The service it signs in to, when it is paid for by a plan rather than a key.
	var signInService: String? { catalogPreset?.signInService }

	/// As `providerLacksCredential`: whether it still needs its key, or its sign-in, before bots can use it.
	/// A custom provider, which has no preset, needs a key.
	var lacksCredential: Bool {
		if signInService != nil { return !signedIn }
		let requiresKey = preset == nil || catalogPreset?.credentialKind == .apiKey
		return requiresKey && !hasApiKey
	}

	/// As `isConnected`: switched on, and holding the key or sign-in it needs.
	var connected: Bool { active && !lacksCredential }
	/// Whether it runs on a machine of the workspace's own, such as Ollama.
	var local: Bool { catalogPreset?.hostingKind == .local }
	/// Whether it was added by its address rather than from the catalog.
	var custom: Bool { preset == nil }
	/// Whether every workspace starts with it, so it is signed out and switched off rather than removed.
	var seeded: Bool { preset.map { ProviderPreset.seeded.contains($0.rawValue) } ?? false }

	/// As `credentialLine`: what a connected provider is connected with.
	var credentialLine: String {
		if signInService != nil { return "Signed in" }
		return hasApiKey ? "API key set" : "No key needed"
	}

	/// As `offeredModelsOf`: what bots may choose from it now, which is nothing while it isn't connected.
	var offeredModels: [ProviderModel] { connected ? models.filter(\.enabled) : [] }
}

/// Who must keep running on some models, as the web's `ModelHolders`: new bots,
/// which start on the workspace's default, and the system bots. The server
/// refuses to switch such a model off, or its provider, until they move.
struct ModelHolders: Equatable, Decodable {
	let newBots: Bool
	let systemBots: Bool

	/// As `heldReason`: why a model, or its provider, can't be switched off, with `subject` naming what they use.
	func reason(_ subject: String) -> String {
		let holders = newBots && systemBots ? "New bots and system agents use" : newBots ? "New bots use" : "System agents use"
		return "\(holders) \(subject). Choose another model for them under Models → Default first."
	}

	/// Who must keep running on any of `modelIds`, all together, or nil when none is held.
	/// `defaultModel` is what new bots start on, and `systemModels` what each system bot runs on.
	static func of(_ modelIds: [String], defaultModel: String?, systemModels: [String?]) -> ModelHolders? {
		let newBots = modelIds.contains { $0 == defaultModel }
		let systemBots = modelIds.contains { id in systemModels.contains(id) }
		return newBots || systemBots ? ModelHolders(newBots: newBots, systemBots: systemBots) : nil
	}
}

/// What to say when `parseProviderBaseURL` can't read a typed address.
let notAServerAddress = "That is not a server address. A host and port, like 192.168.1.10:11434, is enough."

/// As `parseProviderBaseUrl`: `typed` as a server's base URL, or nil if it isn't one.
/// A bare host and port is given `http://` and the OpenAI-compatible path.
func parseProviderBaseURL(_ typed: String) -> String? {
	let trimmed = typed.trimmingCharacters(in: .whitespaces)
	guard !trimmed.isEmpty else { return nil }
	let withScheme = trimmed.range(of: "^[a-z][a-z0-9+.-]*://", options: [.regularExpression, .caseInsensitive]) != nil ? trimmed : "http://\(trimmed)"
	guard var components = URLComponents(string: withScheme), let scheme = components.scheme?.lowercased(),
		scheme == "http" || scheme == "https", components.host?.isEmpty == false
	else { return nil }
	if components.path.isEmpty || components.path == "/" { components.path = ProviderPreset.openAICompatiblePath }
	guard let url = components.string else { return nil }
	return url.hasSuffix("/") ? String(url.dropLast()) : url
}

/// The providers Models lists, as the web's `ModelsSettings` orders them.
struct ProviderListing {
	/// As `POPULAR_PRESETS`: the providers most people connect, listed whether or not they are.
	static let popularPresets: [ProviderPresetId] = [.openrouter, .anthropic, .openai, .gemini]

	/// What is connected: the popular providers holding their key or sign-in, in
	/// their order, then any other connected provider and every custom one.
	let connected: [ModelProvider]
	/// The popular providers still to connect, each offered Connect.
	let toConnect: [ProviderPresetId]

	/// The listing of `providers`, or with nil, while they load, nothing: a
	/// popular provider would read Not connected whether it is or not.
	init(_ providers: [ModelProvider]?) {
		guard let providers else {
			connected = []
			toConnect = []
			return
		}
		let withCredential = { (preset: ProviderPresetId) in
			providers.first { $0.preset == preset && !$0.lacksCredential }
		}
		let others = providers.filter { provider in
			guard let preset = provider.preset else { return true }
			return !Self.popularPresets.contains(preset) && provider.connected
		}
		connected = Self.popularPresets.compactMap(withCredential) + others
		toConnect = Self.popularPresets.filter { withCredential($0) == nil }
	}
}

// MARK: Connections

extension ConnectionToolSetting {
	/// As `connectionToolMutating`: whether the tool may make changes, which any not known to only read may.
	var mutating: Bool { readOnly != true }
}

/// A connection's tools of one kind, those that read or those that make changes,
/// with the access most of them have, as `toolKinds`.
struct ToolKind {
	enum Kind: String, Decodable {
		case read, change
	}

	let kind: Kind
	let tools: [ConnectionToolSetting]
	/// What most of `tools` are set to: the group's setting, which a tool set apart differs from.
	let setting: ConnectionAccess

	var heading: String { kind == .read ? "Tools that read" : "Tools that make changes" }
	var sub: String { kind == .read ? "Look things up without changing anything" : "Create, edit, delete or send things" }
	var all: String {
		let count = tools.count
		return kind == .read ? "All \(count) read \(count == 1 ? "tool" : "tools")" : "All \(count) change \(count == 1 ? "tool" : "tools")"
	}

	/// The tools that only read, then those that may make changes, leaving out an empty kind.
	static func of(_ tools: [ConnectionToolSetting]) -> [ToolKind] {
		[(Kind.read, tools.filter { !$0.mutating }), (.change, tools.filter(\.mutating))].compactMap { kind, ofKind in
			ofKind.isEmpty ? nil : ToolKind(kind: kind, tools: ofKind, setting: setting(of: ofKind, kind: kind))
		}
	}

	/// As `settingOf`: the access most of `tools` have, leaning to allow for reading and ask for changing when tied.
	static func setting(of tools: [ConnectionToolSetting], kind: Kind) -> ConnectionAccess {
		let count = { (access: ConnectionAccess) in tools.filter { $0.access == access }.count }
		let leaning: ConnectionAccess = kind == .read ? .allow : .ask
		return [ConnectionAccess.allow, .ask, .off].reduce(leaning) { best, access in count(access) > count(best) ? access : best }
	}

	/// Each tool of `kinds` set apart from its group, with its group's setting.
	static func setApart(_ kinds: [ToolKind]) -> [(tool: ConnectionToolSetting, setting: ConnectionAccess)] {
		kinds.flatMap { kind in kind.tools.filter { $0.access != kind.setting }.map { ($0, kind.setting) } }
	}
}

// MARK: People

extension WorkspaceMember {
	/// As the web's `mayManageThem`: whether somebody with `permissions`, signed in
	/// as `viewerId`, may change this member's role or remove them. Nobody changes
	/// their own role, since demoting yourself takes away the control you'd need to
	/// undo it; the owner's changes only by their handing ownership on; and an
	/// admin is managed only by those who may manage admins.
	func isManageable(withPermissions permissions: WorkspacePermissions?, byUser viewerId: String) -> Bool {
		guard let permissions, permissions.manageMembers, user.id != viewerId, role != .owner else { return false }
		return role != .admin || permissions.manageAdmins
	}
}

extension WorkspaceInvitation {
	private static let secondsPerDay: TimeInterval = 86_400

	/// As the web's `expiryText`: whole days left at `now`, so one with a day and a half to go says one day.
	func expiryText(at now: Date) -> String {
		let left = expiresAt.timeIntervalSince(now)
		if left <= 0 { return "Expired" }
		let days = Int(left / Self.secondsPerDay)
		if days == 0 { return "Expires within a day" }
		return days == 1 ? "Expires in 1 day" : "Expires in \(days) days"
	}
}

// MARK: Usage

/// A calendar month, which usage is asked for and stepped through by, as the API's `UsageMonth`.
struct YearMonth: Hashable, Comparable {
	let year: Int
	/// 1 for January to 12 for December.
	let month: Int

	init(year: Int, month: Int) {
		self.year = year
		self.month = month
	}

	/// The month `text` names as `YYYY-MM`, or nil if it names none.
	init?(_ text: String) {
		let parts = text.split(separator: "-")
		guard parts.count == 2, let year = Int(parts[0]), let month = Int(parts[1]), (1...12).contains(month) else { return nil }
		self.init(year: year, month: month)
	}

	/// The month `date` falls in, in `zone`.
	static func containing(_ date: Date, in zone: TimeZone) -> YearMonth {
		var calendar = Calendar(identifier: .gregorian)
		calendar.timeZone = zone
		let parts = calendar.dateComponents([.year, .month], from: date)
		return YearMonth(year: parts.year ?? 0, month: parts.month ?? 1)
	}

	/// As the API writes it: `2026-09`.
	var text: String { String(format: "%04d-%02d", year, month) }

	/// As `shiftMonth`: the month `months` after this one, or before it for a negative `months`.
	func shifted(by months: Int) -> YearMonth {
		let index = year * 12 + (month - 1) + months
		let (shiftedYear, monthIndex) = (index.quotientAndRemainder(dividingBy: 12))
		return monthIndex < 0 ? YearMonth(year: shiftedYear - 1, month: monthIndex + 13) : YearMonth(year: shiftedYear, month: monthIndex + 1)
	}

	static func < (left: YearMonth, right: YearMonth) -> Bool {
		(left.year, left.month) < (right.year, right.month)
	}
}

// MARK: Pods

/// How many bots a pod has, and how many people once they're known, as "2 bots, 1 person".
func podSummary(bots: Int, people: Int?) -> String {
	["\(bots) \(bots == 1 ? "bot" : "bots")", people.map { "\($0) \($0 == 1 ? "person" : "people")" }].compactMap { $0 }.joined(separator: ", ")
}

/// A pod's settings pages, as `podSettingsPages`.
enum PodSettingsPage: String, CaseIterable, Hashable {
	case general, connections, people, bots, computer

	var label: String {
		switch self {
		case .general: "General"
		case .connections: "Connections"
		case .people: "People"
		case .bots: "Bots"
		case .computer: "Computer"
		}
	}

	/// The pages a pod of `kind` has, as `podHasSettingsPage` reads them: a
	/// Personal pod is only ever yours, so it has no General or People. Computer
	/// is counted in, since its page says when the workspace's computers are off.
	static func pages(for kind: Pod.Kind) -> [PodSettingsPage] {
		allCases.filter { page in !(kind == .personal && (page == .general || page == .people)) }
	}

	/// As `podSettingsPagesOf`: the pages listed for a pod of `kind`, which leave
	/// out Computer unless `computersEnabled` says the workspace has computers.
	static func pages(for kind: Pod.Kind, computersEnabled: Bool) -> [PodSettingsPage] {
		pages(for: kind).filter { computersEnabled || $0 != .computer }
	}
}
