import SwiftUI

/// The bot's own tools, as `builtInToolCatalog` lists them.
private struct BuiltInTool {
	let key: String
	let name: String
	let description: String
	let usesWeb: Bool

	static let catalog = [
		BuiltInTool(key: "web_fetch", name: "Read web pages", description: "Fetches a public page by its address and reads it as text.", usesWeb: true),
		BuiltInTool(key: "web_search", name: "Search the web", description: "Searches through the workspace's search provider, when one is switched on.", usesWeb: true),
		BuiltInTool(key: "routines", name: "Manage its routines", description: "Lists, sets up and changes its own schedules when a pod admin asks it to.", usesWeb: false),
		BuiltInTool(key: "artifact_list", name: "List artifacts", description: "Lists the documents and HTML pages kept in the bot's pod.", usesWeb: false),
		BuiltInTool(key: "artifact_read", name: "Read artifacts", description: "Reads a document or HTML page kept in the bot's pod.", usesWeb: false),
		BuiltInTool(key: "artifact_write", name: "Write artifacts", description: "Makes a document or HTML page the pod keeps, or saves a new version of one.", usesWeb: false),
		BuiltInTool(key: "artifact_edit", name: "Edit artifacts", description: "Changes part of a document or HTML page, as a new version.", usesWeb: false),
	]

	static let webKeys = catalog.filter(\.usesWeb).map(\.key)
}

/// A bot's settings, as the web's `AgentSettingsPage`: its card, with its
/// look, name, description, model and instructions, its tools, what it
/// inherits, its routines, and Delete. Model and Instructions open in its place.
@MainActor
struct AgentSettingsScreen: View {
	let pod: Pod
	let agent: Agent
	@Environment(WorkspaceStore.self) private var store
	@Environment(\.dismiss) private var dismiss
	@State private var details: Agent?
	@State private var record: Pod?
	@State private var models: WorkspaceModelsResponse?
	@State private var members: [WorkspaceMember]?
	@State private var connections: [Connection]?
	@State private var routineCount: Int?
	@State private var webOff = false
	@State private var computersOff = false
	@State private var failure: String?
	@State private var editingLook = false
	@State private var confirmingDelete = false
	@State private var page: Page?

	enum Page: Hashable {
		case model, instructions
	}

	var body: some View {
		Group {
			if let details { card(details) } else { SettingsPage { if let failure { FormAlert(text: failure) } } }
		}
		.navigationDestination(item: $page) { page in
			if let details {
				switch page {
				case .model: modelPage(details)
				case .instructions: InstructionsPage(agent: details, editable: may.updateAgents) { try await save(AgentUpdate(prompt: $0)) }
				}
			}
		}
		.task {
			await load()
			if DebugSheet.wants("look") { editingLook = true }
		}
	}

	private var may: PodPermissions {
		record?.permissions ?? .none
	}

	// MARK: The card

	private func card(_ agent: Agent) -> some View {
		let workspaceName = store.workspace.name
		let modelName = agent.model.map { id in models?.models.first { $0.modelId == id }?.name ?? id }
		return SettingsPage(
			title: agent.name,
			description: agent.givenDescription,
			hero: AnyView(face(agent))
		) {
			if let failure { FormAlert(text: failure) }
			SettingsGroup(label: "Profile") {
				ProfileField(label: "Name", value: agent.name, maxLength: Limits.agentNameMaxLength, required: true, editable: may.updateAgents) { try await save(AgentUpdate(name: $0)) }
				SettingsDivider()
				ProfileField(label: "Description", value: agent.description ?? "", placeholder: "One line on what it's for", maxLength: Limits.descriptionMaxLength, wide: true, editable: may.updateAgents) {
					try await save(AgentUpdate(description: $0))
				}
				SettingsDivider()
				Button { page = .model } label: {
					SettingsRow.trailing(label: "Model", sub: "From the models set up for \(workspaceName)", chevron: true) {
						SettingsValue(text: modelName ?? "None chosen")
					}
				}
				.buttonStyle(SettingsRowPressStyle())
				SettingsDivider()
				Button { page = .instructions } label: {
					SettingsRow(label: "Instructions", sub: "How it should behave and what to focus on", chevron: true)
				}
				.buttonStyle(SettingsRowPressStyle())
				SettingsDivider()
				addedBy(agent)
			}
			builtInTools(agent, workspaceName: workspaceName)
			inheritedTools
			SettingsGroup {
				NavigationLink(value: Route.routines(pod, agent: self.agent)) {
					SettingsRow.trailing(label: "Routines", sub: "What \(agent.name) does without being asked. Set up on its Routines page.", chevron: true) {
						if let routineCount { SettingsValue(text: routineCount == 0 ? "None" : "\(routineCount)") }
					}
				}
				.buttonStyle(SettingsRowPressStyle())
			}
			if may.deleteAgents {
				SettingsDanger(label: "Delete bot", description: "Its chat, routines and settings go with it.", action: "Delete") { confirmingDelete = true }
			}
		}
		.confirmDelete(
			isPresented: $confirmingDelete,
			title: "Delete \(agent.name)?",
			description: "Its chat, routines and settings go with it. This can't be undone."
		) {
			try await store.client.agents.remove(agentId: agent.id)
			await store.refreshAll()
			// Back to Bots, so Back never returns to it.
			dismiss()
		}
		.fullScreenCover(isPresented: $editingLook) {
			LookEditor(agent: agent) { change in try await save(change) }
		}
	}

	@ViewBuilder
	private func face(_ agent: Agent) -> some View {
		if may.updateAgents {
			Button { editingLook = true } label: {
				BotFace(look: agent.look, size: 44)
					.overlay(alignment: .bottomTrailing) {
						// Cut out of the face by a ring of the page's own colour.
						Icon(.pencil, size: 11, strokeWidth: 2.2)
							.foregroundStyle(Palette.mutedForeground)
							.frame(width: 18, height: 18)
							.background(Palette.chip, in: Circle())
							.padding(2)
							.background(Palette.background, in: Circle())
							.offset(x: 6, y: 6)
					}
			}
			.buttonStyle(.plain)
			.accessibilityLabel("Change look")
		} else {
			BotFace(look: agent.look, size: 44)
		}
	}

	private func addedBy(_ agent: Agent) -> some View {
		let adder = members?.first { $0.user.id == agent.createdById }?.user
		// Said once the roster has answered, rather than guessed before it.
		let who: String? = agent.createdById == nil ? "With the workspace" : adder?.name ?? (members == nil ? nil : "Someone no longer here")
		return SettingsRow.trailing(label: "Added by", sub: agent.createdAt.formatted(.dateTime.day().month(.abbreviated).year())) {
			if let who {
				HStack(spacing: 8) {
					if let adder { PersonAvatar(name: adder.name, email: adder.email, image: adder.image, size: 20) }
					SettingsValue(text: who)
				}
			}
		}
	}

	private func builtInTools(_ agent: Agent, workspaceName: String) -> some View {
		let isOn = { (keys: [String]) in keys.contains { !agent.disabledTools.contains($0) } }
		return SettingsGroup(label: "Built-in tools") {
			toolRow(
				"Computer",
				sub: computersOff ? "Computers are off for \(workspaceName)" : "Run commands, browse and edit files on the pod's computer",
				on: agent.usesSandbox && !computersOff,
				canChange: may.manageSandbox,
				offReason: computersOff ? "Computers are off for \(workspaceName)" : nil
			) { next in Task { try? await save(AgentUpdate(usesSandbox: next)) } }
			// How it uses its computer's browser, so only while it has one.
			if agent.usesSandbox && !computersOff {
				SettingsDivider()
				toolRow(
					"Natural browsing",
					sub: "Show a cursor, scroll smoothly and type at a typing pace, so people watching can follow along. Slower.",
					on: agent.naturalBrowsing,
					canChange: may.updateAgents
				) { next in Task { try? await save(AgentUpdate(naturalBrowsing: next)) } }
			}
			SettingsDivider()
			toolRow(
				"Web search",
				sub: webOff ? "Web search is off for \(workspaceName)" : "Look things up and cite pages",
				on: isOn(BuiltInTool.webKeys) && !webOff,
				canChange: may.updateAgents,
				offReason: webOff ? "Web search is off for \(workspaceName)" : nil
			) { next in setTools(agent, BuiltInTool.webKeys, on: next) }
			ForEach(BuiltInTool.catalog.filter { !$0.usesWeb }, id: \.key) { tool in
				SettingsDivider()
				toolRow(tool.name, sub: tool.description, on: isOn([tool.key]), canChange: may.updateAgents) { next in setTools(agent, [tool.key], on: next) }
			}
		}
	}

	private func toolRow(_ label: String, sub: String, on: Bool, canChange: Bool, offReason: String? = nil, change: @escaping (Bool) -> Void) -> some View {
		SettingsRow(label: label, sub: sub, leading: { EmptyView() }, trailing: {
			if canChange {
				WebToggle(label: "\(on ? "Turn off" : "Turn on") \(label)", isOn: on, change: change).disabled(offReason != nil)
			} else {
				SettingsValue(text: on ? "On" : "Off")
			}
		})
		.foregroundStyle(offReason != nil ? Palette.mutedForeground : Palette.foreground)
	}

	private var inheritedTools: some View {
		let reachable = connections?.filter { $0.toolCounts.allow + $0.toolCounts.ask > 0 }
		return SettingsGroup(label: "Inherited from \(pod.name)", note: "Every bot in \(pod.name) shares these. What each connection allows is set on the pod.") {
			NavigationLink(value: Route.settings(.podPage(pod, .connections))) {
				HStack(spacing: 2) {
					Text("Edit in \(pod.name)")
					Icon(.arrowUpRight, size: 13, strokeWidth: 2)
				}
				.font(Typeface.rubik(13))
				.foregroundStyle(Palette.mutedForeground)
			}
			.buttonStyle(.plain)
		} content: {
			if reachable?.isEmpty == true { SettingsEmptyRow(text: "No connections yet") }
			if let reachable {
				DividedRows(data: reachable) { connection in
					let tools = connection.toolCounts.allow + connection.toolCounts.ask
					SettingsRow(
						label: connection.name,
						sub: "\(tools) \(tools == 1 ? "tool" : "tools")",
						leading: { ConnectionMark(presetId: connection.presetId, name: connection.name, size: .md) },
						trailing: { SettingsValue(text: "Inherited") }
					)
				}
			}
		}
	}

	// MARK: Model

	private func modelPage(_ agent: Agent) -> some View {
		let offered = models?.models ?? []
		let providers = offered.map(\.providerName).reduce(into: [String]()) { if !$0.contains($1) { $0.append($1) } }
		// A model chosen before it was switched off is still the one in use, so it is shown on its own.
		let stranded = agent.model.flatMap { model in offered.contains { $0.modelId == model } ? nil : model }
		return SettingsPage(title: "Model", description: "What \(agent.name) thinks with.") {
			if let failure { FormAlert(text: failure) }
			if let stranded {
				SettingsGroup(label: "In use", note: "This model is no longer switched on for the workspace.") { modelRow(stranded, label: stranded, chosen: agent.model) }
			}
			if models != nil, offered.isEmpty {
				SettingsGroup { SettingsRow(label: "No models are switched on yet.") }
			}
			ForEach(providers, id: \.self) { provider in
				SettingsGroup(label: provider) {
					let ofProvider = offered.filter { $0.providerName == provider }
					DividedRows(data: ofProvider) { model in
						modelRow(model.modelId, label: model.name, chosen: agent.model)
					}
				}
			}
			if models != nil {
				Text(store.permissions?.manageProviders == true
					? "Only models switched on for the workspace appear here. Add providers and switch on more in Models."
					: "Only models switched on for the workspace appear here. To use another, ask a workspace admin to switch it on.")
					.font(Typeface.rubik(13))
					.foregroundStyle(Palette.subtleForeground)
			}
		}
	}

	private func modelRow(_ modelId: String, label: String, chosen: String?) -> some View {
		Button { Task { try? await save(AgentUpdate(model: modelId)) } } label: {
			SettingsRow.trailing(label: label) {
				if modelId == chosen { Icon(.check, size: 16, strokeWidth: 2.6).foregroundStyle(Palette.foreground) }
			}
		}
		.buttonStyle(SettingsRowPressStyle())
		.disabled(!may.updateAgents || modelId == chosen)
	}

	// MARK: Doing

	private func load() async {
		do {
			details = try await store.client.agents.get(agentId: agent.id)
			failure = nil
		} catch {
			failure = error.localizedDescription
		}
		record = try? await store.podRecord(pod.id)
		models = try? await store.workspaceModels()
		members = try? await store.workspaceMembers()
		connections = try? await store.connections(in: pod.id)
		routineCount = (try? await store.routines(of: agent.id))?.count
		webOff = (try? await store.client.searchProviders.webAccess(workspace: store.workspace.id))?.enabled == false
		computersOff = (try? await store.computersEnabled()) == false
	}

	private func save(_ change: AgentUpdate) async throws {
		do {
			details = try await store.client.agents.update(
				agentId: agent.id,
				name: change.name,
				handle: change.handle,
				description: change.description,
				color: change.color,
				face: change.face,
				shape: change.shape,
				model: change.model,
				prompt: change.prompt,
				disabledTools: change.disabledTools,
				usesSandbox: change.usesSandbox,
				naturalBrowsing: change.naturalBrowsing
			)
			failure = nil
			await store.refreshAll()
		} catch {
			failure = error.localizedDescription
			throw error
		}
	}

	private func setTools(_ agent: Agent, _ keys: [String], on: Bool) {
		let disabled = on ? agent.disabledTools.filter { !keys.contains($0) } : Array(Set(agent.disabledTools + keys)).sorted()
		Task { try? await save(AgentUpdate(disabledTools: disabled)) }
	}
}

/// A name or description edited where it stands, saved when the field is left, as `ProfileField`.
private struct ProfileField: View {
	let label: String
	let value: String
	var placeholder = ""
	let maxLength: Int
	var required = false
	var wide = false
	let editable: Bool
	let commit: (String) async throws -> Void
	@State private var draft = ""
	@FocusState private var focused: Bool

	var body: some View {
		HStack(spacing: 14) {
			Text(label)
				.font(Typeface.rubik(13))
				.foregroundStyle(Palette.foreground)
				.frame(width: wide ? 96 : nil, alignment: .leading)
				.frame(maxWidth: wide ? nil : .infinity, alignment: .leading)
			if editable {
				TextField("", text: $draft.limited(to: maxLength), prompt: Text(placeholder).foregroundStyle(Palette.subtleForeground))
					.font(Typeface.rubik(16))
					.foregroundStyle(Palette.foreground)
					.editsInPlace(draft: $draft, saved: value, allowsEmpty: !required, focused: $focused, save: commit)
					.padding(.horizontal, 10)
					.frame(height: 32)
					.frame(maxWidth: wide ? .infinity : 240)
					.background(Palette.settingsRowHover, in: RoundedRectangle(cornerRadius: 9, style: .continuous))
					.overlay(RoundedRectangle(cornerRadius: 9, style: .continuous).strokeBorder(focused ? Palette.ring : Palette.borderStrong))
					.accessibilityLabel(label)
			} else {
				Text(value.isEmpty ? "None yet" : value).font(Typeface.rubik(15)).foregroundStyle(Palette.mutedForeground)
			}
		}
		.padding(.horizontal, 16)
		.padding(.vertical, 10)
		.frame(minHeight: 56)
	}
}

/// A bot's instructions, as the web's `Instructions` page: a long field and Save.
@MainActor
private struct InstructionsPage: View {
	let agent: Agent
	let editable: Bool
	let save: (String) async throws -> Void
	@State private var draft: String
	@State private var saving = false
	@State private var failure: String?

	init(agent: Agent, editable: Bool, save: @escaping (String) async throws -> Void) {
		self.agent = agent
		self.editable = editable
		self.save = save
		_draft = State(initialValue: agent.prompt)
	}

	var body: some View {
		SettingsPage(title: "Instructions", description: "How \(agent.name) should work. It follows these in every chat.") {
			if let failure { FormAlert(text: failure) }
			SettingsGroup(
				note: editable
					? "Write it like a note to a new teammate: what it's for, how to sound, and what to never do. \(draft.count.formatted()) of \(Limits.promptMaxLength.formatted()) characters."
					: nil
			) {
				TextEditor(text: $draft.limited(to: Limits.promptMaxLength))
					.font(Typeface.rubik(16))
					.lineSpacing(16 * 0.65 - 6)
					.foregroundStyle(Palette.foreground)
					.scrollContentBackground(.hidden)
					.disabled(!editable)
					.frame(minHeight: 380)
					.padding(10)
					.overlay(alignment: .topLeading) {
						if draft.isEmpty {
							Text("No instructions yet.").font(Typeface.rubik(16)).foregroundStyle(Palette.subtleForeground).padding(18).allowsHitTesting(false)
						}
					}
					.accessibilityLabel("Instructions")
			}
			if editable {
				HStack {
					Spacer()
					Button(saving ? "Saving…" : "Save") {
						saving = true
						Task {
							do {
								try await save(draft)
								failure = nil
							} catch {
								failure = error.localizedDescription
							}
							saving = false
						}
					}
					.buttonStyle(WebButtonStyle())
					.disabled(draft == agent.prompt || saving)
				}
			}
		}
	}
}

/// A bot's look on a page of its own, as the web's phone `LookEditor`: Close
/// and Save across the top, the bot on its colour, then its shape, face and colour.
@MainActor
private struct LookEditor: View {
	let agent: Agent
	let save: (AgentUpdate) async throws -> Void
	@Environment(\.dismiss) private var dismiss
	@State private var look: BotLook
	@State private var part = LookPart.shape
	@State private var saving = false
	@State private var failure: String?

	init(agent: Agent, save: @escaping (AgentUpdate) async throws -> Void) {
		self.agent = agent
		self.save = save
		_look = State(initialValue: agent.look)
	}

	var body: some View {
		var change = AgentUpdate()
		if look.color != agent.color.rawValue { change.color = AgentColor(rawValue: look.color) }
		if look.shape != agent.shape.rawValue { change.shape = AgentShape(rawValue: look.shape) }
		if look.face != agent.face.rawValue { change.face = AgentFace(rawValue: look.face) }
		// A tint of the bot's colour, faint, so the bot is in its own light without shouting.
		let stage = (BotLooks.palettes[look.color]?.face ?? Palette.chip).opacity(0.05)
		return VStack(spacing: 0) {
			VStack(spacing: 12) {
				ScreenHeader(title: "Look") {
					GlassRoundButton(icon: .x, label: "Cancel", iconSize: 20) { dismiss() }
				} trailing: {
					Button(saving ? "Saving…" : "Save") { submit(change) }
						.buttonStyle(WebButtonStyle(size: .pill))
						.disabled(change == AgentUpdate() || saving)
				}
				BotFace(look: look, size: 88).padding(.top, 8)
				if let failure { FormAlert(text: failure).padding(.horizontal, 16) }
			}
			.padding(.bottom, 20)
			.background(Palette.list.overlay(stage).ignoresSafeArea())
			LookStep(part: $part, look: $look)
				.frame(maxHeight: .infinity, alignment: .top)
				.background(Palette.panel.ignoresSafeArea())
				.overlay(alignment: .top) { Rectangle().fill(Palette.border).frame(height: 1) }
		}
	}

	private func submit(_ change: AgentUpdate) {
		guard change != AgentUpdate() else { return }
		saving = true
		failure = nil
		Task {
			do {
				try await save(change)
				dismiss()
			} catch {
				failure = error.localizedDescription
			}
			saving = false
		}
	}
}
