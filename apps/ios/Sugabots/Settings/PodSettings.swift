import SwiftUI

/// One of a pod's settings pages, as the web's `WorkspacePodsSettings`: its
/// General, Connections, People, Bots or Computer. A page the pod doesn't
/// have, such as a Personal pod's General, gives way to its Connections.
/// Each page is given the pod as just fetched, with what you may do in it.
@MainActor
struct PodPageScreen: View {
	let pod: Pod
	let page: PodSettingsPage
	@Environment(WorkspaceStore.self) private var store
	@State private var record: Pod?
	@State private var failure: String?

	var body: some View {
		Group {
			if let record {
				let shown = PodSettingsPage.pages(for: record.kind).contains(page) ? page : .connections
				switch shown {
				case .general: PodGeneralPage(record: record) { await load() }
				case .connections: PodConnectionsPage(record: record)
				case .people: PodPeoplePage(record: record)
				case .bots: PodBotsPage(record: record)
				case .computer: PodComputerPage(record: record)
				}
			} else if let failure {
				SettingsPage { EmptyState(title: "Could not load this pod", text: failure).frame(minHeight: 320) }
			} else {
				SettingsPage { EmptyView() }
			}
		}
		.task { await load() }
	}

	private func load() async {
		do { record = try await store.podRecord(pod.id) } catch { failure = error.localizedDescription }
	}
}

// MARK: General

/// A pod's General, as `PodDetails`: its name and colour, and deleting it.
@MainActor
private struct PodGeneralPage: View {
	let record: Pod
	let changed: () async -> Void
	@Environment(WorkspaceStore.self) private var store
	@Environment(\.dismiss) private var dismiss
	@State private var people: Int?
	@State private var recolour = SettingsAction()
	@State private var confirmingDelete = false

	var body: some View {
		let may = record.permissions
		let shared = record.kind == .shared
		SettingsPage(
			title: record.name,
			description: podSummary(bots: store.bots(in: record).count, people: shared ? people : nil),
			hero: AnyView(PodInitial(kind: record.kind, name: record.name, color: record.color?.rawValue, size: .large))
		) {
			if let failure = recolour.failure { FormAlert(text: failure) }
			if may.rename {
				SettingsGroup(label: "Pod") {
					SettingsNameRow(name: record.name, maxLength: Limits.podNameMaxLength) { name in
						try await store.updatePod(record.id, name: name)
						await changed()
					}
				}
			}
			if may.rename, let color = record.color?.rawValue {
				SettingsGroup(label: "Look", note: "Shown on the pod's icon in the sidebar.") {
					SettingsControlRow(label: "Colour") {
						ColourSwatches(colors: PodColor.known.map(\.rawValue), swatch: { BotLooks.pods[$0]?.swatch ?? .gray }, value: color) { next in
							recolour.run {
								try await store.updatePod(record.id, color: PodColor(rawValue: next))
								await changed()
							}
						}
						.disabled(recolour.pending)
					}
				}
			}
			if shared && may.rename {
				SettingsDanger(label: "Delete pod", description: "Removes its bots, threads and artifacts.", actionTitle: "Delete") { confirmingDelete = true }
			}
		}
		.confirmDelete(
			isPresented: $confirmingDelete,
			title: "Delete \(record.name)?",
			description: "Its bots, their chats, routines and connections will be deleted. This can't be undone."
		) {
			try await store.deletePod(record.id)
			dismiss()
		}
		.task { people = (try? await store.podMembers(record.id))?.count }
	}
}

// MARK: People

/// Who can see a pod, as `Members`: each with their role, and the − that takes
/// them out, or you, for those who may; Add people for those who may.
@MainActor
private struct PodPeoplePage: View {
	let record: Pod
	@Environment(WorkspaceStore.self) private var store
	@Environment(\.dismiss) private var dismiss
	@State private var members: Loadable<[PodMember]> = .loading
	@State private var roster: [WorkspaceMember]?
	@State private var adding = SettingsAction()
	@State private var removing: PodMember?

	var body: some View {
		let canManage = record.permissions.manageMembers
		let leaving = removing?.userId == store.user.id
		SettingsPage(title: "People", description: "Who can see \(record.name) and talk to its bots.") {
			if canManage { addPeople }
		} content: {
			if let failure = adding.failure { FormAlert(text: failure) }
			SettingsGroup {
				switch members {
				case .loading:
					EmptyView()
				case let .failed(failure):
					FormAlert(text: failure).padding(.horizontal, 16).padding(.vertical, 12)
				case let .loaded(members) where members.isEmpty:
					SettingsRow(label: "Nobody can see into this pod yet")
				case let .loaded(members):
					DividedRows(data: members) { member in row(member, canManage: canManage) }
				}
			}
		}
		.confirmDelete(
			isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }),
			title: leaving ? "Leave \(record.name)?" : "Remove \(removing?.name ?? "this person") from \(record.name)?",
			description: leaving
				? "You lose this pod, its bots, and your chats. An administrator can add you back."
				: "They lose this pod, its bots, and their chats. You can add them back at any time.",
			confirmLabel: leaving ? "Leave" : "Remove"
		) {
			guard let member = removing else { return }
			if leaving {
				try await store.leavePod(record.id)
				dismiss()
			} else {
				try await store.removeFromPod(record.id, userId: member.userId)
				await load()
			}
		}
		.task { await load() }
	}

	private func row(_ member: PodMember, canManage: Bool) -> some View {
		let isYou = member.userId == store.user.id
		let mayTakeOut = isYou ? record.permissions.leave : canManage && member.removable
		return SettingsRow(
			label: member.name,
			leading: { PersonAvatar(name: member.name, email: member.email, image: member.image, size: 24) },
			trailing: {
				HStack(spacing: 14) {
					// Said once the workspace roster has answered, not guessed before it.
					if isYou {
						SettingsValue(text: "You")
					} else if let roster {
						SettingsValue(text: WorkspaceRole.label(roster.first { $0.user.id == member.userId }?.role))
					}
					if mayTakeOut {
						Button { removing = member } label: {
							Icon(.minus, size: 13, strokeWidth: 2.6)
								.foregroundStyle(Palette.destructiveText)
								.frame(width: 28, height: 28)
								.contentShape(Circle())
						}
						.buttonStyle(.plain)
						.accessibilityLabel(isYou ? "Leave \(record.name)" : "Remove \(member.name)")
					}
				}
			}
		)
	}

	/// Add people, as a menu of everyone in the workspace not here yet.
	private var addPeople: some View {
		let inPod = Set(members.value?.map(\.userId) ?? [])
		let invitable = roster?.filter { !inPod.contains($0.user.id) } ?? []
		return Menu {
			if roster == nil {
				Text("Loading…")
			} else if invitable.isEmpty {
				Text("Everyone in the workspace is here.")
			} else {
				ForEach(invitable) { member in
					Button(member.user.name) {
						adding.run {
							try await store.addToPod(record.id, userId: member.user.id)
							await load()
						}
					}
				}
			}
		} label: {
			GlassRoundIcon(icon: .plus, size: 22)
		}
		.disabled(adding.pending)
		.accessibilityLabel("Add people")
	}

	private func load() async {
		members = await .of { try await store.podMembers(record.id) }
		roster = try? await store.workspaceMembers()
	}
}

// MARK: Bots

/// A pod's bots, as `PodBots`, each opening its settings; New bot for those who may.
@MainActor
private struct PodBotsPage: View {
	let record: Pod
	@Environment(WorkspaceStore.self) private var store
	@State private var creating = false
	@Environment(\.openPage) private var openPage

	var body: some View {
		let bots = store.bots(in: record)
		SettingsPage(title: "Bots", description: "\(bots.count) \(bots.count == 1 ? "bot" : "bots") in \(record.name)") {
			if record.permissions.createAgents { SettingsAddButton(label: "New bot") { creating = true } }
		} content: {
			SettingsGroup {
				if bots.isEmpty { SettingsEmptyRow(text: "No bots in this pod yet") }
				DividedRows(data: bots) { agent in
					NavigationLink(value: Route.settings(.agent(record, agent))) {
						SettingsRow(
							label: agent.name,
							sub: agent.givenDescription,
							chevron: true,
							leading: { BotFace(look: agent.look, size: 24) },
							trailing: { EmptyView() }
						)
					}
					.buttonStyle(SettingsRowPressStyle())
				}
			}
		}
		.fullScreenCover(isPresented: $creating) {
			NewBotScreen(pod: record) { made in
				creating = false
				openPage(.settings(.agent(record, made)))
			}
		}
	}
}

// MARK: Computer

/// A pod's computer, as `PodSandboxSettings`: the sandbox, its activity,
/// Upgrade and Reset, and the hosts it may reach.
@MainActor
private struct PodComputerPage: View {
	/// What Upgrade and Reset ask before they're done.
	private enum Confirmation {
		case upgrade, reset
	}

	let record: Pod
	@Environment(WorkspaceStore.self) private var store
	@State private var sandbox: PodSandbox?
	@State private var network: PodSandboxNetwork?
	@State private var failure: String?
	@State private var confirming: Confirmation?
	@State private var hostAction = SettingsAction()
	@State private var newHost = ""

	private static func stateWords(_ state: PodSandboxState.Present.State) -> String {
		switch state {
		case .running: "Running"
		case .paused: "Paused"
		case .lost: "Lost"
		case .unreachable: "Not answering"
		case .unknown: ""
		}
	}

	var body: some View {
		SettingsPage(title: "Computer", description: "The computer \(record.name)'s bots run commands, browse and edit files on. Experimental.") {
			if let failure { FormAlert(text: failure) }
			if let sandbox, sandbox.providerEnabled || sandbox.sandbox.present != nil {
				sandboxGroup(sandbox)
				if let network { networkGroup(network) }
			}
		}
		.confirmDelete(
			isPresented: isConfirming(.upgrade),
			title: "Upgrade the sandbox?",
			description: "Its workspace, every thread's folder and every bot's home, moves to a new sandbox made from the current image. Running programs and open browser tabs are lost.",
			confirmLabel: "Upgrade"
		) {
			_ = try await store.client.podSandbox.upgrade(podId: record.id)
			await load()
		}
		.confirmDelete(
			isPresented: isConfirming(.reset),
			title: "Reset the sandbox?",
			description: "Everything in it is deleted: every thread's folder, every bot's home, and any work that wasn't pushed. This can't be undone.",
			confirmLabel: "Reset"
		) {
			_ = try await store.client.podSandbox.reset(podId: record.id)
			await load()
		}
		.task { await load() }
	}

	private func isConfirming(_ confirmation: Confirmation) -> Binding<Bool> {
		Binding(get: { confirming == confirmation }, set: { if !$0 { confirming = nil } })
	}

	@ViewBuilder
	private func sandboxGroup(_ shown: PodSandbox) -> some View {
		if let sandbox = shown.sandbox.present {
			let turns = sandbox.turnsUsing
			let watching = sandbox.peopleWatching
			let busy = [
				turns > 0 ? "\(turns == 1 ? "A bot is" : "\(turns) bots are") using it" : nil,
				watching > 0 ? "\(watching == 1 ? "1 person" : "\(watching) people") watching" : nil,
			].compactMap { $0 }
			SettingsGroup(label: "Computer", note: Self.stateNote(sandbox.state)) {
				SettingsRow(label: sandbox.providerName, sub: sandbox.image ?? "Image unknown", trailing: {
					SettingsValue(text: Self.stateWords(sandbox.state))
				})
				SettingsDivider()
				SettingsRow(
					label: "Activity",
					sub: busy.isEmpty ? "Last used \(Times.listInSentence(sandbox.lastUsedAt))" : busy.joined(separator: ", "),
					trailing: { SettingsValue(text: "Made \(Times.listInSentence(sandbox.createdAt))") }
				)
				if shown.canManage {
					SettingsDivider()
					Button { confirming = .upgrade } label: {
						SettingsRow(label: sandbox.upgradeAvailable ? "Upgrade available" : "Upgrade", sub: "Moves the pod's work to a new sandbox made from the current image.")
					}
					.buttonStyle(SettingsRowPressStyle())
					.disabled(turns > 0)
					SettingsDivider()
					Button { confirming = .reset } label: {
						SettingsRow(label: "Reset", sub: "Throws the sandbox away. The next one starts empty.")
					}
					.buttonStyle(SettingsRowPressStyle())
					.disabled(turns > 0)
				}
			}
		} else {
			SettingsGroup(label: "Computer") {
				SettingsRow(label: "No computer yet", sub: "One is made the first time a bot here runs a command or uses its browser.")
			}
		}
	}

	@ViewBuilder
	private func networkGroup(_ network: PodSandboxNetwork) -> some View {
		let canManage = record.permissions.manageSandbox
		let reachable = network.workspaceHosts.filter { $0.blockedBy == nil }
		if network.mode == .open {
			SettingsGroup(label: "Network", note: "The workspace's sandboxes are open. Its admins choose this, and any hosts it blocks, in its sandbox settings.") {
				SettingsRow(label: "Open", sub: network.blocking ? "Any host the workspace hasn't blocked" : "Any host")
			}
		} else {
			SettingsGroup(
				label: "Network",
				note: canManage
					? "The sandbox connects to the workspace's hosts and these. When a bot needs another, it asks in its thread, and you can allow it there."
					: "The sandbox connects to the workspace's hosts and these. When a bot needs another, it asks in its thread, and an admin of this pod decides."
			) {
				ForEach(network.addedHosts) { added in
					let by = added.addedByName ?? "someone who has left"
					RemovableRow(
						name: added.host,
						sub: added.blockedBy.map { "Blocked for the workspace by \($0). Added by \(by)" } ?? "Added by \(by)",
						removal: canManage ? .init(label: "Remove \(added.host)") { removeHost(added.host) } : nil
					)
					.disabled(hostAction.pending)
					SettingsDivider()
				}
				if canManage {
					AddHostRow(label: "Add host", buttonTitle: "Add", draft: $newHost, add: addHost)
						.disabled(hostAction.pending)
					SettingsDivider()
				}
				HostListRow(
					label: "From the workspace",
					hosts: reachable.map(\.host),
					summary: "\(reachable.count) hosts every pod reaches: GitHub, package registries and the workspace's own"
				)
			}
			if let failure = hostAction.failure { FormAlert(text: failure) }
		}
	}

	private static func stateNote(_ state: PodSandboxState.Present.State) -> String? {
		switch state {
		case .paused: "Paused while nobody uses it. It wakes when a bot next needs it."
		case .lost: "The provider no longer has this sandbox. A new one is made when a bot next needs it."
		case .unreachable: "The sandbox provider isn't answering, so this may be out of date."
		default: nil
		}
	}

	private func load() async {
		do {
			sandbox = try await store.client.podSandbox.get(podId: record.id)
			failure = nil
		} catch {
			failure = error.localizedDescription
		}
		network = try? await store.client.podSandbox.network(podId: record.id)
	}

	private func addHost(_ host: String) {
		hostAction.run {
			_ = try await store.client.podSandbox.addHost(podId: record.id, host: host)
			newHost = ""
			await load()
		}
	}

	private func removeHost(_ host: String) {
		hostAction.run {
			_ = try await store.client.podSandbox.removeHost(podId: record.id, host: host)
			await load()
		}
	}
}
