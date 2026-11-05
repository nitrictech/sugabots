import SwiftUI

/// Setting up a workspace, the first or another, as the web's `Onboarding`:
/// its name, a provider and model, the first bot, inviting people, and the
/// bot ready to chat. Coming back part way through picks up where the
/// workspace says it got to.
@MainActor
struct OnboardingScreen: View {
	enum Step: Int, CaseIterable {
		case workspace, model, bot, invite, ready

		/// The steps the dots count, which leave out Ready.
		static let counted: [Step] = [.workspace, .model, .bot, .invite]
	}

	@State var setup: WorkspaceSetup
	@Environment(Session.self) private var session
	@State private var store: WorkspaceStore?
	@State private var chosen: Step?
	@State private var personalPod: Pod?
	@State private var firstBot: Agent?
	@State private var botHasModel = false
	@State private var loading = false
	@State private var failure: String?
	@State private var confirmingLeave = false

	/// The Personal pod's bot starts as this placeholder, and becomes yours on the bot step.
	static let placeholderBotName = "Personal Assistant"

	var body: some View {
		let step = chosen ?? (setup.made == nil ? .workspace : botHasModel ? .bot : .model)
		let index = Step.counted.firstIndex(of: step)
		VStack(spacing: 0) {
			header(index: index, step: step)
			GeometryReader { geometry in
				ScrollView {
					// In the middle of the screen while it fits, as the web's frame centres a step.
					VStack(spacing: 22) { content(step) }
						.frame(maxWidth: 440)
						.padding(.horizontal, 16)
						.padding(.vertical, 40)
						.frame(maxWidth: .infinity, minHeight: geometry.size.height)
				}
			}
			.scrollDismissesKeyboard(.interactively)
		}
		.background(Palette.background.ignoresSafeArea())
		.confirmDelete(
			isPresented: $confirmingLeave,
			title: "Leave setup?",
			description: "\(setup.made?.name ?? "This workspace") has been made but isn't set up yet. It stays in your workspaces, and opening it picks up setup where you left off.",
			confirmLabel: "Leave"
		) { await cancel() }
		.task(id: setup.made?.id) { await load() }
	}

	// MARK: Frame

	private func header(index: Int?, step: Step) -> some View {
		ZStack {
			if let index {
				HStack(spacing: 6) {
					ForEach(Array(Step.counted.enumerated()), id: \.offset) { offset, _ in
						Capsule()
							.fill(offset == index ? Palette.foreground : offset < index ? Palette.mutedForeground : Palette.borderStrong)
							.frame(width: offset == index ? 22 : 6, height: 6)
					}
				}
				.animation(.easeOut(duration: 0.2), value: index)
				.accessibilityElement()
				.accessibilityLabel("Step \(index + 1) of \(Step.counted.count)")
			}
			HStack {
				if let index, index > 0 {
					TextBackButton { chosen = Step.counted[index - 1] }
				}
				Spacer()
				if setup.returnTo != nil, step != .ready {
					Button("Cancel") {
						// Leaving a workspace that's made but not set up asks first, as the web's guard does.
						if setup.made != nil { confirmingLeave = true } else { Task { await cancel() } }
					}
					.font(Typeface.rubik(14.5, .medium))
					.foregroundStyle(Palette.foreground)
				}
			}
		}
		.padding(.horizontal, 16)
		.padding(.top, 28)
	}

	@ViewBuilder
	private func content(_ step: Step) -> some View {
		if loading {
			Text("Loading your setup…").font(Typeface.rubik(15)).foregroundStyle(Palette.mutedForeground)
		} else if let failure {
			FormAlert(text: failure)
			Button("Try again") { Task { await load() } }.buttonStyle(WebButtonStyle(variant: .secondary))
		} else {
			switch step {
			case .workspace:
				WorkspaceStep(setup: setup) { made in
					setup.made = made
					chosen = .model
				}
			case .model:
				if let store {
					ModelStep(bot: firstBot) {
						chosen = .bot
						Task { await load() }
					}
					.environment(store)
				}
			case .bot, .invite, .ready:
				if let store, let personalPod {
					switch step {
					case .bot:
						BotStep(bot: firstBot) { bot in
							firstBot = bot
							chosen = .invite
						}
						.environment(store)
					case .invite:
						InviteStep { chosen = .ready }.environment(store)
					default:
						if let firstBot {
							ReadyStep(bot: firstBot) { try await finish(pod: personalPod, bot: firstBot) }
						}
					}
				} else if let store {
					PersonalPodMissing { await load() }.environment(store)
				}
			}
		}
	}

	// MARK: Doing

	/// Reads the workspace being set up: its Personal pod, its first bot, and whether that bot has a model it may use.
	private func load() async {
		guard let made = setup.made else { return }
		let store = storeOpen(on: made)
		loading = personalPod == nil
		do {
			async let pods = store.podRecords()
			async let agents = setup.client.agents.list(workspace: made.id)
			async let models = store.refreshModels()
			let (podList, agentList, modelList) = try await (pods, agents, models)
			personalPod = podList.first { $0.kind == .personal && $0.ownerId == setup.user.id }
			firstBot = agentList.first { $0.podId == personalPod?.id && $0.systemAgentKey == nil }
			botHasModel = modelList.models.contains { $0.modelId == firstBot?.model }
			failure = nil
		} catch {
			failure = error.localizedDescription
		}
		loading = false
	}

	/// The store the steps work in for `made`: the one already open on it, or a new one.
	private func storeOpen(on made: Workspace) -> WorkspaceStore {
		if let store, store.workspace.id == made.id { return store }
		let workspaces = setup.workspaces.contains { $0.id == made.id } ? setup.workspaces : setup.workspaces + [made]
		let opened = WorkspaceStore(client: setup.client, user: setup.user, workspaces: workspaces, workspace: made)
		store = opened
		return opened
	}

	/// Marks setup done and opens the workspace at the first bot's channel, as
	/// the web does. Throws, staying on the step, when setup can't be marked done.
	private func finish(pod: Pod, bot: Agent) async throws {
		guard let made = setup.made else { return }
		try await setup.client.onboarding.complete(workspaceId: made.id, podId: pod.id, agentId: bot.id)
		await session.finishWorkspaceSetup(opening: made, showing: Session.ChannelToOpen(pod: pod, bot: bot))
	}

	/// Goes back to the workspace setup was opened from, deleting one made but not set up, where the person may.
	private func cancel() async {
		if let made = setup.made, made.setupCompletedAt == nil {
			let access = try? await setup.client.workspaceAccess(workspace: made.id)
			if access?.permissions.deleteWorkspace == true {
				try? await setup.client.workspaces.delete(workspace: made.id)
			}
		}
		await session.finishWorkspaceSetup(opening: setup.returnTo)
	}
}

// MARK: Parts

/// A step's title, large and centred, with a line under it, as `StepHeading`.
private struct StepHeading: View {
	let title: String
	var text: String?

	var body: some View {
		VStack(spacing: 22) {
			Text(title)
				.font(Typeface.rubik(30, .bold))
				.tracking(-0.6)
				.lineSpacing(30 * 0.15 - 4)
				.accessibilityAddTraits(.isHeader)
			if let text {
				Text(text).font(Typeface.rubik(15)).lineSpacing(15 * 0.55 - 4).foregroundStyle(Palette.mutedForeground)
			}
		}
		.multilineTextAlignment(.center)
		.foregroundStyle(Palette.foreground)
		.frame(maxWidth: .infinity)
	}
}

/// A step's one field, on the list colour, as `fieldClass`.
private struct OnboardingField: View {
	let label: String
	let placeholder: String
	@Binding var text: String
	var maxLength = 64
	/// Takes the keyboard when the step opens, for a step that asks one question.
	var focusOnAppear = false
	@FocusState private var focused: Bool

	var body: some View {
		TextField("", text: $text.limited(to: maxLength), prompt: Text(placeholder).foregroundStyle(Palette.mutedForeground))
			.focused($focused)
			.onAppear { if focusOnAppear { focused = true } }
			.font(Typeface.rubik(16))
			.foregroundStyle(Palette.foreground)
			.padding(.horizontal, 16)
			.padding(.vertical, 14)
			.background(Palette.list, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
			.accessibilityLabel(label)
	}
}

// MARK: Workspace

/// Naming the workspace, which makes it, or renames one made already, as `WorkspaceStep`.
@MainActor
private struct WorkspaceStep: View {
	let setup: WorkspaceSetup
	let made: (Workspace) -> Void
	@State private var name = ""
	@State private var pending = false
	@State private var failure: String?

	var body: some View {
		let trimmed = name.trimmingCharacters(in: .whitespaces)
		StepHeading(title: "Name your workspace", text: "It's just you for now. You can invite people later.")
		OnboardingField(
			label: "Workspace name",
			placeholder: setup.user.name.split(separator: " ").first.map { "e.g. \($0)'s bots" } ?? "e.g. Acme",
			text: $name,
			focusOnAppear: true
		)
		.onSubmit(submit)
		if let failure { FormAlert(text: failure) }
		Button(pending ? "Saving…" : "Continue", action: submit)
			.buttonStyle(WebButtonStyle(size: .large, fullWidth: true))
			.disabled(slugify(trimmed).isEmpty || pending)
			.onAppear { if name.isEmpty { name = setup.made?.name ?? "" } }
	}

	private func submit() {
		let trimmed = name.trimmingCharacters(in: .whitespaces)
		let slug = slugify(trimmed)
		guard !slug.isEmpty, !pending else { return }
		if let existing = setup.made, trimmed == existing.name { return made(existing) }
		pending = true
		failure = nil
		Task {
			do {
				let record =
					if let existing = setup.made {
						try await setup.client.workspaces.update(workspace: existing.id, name: trimmed, slug: slug)
					} else {
						try await setup.client.workspaces.create(name: trimmed, slug: slug, timeZone: TimeZone.current.identifier)
					}
				made(record)
			} catch let failure as APIFailure where failure.status == 409 {
				self.failure = "That workspace address is already taken."
			} catch {
				failure = error.localizedDescription
			}
			pending = false
		}
	}
}

// MARK: Model

/// Connecting a provider and choosing the first bot's model, as `ModelStep`.
@MainActor
private struct ModelStep: View {
	let bot: Agent?
	let chosen: () -> Void
	@Environment(WorkspaceStore.self) private var store
	@State private var providers: [ModelProvider] = []
	@State private var connectedId: String?
	@State private var adding = false

	var body: some View {
		Group {
			// Read from the workspace's providers rather than kept, so a sign-in finished while choosing brings its models in.
			if let connected = providers.first(where: { $0.id == connectedId }) {
				ChooseModelStep(provider: connected, bot: bot, chosen: chosen, reload: load) { connectedId = nil }
			} else {
				connectStep
			}
		}
		.task { await load() }
	}

	private var connectStep: some View {
		let connected = providers.filter { $0.connected && !$0.models.isEmpty }
		return VStack(spacing: 22) {
			StepHeading(title: "Connect a provider", text: "Bots think with a model from a provider you already use. Pick one to start; you can add more later.")
			if !connected.isEmpty {
				SettingsGroup(label: "Connected") {
					DividedRows(data: connected) { provider in
						Button { connectedId = provider.id } label: {
							SettingsRow(label: provider.name, sub: "\(provider.models.count) models", chevron: true, leading: {
								ProviderTile(name: provider.name, preset: provider.preset?.rawValue)
							})
						}
						.buttonStyle(SettingsRowPressStyle())
					}
				}
			}
			Button("Choose a provider") { adding = true }
				.buttonStyle(WebButtonStyle(size: .large, fullWidth: true))
		}
		.fullScreenCover(isPresented: $adding) {
			AddProviderSheet(providers: providers, startWith: nil) { provider in
				adding = false
				Task {
					// A list that can't be fetched yet leaves the starter models, which is enough to begin.
					_ = try? await store.client.modelProviders.fetchModels(workspace: store.workspace.id, providerId: provider.id)
					await load()
					connectedId = provider.id
				}
			}
			.environment(store)
		}
	}

	private func load() async {
		providers = (try? await store.client.modelProviders.list(workspace: store.workspace.id)) ?? providers
	}
}

/// Choosing the first bot's model from a connected provider, as `ChooseModelStep`;
/// a plan-paid provider signs in here first.
@MainActor
private struct ChooseModelStep: View {
	let provider: ModelProvider
	let bot: Agent?
	let chosen: () -> Void
	let reload: () async -> Void
	let otherProvider: () -> Void
	@Environment(WorkspaceStore.self) private var store
	@State private var chosenId: String?
	@State private var search = ""
	@State private var pending = false
	@State private var failure: String?

	var body: some View {
		let choices = provider.models.filter { !$0.effectiveCapabilities.contains(.embeddings) }
		let large = choices.count > 20
		let needle = search.trimmingCharacters(in: .whitespaces).lowercased()
		let shown = choices.filter { needle.isEmpty || "\($0.modelId) \($0.displayName ?? "")".lowercased().contains(needle) }
		let selected = chosenId ?? choices.first { $0.enabled && $0.modelId == bot?.model }?.id
		StepHeading(title: "Choose a model", text: "Your first bot thinks with this. You can switch on more of \(provider.name)'s models later.")
		if choices.isEmpty, provider.lacksCredential, let service = provider.signInService {
			ProviderSignInRow(provider: provider, service: service, signOutBlocked: nil, changed: reload)
			.background(Palette.list, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
		} else if choices.isEmpty {
			FormAlert(text: "\(provider.name) lists no models yet. Check it has some, or use another provider.")
		} else {
			VStack(spacing: 0) {
				if large {
					SearchField(placeholder: "Search \(choices.count) models", text: $search).padding(12)
					SettingsDivider()
				}
				ScrollView {
					VStack(spacing: 0) {
						if shown.isEmpty {
							Text("No models match.").font(Typeface.rubik(12.5)).foregroundStyle(Palette.mutedForeground)
								.frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 16).padding(.vertical, 12)
						}
						DividedRows(data: shown) { model in
							Button { chosenId = model.id } label: {
								HStack(spacing: 12) {
									Text(model.name).font(Typeface.rubik(14.5, .medium)).foregroundStyle(Palette.foreground).lineLimit(1)
										.frame(maxWidth: .infinity, alignment: .leading)
									Circle()
										.strokeBorder(model.id == selected ? Palette.primary : Palette.borderDashed, lineWidth: model.id == selected ? 6 : 1.5)
										.frame(width: 20, height: 20)
								}
								.padding(.horizontal, 16)
								.padding(.vertical, 12)
								.contentShape(Rectangle())
							}
							.buttonStyle(.plain)
							.accessibilityAddTraits(model.id == selected ? .isSelected : [])
						}
					}
				}
				.frame(maxHeight: large ? 208 : nil)
				.fixedSize(horizontal: false, vertical: !large)
			}
			.background(Palette.list, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
			.clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
		}
		if let failure { FormAlert(text: failure) }
		Button(pending ? "Saving…" : "Continue") {
			if let model = choices.first(where: { $0.id == selected }) { choose(model) }
		}
		.buttonStyle(WebButtonStyle(size: .large, fullWidth: true))
		.disabled(selected == nil || pending)
		Button("Use another provider", action: otherProvider).buttonStyle(QuietLinkStyle())
	}

	private func choose(_ model: ProviderModel) {
		pending = true
		failure = nil
		Task {
			do {
				if !model.enabled {
					_ = try await store.client.modelProviders.updateModel(workspace: store.workspace.id, providerId: provider.id, modelId: model.id, enabled: true)
				}
				if let bot { _ = try await store.client.agents.update(agentId: bot.id, model: .present(model.modelId)) }
				chosen()
			} catch {
				failure = error.localizedDescription
			}
			pending = false
		}
	}
}

// MARK: Bot

/// Making the first bot: its look and name, as `BotStep`. The Personal pod's
/// placeholder bot becomes yours.
@MainActor
private struct BotStep: View {
	let bot: Agent?
	let created: (Agent) -> Void
	@Environment(WorkspaceStore.self) private var store
	@State private var look = BotLook(color: .green, face: .pill, shape: .circle)
	@State private var name = ""
	@State private var pending = false
	@State private var failure: String?

	var body: some View {
		let trimmed = name.trimmingCharacters(in: .whitespaces)
		StepHeading(title: "Make your first bot")
		BotFace(look: look, size: 96)
		VStack(spacing: 0) {
			LookPicker(look: $look)
		}
		.background(Palette.list, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
		OnboardingField(label: "Name", placeholder: "Give it a name", text: $name)
		if bot == nil { FormAlert(text: "Your Personal pod has no bot to set up. Reload to try again.") }
		if let failure { FormAlert(text: failure) }
		Button(pending ? "Creating…" : "Create bot", action: submit)
			.buttonStyle(WebButtonStyle(size: .large, fullWidth: true))
			.disabled(bot == nil || trimmed.isEmpty || pending)
			.onAppear {
				if let bot, bot.name != OnboardingScreen.placeholderBotName, name.isEmpty {
					look = bot.look
					name = bot.name
				}
			}
	}

	private func submit() {
		guard let bot else { return }
		pending = true
		failure = nil
		Task {
			do {
				let updated = try await store.client.agents.update(
					agentId: bot.id,
					name: name.trimmingCharacters(in: .whitespaces),
					color: .present(look.color),
					face: .present(look.face),
					shape: .present(look.shape)
				)
				created(updated)
			} catch {
				failure = error.localizedDescription
			}
			pending = false
		}
	}
}

/// A bot's colour, shape and eyes in rows, as the web's `LookPicker` on a phone.
private struct LookPicker: View {
	@Binding var look: BotLook

	var body: some View {
		SettingsControlRow(label: "Colour", stacked: true) {
			ColourSwatches(colors: AgentColor.known.map(\.rawValue), swatch: { BotLooks.palette(for: AgentColor(rawValue: $0)).face }, value: look.color.rawValue, columns: 8) { look.color = AgentColor(rawValue: $0) }
		}
		SettingsDivider()
		SettingsControlRow(label: "Shape", stacked: true) {
			LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 6), count: 7), spacing: 6) {
				ForEach(AgentShape.known, id: \.self) { shape in
					choice(chosen: look.shape == shape, label: shape.rawValue) { look.shape = shape } content: {
						ShapeGlyph(shape: shape, size: 20)
					}
					.aspectRatio(1, contentMode: .fit)
				}
			}
		}
		SettingsDivider()
		SettingsControlRow(label: "Eyes", stacked: true) {
			LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 6), count: 5), spacing: 6) {
				ForEach(AgentFace.known, id: \.self) { face in
					choice(chosen: look.face == face, label: face.rawValue) { look.face = face } content: {
						EyesGlyph(face: face)
					}
					.frame(height: 44)
				}
			}
		}
	}

	private func choice(chosen: Bool, label: String, action: @escaping () -> Void, @ViewBuilder content: () -> some View) -> some View {
		Button(action: action) {
			content()
				.foregroundStyle(chosen ? Palette.foreground : Palette.softForeground)
				.frame(maxWidth: .infinity, maxHeight: .infinity)
				.background(chosen ? Palette.personAvatar : Palette.chip, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
		}
		.buttonStyle(.plain)
		.accessibilityLabel(label)
		.accessibilityAddTraits(chosen ? .isSelected : [])
	}
}

// MARK: Invite

/// Inviting people, as `InviteStep`: addresses gathered as chips, sent as members, or skipped.
@MainActor
private struct InviteStep: View {
	let done: () -> Void
	@Environment(WorkspaceStore.self) private var store
	@State private var emails: [String] = []
	@State private var draft = ""
	@State private var failed: [InviteFailure] = []
	@State private var sending = false

	var body: some View {
		let count = emails.count
		StepHeading(title: "Bring your friends", text: "Invite people to your workspace. You can add them to pods later.")
		ChipFlow(spacing: 6) {
			ForEach(emails, id: \.self) { email in
				HStack(spacing: 6) {
					Text(email).font(Typeface.rubik(13.5))
					Button { emails.removeAll { $0 == email } } label: {
						Icon(.x, size: 10, strokeWidth: 3).foregroundStyle(Palette.softForeground).frame(width: 18, height: 18)
					}
					.buttonStyle(.plain)
					.accessibilityLabel("Remove \(email)")
				}
				.padding(.leading, 10)
				.padding(.trailing, 6)
				.padding(.vertical, 4)
				.background(Palette.borderStrong, in: Capsule())
			}
			TextField("", text: $draft, prompt: Text(count == 0 ? "Email addresses" : "").foregroundStyle(Palette.mutedForeground))
				.font(Typeface.rubik(16))
				.keyboardType(.emailAddress)
				.textInputAutocapitalization(.never)
				.autocorrectionDisabled()
				.disabled(sending)
				.onSubmit(addDraft)
				.onChange(of: draft) { _, typed in if typed.hasSuffix(",") || typed.hasSuffix(" ") { addDraft() } }
				.frame(minWidth: 160)
				.padding(.horizontal, 4)
				.padding(.vertical, 6)
				.accessibilityLabel("Email addresses")
		}
		.padding(.horizontal, 12)
		.padding(.vertical, 10)
		.frame(maxWidth: .infinity, minHeight: 52, alignment: .leading)
		.background(Palette.list, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
		if !failed.isEmpty { FormAlert(text: failed.map { "\($0.email): \($0.reason)" }.joined(separator: "\n")) }
		Button(sending ? "Sending…" : count == 0 ? "Continue" : "Send \(count) \(count == 1 ? "invite" : "invites")", action: submit)
			.buttonStyle(WebButtonStyle(size: .large, fullWidth: true))
			.disabled(sending)
		Button("Skip for now", action: done).buttonStyle(QuietLinkStyle())
	}

	private func addDraft() {
		let typed = emailAddresses(in: draft)
		guard !typed.isEmpty else { return }
		for email in typed where !emails.contains(email) { emails.append(email) }
		draft = ""
	}

	private func submit() {
		var all = emails
		for email in emailAddresses(in: draft) where !all.contains(email) { all.append(email) }
		guard !all.isEmpty else { return done() }
		sending = true
		Task {
			let failures = await store.invite(all, as: .member)
			sending = false
			if failures.isEmpty { return done() }
			// What went out is done; what's left is what to fix or skip.
			failed = failures
			emails = failures.map(\.email)
			draft = ""
		}
	}
}

/// Children laid out in rows, wrapping to the next when one is full, for the invite step's chips.
private struct ChipFlow: Layout {
	var spacing: CGFloat

	func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache _: inout ()) -> CGSize {
		let rows = rows(for: subviews, width: proposal.width ?? .infinity)
		let height = rows.reduce(0) { $0 + $1.height } + spacing * CGFloat(max(0, rows.count - 1))
		return CGSize(width: proposal.width ?? rows.map(\.width).max() ?? 0, height: height)
	}

	func placeSubviews(in bounds: CGRect, proposal _: ProposedViewSize, subviews: Subviews, cache _: inout ()) {
		var y = bounds.minY
		for row in rows(for: subviews, width: bounds.width) {
			var x = bounds.minX
			for index in row.indices {
				let size = subviews[index].sizeThatFits(.unspecified)
				// The last in a row, such as the field, takes what's left of it.
				let width = index == row.indices.last ? max(size.width, bounds.maxX - x) : size.width
				subviews[index].place(at: CGPoint(x: x, y: y + (row.height - size.height) / 2), proposal: ProposedViewSize(width: width, height: size.height))
				x += width + spacing
			}
			y += row.height + spacing
		}
	}

	private struct Row {
		var indices: [Int] = []
		var width: CGFloat = 0
		var height: CGFloat = 0
	}

	private func rows(for subviews: Subviews, width: CGFloat) -> [Row] {
		var rows: [Row] = [Row()]
		for index in subviews.indices {
			let size = subviews[index].sizeThatFits(.unspecified)
			let needed = rows[rows.count - 1].indices.isEmpty ? size.width : rows[rows.count - 1].width + spacing + size.width
			if needed > width, !rows[rows.count - 1].indices.isEmpty {
				rows.append(Row())
			}
			let row = rows.count - 1
			rows[row].width += (rows[row].indices.isEmpty ? 0 : spacing) + size.width
			rows[row].height = max(rows[row].height, size.height)
			rows[row].indices.append(index)
		}
		return rows
	}
}

// MARK: Ready

/// The first bot ready to chat, greeting you, as `ReadyStep`.
private struct ReadyStep: View {
	let bot: Agent
	let start: () async throws -> Void
	@State private var starting = false
	@State private var failure: String?

	var body: some View {
		let palette = BotLooks.palette(for: bot.color)
		StepHeading(title: "\(bot.name) is ready")
		VStack(alignment: .leading, spacing: 3) {
			Text(bot.name).font(Typeface.rubik(11.5, .medium)).foregroundStyle(Palette.mutedForeground).padding(.leading, 42).padding(.bottom, 4)
			HStack(alignment: .bottom, spacing: 8) {
				BotFace(look: bot.look, size: 34)
				VStack(alignment: .leading, spacing: 3) {
					ForEach(["Hi, I'm \(bot.name).", "I've only just been set up. Help me work out what I'm for?"], id: \.self) { line in
						Text(line)
							.font(Typeface.rubik(15))
							.foregroundStyle(palette.text.resolved)
							.padding(.horizontal, 14)
							.padding(.vertical, 10)
							.background(
								palette.tint.resolved,
								in: UnevenRoundedRectangle(topLeadingRadius: 20, bottomLeadingRadius: 6, bottomTrailingRadius: 20, topTrailingRadius: 20, style: .continuous)
							)
					}
				}
			}
		}
		.padding(.horizontal, 16)
		.padding(.vertical, 18)
		.frame(maxWidth: .infinity, alignment: .leading)
		.background(Palette.list, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
		if let failure { FormAlert(text: failure) }
		Button("Start chatting") {
			starting = true
			failure = nil
			Task {
				do { try await start() } catch { failure = error.localizedDescription }
				starting = false
			}
		}
		.buttonStyle(WebButtonStyle(size: .large, fullWidth: true))
		.disabled(starting)
	}
}

/// Making the Personal pod again, which the first bot lives in, as `PersonalPodMissing`.
@MainActor
private struct PersonalPodMissing: View {
	let made: () async -> Void
	@Environment(WorkspaceStore.self) private var store
	@State private var modelId: String?
	@State private var pending = false
	@State private var failure: String?

	var body: some View {
		StepHeading(title: "Your Personal pod is missing", text: "It is where your first bot lives. Make it again to carry on.")
		if let failure { FormAlert(text: failure) }
		Button("Make it") {
			guard let modelId else { return }
			pending = true
			Task {
				do {
					_ = try await store.client.pods.ensurePersonal(workspace: store.workspace.id, model: modelId)
					await made()
				} catch {
					failure = error.localizedDescription
				}
				pending = false
			}
		}
		.buttonStyle(WebButtonStyle(size: .large, fullWidth: true))
		.disabled(modelId == nil || pending)
		.task {
			_ = try? await store.refreshModels()
			modelId = store.enabledModels?.models.first?.modelId
		}
	}
}
